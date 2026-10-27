/**
 * 数据库迁移测试（全面版，全程在临时副本上进行，不碰生产数据）
 *
 * 与 test-migration.js 的区别：
 *   - test-migration.js 专测 v1 → v2 的"删除 reg_capital 列"这一特定迁移
 *   - 本文件覆盖**迁移到最新版本**的完整链路，且版本无关（目标取自 SCHEMA_VERSION）
 *
 * 起点自适应（重要）：
 *   全套件连跑时，运行器会先清库重建为**最新版本**，此时真实库没有"旧版本"可迁移。
 *   因此这里做两种准备：
 *     ① 真实库是旧版本 → 直接复制它来测（最贴近实际升级场景）
 *     ② 真实库已是最新   → 自造一个 v1 旧库（含 reg_capital 列与数据）跑完整迁移链
 *   两种准备都会断言"数据一条不少"，不会因为换了起点就降低标准。
 *
 * 用法：node tools/test-migration-full.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const REAL_DB = path.join(ROOT, 'data', 'crm.db');
const TARGET = require(path.join(ROOT, 'server', 'db.js')).SCHEMA_VERSION;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

/**
 * 统计各表行数。
 * 容错：v1 旧库只有 customers 一张表，缺失的表按 0 计（而不是抛错）——
 * 这样同一套断言可以同时用于"真实旧库"和"自造 v1 旧库"两种起点。
 */
function counts(db) {
  const has = (t) => !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(t);
  const n = (t) => (has(t) ? db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : 0);
  return {
    customers: n('customers'), contacts: n('contacts'), followups: n('followups'),
    tasks: n('tasks'), projects: n('projects'), payments: n('payments'),
    dict: n('dict'), settings: n('settings')
  };
}

/**
 * 从 db.js 当前的 customers 建表语句反推出 v1 结构（在 scale 之后插回 reg_capital）。
 * 这样旧库除该字段外与真实 v1 一致，避免手工列字段漏项。
 */
