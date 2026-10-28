/**
 * 登录与异地访问专项（1.25 新增）
 *
 * 特点：**自带隔离实例**——不依赖 8899 / 8955 上的共享服务：
 *   · 用 fs.mkdtempSync 建临时目录，只复制 server/（后端代码）与登录页所需的最少静态文件
 *   · CRM_ROOT=<临时目录>、CRM_PORT=8898（若该端口段已有别的本软件实例，自动换 8908/8918）
 *   · spawn node server/server.js，等 /api/health 就绪后开跑
 *   · 结束时 kill 进程并删除临时目录，真实 data/ 一个字节都不碰
 *
 * 覆盖（约 60 项）：
 *   默认无需登录 / 只听 127.0.0.1；未设密码不能开监听、不能启用登录；
 *   scrypt 哈希格式与明文不落库；登录成功下发 Cookie（属性/结构/30 天）；
 *   未登录 401；错误密码计数；连错 5 次锁 15 分钟（正确密码也 423）；退出后 401；
 *   改密后旧 Cookie / 旧密码全部失效；IP 白名单 403 且不泄漏密码对错；
 *   监听范围落库 + restart_required；审计含登录/失败/退出/改密/监听变更且不含密码；
 *   auth/status 与 settings 接口不泄漏哈希/密钥；reset-password.js 可清空密码并关闭登录。
 *
 * 用法：node tools/test-auth-125.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(REPO, 'server', 'server.js');
const RESET_TOOL = path.join(REPO, 'tools', 'reset-password.js');

const PASSWORD1 = 'Auth!125-Pass';
const PASSWORD2 = 'Auth!125-NewPass';
const PASSWORD_WRONG = 'definitely-wrong-125';
const SESSION_TTL = 2592000;

let TMP = '';
let DB_FILE = '';
let PORT = 0;
let BASE = '';
let child = null;
let serverLog = '';
let cookie = '';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

/* ------------------------------------------------------------------ */
/* HTTP（带 Cookie 罐）                                                */
/* ------------------------------------------------------------------ */

async function http(method, p, opts) {
  const o = opts || {};
  const headers = Object.assign({ Accept: 'application/json' }, o.headers || {});
  const useCookie = Object.prototype.hasOwnProperty.call(o, 'cookie') ? o.cookie : cookie;
  if (useCookie) headers.Cookie = useCookie;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';

  const res = await fetch(BASE + p, {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    redirect: 'manual'
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON（静态文件） */ }
  return {
    status: res.status,
    headers: res.headers,
    setCookie: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    text,
    json,
    data: json && json.data
  };
}

function takeSessionCookie(res) {
  const list = res.setCookie || [];
  const line = list.find((x) => x.startsWith('crm_session='));
  if (!line) return '';
  cookie = line.split(';')[0];
  return line;
}

async function login(password, username) {
  const r = await http('POST', '/api/auth/login', {
    body: { username: username || 'admin', password },
    cookie: ''
  });
  if (r.status === 200) takeSessionCookie(r);
  return r;
}

/* ------------------------------------------------------------------ */
/* 数据库（只读断言 + 测试专用的两点写入）                              */
/* ------------------------------------------------------------------ */

function withDb(fn) {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

function authSettings() {
  return withDb((db) => {
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'auth%' OR key = 'listen_mode'"
    ).all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  });
}

/** 测试专用：直接改某一个设置项（用于清锁定 / 清白名单，避免用例被自己挡住） */
function forceSetting(key, value) {
  const db = new DatabaseSync(DB_FILE);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?')
      .run(String(value), new Date().toISOString(), key);
  } finally {
    db.close();
  }
}

function auditRows() {
  return withDb((db) => db.prepare(
    `SELECT entity_type, action, summary, detail, created_at FROM activity_logs
     WHERE entity_type = 'auth' ORDER BY id ASC`
  ).all().map((r) => Object.assign({}, r)));
}

function countAuthLogs(action) {
  return withDb((db) => db.prepare(
    "SELECT COUNT(*) AS n FROM activity_logs WHERE entity_type = 'auth' AND action = ?"
  ).get(action).n);
}

/* ------------------------------------------------------------------ */
/* 隔离实例                                                            */
/* ------------------------------------------------------------------ */

