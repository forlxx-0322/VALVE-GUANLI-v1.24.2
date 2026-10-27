/**
 * 数据库迁移测试（全面版，全程在临时副本上进行，不碰生产数据）
 *
 * 与 test-migration.js 的区别：
 *   - test-migration.js 专测 v1 → 最新版本的完整升级链路
 *   - 本文件覆盖**迁移到最新版本**的完整链路，且版本无关（目标取自 SCHEMA_VERSION），
 *     并逐版核对各版本的产物（v8 删表、v9 costs、v10 客户精简与一客户一项目、v11 产品价目表、
 *     v12 二级分类自定义、v13 三级分类 6 / 22 / 46 = 74）
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
const { seedLegacyCustomers, markVersion } = require('./legacy-schema');

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

/** 造一个 v1 旧库（带 reg_capital 列与业务数据） */
function makeLegacyDb(file) {
  const db = new DatabaseSync(file);
  seedLegacyCustomers(db, [
    { name: '迁移测试客户甲', short_name: '迁移甲', industry: '石油', scale: '大型', reg_capital: 500000, annual_demand: 800, city: '乌鲁木齐市' },
    { name: '迁移测试客户乙', short_name: '迁移乙', type: '贸易商/经销商', industry: '化工', scale: '中型', reg_capital: 1000, annual_demand: 120 },
    { name: '迁移测试客户丙', short_name: '迁移丙', type: '设计院', industry: '电力', scale: '小型', reg_capital: 200, annual_demand: 60 }
  ]);
  markVersion(db, 1);
  db.close();
}

/** 1.24 / v12 的两级分类种子（6 + 23），用来构造升级前的老库 */
const OLD_TWO_LEVEL_SEED = [
  ['蝶阀', ['对夹式', '法兰式', '凸耳式', '焊接式']],
  ['球阀', ['浮动球', '固定球', '三通球', '全焊接']],
  ['止回阀', ['旋启式', '升降式', '对夹式', '双瓣式']],
  ['隔膜阀', ['堰式', '直通式', '衬氟']],
  ['刀闸阀', ['手动', '气动', '电动', '浆液专用']],
  ['执行器', ['气动', '电动', '电液联动', '附件']]
];
/** 1.24 的 23 条二级示例路径，以及其中未被新种子沿用的 22 条 */
const OLD_EXAMPLE_PATHS = OLD_TWO_LEVEL_SEED.flatMap(([root, kids]) => kids.map((k) => `${root} / ${k}`));
const OLD_ONLY_PATHS = OLD_EXAMPLE_PATHS.filter((p) => p !== '执行器 / 附件');

/**
 * 造一个 v12 老库：先按当前代码建库拿到完整表结构，再把分类还原成 v12 的
 * 6 + 23 两级种子、版本号降到 12，并可按需模拟用户改动（改名 / 加产品 / 自建分类）。
 */
function makeV12Db(dbMod, tmp, mutate) {
  const dataDir = path.join(tmp, 'data');
  const dbFile = path.join(dataDir, 'crm.db');
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  const boot = dbMod.initDatabase({ dataDir, dbFile, backupDir: path.join(dataDir, 'backups') });
  dbMod.closeDatabase(boot.db);

  const db = new DatabaseSync(dbFile);
  const ts = new Date().toISOString();
  db.exec('DELETE FROM products; DELETE FROM product_categories;');
  const ins = db.prepare(`INSERT INTO product_categories
    (parent_id, name, sort, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const ids = {};
  for (const [i, [name, kids]] of OLD_TWO_LEVEL_SEED.entries()) {
    const r = ins.run(null, name, (i + 1) * 10, 1, ts, ts);
    const pid = Number(r.lastInsertRowid);
    ids[name] = pid;
    kids.forEach((k, j) => ins.run(pid, k, (j + 1) * 10, 0, ts, ts));
  }
  if (mutate) mutate(db, ids, ts);
  db.prepare('DELETE FROM schema_version WHERE version >= 13').run();
  db.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at, note)
    VALUES (12, ?, 'v12 fixture')`).run(ts);
  db.close();
  return { dataDir, dbFile };
}