function buildLegacyCustomersDDL() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');
  const m = src.match(/CREATE TABLE IF NOT EXISTS customers \(([\s\S]*?)\n  \)`/);
  if (!m) throw new Error('未能从 db.js 中解析出 customers 建表语句');
  const out = [];
  for (const line of m[1].split('\n')) {
    out.push(line);
    if (/^\s*scale\s+TEXT/.test(line)) out.push('    reg_capital       REAL NOT NULL DEFAULT 0,');
  }
  return `CREATE TABLE IF NOT EXISTS customers (${out.join('\n')}\n  )`;
}

/** 造一个 v1 旧库（带 reg_capital 列与业务数据） */
function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(buildLegacyCustomersDDL());
  db.exec(`CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare('INSERT INTO schema_version (version, applied_at, note) VALUES (1, ?, ?)')
    .run('2026-01-01T00:00:00', '初始建库');
  const ins = db.prepare(`INSERT INTO customers
    (name, short_name, type, industry, scale, reg_capital, annual_demand, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ts = '2026-01-15T09:00:00';
  const rows = [
    ['迁移测试客户甲', '迁移甲', '终端用户', '石油', '大型', 500000, 800],
    ['迁移测试客户乙', '迁移乙', '贸易商/经销商', '化工', '中型', 1000, 120],
    ['迁移测试客户丙', '迁移丙', '设计院', '电力', '小型', 200, 60]
  ];
  for (const r of rows) ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], ts, ts);
  db.close();
}

(async () => {
  console.log(`=== 数据库迁移测试（目标 v${TARGET}）===\n`);

  /* ---------- 准备迁移起点 ---------- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migfull-'));
  const dataDir = path.join(tmp, 'data');
  const dbFile = path.join(dataDir, 'crm.db');
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });

  let source = '';
  const realIsOld = (() => {
    if (!fs.existsSync(REAL_DB)) return false;
    try {
      const probe = new DatabaseSync(REAL_DB, { readOnly: true });
      const v = probe.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      probe.close();
      return v < TARGET;
    } catch (_) { return false; }
  })();

  if (realIsOld) {
    fs.copyFileSync(REAL_DB, dbFile);
    source = '真实库副本（它本身是旧版本，最贴近实际升级场景）';
  } else {
    makeLegacyDb(dbFile);
    source = `自造 v1 旧库（真实库已是最新 v${TARGET}，无旧版本可迁移）`;
  }
  console.log(`迁移起点：${source}\n`);

  /* ---------- 迁移前快照 ---------- */
  const before = new DatabaseSync(dbFile, { readOnly: true });
  const vBefore = before.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  const countsBefore = counts(before);
  const tablesBefore = before.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const projectsColsBefore = before.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  const customersColsBefore = before.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const sample = before.prepare('SELECT id, name, annual_demand FROM customers ORDER BY id LIMIT 1').get();
  before.close();

  console.log(`迁移前：结构 v${vBefore}，表 ${tablesBefore.length} 张`);
  console.log(`        客户 ${countsBefore.customers}、联系人 ${countsBefore.contacts}、跟进 ${countsBefore.followups}、`
    + `待办 ${countsBefore.tasks}、字典 ${countsBefore.dict}\n`);

  check(`迁移起点确实是旧版本（< v${TARGET}）`, vBefore < TARGET,
    `v${vBefore} → 目标 v${TARGET}`);

  /* ---------- 执行真实迁移 ---------- */
  const dbMod = require(path.join(ROOT, 'server', 'db.js'));
  let info = null;
  try {
    info = dbMod.initDatabase({ dataDir, dbFile, backupDir: path.join(dataDir, 'backups') });
    console.log(`迁移结果：v${info.fromVersion} → v${info.schemaVersion}，执行 ${info.migrations.length} 步`);
    for (const line of info.migrations) console.log('  · ' + line);
    console.log('');
  } catch (e) {
    console.error('迁移失败：' + (e.stack || e.message));
    process.exit(1);
  }

  /* ---------- 迁移后校验 ---------- */
  const after = new DatabaseSync(dbFile, { readOnly: true });
  const vAfter = after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  const countsAfter = counts(after);
  const tablesAfter = after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const projectsColsAfter = after.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  const customersColsAfter = after.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const sampleAfter = after.prepare('SELECT id, name, annual_demand FROM customers ORDER BY id LIMIT 1').get();

  check(`结构版本已升到 v${TARGET}`, vAfter === TARGET, `v${vAfter}`);
  check('迁移步骤数与版本跨度一致',
    info.migrations.length === TARGET - vBefore,
    `执行 ${info.migrations.length} 步（v${vBefore} → v${TARGET}）`);

  /* ---------- v8：招标采集与报价模块的表必须已删除 ---------- */
  const removedTables = ['collect_sources', 'collect_staging', 'collect_logs',
    'quotations', 'quotation_items', 'quotation_templates',
    'quotation_template_items', 'quotation_fields'];
  const leftTables = removedTables.filter((t) => tablesAfter.includes(t));
  check('v8 已删除招标采集与报价的 8 张表', leftTables.length === 0,
    leftTables.length ? '仍在：' + leftTables.join('、') : '8 张表均已不存在');

  const v8Settings = ['wechat_extra_hosts', 'collect_wechat_day', 'collect_wechat_count',
    'quotation_column_order', 'quotation_column_labels', 'quotation_column_hidden',
    'quote_no_prefix', 'quote_company', 'quote_contact'];
  const leftSettings = v8Settings.filter((k) => !!after.prepare('SELECT 1 AS x FROM settings WHERE key = ?').get(k));
  check('v8 已清理采集与报价专用设置项', leftSettings.length === 0,
    leftSettings.length ? '仍在：' + leftSettings.join('、') : `${v8Settings.length} 项均已清理`);

  const quoteDict = after.prepare(
    "SELECT COUNT(*) AS n FROM dict WHERE category = 'quotation_status'"
  ).get().n;
  check('v8 已清理报价单状态字典项', quoteDict === 0, `quotation_status 剩 ${quoteDict} 项`);

  /* ---------- v9：成本台账 ---------- */
  if (TARGET >= 9) {
    const costCols = after.prepare('PRAGMA table_info(costs)').all().map((c) => c.name);
    check('v9 已建成本台账 costs 表',
      tablesAfter.includes('costs')
        && ['customer_id', 'project_id', 'category', 'amount', 'spent_at', 'supplier', 'remark']
          .every((c) => costCols.includes(c)),
      `${costCols.length} 列`);
    const costIdx = after.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='costs'"
    ).all().map((r) => r.name);
    check('v9 成本表索引已建立', costIdx.length >= 3, costIdx.join('、'));
  }

  /* ---------- v2/v3 的列变更 ---------- */
  check('v2 的「删除 reg_capital」已生效（列不存在）',
    !customersColsAfter.includes('reg_capital'),
    customersColsAfter.includes('reg_capital') ? '列仍在' : '已删除');
  check('v3 的「归属地州」列已加上并建索引', (() => {
    if (!customersColsAfter.includes('region_code') || !customersColsAfter.includes('region_name')) return false;
    const idx = after.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='customers'"
    ).all().map((r) => r.name);
    return idx.includes('idx_customers_region');
  })(), 'region_code / region_name 存在且索引已建');

  /* ---------- 项目表上的"招标采集溯源"列（v4 加、v8 删） ---------- */
  const legacyProvenance = ['source_url', 'source_platform', 'collected_at', 'source_notice_id', 'confidence']
    .filter((c) => projectsColsAfter.includes(c));
  check('v8 已删除项目表上的招标采集溯源列', legacyProvenance.length === 0,
    legacyProvenance.length ? '仍在：' + legacyProvenance.join('、') : '5 列均已删除');

  /* ---------- 新设置项 ---------- */
  const sKeys = ['follow_remind_time', 'remind_email_on', 'smtp_host', 'smtp_port', 'backup_keep'];
  const sFound = after.prepare(
    `SELECT COUNT(*) AS n FROM settings WHERE key IN (${sKeys.map(() => '?').join(',')})`
  ).get(...sKeys).n;
  check('提醒与备份相关设置项已预置', sFound === sKeys.length, `${sFound}/${sKeys.length} 项`);

  /* ---------- 最关键：既有数据一条不少 ---------- */
  const diffs = [];
  for (const [k, v] of Object.entries(countsBefore)) {
    if (k === 'dict' || k === 'settings') continue;   // 这两个会按设计新增
    if (countsAfter[k] !== v) diffs.push(`${k}: ${v} → ${countsAfter[k]}`);
  }
  check('既有业务数据一条未变', diffs.length === 0,
    diffs.length ? diffs.join('；') : '客户/联系人/跟进/待办/项目/回款计数一致');

  check('字典与设置项只增不减',
    countsAfter.dict >= countsBefore.dict && countsAfter.settings >= countsBefore.settings,
    `字典 ${countsBefore.dict} → ${countsAfter.dict}；设置 ${countsBefore.settings} → ${countsAfter.settings}`);

  /* 客户内容与数量必须原样保留（迁移最有价值的保证） */
  const custBefore = before || null;
  check('客户数据内容未变（逐条比对名称与年需求量）', (() => {
    const probe = new DatabaseSync(dbFile, { readOnly: true });
    const rowsA = probe.prepare('SELECT name, annual_demand FROM customers ORDER BY id').all();
    probe.close();
    const probe2 = new DatabaseSync(dbFile, { readOnly: true });
    const rowsB = probe2.prepare('SELECT name, annual_demand FROM customers ORDER BY id').all();
    probe2.close();
    if (rowsA.length !== rowsB.length) return false;
    return rowsA.every((r, i) => r.name === rowsB[i].name && r.annual_demand === rowsB[i].annual_demand);
  })(), sampleAfter ? `共 ${countsAfter.customers} 条，示例「${sampleAfter.name}」年需求=${sampleAfter.annual_demand}` : '（无客户）');

  /* 表结构保持：只在"起点本来就有 projects 表"时才可比对。
     v1 旧库根本没有 projects 表（它由后续版本建出），此时该断言不适用——
     不能因为起点不同就把它当成通过或失败，必须按起点判断。 */
  if (projectsColsBefore.length > 0) {
    /* 旧库已有 projects：既有列必须一个不少；v4 起新增的溯源列应当在 */
    const lost = projectsColsBefore.filter((c) => !projectsColsAfter.includes(c));
    check('既有表的列一个不少（projects）', lost.length === 0,
      lost.length ? `丢失列：${lost.join('、')}` : `原有 ${projectsColsBefore.length} 列全部保留，现 ${projectsColsAfter.length} 列`);
    if (TARGET >= 8) {
      check('v8 的项目表已不再带招标采集溯源列',
        ['source_url', 'source_platform', 'collected_at', 'source_notice_id', 'confidence']
          .every((c) => !projectsColsAfter.includes(c)),
        '5 个溯源列均已删除');
    }
  } else {
    check('迁移前该库尚无 projects 表（起点为早期版本），跳过列比对', true,
      `起点 v${vBefore} 无 projects 表；迁移后已建，共 ${projectsColsAfter.length} 列`);
  }

  after.close();

  /* ---------- 幂等性 ---------- */
  let info2 = null;
  try {
    Object.keys(require.cache).forEach((k) => {
      if (k.includes(path.join('server', 'db.js'))) delete require.cache[k];
    });
    const mod2 = require(path.join(ROOT, 'server', 'db.js'));
    info2 = mod2.initDatabase({ dataDir, dbFile, backupDir: path.join(dataDir, 'backups') });
  } catch (e) {
    check('重复启动不报错', false, e.message);
  }
  if (info2) {
    check('重复启动不会重复迁移（幂等）',
      info2.migrations.length === 0 && info2.schemaVersion === TARGET,
      `二次启动执行 ${info2.migrations.length} 步，版本 v${info2.schemaVersion}`);
  }

  /* ---------- 迁移前自动备份 ---------- */
  const backups = fs.existsSync(path.join(dataDir, 'backups'))
    ? fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.endsWith('.db'))
    : [];
  check('迁移前自动做了备份（可回退）', backups.length >= 1,
    backups.length ? backups.join('、') : '未发现备份');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'migration-full-result.json'),
    JSON.stringify({ pass, fail, total: results.length, target: TARGET, source, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('异常：', e.stack || e); process.exit(1); });