async function probeHealth(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return 'other';
    const j = await res.json().catch(() => null);
    const app = j && j.data && j.data.app;
    return typeof app === 'string' && app.startsWith('crm-bjxt') ? 'crm' : 'other';
  } catch (_) {
    return 'free';
  }
}

/**
 * 选端口：优先 8898（规格要求）。
 * server.js 的单实例探测会扫描 [port, port+10]；如果这一段里有别的本软件实例
 * （例如使用者正开着 8899），隔离实例会误判"已在运行"而退出，因此自动换一段。
 */
async function pickPort() {
  for (const p of [8898, 8908, 8918, 8928]) {
    if (await probeHealth(p) !== 'free') continue;
    let clash = false;
    for (let q = p + 1; q <= p + 10; q++) {
      if (await probeHealth(q) === 'crm') { clash = true; break; }
    }
    if (!clash) return p;
  }
  throw new Error('找不到可用的隔离端口（8898/8908/8918/8928 均被占用，或扫描范围内有共享实例）');
}

function copyRuntime() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-auth-125-'));
  DB_FILE = path.join(TMP, 'data', 'crm.db');

  /* 后端代码（含 server/data/region.json 种子） */
  fs.cpSync(path.join(REPO, 'server'), path.join(TMP, 'server'), { recursive: true });

  /* 登录页与静态文件：只拷测试要访问的几份，不复制 vendor（约 10MB） */
  const web = path.join(TMP, 'web');
  fs.mkdirSync(path.join(web, 'js'), { recursive: true });
  fs.mkdirSync(path.join(web, 'css'), { recursive: true });
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  for (const [from, to] of [
    ['web/login.html', 'web/login.html'],
    ['web/index.html', 'web/index.html'],
    ['web/js/login.js', 'web/js/login.js'],
    ['web/css/login.css', 'web/css/login.css'],
    ['web/assets/logo.svg', 'web/assets/logo.svg']
  ]) {
    const src = path.join(REPO, from);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, to));
  }
}

async function startServer() {
  PORT = await pickPort();
  BASE = `http://127.0.0.1:${PORT}`;
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: TMP,
    env: Object.assign({}, process.env, { CRM_ROOT: TMP, CRM_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (child.exitCode !== null) {
      throw new Error(`隔离实例启动即退出（退出码 ${child.exitCode}）\n${serverLog.slice(-2000)}`);
    }
    const hit = await probeHealth(PORT);
    if (hit === 'crm') return;
  }
  throw new Error(`隔离实例 30 秒内未就绪\n${serverLog.slice(-2000)}`);
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
      resolve();
    }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch (_) { /* 忽略 */ }
  });
}

function cleanupFiles() {
  if (!TMP) return true;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) { /* 忽略 */ }
  return !fs.existsSync(TMP);
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

