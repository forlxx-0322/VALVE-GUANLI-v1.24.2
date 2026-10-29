/**
 * 数据库结构迁移验证（v1 旧库 → 最新版本）
 *
 * 场景：模拟一个 v1 结构的旧数据库（68 列客户表 + reg_capital 列 + 数据），
 *       验证逐级升级到 v10 时：
 *         1. 自动备份旧库（备份里仍是旧结构，可回滚）
 *         2. v2 删除 reg_capital、v3 加归属地州、v9 建 costs、v10 客户精简
 *         3. 客户业务数据一条不少、内容不变，客户编号自动回填
 *         4. projects.archived + v16 删除一客户一项目唯一索引 + 5 个固定标签
 *         5. 重复执行不会重复迁移（幂等）
 *
 * 用法：node tools/test-migration.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { initDatabase, closeDatabase, SCHEMA_VERSION, FIXED_TAG_NAMES } = require('../server/db');
const { seedLegacyCustomers, markVersion } = require('./legacy-schema');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 造一个 v1 结构的旧库：客户表带 reg_capital，版本号记为 1 */
function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  seedLegacyCustomers(db, [
    { name: '中国石油独山子石化分公司', short_name: '独山子石化', industry: '石油', scale: '大型', reg_capital: 500000, annual_demand: 800, city: '克拉玛依市', district: '独山子区' },
    { name: '新疆天成阀门销售有限公司', short_name: '天成阀门', type: '贸易商/经销商', industry: '化工', scale: '中型', reg_capital: 1000, annual_demand: 120 },
    { name: '宝钢集团新疆八一钢铁有限公司', short_name: '八一钢铁', industry: '冶金', scale: '大型', reg_capital: 2000000, annual_demand: 1500 }
  ]);
  markVersion(db, 1);
  db.close();
}

/* v10 删掉的 47 个旧列（抽查其中典型的；完整清单在 server/db.js） */
const DROPPED_SAMPLE = ['type', 'level', 'status', 'owner', 'phone', 'fax', 'website',
  'wechat', 'credit_code', 'zip_code', 'enterprise_nature', 'scale', 'founded_at',
  'valve_types', 'annual_demand', 'account_period', 'supplier_code', 'deal_amount',
  'customer_since', 'last_order_at'];
const NEW_COLUMNS = ['customer_no', 'contact_name', 'contact_position', 'contact_phone',
  'contact_birthday', 'follow_cycle_days'];

