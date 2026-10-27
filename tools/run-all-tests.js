/**
 * 一键运行全部测试套件，汇总各套件通过/失败数量。
 *
 * 运行顺序与依赖（很关键）：
 *   1. 先清空业务数据（node tools/cleanup-test-data.js --all），让全部套件从空库起跑；
 *      否则各套件按累计数据算出的精确断言（如"设计院 0 家""乌鲁木齐 60 家"）会误判。
 *   2. 阶段七「接口/性能/文件」套件内含备份恢复用例，恢复完会重启服务，务必排在
 *      「浏览器」套件之前，且两者之间不需要人工干预。
 *   3. 阶段一套件会调用优雅停机接口关掉服务，必须放在最末。
 *
 * 用法：
 *   node tools/run-all-tests.js            自动清库后跑全套（默认：在沙箱副本里跑，不碰真实 data/）
 *   node tools/run-all-tests.js --no-clean 跳过清库（沿用当前数据）
 *   node tools/run-all-tests.js --in-place 就地跑（**会清空本目录 data/**，仅供空库/测试库使用）
 *
 * 为什么要沙箱：1.20 之后吃过一次亏 —— 测试直接在真实数据目录里跑，清库把使用者的数据清掉了。
 * 现在默认把 server/ web/ tools/ 复制到 .fixtures/sandbox/，在里面用空库、独立端口（8955）跑，
 * 真实 data/ 全程只读不碰。只有显式加 --in-place 才会就地跑。
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const IN_PLACE = ARGS.includes('--in-place');
const SANDBOX_PORT = String(process.env.CRM_SANDBOX_PORT || 8955);
const SANDBOX = path.join(ROOT, '.fixtures', 'sandbox');
const BASE = process.env.CRM_TEST_BASE
  || (IN_PLACE ? 'http://127.0.0.1:' + (process.env.CRM_PORT || 8899) : 'http://127.0.0.1:' + SANDBOX_PORT);

/**
 * 沙箱是空库，但有两类**静态参考数据**必须和真实环境一致，否则地图/归属套件会假失败：
 *   - `region`（行政区划，由 tools/fetch-map-data.js 首次联网抓取后写入真实库）
 *   - 地图 GeoJSON 在 web/vendor/map/ 里，已随代码复制，不需要额外处理
 * 这里只从真实库**只读复制 region 一张表**，不读任何客户/项目等业务数据。
 */