async function runTests() {
  const s0 = authSettings();

  /* ===== 0. 隔离实例与默认值 ===== */
  const health = await http('GET', '/api/health');
  check('隔离实例健康检查通过（不依赖 8899 / 8955）',
    health.status === 200 && health.data && /^crm-bjxt/.test(String(health.data.app || ''))
      && /^1\.2[0-9]/.test(String(health.data.version || '')),
    `端口 ${PORT} · app=${health.data && health.data.app} · version=${health.data && health.data.version}`);
  check('默认只监听 127.0.0.1（listen_mode=local）',
    s0.listen_mode === 'local' && health.data.bindAddress === '127.0.0.1',
    `listen_mode=${s0.listen_mode} · bind=${health.data.bindAddress}`);
  check('默认不启用登录（auth_enabled=0、哈希为空）',
    s0.auth_enabled === '0' && s0.auth_pass_hash === '',
    `auth_enabled=${s0.auth_enabled} · hashLen=${String(s0.auth_pass_hash || '').length}`);
  check('8 个登录设置项已按默认值种入',
    s0.auth_user === 'admin' && s0.auth_session_secret === '' && s0.auth_fail_state === '{}'
      && s0.auth_ip_allow === '' && s0.auth_totp_secret === '',
    `user=${s0.auth_user} secretLen=${String(s0.auth_session_secret || '').length} fail=${s0.auth_fail_state}`);

  const st0 = await http('GET', '/api/auth/status');
  check('默认 /api/auth/status 返回未启用、未登录、不能异地',
    st0.status === 200 && st0.data && st0.data.auth_enabled === false
      && st0.data.logged_in === false && st0.data.listen_mode === 'local'
      && st0.data.can_remote === false && st0.data.has_password === false,
    `auth_enabled=${st0.data && st0.data.auth_enabled} can_remote=${st0.data && st0.data.can_remote}`);

  const cust0 = await http('GET', '/api/customers?pageSize=1');
  const set0 = await http('GET', '/api/settings');
  check('默认无需登录即可访问业务接口（与 1.24 行为一致）',
    cust0.status === 200 && set0.status === 200,
    `GET /api/customers=${cust0.status} · GET /api/settings=${set0.status}`);

  const loginHtml = await http('GET', '/login.html');
  const loginJs = await http('GET', '/js/login.js');
  const loginCss = await http('GET', '/css/login.css');
  const noExternal = !/https?:\/\//i.test(loginHtml.text || '');
  check('登录页 / 脚本 / 样式可访问，且不引用任何外链',
    loginHtml.status === 200 && loginJs.status === 200 && loginCss.status === 200
      && /js\/login\.js/.test(loginHtml.text || '') && noExternal,
    `HTML=${loginHtml.status} JS=${loginJs.status} CSS=${loginCss.status} 无外链=${noExternal}`);

  /* ===== 1. 前置条件：没密码不能对外开放 / 不能启用登录 ===== */
  const lanNoPass = await http('PUT', '/api/settings', { body: { listen_mode: 'lan' } });
  check('未设密码时切换监听范围 lan → 400 并被拒绝',
    lanNoPass.status === 400 && lanNoPass.json && lanNoPass.json.code === 'NO_PASSWORD',
    `HTTP ${lanNoPass.status} code=${lanNoPass.json && lanNoPass.json.code}`);
  const allNoPass = await http('PUT', '/api/settings', { body: { listen_mode: 'all' } });
  check('未设密码时切换监听范围 all → 400 并被拒绝',
    allNoPass.status === 400 && allNoPass.json && allNoPass.json.code === 'NO_PASSWORD',
    `HTTP ${allNoPass.status}`);
  check('被拒后 listen_mode 仍为 local',
    authSettings().listen_mode === 'local', `listen_mode=${authSettings().listen_mode}`);

  const enableNoPass = await http('PUT', '/api/settings', { body: { auth_enabled: '1' } });
  check('未设密码时启用登录 → 400 并被拒绝',
    enableNoPass.status === 400 && enableNoPass.json && enableNoPass.json.code === 'NO_PASSWORD',
    `HTTP ${enableNoPass.status}`);

  const writeHash = await http('PUT', '/api/settings', {
    body: { auth_pass_hash: 'scrypt$16384$8$1$deadbeef$deadbeef' }
  });
  check('PUT /api/settings 不允许写 auth_pass_hash（400 SENSITIVE_SETTING）',
    writeHash.status === 400 && writeHash.json && writeHash.json.code === 'SENSITIVE_SETTING',
    `HTTP ${writeHash.status} code=${writeHash.json && writeHash.json.code}`);
  const writeSecret = await http('PUT', '/api/settings', { body: { auth_session_secret: 'a'.repeat(64) } });
  check('PUT /api/settings 不允许写 auth_session_secret',
    writeSecret.status === 400 && writeSecret.json && writeSecret.json.code === 'SENSITIVE_SETTING',
    `HTTP ${writeSecret.status}`);

  const badMode = await http('PUT', '/api/settings', { body: { listen_mode: 'wan' } });
  const badAllow = await http('PUT', '/api/settings', { body: { auth_ip_allow: '999.1.1.1' } });
  check('非法 listen_mode / 非法 IP 白名单被拒绝',
    badMode.status === 400 && badAllow.status === 400
      && badMode.json.code === 'BAD_LISTEN_MODE' && badAllow.json.code === 'BAD_IP_ALLOW',
    `listen_mode=${badMode.status}/${badMode.json && badMode.json.code} · ip_allow=${badAllow.status}/${badAllow.json && badAllow.json.code}`);

  /* ===== 2. 首次设置密码（本机，未启用登录） ===== */
  const setPwd = await http('POST', '/api/auth/password', {
    body: { new_password: PASSWORD1 }, cookie: ''
  });
  const s1 = authSettings();
  const hashParts = String(s1.auth_pass_hash || '').split('$');
  check('首次设置登录密码成功（本机免登录，仅写哈希）',
    setPwd.status === 200 && setPwd.data && setPwd.data.first_time === true,
    `HTTP ${setPwd.status} first_time=${setPwd.data && setPwd.data.first_time}`);
  check('哈希格式为 scrypt$16384$8$1$<16字节saltHex>$<64字节hashHex>',
    hashParts.length === 6 && hashParts[0] === 'scrypt'
      && hashParts[1] === '16384' && hashParts[2] === '8' && hashParts[3] === '1'
      && /^[0-9a-f]{32}$/.test(hashParts[4] || '') && /^[0-9a-f]{128}$/.test(hashParts[5] || ''),
    `段数=${hashParts.length} salt=${(hashParts[4] || '').length}字符 hash=${(hashParts[5] || '').length}字符`);
  const pwdLeakInSettings = Object.values(authSettings()).some((v) => String(v).includes(PASSWORD1));
  check('明文密码没有写进 settings 任何一项', !pwdLeakInSettings,
    pwdLeakInSettings ? '发现明文' : '仅存 scrypt 哈希');

  const st1 = await http('GET', '/api/auth/status');
  check('设置密码后 auth/status has_password=true，但仍未启用登录',
    st1.data && st1.data.has_password === true && st1.data.auth_enabled === false,
    `has_password=${st1.data && st1.data.has_password} enabled=${st1.data && st1.data.auth_enabled}`);

  /* ===== 3. 启用登录 + 会话 ===== */
  const enable = await http('PUT', '/api/settings', { body: { auth_enabled: '1' } });
  const s2 = authSettings();
  check('设密码后启用登录成功，并自动生成 32 字节会话密钥',
    enable.status === 200 && s2.auth_enabled === '1' && /^[0-9a-f]{64}$/.test(s2.auth_session_secret || ''),
    `HTTP ${enable.status} secretLen=${String(s2.auth_session_secret || '').length}`);

  cookie = '';
  const unauthGet = await http('GET', '/api/customers?pageSize=1');
  const unauthSettings = await http('GET', '/api/settings');
  const unauthWrite = await http('POST', '/api/customers', { body: { name: '不该被创建-125' } });
  check('未登录访问受保护接口 → 401（读、设置、写各一次）',
    unauthGet.status === 401 && unauthSettings.status === 401 && unauthWrite.status === 401
      && unauthGet.json.code === 'AUTH_REQUIRED',
    `GET customers=${unauthGet.status} · GET settings=${unauthSettings.status} · POST customers=${unauthWrite.status}`);
  const createdByAnon = withDb((db) => db.prepare(
    "SELECT COUNT(*) AS n FROM customers WHERE name = '不该被创建-125'"
  ).get().n);
  check('未登录的写请求没有落库', createdByAnon === 0, `写入行数=${createdByAnon}`);

  const healthWhenOn = await http('GET', '/api/health');
  const statusWhenOn = await http('GET', '/api/auth/status');
  const indexWhenOn = await http('GET', '/index.html');
  check('health / auth/status / 静态文件在启用登录后仍可访问',
    healthWhenOn.status === 200 && statusWhenOn.status === 200 && indexWhenOn.status === 200,
    `health=${healthWhenOn.status} status=${statusWhenOn.status} index=${indexWhenOn.status}`);

  /* 从干净计数开始 */
  forceSetting('auth_fail_state', '{}');
  const wrong1 = await login(PASSWORD_WRONG);
  const stateAfterWrong = JSON.parse(authSettings().auth_fail_state || '{}');
  const ipKey = Object.keys(stateAfterWrong)[0];
  check('错误密码登录 → 401，并提示剩余尝试次数',
    wrong1.status === 401 && wrong1.json.code === 'AUTH_FAILED'
      && /再错 4 次/.test(wrong1.json.message || ''),
    `HTTP ${wrong1.status} · ${wrong1.json && wrong1.json.message}`);
  check('失败计数写入 auth_fail_state（按 IP 记 n / until）',
    !!ipKey && Number(stateAfterWrong[ipKey].n) === 1,
    `IP=${ipKey} n=${stateAfterWrong[ipKey] && stateAfterWrong[ipKey].n}`);

  const okLogin = await login(PASSWORD1);
  const setCookieLine = (okLogin.setCookie || []).find((x) => x.startsWith('crm_session=')) || '';
  check('正确密码登录成功并下发 crm_session Cookie',
    okLogin.status === 200 && !!setCookieLine && okLogin.data.logged_in === true,
    `HTTP ${okLogin.status} · Cookie=${setCookieLine ? '有' : '无'}`);
  check('Cookie 属性齐全：HttpOnly / SameSite=Lax / Path=/ / Max-Age=2592000',
    /HttpOnly/i.test(setCookieLine) && /SameSite=Lax/i.test(setCookieLine)
      && /Path=\//.test(setCookieLine) && new RegExp(`Max-Age=${SESSION_TTL}`).test(setCookieLine),
    setCookieLine.replace(/crm_session=[^;]+/, 'crm_session=<略>'));
  const cookieValue = setCookieLine.split(';')[0].replace('crm_session=', '');
  const dot = cookieValue.lastIndexOf('.');
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(cookieValue.slice(0, dot), 'base64url').toString('utf8'));
  } catch (_) { payload = null; }
  const expDelta = payload ? Math.abs(Number(payload.exp) - (Math.floor(Date.now() / 1000) + SESSION_TTL)) : 9999;
  check('Cookie 结构为 base64url(payload).64位hex，payload={u, exp} 且 30 天有效',
    dot > 0 && /^[0-9a-f]{64}$/.test(cookieValue.slice(dot + 1))
      && payload && payload.u === 'admin' && expDelta <= 30,
    `payload.u=${payload && payload.u} · exp 偏差=${expDelta} 秒`);

  const authGet = await http('GET', '/api/customers?pageSize=1');
  const authStatus = await http('GET', '/api/auth/status');
  check('携带 Cookie 访问受保护接口 → 200',
    authGet.status === 200, `HTTP ${authGet.status}`);
  check('auth/status 显示已登录用户名 + 最近登录 IP / 时间',
    authStatus.data && authStatus.data.logged_in === true && authStatus.data.username === 'admin'
      && authStatus.data.last_login && authStatus.data.last_login.ip === '127.0.0.1'
      && !!authStatus.data.last_login.at,
    `user=${authStatus.data && authStatus.data.username} last=${authStatus.data && JSON.stringify(authStatus.data.last_login)}`);
  check('登录成功清零该 IP 的失败计数',
    JSON.parse(authSettings().auth_fail_state || '{}')[ipKey] === undefined,
    `auth_fail_state=${authSettings().auth_fail_state}`);

  /* ===== 4. 连错 5 次锁定 15 分钟 ===== */
  forceSetting('auth_fail_state', '{}');
  cookie = '';
  const attempts = [];
  for (let i = 0; i < 5; i++) {
    const r = await login(PASSWORD_WRONG);
    attempts.push(r.status);
  }
  check('同一 IP 连续 5 次密码错误 → 前 4 次 401、第 5 次 423 锁定',
    attempts.slice(0, 4).every((x) => x === 401) && attempts[4] === 423,
    `状态码序列=${attempts.join(',')}`);
  const lockState = await http('GET', '/api/auth/status');
  check('锁定后 auth/status 返回剩余锁定时间（>0 秒）',
    lockState.data && lockState.data.lock && lockState.data.lock.locked === true
      && lockState.data.lock.remaining_sec > 0,
    `remaining_sec=${lockState.data && lockState.data.lock && lockState.data.lock.remaining_sec}`);
  const correctWhileLocked = await login(PASSWORD1);
  check('锁定期间即使密码正确也返回 423（不提前解锁）',
    correctWhileLocked.status === 423 && correctWhileLocked.json.code === 'AUTH_LOCKED'
      && /剩余/.test(correctWhileLocked.json.message || ''),
    `HTTP ${correctWhileLocked.status} · ${correctWhileLocked.json && correctWhileLocked.json.message}`);
  const stateLocked = JSON.parse(authSettings().auth_fail_state || '{}');
  const lockEntry = stateLocked[ipKey] || {};
  check('auth_fail_state 记录 n≥5 且 until 为未来时间戳',
    Number(lockEntry.n) >= 5 && Number(lockEntry.until) > Math.floor(Date.now() / 1000),
    `n=${lockEntry.n} until=${lockEntry.until}`);

  forceSetting('auth_fail_state', '{}');   // 测试专用：解除锁定，继续后面的用例
  const afterUnlock = await login(PASSWORD1);
  check('锁定解除后正确密码可正常登录', afterUnlock.status === 200, `HTTP ${afterUnlock.status}`);

  /* ===== 5. 退出登录 ===== */
  const logout = await http('POST', '/api/auth/logout', { body: {} });
  check('退出登录返回 200 并下发清空 Cookie（Max-Age=0）',
    logout.status === 200 && (logout.setCookie || []).some((c) => /^crm_session=;/.test(c) && /Max-Age=0/.test(c)),
    `HTTP ${logout.status}`);
  /* 浏览器收到 Max-Age=0 后会丢弃 Cookie；此后的请求自然回到未登录 */
  cookie = '';
  const afterLogout = await http('GET', '/api/customers?pageSize=1');
  check('退出后（浏览器已丢弃 Cookie）访问受保护接口 → 401',
    afterLogout.status === 401 && afterLogout.json.code === 'AUTH_REQUIRED',
    `HTTP ${afterLogout.status}`);

  /* ===== 6. 修改密码：旧会话 / 旧密码全部失效 ===== */
  cookie = '';
  const relogin = await login(PASSWORD1);
  const hashBefore = authSettings().auth_pass_hash;
  const secretBefore = authSettings().auth_session_secret;
  const cookieBeforeChange = cookie;
  check('重新登录成功，准备改密', relogin.status === 200, `HTTP ${relogin.status}`);

  const wrongOld = await http('POST', '/api/auth/password', {
    body: { old_password: PASSWORD_WRONG, new_password: PASSWORD2 }
  });
  const shortPwd = await http('POST', '/api/auth/password', {
    body: { old_password: PASSWORD1, new_password: '12345' }
  });
  check('改密必须验证旧密码（错旧密码 → 401；新密码 <6 位 → 400）',
    wrongOld.status === 401 && wrongOld.json.code === 'INVALID_OLD_PASSWORD'
      && shortPwd.status === 400 && shortPwd.json.code === 'PASSWORD_TOO_SHORT',
    `旧密码错=${wrongOld.status} · 新密码短=${shortPwd.status}`);

  const change = await http('POST', '/api/auth/password', {
    body: { old_password: PASSWORD1, new_password: PASSWORD2 }
  });
  const s3 = authSettings();
  check('旧密码正确时改密成功，并提示需要重新登录',
    change.status === 200 && change.data && change.data.relogin === true,
    `HTTP ${change.status} relogin=${change.data && change.data.relogin}`);
  check('改密后密码哈希已变化（新密码重新 scrypt 加盐）',
    s3.auth_pass_hash && s3.auth_pass_hash !== hashBefore,
    `hash 前 12 位=${String(s3.auth_pass_hash).slice(0, 12)}…`);
  check('改密后会话密钥已轮换（旧会话全部失效）',
    s3.auth_session_secret && s3.auth_session_secret !== secretBefore
      && /^[0-9a-f]{64}$/.test(s3.auth_session_secret),
    `secret 已变化=${s3.auth_session_secret !== secretBefore}`);

  const staleCookie = await http('GET', '/api/customers?pageSize=1', { cookie: cookieBeforeChange });
  check('改密后旧 Cookie 立即失效（401）',
    staleCookie.status === 401, `HTTP ${staleCookie.status}`);
  cookie = '';
  const oldPwdLogin = await login(PASSWORD1);
  check('旧密码不能再登录（401）',
    oldPwdLogin.status === 401, `HTTP ${oldPwdLogin.status}`);
  const newPwdLogin = await login(PASSWORD2);
  check('新密码可以登录（200）', newPwdLogin.status === 200, `HTTP ${newPwdLogin.status}`);

  /* ===== 7. IP 白名单 ===== */
  const allowSelf = await http('PUT', '/api/settings', {
    body: { auth_ip_allow: '127.0.0.1/32,::1' }
  });
  const selfStillOk = await http('GET', '/api/auth/status');
  check('白名单含本机地址时可正常访问',
    allowSelf.status === 200 && selfStillOk.status === 200,
    `保存=${allowSelf.status} status=${selfStillOk.status}`);

  const allowOther = await http('PUT', '/api/settings', { body: { auth_ip_allow: '10.9.9.9' } });
  const blockedGet = await http('GET', '/api/customers?pageSize=1');
  const blockedLoginOk = await login(PASSWORD2);
  const blockedLoginBad = await login(PASSWORD_WRONG);
  const blockedHealth = await http('GET', '/api/health');
  check('白名单不含本机时所有 /api/* → 403（含已登录会话）',
    allowOther.status === 200 && blockedGet.status === 403
      && blockedGet.json.code === 'IP_NOT_ALLOWED',
    `GET /api/customers=${blockedGet.status} code=${blockedGet.json && blockedGet.json.code}`);
  check('白名单 403 时不存在"密码对/错"的信息差（相同 code 与 message）',
    blockedLoginOk.status === 403 && blockedLoginBad.status === 403
      && blockedLoginOk.json.code === blockedLoginBad.json.code
      && blockedLoginOk.json.message === blockedLoginBad.json.message,
    `正确密码=${blockedLoginOk.status}/${blockedLoginOk.json.code} · 错误密码=${blockedLoginBad.status}/${blockedLoginBad.json.code}`);
  check('健康检查不受白名单影响（启动器 / 单实例探测仍可用）',
    blockedHealth.status === 200, `HTTP ${blockedHealth.status}`);

  forceSetting('auth_ip_allow', '');   // 测试专用：清空白名单，避免后续用例被挡住
  cookie = '';
  const afterAllowReset = await login(PASSWORD2);
  check('清空白名单后恢复正常访问', afterAllowReset.status === 200, `HTTP ${afterAllowReset.status}`);

  /* ===== 8. 监听范围落库 ===== */
  const toLan = await http('PUT', '/api/settings', { body: { listen_mode: 'lan' } });
  const stLan = await http('GET', '/api/auth/status');
  check('已设密码时切到 lan 成功，接口返回 restart_required=true',
    toLan.status === 200 && toLan.data && toLan.data.restart_required === true,
    `HTTP ${toLan.status} restart_required=${toLan.data && toLan.data.restart_required}`);
  check('listen_mode 已落库为 lan',
    authSettings().listen_mode === 'lan', `listen_mode=${authSettings().listen_mode}`);
  check('进程未重启前仍只绑定 127.0.0.1，status 给出 restart_required 与 can_remote',
    stLan.data && stLan.data.bind_address === '127.0.0.1'
      && stLan.data.restart_required === true && stLan.data.can_remote === true,
    `bind=${stLan.data && stLan.data.bind_address} restart=${stLan.data && stLan.data.restart_required} can_remote=${stLan.data && stLan.data.can_remote}`);
  const backLocal = await http('PUT', '/api/settings', { body: { listen_mode: 'local' } });
  check('切回「仅本机」也返回 restart_required=true，并落库 local',
    backLocal.status === 200 && backLocal.data.restart_required === true
      && authSettings().listen_mode === 'local',
    `HTTP ${backLocal.status} listen_mode=${authSettings().listen_mode}`);

  /* ===== 9. 审计与脱敏 ===== */
  const logs = auditRows();
  const actions = new Set(logs.map((r) => r.action));
  check('审计含 login / login_failed / logout / password_change / listen_mode 五类动作',
    ['login', 'login_failed', 'logout', 'password_change', 'listen_mode'].every((a) => actions.has(a)),
    `实际动作=${[...actions].join(',')}`);
  const loginRow = logs.find((r) => r.action === 'login');
  check('登录成功审计含 IP 与 User-Agent，且不含密码',
    loginRow && /127\.0\.0\.1/.test(loginRow.summary)
      && /"ua"\s*:/.test(loginRow.detail || '')
      && !JSON.stringify(logs).includes(PASSWORD1) && !JSON.stringify(logs).includes(PASSWORD2),
    `summary=${loginRow && loginRow.summary}`);
  const listenRow = logs.filter((r) => r.action === 'listen_mode').pop();
  let listenDetail = {};
  try { listenDetail = JSON.parse((listenRow && listenRow.detail) || '{}'); } catch (_) {}
  check('监听范围审计记录 from / to 与"重启后生效"',
    listenRow && /重启后生效/.test(listenRow.summary)
      && listenDetail.from === 'lan' && listenDetail.to === 'local'
      && listenDetail.restart_required === true,
    `summary=${listenRow && listenRow.summary}`);
  const allLogText = JSON.stringify(logs);
  const secretNow = authSettings().auth_session_secret || '';
  check('审计中不含密码哈希 / 会话密钥 / Cookie 值',
    !allLogText.includes('scrypt$') && (!secretNow || !allLogText.includes(secretNow))
      && !allLogText.includes(cookieValue),
    '已扫描全部 auth 审计行');

  const statusText = JSON.stringify((await http('GET', '/api/auth/status')).json);
  const settingsWithAuth = await http('GET', '/api/settings');
  const statusApi = await http('GET', '/api/status');
  const hashNow = authSettings().auth_pass_hash || '';
  check('/api/auth/status 不泄漏哈希 / 会话密钥 / Cookie',
    !statusText.includes('scrypt$') && !statusText.includes(hashNow)
      && !statusText.includes(secretNow) && !statusText.includes(cookieValue),
    '已扫描响应全文');
  check('GET /api/settings 不含 auth_pass_hash / auth_session_secret / auth_fail_state',
    settingsWithAuth.status === 200 && settingsWithAuth.data && settingsWithAuth.data.settings
      && !('auth_pass_hash' in settingsWithAuth.data.settings)
      && !('auth_session_secret' in settingsWithAuth.data.settings)
      && !('auth_fail_state' in settingsWithAuth.data.settings)
      && !settingsWithAuth.text.includes(hashNow),
    `keys=${Object.keys((settingsWithAuth.data && settingsWithAuth.data.settings) || {}).length} 项`);
  check('GET /api/status 里的 settings 同样已脱敏',
    statusApi.status === 200 && statusApi.data && statusApi.data.settings
      && !('auth_pass_hash' in statusApi.data.settings)
      && !('auth_session_secret' in statusApi.data.settings),
    'auth_pass_hash / auth_session_secret 均未返回');

  /* ===== 10. 关闭登录 = 回到 1.24 默认状态 ===== */
  const disable = await http('PUT', '/api/settings', { body: { auth_enabled: '0' } });
  cookie = '';
  const afterDisable = await http('GET', '/api/customers?pageSize=1');
  const stOff = await http('GET', '/api/auth/status');
  check('关闭登录后无需会话即可访问，auth/status 回到未启用',
    disable.status === 200 && afterDisable.status === 200
      && stOff.data.auth_enabled === false && stOff.data.logged_in === false,
    `访问=${afterDisable.status} enabled=${stOff.data.auth_enabled}`);

  /* 为 reset-password 用例准备：重新启用登录（此时仍有密码） */
  const reEnable = await http('PUT', '/api/settings', { body: { auth_enabled: '1' } });
  check('重新启用登录（留给 reset-password 用例）', reEnable.status === 200, `HTTP ${reEnable.status}`);
}