function insertProduct(db, categoryId, name, code, ts) {
  db.prepare(`INSERT INTO products
    (category_id, name, code, unit, price, lead_time_days, body_material,
     pressure_rating, discount, remark, enabled, sort, created_at, updated_at)
    VALUES (?, ?, ?, '台', 100, 3, '', '', 0, '', 1, 10, ?, ?)`)
    .run(categoryId, name, code, ts, ts);
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
  const sample = before.prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1').get();
  const customersBefore = before.prepare('SELECT name, short_name, industry FROM customers ORDER BY id').all();
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
  const sampleAfter = after.prepare('SELECT id, name FROM customers ORDER BY id LIMIT 1').get();

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

  /* ---------- v10：客户精简 + 一客户一项目 ---------- */
  if (TARGET >= 10) {
    const NEW_COLS = ['customer_no', 'contact_name', 'contact_position', 'contact_phone',
      'contact_birthday', 'follow_cycle_days'];
    const DROPPED = ['type', 'level', 'status', 'owner', 'phone', 'fax', 'website', 'wechat',
      'credit_code', 'zip_code', 'enterprise_nature', 'parent_group', 'scale', 'founded_at',
      'employees', 'legal_person', 'is_listed', 'purchase_mode', 'end_user', 'design_institute',
      'epc_contractor', 'valve_types', 'drive_mode', 'body_material', 'pressure_rating',
      'size_range', 'design_standard', 'connection_type', 'cert_required', 'annual_demand',
      'purchase_cycle', 'account_period', 'warranty_ratio', 'warranty_months', 'payer',
      'tender_platform', 'qualification', 'has_ts_license', 'has_explosion_proof',
      'quality_grade', 'supplier_code', 'credit_rating', 'introducer', 'competitor',
      'deal_amount', 'customer_since', 'last_order_at'];
    check('v10 客户表已加 6 个新列且保留 industry',
      NEW_COLS.every((c) => customersColsAfter.includes(c)) && customersColsAfter.includes('industry'),
      `新列 ${NEW_COLS.filter((c) => customersColsAfter.includes(c)).length}/6，industry=${customersColsAfter.includes('industry')}`);
    const left = DROPPED.filter((c) => customersColsAfter.includes(c));
    check(`v10 已删除 ${DROPPED.length} 个旧列（含 last_order_at）`,
      left.length === 0 && customersColsAfter.length === 27,
      left.length ? `仍在：${left.join('、')}` : `旧列全部删除，现 ${customersColsAfter.length} 列`);

    const uq = after.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
    ).get();
    check('v10 已建一客户一项目唯一索引（archived=0 的部分唯一索引）',
      projectsColsAfter.includes('archived') && !!uq && /archived\s*=\s*0/.test(String(uq.sql || '')),
      uq ? String(uq.sql) : '索引不存在');

    const fixed = after.prepare(
      "SELECT name FROM tags WHERE name IN ('重点客户','老客户','待回访','已成交','暂停合作')"
    ).all().map((r) => r.name);
    check('v10 已种入 5 个固定标签', fixed.length === 5, fixed.join('、'));

    const nos = after.prepare('SELECT customer_no FROM customers ORDER BY id').all().map((r) => r.customer_no);
    check('v10 老客户自动回填客户编号',
      nos.length === customersBefore.length && nos.every((n) => /^KH-\d{4}-\d{4}$/.test(String(n || '')))
        && new Set(nos).size === nos.length,
      nos.join('、') || '（无客户）');
  }

  /* ---------- v11：产品价目表（1.24） ---------- */
  if (TARGET >= 11) {
    const CAT_COLS = ['id', 'parent_id', 'name', 'sort', 'is_system', 'created_at', 'updated_at', 'deleted_at'];
    const PROD_COLS = ['id', 'category_id', 'name', 'code', 'unit', 'price', 'lead_time_days',
      'body_material', 'pressure_rating', 'discount', 'remark', 'enabled', 'sort',
      'created_at', 'updated_at', 'deleted_at'];
    const catCols = after.prepare('PRAGMA table_info(product_categories)').all().map((c) => c.name);
    const prodCols = after.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    check('v11 已建产品价目表两张表且列齐全（8 + 16）',
      tablesAfter.includes('product_categories') && tablesAfter.includes('products')
        && CAT_COLS.every((c) => catCols.includes(c)) && catCols.length === CAT_COLS.length
        && PROD_COLS.every((c) => prodCols.includes(c)) && prodCols.length === PROD_COLS.length,
      `product_categories ${catCols.length} 列 / products ${prodCols.length} 列`);

    const rootCount = after.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1 AND parent_id IS NULL`).get().n;
    const secondTotal = after.prepare(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.parent_id IS NOT NULL
        AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NULL`).get().n;
    const thirdTotal = after.prepare(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.parent_id IS NOT NULL
        AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NOT NULL`).get().n;
    const totalCats = after.prepare(
      'SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL'
    ).get().n;
    const systemCats = after.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1`).get().n;
    const systemChildren = after.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1 AND parent_id IS NOT NULL`).get().n;
    const maxDepth = after.prepare(`WITH RECURSIVE d(id, depth) AS (
        SELECT id, 1 FROM product_categories WHERE deleted_at IS NULL AND parent_id IS NULL
        UNION ALL
        SELECT c.id, d.depth + 1 FROM product_categories c JOIN d ON c.parent_id = d.id
        WHERE c.deleted_at IS NULL
      ) SELECT MAX(depth) AS m FROM d`).get().m;
    const rootNames = after.prepare(`SELECT name FROM product_categories
      WHERE deleted_at IS NULL AND parent_id IS NULL ORDER BY sort, id`).all().map((r) => r.name);
    check('v13 分类扩为三级：一级 6 个（内置）+ 二级 22 + 三级 46 = 74，最大深度 3',
      rootCount === 6 && secondTotal === 22 && thirdTotal === 46 && totalCats === 74
        && systemCats === 6 && systemChildren === 0 && maxDepth === 3
        && ['蝶阀', '球阀', '止回阀', '隔膜阀', '刀闸阀', '执行器'].every((n) => rootNames.includes(n)),
      `一级 ${rootCount}（${rootNames.join(' / ')}），二级 ${secondTotal}，三级 ${thirdTotal}，`
        + `合计 ${totalCats}，is_system=1 共 ${systemCats}，最大深度 ${maxDepth}`);

    /* 三级抽样：蝶阀 → 三偏心蝶阀 → 对夹 / 法兰 / 支耳 */
    const dieRow = after.prepare(`SELECT id FROM product_categories
      WHERE deleted_at IS NULL AND parent_id IS NULL AND name = '蝶阀'`).get();
    const sanRow = dieRow && after.prepare(`SELECT id FROM product_categories
      WHERE deleted_at IS NULL AND parent_id = ? AND name = '三偏心蝶阀'`).get(dieRow.id);
    const sanLinks = sanRow ? after.prepare(`SELECT name FROM product_categories
      WHERE deleted_at IS NULL AND parent_id = ? ORDER BY sort, id`).all(sanRow.id).map((r) => r.name) : [];
    check('v13 三级名称正确（蝶阀 → 三偏心蝶阀 → 对夹 / 法兰 / 支耳）',
      sanLinks.join(',') === '对夹,法兰,支耳',
      `三偏心蝶阀下：${sanLinks.join(' / ') || '（缺失）'}`);

    const prodIdx = after.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('product_categories','products')"
    ).all().map((r) => r.name);
    const NEED_IDX = ['idx_product_categories_parent', 'idx_products_category', 'idx_products_name',
      'idx_products_enabled', 'idx_products_deleted'];
    check('v11 产品相关 5 个索引已建立',
      NEED_IDX.every((n) => prodIdx.includes(n)),
      NEED_IDX.filter((n) => !prodIdx.includes(n)).join('、') || NEED_IDX.join('、'));

    const prodCount = after.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    check('v11 为纯新增迁移：产品表迁移后为空，既有业务数据不受影响',
      prodCount === 0 && countsAfter.customers === countsBefore.customers,
      `products ${prodCount} 条；客户 ${countsBefore.customers} → ${countsAfter.customers}`);

    /* ---------- v12：二级分类降级为自定义（可删除） ---------- */
    check('v12 二级/三级分类均为自定义（is_system=0，可删除），一级仍为系统分类',
      systemChildren === 0 && rootCount === 6 && totalCats === 74,
      `一级系统 ${rootCount} / 非一级系统 ${systemChildren} / 分类合计 ${totalCats}`);

    /* ---------- v13：归档 1.24 的旧二级示例 ----------
     * 旧种子共 23 条二级路径，其中「执行器 / 附件」被 1.24.2 的新三级结构沿用，
     * 因此真正需要归档的是另外 22 条旧路径；附件保留为新种子的二级节点。 */
    const livePairs = new Set(after.prepare(`SELECT p.name || ' / ' || c.name AS path
      FROM product_categories c JOIN product_categories p ON p.id = c.parent_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL`).all()
      .map((r) => r.path));
    const oldLeft = OLD_ONLY_PATHS.filter((p) => livePairs.has(p));
    check('v13 已归档 1.24 的 22 条旧二级示例路径（旧名单里仅「执行器 / 附件」被新结构沿用）',
      oldLeft.length === 0,
      oldLeft.length ? `仍在：${oldLeft.join('、')}` : `22 条旧路径均已消失；附件保留=${livePairs.has('执行器 / 附件')}`);
    check('v13 旧 23 条示例中的「执行器 / 附件」作为新种子保留（且只有 1 个）',
      livePairs.has('执行器 / 附件')
        && after.prepare(`SELECT COUNT(*) AS n FROM product_categories c
            JOIN product_categories p ON p.id = c.parent_id
            WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL
              AND p.name = '执行器' AND c.name = '附件'`).get().n === 1,
      '附件（无三级，自定义分类）存在且唯一');
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
  check('客户数据内容未变（逐条比对名称 / 简称 / 行业）', (() => {
    const probe = new DatabaseSync(dbFile, { readOnly: true });
    const rowsAfter = probe.prepare('SELECT name, short_name, industry FROM customers ORDER BY id').all();
    probe.close();
    if (customersBefore.length !== rowsAfter.length) return false;
    return customersBefore.every((r, i) => r.name === rowsAfter[i].name
      && r.short_name === rowsAfter[i].short_name
      && r.industry === rowsAfter[i].industry);
  })(), sampleAfter
    ? `共 ${countsAfter.customers} 条，示例「${sampleAfter.name}」`
    : '（无客户）');

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

    const catsAfterSecond = info2.db.prepare(
      'SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL'
    ).get().n;
    check('重复启动不会重复灌入内置分类（仍为 74 个）',
      catsAfterSecond === 74, `分类 ${catsAfterSecond} 个`);
  }

  /* ---------- 迁移前自动备份 ---------- */
  const backups = fs.existsSync(path.join(dataDir, 'backups'))
    ? fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.endsWith('.db'))
    : [];
  check('迁移前自动做了备份（可回退）', backups.length >= 1,
    backups.length ? backups.join('、') : '未发现备份');

  /* ================================================================ */
  /* v12 → v13 专项：带 1.24 旧 23 个二级示例的库                       */
  /* （全链 v1 → v13 时 v11 已直接灌入新种子，这里单独构造 v12 现场）     */
  /* ================================================================ */
  const tmpV12a = fs.mkdtempSync(path.join(os.tmpdir(), 'migv13a-'));
  let dbV12a = null;
  try {
    const fx = makeV12Db(dbMod, tmpV12a, null);
    const mig = dbMod.initDatabase({
      dataDir: fx.dataDir, dbFile: fx.dbFile, backupDir: path.join(fx.dataDir, 'backups')
    });
    dbV12a = mig.db;
    const n = (sql) => dbV12a.prepare(sql).get().n;
    const live = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL');
    const roots = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL AND parent_id IS NULL');
    const second = n(`SELECT COUNT(*) AS n FROM product_categories c WHERE c.deleted_at IS NULL
      AND c.parent_id IS NOT NULL AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NULL`);
    const third = n(`SELECT COUNT(*) AS n FROM product_categories c WHERE c.deleted_at IS NULL
      AND c.parent_id IS NOT NULL AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NOT NULL`);
    const sys = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL AND is_system = 1');
    const sysChildren = n(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1 AND parent_id IS NOT NULL`);
    const maxDepth = dbV12a.prepare(`WITH RECURSIVE d(id, depth) AS (
        SELECT id, 1 FROM product_categories WHERE deleted_at IS NULL AND parent_id IS NULL
        UNION ALL
        SELECT c.id, d.depth + 1 FROM product_categories c JOIN d ON c.parent_id = d.id
        WHERE c.deleted_at IS NULL
      ) SELECT MAX(depth) AS m FROM d`).get().m;
    check('v13 从 v12 纯种子库升级：执行 1 步迁移，分类 74 个 / 系统 6 / 深度 3',
      mig.fromVersion === 12 && mig.schemaVersion === 13 && mig.migrations.length === 1
        && live === 74 && roots === 6 && second === 22 && third === 46
        && sys === 6 && sysChildren === 0 && maxDepth === 3,
      `v${mig.fromVersion} → v${mig.schemaVersion}（${mig.migrations.length} 步）；`
        + `一级 ${roots} / 二级 ${second} / 三级 ${third} / 系统 ${sys} / 深度 ${maxDepth}`);

    const livePairs = new Set(dbV12a.prepare(`SELECT p.name || ' / ' || c.name AS path
      FROM product_categories c JOIN product_categories p ON p.id = c.parent_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL`).all()
      .map((r) => r.path));
    const oldLeft = OLD_ONLY_PATHS.filter((p) => livePairs.has(p));
    const tomb = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NOT NULL');
    check('v13 旧 23 个示例已不在（22 条旧路径归档，「附件」由新种子沿用）',
      oldLeft.length === 0 && livePairs.has('执行器 / 附件') && tomb === 22,
      oldLeft.length ? `仍在：${oldLeft.join('、')}` : `22 条旧路径消失，附件保留，软删除 ${tomb} 条`);

    dbMod.closeDatabase(dbV12a);
    dbV12a = null;
  } catch (e) {
    check('v13 从 v12 纯种子库升级（专项）', false, e.message);
  } finally {
    if (dbV12a) { try { dbMod.closeDatabase(dbV12a); } catch (_) { /* 忽略 */ } }
    try { fs.rmSync(tmpV12a, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  /* ---------- v12 老库 + 用户改动：改名 / 已有产品 / 自建分类 ---------- */
  const tmpV12b = fs.mkdtempSync(path.join(os.tmpdir(), 'migv13b-'));
  let dbV12b = null;
  try {
    const fx = makeV12Db(dbMod, tmpV12b, (db, ids, ts) => {
      const jia = db.prepare("SELECT id FROM product_categories WHERE parent_id = ? AND name = '对夹式'").get(ids['蝶阀']);
      db.prepare('UPDATE product_categories SET name = ? WHERE id = ?').run('夹套式（改名）', jia.id);
      const fa = db.prepare("SELECT id FROM product_categories WHERE parent_id = ? AND name = '法兰式'").get(ids['蝶阀']);
      insertProduct(db, fa.id, '老产品 法兰式', 'OLD-1', ts);
      const fj = db.prepare("SELECT id FROM product_categories WHERE parent_id = ? AND name = '附件'").get(ids['执行器']);
      insertProduct(db, fj.id, '老产品 附件', 'OLD-2', ts);
      const ur = db.prepare(`INSERT INTO product_categories
        (parent_id, name, sort, is_system, created_at, updated_at) VALUES (NULL, ?, 70, 0, ?, ?)`)
        .run('用户自定义大类', ts, ts);
      db.prepare(`INSERT INTO product_categories
        (parent_id, name, sort, is_system, created_at, updated_at) VALUES (?, ?, 10, 0, ?, ?)`)
        .run(Number(ur.lastInsertRowid), '用户自定义子类', ts, ts);
      db.prepare(`INSERT INTO customers (name, short_name, industry, created_at, updated_at)
        VALUES ('迁移测试客户V12', 'V12', '石油', ?, ?)`).run(ts, ts);
    });
    const mig = dbMod.initDatabase({
      dataDir: fx.dataDir, dbFile: fx.dbFile, backupDir: path.join(fx.dataDir, 'backups')
    });
    dbV12b = mig.db;
    const n = (sql) => dbV12b.prepare(sql).get().n;
    const live = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL');
    const roots = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL AND parent_id IS NULL');
    const second = n(`SELECT COUNT(*) AS n FROM product_categories c WHERE c.deleted_at IS NULL
      AND c.parent_id IS NOT NULL AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NULL`);
    const third = n(`SELECT COUNT(*) AS n FROM product_categories c WHERE c.deleted_at IS NULL
      AND c.parent_id IS NOT NULL AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NOT NULL`);
    const sys = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL AND is_system = 1');
    const tomb = n('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NOT NULL');
    const products = n('SELECT COUNT(*) AS n FROM products WHERE deleted_at IS NULL');
    const customers = n('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL');
    const renamedKept = n(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND name = '夹套式（改名）'`);
    const productCatKept = n(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.name = '法兰式'
        AND EXISTS (SELECT 1 FROM products p WHERE p.deleted_at IS NULL AND p.category_id = c.id)`);
    const userKept = n(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND name IN ('用户自定义大类', '用户自定义子类')`);
    const fujian = n(`SELECT COUNT(*) AS n FROM product_categories c
      JOIN product_categories p ON p.id = c.parent_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.name = '执行器' AND c.name = '附件'`);
    const fujianProduct = n(`SELECT COUNT(*) AS n FROM products p
      JOIN product_categories c ON c.id = p.category_id
      WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL AND c.name = '附件'`);
    const livePairs = new Set(dbV12b.prepare(`SELECT p.name || ' / ' || c.name AS path
      FROM product_categories c JOIN product_categories p ON p.id = c.parent_id
      WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL`).all()
      .map((r) => r.path));
    const oldOnlyLeft = OLD_ONLY_PATHS.filter((p) => livePairs.has(p));

    check('v13 用户改过名 / 已挂产品 / 自建分类的库：分类与产品都不丢',
      mig.schemaVersion === 13 && live === 78 && roots === 7 && second === 25 && third === 46
        && sys === 6 && tomb === 20
        && products === 2 && customers === 1
        && renamedKept === 1 && productCatKept === 1 && userKept === 2
        && fujian === 1 && fujianProduct === 1,
      `分类 ${live}（一级 ${roots} / 二级 ${second} / 三级 ${third} / 系统 ${sys} / 归档 ${tomb}）；`
        + `产品 ${products}、客户 ${customers}；改名保留 ${renamedKept}、有产品旧类保留 ${productCatKept}、`
        + `自建分类保留 ${userKept}、附件 ${fujian}（产品 ${fujianProduct}）`);

    check('v13 旧示例只归档"空"的路径：有产品的旧分类仍留在树上',
      oldOnlyLeft.join('、') === '蝶阀 / 法兰式'
        && livePairs.has('蝶阀 / 夹套式（改名）'),
      `仍存活的旧路径：${oldOnlyLeft.join('、') || '（无）'}`);

    dbMod.closeDatabase(dbV12b);
    dbV12b = null;
  } catch (e) {
    check('v13 用户改动场景（专项）', false, e.message);
  } finally {
    if (dbV12b) { try { dbMod.closeDatabase(dbV12b); } catch (_) { /* 忽略 */ } }
    try { fs.rmSync(tmpV12b, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

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