function seedSandboxDb() {
  const sandboxData = path.join(SANDBOX, 'data');
  const dbFile = path.join(sandboxData, 'crm.db');
  const realDbFile = path.join(ROOT, 'data', 'crm.db');
  const dbMod = require(path.join(SANDBOX, 'server', 'db.js'));
  const info = dbMod.initDatabase({
    dataDir: sandboxData,
    dbFile,
    backupDir: path.join(sandboxData, 'backups')
  });

  let copied = 0;
  if (fs.existsSync(realDbFile)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const src = new DatabaseSync(realDbFile, { readOnly: true });
      const rows = src.prepare('SELECT * FROM region').all();
      src.close();
      if (rows.length) {
        const cols = info.db.prepare('PRAGMA table_info(region)').all().map((c) => c.name);
        const ins = info.db.prepare(
          `INSERT OR REPLACE INTO region (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        );
        info.db.exec('BEGIN');
        for (const row of rows) {
          try {
            ins.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
            copied++;
          } catch (_) { /* 单行异常忽略 */ }
        }
        info.db.exec('COMMIT');
      }
    } catch (e) {
      console.log(`（提示：从真实库复制行政区划失败：${e.message}）`);
    }
  }
  dbMod.closeDatabase(info.db);
  console.log(copied
    ? `沙箱库已建好，并从真实库复制行政区划 ${copied} 行（只复制参考数据）`
    : '沙箱库已建好（未找到行政区划数据；地图/归属套件可能失败，先跑一次 tools/fetch-map-data.js）');
}

/**
 * 沙箱模式：把代码复制到 .fixtures/sandbox/（不含 data、.git、测试产物），
 * 在里面用空库跑一遍内层 runner。真实 data/ 一个字节都不动。
 */
function runInSandbox() {
  console.log('================ 沙箱模式 ================');
  console.log(`代码复制到：${SANDBOX}`);
  console.log(`数据目录：${path.join(SANDBOX, 'data')}（空库）   端口：${SANDBOX_PORT}`);
  console.log('真实 data/ 不会被执行任何写操作。\n');

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  const SKIP = new Set(['.git', 'data', '.fixtures', '.shots', 'node_modules', '.wbhome',
    'workbuddy-bridge', '.npm-cache']);
  for (const name of fs.readdirSync(ROOT)) {
    if (SKIP.has(name)) continue;
    const src = path.join(ROOT, name);
    const dst = path.join(SANDBOX, name);
    fs.cpSync(src, dst, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git${path.sep}`) });
  }
  fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
  /* 套件会把结果 JSON / 临时 xlsx 写进 ROOT/.fixtures，沙箱里也要有这一层 */
  fs.mkdirSync(path.join(SANDBOX, '.fixtures'), { recursive: true });

  seedSandboxDb();

  /* 验收套件要读 .fixtures 里的图片/PDF/xlsx 夹具，沙箱里用生成器现做一份 */
  try {
    const mk = path.join(SANDBOX, 'tools', 'make-fixtures.js');
    if (fs.existsSync(mk)) {
      const r = spawnSync(process.execPath, [mk], { cwd: SANDBOX, stdio: 'ignore' });
      console.log(r.status === 0 ? '沙箱测试夹具已生成（PNG / PDF / xlsx / csv）'
        : `（提示：夹具生成失败，退出码 ${r.status}）`);
    }
  } catch (_) { /* 忽略 */ }

  const r = spawnSync(process.execPath, [path.join(SANDBOX, 'tools', 'run-all-tests.js'),
    '--in-place', '--no-clean'],
  {
    cwd: SANDBOX,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      CRM_TEST_BASE: `http://127.0.0.1:${SANDBOX_PORT}`,
      CRM_PORT: SANDBOX_PORT
    })
  });

  /* 把结果文件带回来，方便在外层 .fixtures 里翻看 */
  try {
    const inner = path.join(SANDBOX, '.fixtures');
    if (fs.existsSync(inner)) {
      for (const f of fs.readdirSync(inner)) {
        if (/\.json$|\.log$/.test(f)) {
          fs.copyFileSync(path.join(inner, f), path.join(ROOT, '.fixtures', 'sandbox-' + f));
        }
      }
    }
  } catch (_) { /* 忽略 */ }

  return r.status === null ? 1 : r.status;
}

if (!IN_PLACE) {
  process.exit(runInSandbox());
}

/* ================= 就地模式（沙箱内的内层 runner 走这里） ================= */

/* 依赖服务的套件（按阶段顺序），阶段一放最后（它会关停服务） */
const SUITES = [
  ['阶段二 · 接口', 'tools/test-phase2-api.js'],
  ['阶段二 · 数据契约', 'tools/test-phase2-ui-contract.js'],
  ['阶段二 · 界面交互', 'tools/test-phase2-ui-interaction.js'],
  ['阶段三 · 接口', 'tools/test-phase3-api.js'],
  ['阶段三 · 界面交互', 'tools/test-phase3-ui-interaction.js'],
  /* 1.23：客户精简专项（一客户一项目 / 客户编号 / 主联系人同步 / 回访周期 / 财务口径） */
  ['客户精简专项（1.23）', 'tools/test-customer-123.js'],
  ['阶段四 · 接口', 'tools/test-phase4-api.js'],
  ['阶段四 · 界面交互', 'tools/test-phase4-ui-interaction.js'],
  ['阶段五 · 接口', 'tools/test-phase5-api.js'],
  ['阶段五 · 界面交互', 'tools/test-phase5-ui-interaction.js'],
  /* 1.22：地图模块与 3 个地图套件下线（阶段六 / 地图客户点 / 地址归属与地图显示），
     改为「客户分布统计 + 收入报表 + 成本台账」套件 */
  ['数据库结构迁移', 'tools/test-migration.js'],
  ['数据库迁移（全面）', 'tools/test-migration-full.js'],
  ['统计报表与成本台账（1.22）', 'tools/test-stats-122.js'],
  ['归属地州历史数据纠正', 'tools/test-region-legacy-fix.js'],
  ['归属地州下拉取值', 'tools/test-region-select.js'],
  ['客户详细地址保存', 'tools/test-customer-address.js'],
  ['客户录入路径（含查重面板）', 'tools/test-customer-create-crash.js'],
  ['批量导入模板内容', 'tools/test-import-template.js'],
  ['批量导入客户（接口）', 'tools/test-import-customers.js'],
  ['批量导入客户（界面）', 'tools/test-import-ui.js'],
  /* 1.11 新增 */
  ['跟进提醒（界面）', 'tools/test-remind-ui.js'],
  ['邮件提醒（SMTP）', 'tools/test-notify-email.js'],
  ['提醒与偏好设置页', 'tools/test-prefs-ui.js'],
  /* 1.21：招标采集与报价单两个模块整体移除，对应套件一并下线 */
  ['阶段七 · 最终验收（接口/性能/文件）', 'tools/test-acceptance-core.js'],
  ['阶段七 · 最终验收（浏览器）', 'tools/test-acceptance-browser.js'],
  ['阶段一 · 环境与服务（会关停服务，放最后）', 'tools/test-phase1.js']
];