async function runResetToolCheck() {
  const before = authSettings();
  const r = spawnSync(process.execPath, [RESET_TOOL], {
    cwd: TMP,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CRM_ROOT: TMP })
  });
  const after = authSettings();
  check('tools/reset-password.js 可正常执行（exit 0）',
    r.status === 0, `exit=${r.status}${r.status !== 0 ? ' · ' + (r.stderr || '').slice(-300) : ''}`);
  check('reset-password.js 清空密码哈希并关闭登录、作废旧会话',
    before.auth_enabled === '1' && before.auth_pass_hash !== ''
      && after.auth_pass_hash === '' && after.auth_enabled === '0' && after.auth_session_secret === '',
    `before enabled=${before.auth_enabled} hashLen=${String(before.auth_pass_hash).length} → after enabled=${after.auth_enabled} hashLen=${after.auth_pass_hash.length}`);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function summary() {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  try {
    fs.writeFileSync(
      path.join(REPO, '.fixtures', 'auth-125-result.json'),
      JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
      'utf8'
    );
  } catch (_) { /* 忽略 */ }
  return fail;
}

(async () => {
  let exitCode = 0;
  try {
    copyRuntime();
    await startServer();
    await runTests();
  } catch (e) {
    console.error('\n测试异常：', e && e.stack ? e.stack : e);
    exitCode = 1;
  } finally {
    await stopServer();
    if (TMP && fs.existsSync(DB_FILE)) {
      try { await runResetToolCheck(); } catch (e) {
        check('reset-password.js 用例未执行', false, e.message);
      }
    }
    const cleaned = cleanupFiles();
    check('隔离实例已停止，临时目录已删除（真实 data/ 未读写）', cleaned,
      cleaned ? `已删除 ${TMP}` : `仍存在 ${TMP}`);
  }
  if (summary()) exitCode = 1;
  process.exit(exitCode);
})();
