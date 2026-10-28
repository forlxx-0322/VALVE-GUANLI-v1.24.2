/**
 * 登录与会话服务 —— 1.25「登录 + 异地访问」
 *
 * 安全模型（详见 docs/方案/登录与异地访问_实施规格.md）：
 *   1. 默认不启用登录、只监听 127.0.0.1；异地访问是显式开启的能力。
 *   2. 密码只存 scrypt 加盐哈希：`scrypt$N$r$p$<saltHex>$<hashHex>`
 *      （node:crypto 内置，salt 16 字节随机，N=16384 r=8 p=1，keylen=64）。
 *   3. 会话是服务端签名 Cookie（`crm_session`），HttpOnly + SameSite=Lax + 30 天；
 *      值 = `<base64url(payload)>.<hmacSHA256 hex>`，payload = `{u, exp}`，密钥持久化在
 *      settings.auth_session_secret（32 字节 hex），重启不掉线。
 *   4. 防爆破：同一 IP 连续失败 5 次锁 15 分钟（状态存 settings.auth_fail_state JSON）。
 *   5. 可选 IP 白名单（逗号分隔 IP/CIDR，空 = 不限制）。
 *   6. 审计写 activity_logs（entity_type='auth'），**绝不写密码 / 哈希 / 密钥 / Cookie**。
 *
 * 本文件只做纯函数与服务逻辑，不直接发响应；HTTP 包装见 server/routes/auth.js。
 */

'use strict';

const crypto = require('node:crypto');
const { getSettings, now } = require('../db');
const { logActivity } = require('./crm');

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const SESSION_COOKIE = 'crm_session';
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;   // 30 天 = 2592000 秒
const LOCK_FAILS = 5;
const LOCK_SEC = 15 * 60;                     // 15 分钟

/** 只允许通过 PUT /api/settings 写入的登录相关设置项 */
const WRITABLE_AUTH_KEYS = ['auth_enabled', 'auth_user', 'listen_mode', 'auth_ip_allow'];

/** 这些设置项绝不允许通过接口回传或写入（哈希 / 密钥 / 锁定状态 / 预留 TOTP） */
const SECRET_SETTINGS = ['auth_pass_hash', 'auth_session_secret', 'auth_fail_state', 'auth_totp_secret'];

const LISTEN_MODES = ['local', 'lan', 'all'];
const LISTEN_LABEL = { local: '仅本机', lan: '局域网', all: '全部网卡' };

/* ------------------------------------------------------------------ */
/* 设置项读写                                                          */
/* ------------------------------------------------------------------ */

function readSettings(db) {
  return getSettings(db);
}

/** 写单个设置项（不存在则补一行，兼容极早期手工删过键的库） */
function setSetting(db, key, value) {
  const ts = now();
  const r = db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?')
    .run(String(value === null || value === undefined ? '' : value), ts, key);
  if (!r || !r.changes) {
    db.prepare('INSERT INTO settings (key, value, remark, updated_at) VALUES (?, ?, ?, ?)')
      .run(key, String(value === null || value === undefined ? '' : value), '登录与异地访问', ts);
  }
}