/** 从套件输出里解析「通过 N / M」 */
function parseTotals(out) {
  const patterns = [
    /通过\s*(\d+)\s*\/\s*(\d+)/g,
    /(\d+)\s*\/\s*(\d+)\s*通过/g,
    /合计[：:]\s*(\d+)\s*\/\s*(\d+)/g
  ];
  let pass = 0; let total = 0; let found = false;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(out))) {
      found = true;
      pass = Math.max(pass, Number(m[1]));
      total = Math.max(total, Number(m[2]));
    }
  }
  return found ? { pass, total } : null;
}

async function healthOk() {
  try {
    const r = await fetch(BASE + '/api/health');
    if (!r.ok) return false;
    const j = await r.json();
    /* 必须确认是本软件的服务，避免把同端口的其它程序当成它
       （signature 形如 crm-bjxt/1，带版本号，所以用前缀匹配） */
    return !!(j && j.ok === true && j.data && typeof j.data.app === 'string'
      && j.data.app.startsWith('crm-bjxt'));
  } catch (_) { return false; }
}

/** 端口上是否还有进程在监听 */
function portBusy(port) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`
    ], { encoding: 'utf8', timeout: 8000 });
    return Number(String(out).trim()) > 0;
  } catch (_) { return false; }
}

/**
 * 确保服务在线。
 *
 * 为什么需要耐心等待：阶段七的「备份恢复」用例会让服务以退出码 4 主动重启，
 * 紧接着的套件如果在这个窗口内开跑，请求就会 fetch failed。
 * 因此这里先等端口彻底空闲（避免新实例被单实例锁挡掉），再拉起并等健康检查通过。
 */
async function ensureServer() {
  const port = (BASE.match(/:(\d+)/) || [])[1] || '8899';

  /* 已经在跑就直接用 */
  if (await healthOk()) return true;

  /* 先等旧进程把端口让出来（最多 15 秒）；期间若它自己回来了就直接用 */
  for (let i = 0; i < 30; i++) {
    if (await healthOk()) return true;
    if (!portBusy(port)) break;
    await new Promise((s) => setTimeout(s, 500));
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { CRM_ROOT: ROOT, CRM_PORT: port })
  });
  child.unref();

  /* 等健康检查通过；超时则再确认一次端口状态后放弃 */
  for (let i = 0; i < 60; i++) {
    await new Promise((s) => setTimeout(s, 500));
    if (await healthOk()) {
      /* 连续两次通过才认为稳定，避免打到正在重启的实例 */
      await new Promise((s) => setTimeout(s, 300));
      if (await healthOk()) {
        console.log(`   （已重新拉起服务，端口 ${port}）`);
        return true;
      }
    }
  }
  return false;
}

const summary = [];

(async () => {
  console.log('================ 全部测试套件 ================\n');

  /* 前置：服务必须在跑。没跑就自动拉起（阶段一套件会在最后关掉服务，
     所以「跑两次全套」时第二次进来时服务是停的）。 */
  if (!(await healthOk())) {
    console.log(`服务未运行（${BASE}），正在自动启动…`);
    if (await ensureServer()) {
      console.log('');
    } else {
      console.log(`自动启动失败，请手动启动服务后重跑（见 启动.bat）。`);
      process.exit(2);
    }
  }

  /* 清空业务数据，保证各套件从空库起跑。
     注意：cleanup-test-data.js 会在检测到"看起来是真实业务数据"的客户时拒绝执行
     （退出码 3），这是为了防止在已录入真实数据的库上误跑验收脚本。
     这种情况下必须由使用者显式确认，运行器不代为跳过。 */
  if (!process.argv.includes('--no-clean')) {
    console.log('--- 前置：清空业务数据（保留字典与行政区划）');
    const clean = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'cleanup-test-data.js'), '--all', '--yes'],
      { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write((clean.stdout || '') + (clean.stderr || ''));
    if (clean.status === 3) {
      console.log('\n已中止：库里存在真实业务数据，未做任何删除。');
      console.log('全套测试需要从空库起跑。请任选其一：');
      console.log('  1) 先备份真实数据（设置 → 备份与恢复 → 立即备份），再确认清空后重跑：');
      console.log('       node tools/cleanup-test-data.js --all --yes --force');
      console.log('       node tools/run-all-tests.js --no-clean');
      console.log('  2) 把数据目录切到测试用的空库再跑：设置 CRM_ROOT 指向另一份拷贝');
      console.log('  3) 只想验证个别功能时，单跑对应套件（它们大多自建自清数据）');
      process.exit(3);
    }
    if (clean.status !== 0) {
      console.log('清库失败，终止。');
      process.exit(2);
    }
    console.log('');
  }

  for (const [label, file] of SUITES) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      console.log(`--- ${label}：文件不存在，跳过（${file}）`);
      summary.push({ label, file, pass: 0, total: 0, code: -1, note: '文件不存在' });
      continue;
    }

    /* 除阶段一（它负责停机）外，每个套件开跑前确保服务在线：
       阶段七「备份恢复」用例执行完会关停服务，需要重新拉起。 */
    if (!file.includes('test-phase1')) {
      const alive = await ensureServer();
      if (!alive) {
        console.log(`--- ${label}：服务不可用，跳过`);
        summary.push({ label, file, pass: 0, total: 0, code: -1, note: '服务不可用' });
        continue;
      }
    }

    process.stdout.write(`--- ${label}（${file}）… `);
    const r = spawnSync(process.execPath, [abs], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CRM_TEST_BASE: BASE })
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const totals = parseTotals(out);
    const failures = (out.match(/✗/g) || []).length;

    if (totals) {
      console.log(`通过 ${totals.pass}/${totals.total}${r.status !== 0 ? `（退出码 ${r.status}）` : ''}`);
      summary.push({ label, file, pass: totals.pass, total: totals.total, code: r.status, failures });
    } else {
      console.log(r.status === 0 ? '完成（未解析到汇总行）' : `退出码 ${r.status}`);
      summary.push({ label, file, pass: 0, total: 0, code: r.status, failures, note: '未解析到汇总行' });
    }

    fs.writeFileSync(
      path.join(ROOT, '.fixtures', 'suite-' + path.basename(file, '.js') + '.log'),
      out, 'utf8'
    );
  }

  console.log('\n================ 汇总 ================');
  let allPass = 0; let allTotal = 0; let badSuites = 0;
  for (const s of summary) {
    const ok = s.total > 0 && s.pass === s.total && s.code === 0;
    if (!ok) badSuites++;
    allPass += s.pass; allTotal += s.total;
    console.log(`${ok ? '✓' : '✗'} ${s.label}：${s.total ? `${s.pass}/${s.total}` : (s.note || '未通过')}`
      + `${s.code !== 0 ? `（退出码 ${s.code}）` : ''}`);
  }
  console.log(`\n合计：通过 ${allPass} / ${allTotal}；${badSuites ? `有 ${badSuites} 个套件未全绿` : '全部套件通过'}`);

  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'all-suites-summary.json'),
    JSON.stringify({ allPass, allTotal, badSuites, summary }, null, 2),
    'utf8'
  );
  console.log('（明细已写入 .fixtures/all-suites-summary.json 与 .fixtures/suite-*.log）');

  process.exit(badSuites ? 1 : 0);
})().catch((e) => {
  console.error('运行器异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