(async () => {
  console.log('=== 数据库结构迁移验证（v1 → v' + SCHEMA_VERSION + '）===\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crmmig-'));
  const dataDir = path.join(tmp, 'data');
  const backupDir = path.join(dataDir, 'backups');
  const dbFile = path.join(dataDir, 'crm.db');

  fs.mkdirSync(backupDir, { recursive: true });
  makeLegacyDb(dbFile);

  /* 迁移前状态 */
  const before = new DatabaseSync(dbFile, { readOnly: true });
  const beforeCols = before.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const beforeRows = before.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const beforeVer = before.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  before.close();

  check('测试库已构造为 v1 结构（含 reg_capital 列）',
    beforeCols.includes('reg_capital') && beforeRows === 3 && beforeVer === 1,
    `版本 v${beforeVer}，${beforeRows} 条客户，含 reg_capital=${beforeCols.includes('reg_capital')}`);

  /* 执行迁移 */
  const info = initDatabase({ dataDir, dbFile, backupDir });

  check('迁移被正确识别并逐级执行',
    info.migrated === true && info.fromVersion === 1 && info.schemaVersion === SCHEMA_VERSION,
    `v${info.fromVersion} → v${info.schemaVersion}，执行 ${info.migrations.length} 步`);

  check('迁移前自动备份了旧库',
    !!info.backedUpTo && fs.existsSync(info.backedUpTo),
    info.backedUpTo ? path.basename(info.backedUpTo) + `（${Math.round(fs.statSync(info.backedUpTo).size / 1024)} KB）` : '未生成备份');

  /* 备份文件应当是迁移前的结构（仍含 reg_capital） */
  if (info.backedUpTo) {
    const bak = new DatabaseSync(info.backedUpTo, { readOnly: true });
    const bakCols = bak.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    const bakRows = bak.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
    const bakReg = bak.prepare('SELECT name, reg_capital FROM customers ORDER BY id LIMIT 1').get();
    bak.close();
    check('备份文件保留迁移前完整结构（可随时回滚）',
      bakCols.includes('reg_capital') && bakRows === 3 && bakReg.reg_capital === 500000,
      `备份含 reg_capital=${bakCols.includes('reg_capital')}，${bakRows} 条数据，首条注册资金=${bakReg.reg_capital}`);
  } else {
    check('备份文件保留迁移前完整结构（可随时回滚）', false, '无备份文件');
  }

  /* 迁移后校验 */
  const db = info.db;
  const afterCols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const afterVer = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  const first = db.prepare('SELECT name, short_name, industry, customer_no FROM customers WHERE id = 1').get();
  const names = db.prepare('SELECT name FROM customers ORDER BY id').all().map((r) => r.name);
  const nos = db.prepare('SELECT customer_no FROM customers ORDER BY id').all().map((r) => r.customer_no);

  check('v2 的 reg_capital 列已被删除',
    !afterCols.includes('reg_capital'),
    `客户表共 ${afterCols.length} 列，已无 reg_capital`);

  check('v10 删掉的 47 个旧列已不存在（抽查 20 个）',
    DROPPED_SAMPLE.every((c) => !afterCols.includes(c)) && afterCols.length === 27,
    `仍存在：${DROPPED_SAMPLE.filter((c) => afterCols.includes(c)).join('、') || '无'}；列数 ${afterCols.length}`);

  check('v10 新增的 6 列已存在（行业列保留）',
    NEW_COLUMNS.every((c) => afterCols.includes(c)) && afterCols.includes('industry'),
    `新列 ${NEW_COLUMNS.filter((c) => afterCols.includes(c)).length}/6，industry=${afterCols.includes('industry')}`);

  check('业务数据完整保留（3 条客户未丢失）',
    afterCount === 3 && names.length === 3,
    `${afterCount} 条：${names.map((n) => n.slice(0, 8)).join(' / ')}`);

  check('其余字段值未被破坏（简称 / 行业保留）',
    first && first.short_name === '独山子石化' && first.industry === '石油',
    `简称=${first && first.short_name}，行业=${first && first.industry}`);

  check('老客户自动回填客户编号（KH-年份-序号，且不重复）',
    nos.every((n) => /^KH-\d{4}-\d{4}$/.test(String(n || '')))
      && new Set(nos).size === nos.length,
    nos.join('、'));

  check('v10 项目表已加 archived 列，v16 已删除一客户一项目唯一索引',
    (() => {
      const projCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
      const uq = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
      ).get();
      return projCols.includes('archived') && !uq;
    })(),
    'archived 列存在，uq_projects_customer_current 已不存在');

  check('v10 已种入 5 个固定标签（重点客户 / 老客户 / 待回访 / 已成交 / 暂停合作）',
    (() => {
      const rows = db.prepare('SELECT name FROM tags').all().map((r) => r.name);
      return FIXED_TAG_NAMES.every((n) => rows.includes(n)) && rows.length === 5;
    })(),
    FIXED_TAG_NAMES.join('、'));

  const migratedProdCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  check('v15 产品表已增加 lead_time_weeks 列（按周精确存储）',
    migratedProdCols.includes('lead_time_weeks'),
    `products ${migratedProdCols.length} 列，lead_time_weeks=${migratedProdCols.includes('lead_time_weeks')}`);

  check('版本号已更新为代码当前版本',
    afterVer === SCHEMA_VERSION,
    `schema_version = ${afterVer}（代码当前 v${SCHEMA_VERSION}）`);

  /* 新库应直接是最新结构（不经过迁移） */
  const freshDir = path.join(tmp, 'fresh');
  const fresh = initDatabase({
    dataDir: freshDir,
    dbFile: path.join(freshDir, 'crm.db'),
    backupDir: path.join(freshDir, 'backups')
  });
  const freshCols = fresh.db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  const freshUq = fresh.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
  ).get();
  check('全新数据库直接建为最新结构（不会留下已删除字段）',
    !freshCols.includes('reg_capital') && !freshCols.includes('type') && fresh.created === true
      && fresh.schemaVersion === SCHEMA_VERSION && fresh.backedUpTo === null,
    `全新建库=${fresh.created}，版本 v${fresh.schemaVersion}，列数 ${freshCols.length}，无谓备份=${fresh.backedUpTo === null}`);
  check('全新建库不再创建一客户一项目唯一索引（v16 多项目）',
    !freshUq,
    `uq_projects_customer_current=${!!freshUq}（应为 false）`);
  closeDatabase(fresh.db);

  /* 幂等性：再次初始化不应重复迁移 */
  closeDatabase(db);
  const again = initDatabase({ dataDir, dbFile, backupDir });
  check('重复启动不会重复迁移（幂等）',
    again.migrations.length === 0 && again.schemaVersion === SCHEMA_VERSION,
    `迁移步骤=${again.migrations.length}，版本 v${again.schemaVersion}`);
  closeDatabase(again.db);

  /* 清理 */
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