/** 过滤掉绝不可回传的设置项（哈希 / 会话密钥 / 锁定状态 / TOTP 预留） */
function publicSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (SECRET_SETTINGS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 密码：scrypt 加盐哈希                                                */
/* ------------------------------------------------------------------ */

/**
 * 生成密码哈希。
 * @param {string} password 明文（只在内存中出现，不落库、不写日志）
 * @returns {string} `scrypt$16384$8$1$<saltHex>$<hashHex>`
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), hash.toString('hex')].join('$');
}

/**
 * 校验密码（timingSafeEqual，避免按字节比较泄漏）。
 * 任何格式异常都按"不匹配"处理，不抛错。
 */
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1024 || N > 1048576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt;
  let want;
  try {
    salt = Buffer.from(parts[4], 'hex');
    want = Buffer.from(parts[5], 'hex');
  } catch (_) {
    return false;
  }
  if (!salt.length || !want.length) return false;

  let got;
  try {
    got = crypto.scryptSync(String(password), salt, want.length, {
      N, r, p, maxmem: Math.max(64 * 1024 * 1024, 128 * N * r + 1024 * 1024)
    });
  } catch (_) {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** 是否已设置过登录密码 */
function hasPassword(settings) {
  return /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/i.test(String((settings && settings.auth_pass_hash) || ''));
}

/* ------------------------------------------------------------------ */
/* 会话：HMAC-SHA256 签名 Cookie                                        */
/* ------------------------------------------------------------------ */

/** 生成 32 字节会话密钥（hex） */
function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/** 确保会话密钥存在；首次启用登录时调用并持久化 */
function ensureSessionSecret(db) {
  const s = readSettings(db);
  const current = String(s.auth_session_secret || '');
  if (/^[0-9a-f]{64}$/i.test(current)) return current;
  const secret = generateSessionSecret();
  setSetting(db, 'auth_session_secret', secret);
  return secret;
}

/** 轮换会话密钥：改密 / 改用户名后让所有旧会话立即失效 */
function rotateSessionSecret(db) {
  const secret = generateSessionSecret();
  setSetting(db, 'auth_session_secret', secret);
  return secret;
}

/** 签发会话值：`<base64url(payload)>.<hmacSHA256 hex>` */
function signSession(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', Buffer.from(String(secret), 'hex')).update(body).digest('hex');
  return body + '.' + sig;
}

/**
 * 校验会话值。
 * @returns {{u:string, exp:number}|null} 有效返回 payload，否则 null
 */
function verifySession(secret, value, expectedUser) {
  const raw = String(value || '');
  const secretHex = String(secret || '');
  if (!raw || !/^[0-9a-f]{64}$/i.test(secretHex)) return null;

  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  if (!/^[0-9a-f]{64}$/i.test(sig)) return null;

  let expect;
  try {
    expect = crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(body).digest('hex');
  } catch (_) {
    return null;
  }
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expect, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (String(payload.u || '') !== String(expectedUser || '')) return null;
  const exp = Number(payload.exp) || 0;
  if (exp <= Math.floor(Date.now() / 1000)) return null;
  return { u: String(payload.u), exp };
}

/** 构造会话 Cookie（30 天） */
function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

/** 构造清空 Cookie 的头（退出登录） */
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** 从请求里取某个 Cookie 的值（不依赖框架） */
function readCookie(req, name) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch (_) {
      return v;
    }
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 请求来源：IP / UA                                                    */
/* ------------------------------------------------------------------ */

/** 规范化 IP：去掉 IPv6 zone 与 IPv4-mapped 前缀 */
function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (!s) return '';
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return s.toLowerCase();
}

/** 请求来源 IP（服务端 socket 地址；本机访问可能是 ::1 或 127.0.0.1） */
function clientIp(req) {
  return normalizeIp((req && req.socket && req.socket.remoteAddress) || '');
}

/** 是否本机请求（用于"首次设置密码"这种只允许在本机做的操作） */
function isLocalIp(ip) {
  const s = normalizeIp(ip);
  return s === '127.0.0.1' || s === '::1';
}

/** 截断并清洗 User-Agent（审计里最多留 200 字符） */
function userAgent(req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  return ua.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* IP / CIDR 白名单                                                     */
/* ------------------------------------------------------------------ */

function ipv4Bytes(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x >= 0 && x <= 255) ? b : null;
}

function ipv6Words(s) {
  const text = String(s || '').toLowerCase();
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const expand = (part) => {
    if (!part) return [];
    const out = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const b = ipv4Bytes(g);
        if (!b) return null;
        out.push(((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16).toString(16));
      }
    }
    return out;
  };

  const head = expand(halves[0]);
  if (!head) return null;
  let words;
  if (halves.length === 2) {
    const tail = expand(halves[1]);
    if (!tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    words = head.concat(new Array(missing).fill('0'), tail);
  } else {
    if (head.length !== 8) return null;
    words = head;
  }
  return words.map((w) => parseInt(w, 16));
}

/** 把 IP 转成字节数组；非法返回 null */
function ipToBytes(ip) {
  const s = normalizeIp(ip);
  if (!s) return null;
  const v4 = ipv4Bytes(s);
  if (v4) return { version: 4, bytes: v4 };
  const words = ipv6Words(s);
  if (!words) return null;
  const bytes = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  return { version: 6, bytes };
}

function cidrMatch(target, net, prefix) {
  if (target.version !== net.version) return false;
  const maxBits = target.bytes.length * 8;
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false;
  let left = bits;
  for (let i = 0; left > 0; i++) {
    const take = Math.min(8, left);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((target.bytes[i] & mask) !== (net.bytes[i] & mask)) return false;
    left -= take;
  }
  return true;
}

/** 是否是合法的单 IP 或 CIDR（用于保存白名单时校验） */
function isValidIpOrCidr(entry) {
  const s = String(entry || '').trim();
  if (!s) return false;
  const pieces = s.split('/');
  if (pieces.length > 2) return false;
  const b = ipToBytes(pieces[0]);
  if (!b) return false;
  if (pieces.length === 1) return true;
  if (!/^\d{1,3}$/.test(pieces[1])) return false;
  return Number(pieces[1]) <= (b.version === 4 ? 32 : 128);
}

/** 是否命中白名单（空名单 = 不限制） */
function isIpAllowed(ip, allowStr) {
  const list = String(allowStr || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return true;

  const target = ipToBytes(ip);
  if (!target) return false;

  for (const entry of list) {
    const [addr, prefix] = entry.split('/');
    const net = ipToBytes(addr);
    if (!net || net.version !== target.version) continue;
    if (prefix === undefined) {
      if (net.bytes.every((b, i) => b === target.bytes[i])) return true;
    } else if (cidrMatch(target, net, prefix)) {
      return true;
    }
  }
  return false;
}

/** 把白名单字符串规范化（去空格、去空项、小写） */
function normalizeAllowList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}

/* ------------------------------------------------------------------ */
/* 失败计数与锁定                                                       */
/* ------------------------------------------------------------------ */

/** 读取失败状态对象（损坏按空处理） */
function readFailState(db) {
  let parsed = {};
  try {
    parsed = JSON.parse(String(readSettings(db).auth_fail_state || '{}'));
  } catch (_) {
    parsed = {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

function writeFailState(db, state) {
  const nowSec = Math.floor(Date.now() / 1000);
  const clean = {};
  for (const [ip, entry] of Object.entries(state || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const n = Math.max(0, Number(entry.n) || 0);
    const until = Math.max(0, Number(entry.until) || 0);
    /* 只保留还有计数或仍在锁定期内的记录，避免 JSON 无限膨胀 */
    if (!n && until <= nowSec) continue;
    clean[ip] = { n, until };
  }
  setSetting(db, 'auth_fail_state', JSON.stringify(clean));
  return clean;
}

/** 当前 IP 的锁定剩余秒数（0 = 未锁定） */
function lockRemainingSec(db, ip) {
  const entry = readFailState(db)[normalizeIp(ip)];
  if (!entry) return 0;
  const until = Number(entry.until) || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  return until > nowSec ? until - nowSec : 0;
}

/** 记录一次失败，返回 { count, locked, remaining } */
function recordFailure(db, ip) {
  const key = normalizeIp(ip);
  const state = readFailState(db);
  const nowSec = Math.floor(Date.now() / 1000);
  let entry = state[key];
  /* 上一轮锁定已过期：重新开始计数 */
  if (!entry || (Number(entry.until) || 0) <= nowSec && (Number(entry.until) || 0) > 0) {
    entry = { n: 0, until: 0 };
  }
  entry.n = (Number(entry.n) || 0) + 1;
  if (entry.n >= LOCK_FAILS) entry.until = nowSec + LOCK_SEC;
  state[key] = entry;
  writeFailState(db, state);
  return {
    count: entry.n,
    locked: entry.until > nowSec,
    remaining: entry.until > nowSec ? entry.until - nowSec : 0,
    until: entry.until || 0
  };
}

/** 登录成功后清零该 IP 的失败计数 */
function clearFailures(db, ip) {
  const key = normalizeIp(ip);
  const state = readFailState(db);
  if (!state[key]) return;
  delete state[key];
  writeFailState(db, state);
}

/* ------------------------------------------------------------------ */
/* 审计                                                                */
/* ------------------------------------------------------------------ */

/**
 * 写登录相关审计（entity_type = 'auth'）。
 * 约定：summary 里只出现用户名、IP、UA、结果；detail 用结构化字段。
 * **绝不传密码 / 哈希 / 密钥 / Cookie 值。**
 */
function audit(db, action, summary, detail) {
  try {
    logActivity(db, 'auth', null, action, summary, detail || null);
  } catch (_) {
    /* 审计失败不影响主流程 */
  }
}

/** 最近一次登录成功的来源（从审计日志里取，不额外加设置项） */
function lastLogin(db) {
  try {
    const row = db.prepare(
      `SELECT created_at, summary, detail FROM activity_logs
       WHERE entity_type = 'auth' AND action = 'login'
       ORDER BY id DESC LIMIT 1`
    ).get();
    if (!row) return null;
    let detail = {};
    try {
      detail = JSON.parse(row.detail || '{}');
    } catch (_) {
      detail = {};
    }
    return {
      at: row.created_at,
      ip: detail.ip || '',
      ua: detail.ua || '',
      username: detail.username || ''
    };
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 监听范围                                                            */
/* ------------------------------------------------------------------ */

function normalizeListenMode(mode) {
  return LISTEN_MODES.includes(String(mode || '')) ? String(mode) : 'local';
}

/** 监听地址：local → 127.0.0.1；lan / all → 0.0.0.0 */
function bindAddressOf(mode) {
  return normalizeListenMode(mode) === 'local' ? '127.0.0.1' : '0.0.0.0';
}

function listenModeLabel(mode) {
  return LISTEN_LABEL[normalizeListenMode(mode)] || LISTEN_LABEL.local;
}

/* ------------------------------------------------------------------ */
/* 请求守卫（供 server.js 的鉴权中间件调用）                             */
/* ------------------------------------------------------------------ */

/**
 * 判定一个 /api 请求是否被拦截。
 * @returns {null} 放行；`{status, code, message}` 拦截
 */
function guard(db, req, pathname) {
  if (!String(pathname || '').startsWith('/api/')) return null;
  /* 健康检查永远放行：启动器 / 单实例探测 / 监控都靠它 */
  if (pathname === '/api/health') return null;

  const s = readSettings(db);

  /* 1. IP 白名单优先于一切：不在名单内直接 403，
        且不区分"密码对/错"，避免借错误信息判断密码。 */
  if (s.auth_ip_allow && !isIpAllowed(clientIp(req), s.auth_ip_allow)) {
    return { status: 403, code: 'IP_NOT_ALLOWED', message: '当前 IP 不在允许访问的范围内，请在设置中调整 IP 白名单' };
  }

  /* 2. 未启用登录：行为与 1.24 完全一致 */
  if (s.auth_enabled !== '1') return null;

  /* 3. 登录、状态查询、退出本身不需要会话
        （退出永远允许，这样即使会话已失效也能把浏览器里的 Cookie 清掉） */
  if (pathname === '/api/auth/login' || pathname === '/api/auth/status'
    || pathname === '/api/auth/logout') return null;

  /* 4. 启用登录但没有密码（理论上写不进来）——按未启用处理，避免把自己锁死 */
  if (!hasPassword(s)) return null;

  const session = verifySession(s.auth_session_secret, readCookie(req, SESSION_COOKIE), s.auth_user || 'admin');
  if (!session) {
    return { status: 401, code: 'AUTH_REQUIRED', message: '登录状态已失效，请重新登录' };
  }
  return null;
}

/** 为已登录会话续期（每次请求不续期，保持 30 天固定 TTL 简单可靠） */
function issueSession(db, username) {
  const secret = ensureSessionSecret(db);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  return {
    cookie: sessionCookie(signSession(secret, { u: String(username), exp })),
    exp,
    maxAge: SESSION_TTL_SEC
  };
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

/**
 * 登录与异地访问状态（不含哈希 / 密钥 / 锁定细节以外的任何秘密）。
 * @param {object} opts { bindAddress }
 */
function authStatus(db, req, opts) {
  const s = readSettings(db);
  const enabled = s.auth_enabled === '1';
  const username = s.auth_user || 'admin';
  const passSet = hasPassword(s);
  const session = enabled && passSet
    ? verifySession(s.auth_session_secret, readCookie(req, SESSION_COOKIE), username)
    : null;
  const ip = clientIp(req);
  const lockSec = enabled ? lockRemainingSec(db, ip) : 0;
  const mode = normalizeListenMode(s.listen_mode);
  const bindAddress = (opts && opts.bindAddress) || bindAddressOf(mode);

  return {
    auth_enabled: enabled,
    logged_in: !!session,
    username: session ? session.u : '',
    has_password: passSet,
    listen_mode: mode,
    bind_address: bindAddress,
    /* 配置层面是否具备异地访问条件（已设密码 + 已启用登录 + 允许非本机监听）；
       是否已经重启生效看 restart_required。 */
    can_remote: passSet && enabled && mode !== 'local',
    restart_required: (mode === 'local') !== (bindAddress === '127.0.0.1'),
    ip,
    last_login: lastLogin(db),
    lock: {
      locked: lockSec > 0,
      remaining_sec: lockSec,
      until: lockSec > 0 ? Math.floor(Date.now() / 1000) + lockSec : 0
    }
  };
}

/* ------------------------------------------------------------------ */
/* PUT /api/settings 的登录字段校验                                     */
/* ------------------------------------------------------------------ */

/**
 * 校验并整理 PUT /api/settings 的补丁。
 * @returns {{reject:{status,code,message}}|{patch:object, listenChanged:boolean,
 *            restartRequired:boolean, warning:string}}
 */
function prepareSettingsUpdate(db, payload) {
  const patch = {};
  const input = payload && typeof payload === 'object' ? payload : {};

  /* 敏感项一律拒绝：密码只能走 /api/auth/password，密钥与锁定状态由服务端维护 */
  const blocked = SECRET_SETTINGS.filter((k) => Object.prototype.hasOwnProperty.call(input, k));
  if (blocked.length) {
    return {
      reject: {
        status: 400,
        code: 'SENSITIVE_SETTING',
        message: `以下设置项不允许通过此接口修改：${blocked.join('、')}`
      }
    };
  }

  for (const [k, v] of Object.entries(input)) patch[k] = v;

  const s = readSettings(db);
  const currentMode = normalizeListenMode(s.listen_mode);
  const currentEnabled = s.auth_enabled === '1';

  /* ---- auth_enabled ---- */
  let enabled = currentEnabled;
  if (Object.prototype.hasOwnProperty.call(patch, 'auth_enabled')) {
    const v = String(patch.auth_enabled === true ? '1' : patch.auth_enabled === false ? '0' : patch.auth_enabled).trim();
    if (v !== '0' && v !== '1') {
      return { reject: { status: 400, code: 'BAD_AUTH_ENABLED', message: 'auth_enabled 只能是 0 或 1' } };
    }
    patch.auth_enabled = v;
    enabled = v === '1';
    if (enabled && !hasPassword(s)) {
      return {
        reject: {
          status: 400,
          code: 'NO_PASSWORD',
          message: '还没有设置登录密码，不能启用登录。请先在「登录与异地访问」里设置密码。'
        }
      };
    }
    /* 首次启用：生成并持久化会话密钥（2 行设置都走同一个事务外写入，无需迁移） */
    if (enabled && !/^[0-9a-f]{64}$/i.test(String(s.auth_session_secret || ''))) {
      patch.auth_session_secret = generateSessionSecret();
    }
  }

  /* ---- auth_user ---- */
  if (Object.prototype.hasOwnProperty.call(patch, 'auth_user')) {
    const v = String(patch.auth_user === null || patch.auth_user === undefined ? '' : patch.auth_user).trim();
    if (!v) {
      return { reject: { status: 400, code: 'BAD_AUTH_USER', message: '登录用户名不能为空' } };
    }
    if (v.length > 64 || /[\u0000-\u001f\u007f]/.test(v)) {
      return { reject: { status: 400, code: 'BAD_AUTH_USER', message: '登录用户名不能超过 64 个字符，也不能包含控制字符' } };
    }
    patch.auth_user = v;
    /* 换用户名后旧会话里的 u 不再匹配，自动失效（前端会提示重新登录） */
  }

  /* ---- listen_mode ---- */
  let listenChanged = false;
  if (Object.prototype.hasOwnProperty.call(patch, 'listen_mode')) {
    const v = String(patch.listen_mode === null || patch.listen_mode === undefined ? '' : patch.listen_mode).trim();
    if (!LISTEN_MODES.includes(v)) {
      return { reject: { status: 400, code: 'BAD_LISTEN_MODE', message: '监听范围只能是 local / lan / all' } };
    }
    if (v !== 'local' && !hasPassword(s)) {
      return {
        reject: {
          status: 400,
          code: 'NO_PASSWORD',
          message: '开启局域网 / 异地访问前必须先在「登录与异地访问」里设置登录密码（避免客户资料裸奔）'
        }
      };
    }
    patch.listen_mode = v;
    listenChanged = v !== currentMode;
  }

  /* ---- auth_ip_allow ---- */
  if (Object.prototype.hasOwnProperty.call(patch, 'auth_ip_allow')) {
    const raw = String(patch.auth_ip_allow === null || patch.auth_ip_allow === undefined ? '' : patch.auth_ip_allow);
    if (raw.length > 500) {
      return { reject: { status: 400, code: 'BAD_IP_ALLOW', message: 'IP 白名单太长（最多 500 个字符）' } };
    }
    const items = raw.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = items.filter((x) => !isValidIpOrCidr(x));
    if (bad.length) {
      return {
        reject: {
          status: 400,
          code: 'BAD_IP_ALLOW',
          message: `IP 白名单里有无法识别的地址：${bad.join('、')}（支持 1.2.3.4 或 100.64.0.0/10 这种写法）`
        }
      };
    }
    patch.auth_ip_allow = normalizeAllowList(raw);
  }

  const effectiveMode = Object.prototype.hasOwnProperty.call(patch, 'listen_mode')
    ? patch.listen_mode : currentMode;

  let warning = '';
  if (effectiveMode !== 'local' && !enabled) {
    warning = '已允许局域网 / 异地访问，但登录尚未启用：任何能连上本机的人都能读写客户资料，强烈建议同时开启登录。';
  }

  return {
    patch,
    listenChanged,
    restartRequired: listenChanged,
    warning
  };
}

/* ------------------------------------------------------------------ */

module.exports = {
  SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN,
  SESSION_COOKIE, SESSION_TTL_SEC, LOCK_FAILS, LOCK_SEC,
  LISTEN_MODES, LISTEN_LABEL, WRITABLE_AUTH_KEYS, SECRET_SETTINGS,
  readSettings, setSetting, publicSettings,
  hashPassword, verifyPassword, hasPassword,
  generateSessionSecret, ensureSessionSecret, rotateSessionSecret,
  signSession, verifySession, sessionCookie, clearSessionCookie, readCookie,
  normalizeIp, clientIp, isLocalIp, userAgent,
  ipToBytes, cidrMatch, isValidIpOrCidr, isIpAllowed, normalizeAllowList,
  readFailState, writeFailState, lockRemainingSec, recordFailure, clearFailures,
  audit, lastLogin,
  normalizeListenMode, bindAddressOf, listenModeLabel,
  guard, issueSession, authStatus, prepareSettingsUpdate
};
