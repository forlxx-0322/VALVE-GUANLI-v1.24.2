/**
 * 旧版客户表结构（v1 ~ v9）—— 迁移测试专用夹具（1.23 新增）
 *
 * 1.23 把 customers 精简到 27 列之后，迁移测试不能再"从当前建表语句反推旧结构"
 * （旧列已经不存在了），因此这里把 1.22 及以前的 68 列结构固化下来，
 * 并补上 v2 迁移要删的 reg_capital 列，用来模拟真实的老库升级路径。
 *
 * 仅测试使用，不参与运行时。
 */
'use strict';

/** v1 结构的 customers 建表语句（含已删除的 reg_capital） */
const LEGACY_CUSTOMERS_DDL = `CREATE TABLE IF NOT EXISTS customers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    short_name        TEXT NOT NULL DEFAULT '',
    type              TEXT NOT NULL DEFAULT '',
    industry          TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT '',
    level             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT '潜在',
    owner             TEXT NOT NULL DEFAULT '',
    phone             TEXT NOT NULL DEFAULT '',
    fax               TEXT NOT NULL DEFAULT '',
    website           TEXT NOT NULL DEFAULT '',
    email             TEXT NOT NULL DEFAULT '',
    wechat            TEXT NOT NULL DEFAULT '',
    credit_code       TEXT NOT NULL DEFAULT '',
    province          TEXT NOT NULL DEFAULT '',
    city              TEXT NOT NULL DEFAULT '',
    district          TEXT NOT NULL DEFAULT '',
    address           TEXT NOT NULL DEFAULT '',
    zip_code          TEXT NOT NULL DEFAULT '',
    enterprise_nature TEXT NOT NULL DEFAULT '',
    parent_group      TEXT NOT NULL DEFAULT '',
    scale             TEXT NOT NULL DEFAULT '',
    reg_capital       REAL NOT NULL DEFAULT 0,
    founded_at        TEXT,
    employees         TEXT NOT NULL DEFAULT '',
    legal_person      TEXT NOT NULL DEFAULT '',
    is_listed         INTEGER NOT NULL DEFAULT 0,
    purchase_mode     TEXT NOT NULL DEFAULT '',
    end_user          TEXT NOT NULL DEFAULT '',
    design_institute  TEXT NOT NULL DEFAULT '',
    epc_contractor    TEXT NOT NULL DEFAULT '',
    valve_types       TEXT NOT NULL DEFAULT '',
    drive_mode        TEXT NOT NULL DEFAULT '',
    body_material     TEXT NOT NULL DEFAULT '',
    pressure_rating   TEXT NOT NULL DEFAULT '',
    size_range        TEXT NOT NULL DEFAULT '',
    design_standard   TEXT NOT NULL DEFAULT '',
    connection_type   TEXT NOT NULL DEFAULT '',
    cert_required     TEXT NOT NULL DEFAULT '',
    annual_demand     REAL NOT NULL DEFAULT 0,
    purchase_cycle    TEXT NOT NULL DEFAULT '',
    account_period    TEXT NOT NULL DEFAULT '',
    warranty_ratio    REAL NOT NULL DEFAULT 0,
    warranty_months   INTEGER NOT NULL DEFAULT 0,
    payer             TEXT NOT NULL DEFAULT '',
    tender_platform   TEXT NOT NULL DEFAULT '',
    qualification     TEXT NOT NULL DEFAULT '',
    has_ts_license    INTEGER NOT NULL DEFAULT 0,
    has_explosion_proof INTEGER NOT NULL DEFAULT 0,
    quality_grade     TEXT NOT NULL DEFAULT '',
    supplier_code     TEXT NOT NULL DEFAULT '',
    credit_rating     TEXT NOT NULL DEFAULT '',
    introducer        TEXT NOT NULL DEFAULT '',
    competitor        TEXT NOT NULL DEFAULT '',
    longitude         REAL,
    latitude          REAL,
    region_code       TEXT NOT NULL DEFAULT '',
    region_name       TEXT NOT NULL DEFAULT '',
    customer_since    TEXT,
    last_order_at     TEXT,
    next_follow_at    TEXT,
    last_follow_at    TEXT,
    follow_count      INTEGER NOT NULL DEFAULT 0,
    deal_amount       REAL NOT NULL DEFAULT 0,
    remark            TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
  )`;

/**
 * 在给定的 SQLite 连接上建出旧库的最小骨架并写入若干客户。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{name:string, short_name?:string, industry?:string, scale?:string,
 *                reg_capital?:number, annual_demand?:number, city?:string, district?:string}>} rows
 */
function seedLegacyCustomers(db, rows) {
  db.exec(LEGACY_CUSTOMERS_DDL);
  const ins = db.prepare(
    `INSERT INTO customers
      (name, short_name, type, industry, source, level, status, owner, phone, email,
       province, city, district, address, scale, reg_capital, annual_demand, deal_amount,
       next_follow_at, follow_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, '跟进中', '', ?, '', '新疆维吾尔自治区', ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?)`
  );
  const ts = '2026-01-15T09:00:00';
  for (const r of rows) {
    ins.run(r.name, r.short_name || '', r.type || '终端用户', r.industry || '石油',
      r.level || 'A 重点客户', r.phone || '', r.city || '乌鲁木齐市',
      r.district || '天山区', r.address || '某路 1 号', r.scale || '大型',
      r.reg_capital === undefined ? 0 : r.reg_capital,
      r.annual_demand === undefined ? 0 : r.annual_demand, ts, ts);
  }
  return rows.length;
}

/** 建 schema_version 表并写入起始版本号 */
function markVersion(db, version) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
  )`);
  db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)')
    .run(version, '2026-01-01T00:00:00', '旧库起始版本');
}

module.exports = { LEGACY_CUSTOMERS_DDL, seedLegacyCustomers, markVersion };
