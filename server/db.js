/**
 * 数据库层 —— 客户管理系统
 *
 * 职责：
 *   1. 建立 SQLite 连接（Node 内置 node:sqlite，零依赖）
 *   2. 建全 17 张表与索引
 *   3. 结构版本管理（schema_version）+ 迁移前自动备份（当前 v16：一个客户可管理多个项目）
 *   4. 写入初始字典数据、系统设置与内置产品分类
 *
 * 编码约定：本文件与所有 .js 文件统一 UTF-8 无 BOM。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 16;

/* ------------------------------------------------------------------ */
/* 17 张表结构                                                          */
/* ------------------------------------------------------------------ */

const TABLES = [

  /* 1. 客户主表 —— 1.23 精简版：客户只留 21 个基础列 + 6 个新增列。
   *    项目信息由 projects 表承载（1.27 起一个客户可同时有多个进行中项目）；
   *    经纬度保留但界面不显示（以后想接地图不必再迁移）。 */
  `CREATE TABLE IF NOT EXISTS customers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL,
    short_name         TEXT NOT NULL DEFAULT '',
    customer_no        TEXT NOT NULL DEFAULT '',
    industry           TEXT NOT NULL DEFAULT '',
    source             TEXT NOT NULL DEFAULT '',
    email              TEXT NOT NULL DEFAULT '',
    contact_name       TEXT NOT NULL DEFAULT '',
    contact_position   TEXT NOT NULL DEFAULT '',
    contact_phone      TEXT NOT NULL DEFAULT '',
    contact_birthday   TEXT NOT NULL DEFAULT '',
    follow_cycle_days  INTEGER NOT NULL DEFAULT 0,
    province           TEXT NOT NULL DEFAULT '',
    city               TEXT NOT NULL DEFAULT '',
    district           TEXT NOT NULL DEFAULT '',
    address            TEXT NOT NULL DEFAULT '',
    longitude          REAL,
    latitude           REAL,
    region_code        TEXT NOT NULL DEFAULT '',
    region_name        TEXT NOT NULL DEFAULT '',
    next_follow_at     TEXT,
    last_follow_at     TEXT,
    follow_count       INTEGER NOT NULL DEFAULT 0,
    remark             TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    deleted_at         TEXT
  )`,

  /* 2. 联系人 —— 一客户多人 */
  `CREATE TABLE IF NOT EXISTS contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    name        TEXT NOT NULL,
    position    TEXT NOT NULL DEFAULT '',
    department  TEXT NOT NULL DEFAULT '',
    mobile      TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    wechat      TEXT NOT NULL DEFAULT '',
    email       TEXT NOT NULL DEFAULT '',
    is_decision INTEGER NOT NULL DEFAULT 0,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    influence   TEXT NOT NULL DEFAULT '',
    birthday    TEXT,
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 3. 标签 */
  `CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#4b7bec',
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /* 4. 客户-标签关联 */
  `CREATE TABLE IF NOT EXISTS customer_tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    tag_id      INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (customer_id, tag_id)
  )`,

  /* 5. 跟进记录 */
  `CREATE TABLE IF NOT EXISTS followups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    project_id  INTEGER,
    followed_at TEXT NOT NULL,
    method      TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    result      TEXT NOT NULL DEFAULT '',
    next_plan   TEXT NOT NULL DEFAULT '',
    next_at     TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 6. 项目 —— 1.27 起一个客户可同时有多个进行中项目（1:N）。
   *    archived=1 表示历史项目（只读，不计入客户财务汇总，可随时恢复归档）。
   *    回款 / 成本 / 待办 / 附件仍挂 project_id，各项目之间互不影响。 */
  `CREATE TABLE IF NOT EXISTS projects (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    customer_id       INTEGER NOT NULL,
    stage             TEXT NOT NULL DEFAULT '信息收集',
    progress          INTEGER NOT NULL DEFAULT 0,
    end_user          TEXT NOT NULL DEFAULT '',
    design_institute  TEXT NOT NULL DEFAULT '',
    valve_needs       TEXT NOT NULL DEFAULT '',
    quantity          INTEGER NOT NULL DEFAULT 0,
    contract_amount   REAL NOT NULL DEFAULT 0,
    signed_at         TEXT,
    bid_date          TEXT,
    bid_result        TEXT NOT NULL DEFAULT '',
    win_rate_note     TEXT NOT NULL DEFAULT '',
    start_date        TEXT,
    end_date          TEXT,
    delivery_date     TEXT,
    owner             TEXT NOT NULL DEFAULT '',
    received_amount   REAL NOT NULL DEFAULT 0,
    payment_status    TEXT NOT NULL DEFAULT '未开始',
    remark            TEXT NOT NULL DEFAULT '',
    data_origin       TEXT NOT NULL DEFAULT '手动录入',
    archived          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    deleted_at        TEXT
  )`,

  /* 7. 回款 —— 计划与实收共用，type 区分 */
  `CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    customer_id INTEGER,
    type        TEXT NOT NULL,
    amount      REAL NOT NULL DEFAULT 0,
    plan_date   TEXT,
    actual_date TEXT,
    method      TEXT NOT NULL DEFAULT '',
    plan_id     INTEGER,
    voucher     TEXT NOT NULL DEFAULT '',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )`,

  /* 8. 待办事项 */
  `CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    customer_id INTEGER,
    project_id  INTEGER,
    due_at      TEXT,
    priority    TEXT NOT NULL DEFAULT '中',
    status      TEXT NOT NULL DEFAULT '待办',
    done_at     TEXT,
    source      TEXT NOT NULL DEFAULT '手动',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 9. 附件 */
  `CREATE TABLE IF NOT EXISTS attachments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL,
    owner_id   INTEGER NOT NULL,
    file_name  TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    file_size  INTEGER NOT NULL DEFAULT 0,
    mime_type  TEXT NOT NULL DEFAULT '',
    category   TEXT NOT NULL DEFAULT '其他',
    remark     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  /* 10. 操作日志 */
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  )`,

  /* 11. 字典 —— 全部下拉选项，可在界面自定义增删改 */
  `CREATE TABLE IF NOT EXISTS dict (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    value      TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_system  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  /* 12. 系统设置 */
  `CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    remark     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,

  /* 13. 行政区划（客户分布统计与"地址→地州"归属用；数据来自 server/data/region.json，纯本地） */
  `CREATE TABLE IF NOT EXISTS region (
    code           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    level          TEXT NOT NULL,
    parent_code    TEXT NOT NULL DEFAULT '',
    longitude      REAL,
    latitude       REAL,
    geojson_path   TEXT NOT NULL DEFAULT '',
    sort           INTEGER NOT NULL DEFAULT 0,
    customer_count INTEGER NOT NULL DEFAULT 0
  )`,

  /* 14. 成本台账（v9 新增）
   * 利润口径：利润 = 已收 − 采购成本 − 维护成本 − 差旅 − 其他。
   * 采购成本按笔登记（可选供应商），报表按 spent_at 归月/归年。 */
  `CREATE TABLE IF NOT EXISTS costs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    project_id  INTEGER,
    category    TEXT NOT NULL DEFAULT '其他',
    amount      REAL NOT NULL DEFAULT 0,
    spent_at    TEXT NOT NULL DEFAULT '',
    supplier    TEXT NOT NULL DEFAULT '',
    remark      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  )`,

  /* 15. 产品分类（v11 新增）—— 价目表的分类树，可无限层级。
   *     is_system=1 的内置分类（蝶阀/球阀/…）可改名、可排序，但不可删除。 */
  `CREATE TABLE IF NOT EXISTS product_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id  INTEGER,
    name       TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0,
    is_system  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  /* 16. 产品（v11 新增）—— 价目表主表。
   *     折后价不落库：net_price = round(price × (1 − discount/100), 2) 由查询时计算，
   *     避免单价或折扣改动后出现两份对不上的数字。 */
  `CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id     INTEGER NOT NULL,
    name            TEXT NOT NULL,
    code            TEXT NOT NULL DEFAULT '',
    unit            TEXT NOT NULL DEFAULT '台',
    price           REAL NOT NULL DEFAULT 0,
    lead_time_days  INTEGER NOT NULL DEFAULT 0,
    lead_time_weeks REAL NOT NULL DEFAULT 0,
    body_material   TEXT NOT NULL DEFAULT '',
    pressure_rating TEXT NOT NULL DEFAULT '',
    discount        REAL NOT NULL DEFAULT 0,
    remark          TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    sort            INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
  )`,
];

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_customers_name           ON customers(name)',
  'CREATE INDEX IF NOT EXISTS idx_customers_short_name     ON customers(short_name)',
  'CREATE INDEX IF NOT EXISTS idx_customers_industry       ON customers(industry)',
  'CREATE INDEX IF NOT EXISTS idx_customers_next_follow    ON customers(next_follow_at)',
  /* 注意：customer_no 索引不放在这里 —— 老库（v9）还没有该列，
     而建索引发生在迁移之前，会报 no such column。
     这些索引在 v10 迁移脚本内部创建。 */
  /* 注意：1.27（v16）已删除「一客户一项目」的部分唯一索引
     uq_projects_customer_current，一个客户允许同时有多个进行中项目；
     项目名唯一性改由服务层在「同一客户 + 未归档」范围内校验。 */
  /* 注意：region_code 的索引同样在 v3 迁移脚本内部创建（原因相同）。 */
  'CREATE INDEX IF NOT EXISTS idx_customers_deleted        ON customers(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_customer        ON contacts(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_deleted         ON contacts(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_customer_tags_customer   ON customer_tags(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_customer_tags_tag        ON customer_tags(tag_id)',
  'CREATE INDEX IF NOT EXISTS idx_followups_customer       ON followups(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_followups_project        ON followups(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_followups_followed_at    ON followups(followed_at)',
  'CREATE INDEX IF NOT EXISTS idx_projects_customer        ON projects(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_projects_stage           ON projects(stage)',
  'CREATE INDEX IF NOT EXISTS idx_projects_bid_date        ON projects(bid_date)',
  'CREATE INDEX IF NOT EXISTS idx_projects_deleted         ON projects(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_payments_project         ON payments(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_customer        ON payments(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_payments_type            ON payments(type)',
  'CREATE INDEX IF NOT EXISTS idx_payments_plan_date       ON payments(plan_date)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_status             ON tasks(status)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_due_at             ON tasks(due_at)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_customer           ON tasks(customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_project            ON tasks(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_deleted            ON tasks(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_owner        ON attachments(owner_type, owner_id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_deleted      ON attachments(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_logs_entity              ON activity_logs(entity_type, entity_id)',
  'CREATE INDEX IF NOT EXISTS idx_logs_created             ON activity_logs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_dict_category            ON dict(category, sort)',
  'CREATE INDEX IF NOT EXISTS idx_dict_deleted             ON dict(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_region_parent            ON region(parent_code)',
  /* 成本台账（v9）：按客户/项目查，按发生日期做月/年报表 */
  'CREATE INDEX IF NOT EXISTS idx_costs_customer           ON costs(customer_id, spent_at)',
  'CREATE INDEX IF NOT EXISTS idx_costs_project            ON costs(project_id, spent_at)',
  'CREATE INDEX IF NOT EXISTS idx_costs_spent              ON costs(spent_at)',
  'CREATE INDEX IF NOT EXISTS idx_costs_category           ON costs(category)',
  /* 产品价目表（v11）：分类树按父级排序，产品按分类排序 / 名称 / 启用 / 软删除查 */
  'CREATE INDEX IF NOT EXISTS idx_product_categories_parent ON product_categories(parent_id, sort)',
  'CREATE INDEX IF NOT EXISTS idx_products_category         ON products(category_id, sort)',
  'CREATE INDEX IF NOT EXISTS idx_products_name             ON products(name)',
  'CREATE INDEX IF NOT EXISTS idx_products_enabled          ON products(enabled)',
  'CREATE INDEX IF NOT EXISTS idx_products_deleted          ON products(deleted_at)',
];

/* ------------------------------------------------------------------ */
/* 固定标签（1.23 内置，由代码常量维护，不加数据库列）                    */
/*                                                                     */
/* 约定：这 5 个标签在任何库里都必须存在（迁移时种入）；界面据此禁用删除， */
/*       自定义标签随意增删。名称即标识，改名后会被视为自定义标签。        */
/* ------------------------------------------------------------------ */

const FIXED_TAGS = [
  { name: '重点客户', color: '#dc2626', sort: 10 },
  { name: '老客户', color: '#0ea5e9', sort: 20 },
  { name: '待回访', color: '#f59e0b', sort: 30 },
  { name: '已成交', color: '#16a34a', sort: 40 },
  { name: '暂停合作', color: '#64748b', sort: 50 }
];

const FIXED_TAG_NAMES = FIXED_TAGS.map((t) => t.name);

/* ------------------------------------------------------------------ */
/* 产品分类种子（1.24 · v11；1.24.2 · v13 起三级）                       */
/*                                                                     */
/* 层级：一级 = 阀门大类（固定 6 个，is_system=1，可改名不可删）            */
/*       二级 = 按结构（is_system=0，可改名 / 挪位 / 删除）                 */
/*       三级 = 按连接/法兰安装方式（同二级，自定义）                      */
/*                                                                     */
/* 结构：有子级的节点写成 { name, children: [...] }，叶子节点可写成字符串。  */
/* 层级顺序即排序（同级序号 × 10），合计 6 + 22 + 46 = 74 个。              */
/* 全新安装（fromVersion=0）与老库升级（v11 迁移）都走 seedProductCategories， */
/* 仅在 product_categories 表为空时灌入，因此天然幂等。                   */
/* ------------------------------------------------------------------ */

const PRODUCT_CATEGORY_SEED = [
  {
    name: '蝶阀',
    children: [
      { name: '衬胶蝶阀', children: ['对夹', '法兰', '支耳'] },
      { name: '双偏心蝶阀', children: ['对夹', '法兰', '支耳'] },
      { name: '三偏心蝶阀', children: ['对夹', '法兰', '支耳'] }
    ]
  },
  {
    name: '球阀',
    children: [
      { name: '浮动球阀', children: ['法兰', '螺纹', '焊接'] },
      { name: '固定球阀', children: ['法兰', '螺纹', '焊接'] },
      { name: '三通球阀', children: ['法兰', '螺纹', '焊接'] },
      { name: '全焊接球阀', children: ['法兰', '焊接'] }
    ]
  },
  {
    name: '止回阀',
    children: [
      { name: '旋启式止回阀', children: ['法兰', '对夹', '焊接'] },
      { name: '升降式止回阀', children: ['法兰', '螺纹'] },
      { name: '对夹式止回阀', children: ['对夹', '法兰'] },
      { name: '双瓣式止回阀', children: ['对夹', '法兰'] }
    ]
  },
  {
    name: '隔膜阀',
    children: [
      { name: '堰式隔膜阀', children: ['法兰', '螺纹'] },
      { name: '直通式隔膜阀', children: ['法兰', '螺纹'] },
      { name: '衬氟隔膜阀', children: ['法兰'] }
    ]
  },
  {
    name: '刀闸阀',
    children: [
      { name: '手动刀闸阀', children: ['法兰', '对夹'] },
      { name: '气动刀闸阀', children: ['法兰', '对夹'] },
      { name: '电动刀闸阀', children: ['法兰', '对夹'] },
      { name: '浆液专用刀闸阀', children: ['法兰'] }
    ]
  },
  {
    name: '执行器',
    children: [
      { name: '气动执行器', children: ['法兰连接', '支架连接'] },
      { name: '电动执行器', children: ['法兰连接', '支架连接'] },
      { name: '电液联动执行器', children: ['法兰连接'] },
      { name: '附件' }
    ]
  }
];

/** 种子节点名称（叶子可写成字符串） */
function seedName(node) {
  return typeof node === 'string' ? node : node.name;
}

/** 种子节点子级（叶子没有 children） */
function seedChildren(node) {
  return typeof node === 'string' ? [] : (node.children || []);
}

/**
 * 1.24 的两级分类种子路径（v13 迁移据此归档旧二级示例）。
 * 说明：执行器 / 附件 同时是 v13 新种子的二级节点，迁移里会跳过，不归档。
 */
const OLD_SECOND_LEVEL_PATHS = [
  '蝶阀 / 对夹式', '蝶阀 / 法兰式', '蝶阀 / 凸耳式', '蝶阀 / 焊接式',
  '球阀 / 浮动球', '球阀 / 固定球', '球阀 / 三通球', '球阀 / 全焊接',
  '止回阀 / 旋启式', '止回阀 / 升降式', '止回阀 / 对夹式', '止回阀 / 双瓣式',
  '隔膜阀 / 堰式', '隔膜阀 / 直通式', '隔膜阀 / 衬氟',
  '刀闸阀 / 手动', '刀闸阀 / 气动', '刀闸阀 / 电动', '刀闸阀 / 浆液专用',
  '执行器 / 气动', '执行器 / 电动', '执行器 / 电液联动', '执行器 / 附件'
];

/* ------------------------------------------------------------------ */
/* 结构迁移脚本                                                        */
/*                                                                     */
/* 约定：数组下标 + 1 = 目标版本号。例如 MIGRATIONS[1] 把库从 v1 升到 v2。 */
/* 执行顺序：先按最新结构 CREATE TABLE IF NOT EXISTS（新库直接是最终结构）， */
/*           再把旧库按版本号逐级迁移。                                  */
/* 说明：SQLite 不支持 DROP COLUMN 时回退方案是「建新表→搬数据→换名」，   */
/*       当前环境为 SQLite 3.53.4，支持 ALTER TABLE DROP COLUMN，直接用。 */
/* ------------------------------------------------------------------ */

/** 1.23 删掉的旧客户字段（顺序即删列顺序；不存在则跳过，可重入）
 *  说明：需求列出的 45/46 项之外，旧库还有 last_order_at（成交额同步的冗余列），
 *  新模型里已无「累计成交额」概念，一并删除，避免遗留列与新字段白名单不一致。 */
const DROPPED_CUSTOMER_COLUMNS = [
  'type', 'level', 'status', 'owner', 'phone', 'fax', 'website', 'wechat',
  'credit_code', 'zip_code', 'enterprise_nature', 'parent_group', 'scale',
  'founded_at', 'employees', 'legal_person', 'is_listed', 'purchase_mode',
  'end_user', 'design_institute', 'epc_contractor', 'valve_types', 'drive_mode',
  'body_material', 'pressure_rating', 'size_range', 'design_standard',
  'connection_type', 'cert_required', 'annual_demand', 'purchase_cycle',
  'account_period', 'warranty_ratio', 'warranty_months', 'payer',
  'tender_platform', 'qualification', 'has_ts_license', 'has_explosion_proof',
  'quality_grade', 'supplier_code', 'credit_rating', 'introducer', 'competitor',
  'deal_amount', 'customer_since', 'last_order_at'
];

const MIGRATIONS = [
  /* v1 → v2：删除客户表的「注册资金」字段（按需求移除，不再使用） */
  {
    version: 2,
    note: '删除 customers.reg_capital 字段',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
      if (cols.includes('reg_capital')) {
        db.exec('ALTER TABLE customers DROP COLUMN reg_capital');
        return '已删除列 reg_capital';
      }
      return '列 reg_capital 不存在，跳过';
    }
  },

  /* v2 → v3：客户表增加行政区划归属（地图统计与筛选使用） */
  {
    version: 3,
    note: '客户表增加 region_code / region_name 字段',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
      const added = [];
      if (!cols.includes('region_code')) {
        db.exec("ALTER TABLE customers ADD COLUMN region_code TEXT NOT NULL DEFAULT ''");
        added.push('region_code');
      }
      if (!cols.includes('region_name')) {
        db.exec("ALTER TABLE customers ADD COLUMN region_name TEXT NOT NULL DEFAULT ''");
        added.push('region_name');
      }
      /* 建立索引，地图统计与按区域筛选都要用 */
      db.exec("CREATE INDEX IF NOT EXISTS idx_customers_region ON customers(region_code)");

      /* 已有数据回填：按客户所在城市名称匹配行政区划 */
      let filled = 0;
      try {
        const rows = db.prepare(
          `SELECT id, city, district FROM customers
           WHERE deleted_at IS NULL AND (region_code IS NULL OR region_code = '')`
        ).all();
        const findByDistrict = db.prepare(
          "SELECT code, name, parent_code FROM region WHERE level = 'district' AND name = ? LIMIT 1"
        );
        const findByCity = db.prepare(
          "SELECT code, name FROM region WHERE level = 'city' AND (name = ? OR name LIKE ?) LIMIT 1"
        );
        const upd = db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?');

        for (const r of rows) {
          const city = String(r.city || '').replace(/(市|地区|自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|回族自治州)$/, '');
          const dist = String(r.district || '');
          let hit = null;

          /* 先按区县精确匹配（更细），再按地州匹配 */
          if (dist) {
            const d = findByDistrict.get(dist)
              || findByDistrict.get(dist.replace(/(区|县|市)$/, ''));
            if (d) hit = { code: d.parent_code, name: '' };
          }
          if (!hit && city) {
            const c = findByCity.get(r.city, city + '%');
            if (c) hit = { code: c.code, name: c.name };
          }
          if (hit) {
            /* 补齐区域名称 */
            const nm = hit.name || (db.prepare('SELECT name FROM region WHERE code = ?').get(hit.code) || {}).name || '';
            upd.run(hit.code, nm, r.id);
            filled++;
          }
        }
      } catch (_) { /* 首次迁移时 region 表可能还没有数据，忽略 */ }

      return `新增列 ${added.join('、') || '无'}${filled ? `，回填 ${filled} 条客户归属` : ''}`;
    }
  },

  /* v3 → v4：招标信息采集模块（邮件订阅解析路线）
   * 新增 3 张表 + 项目表 5 个溯源字段。
   * 注意：本模块默认关闭，且只实现订阅邮件解析；不写任何库内数据即可安全回退。 */
  {
    version: 4,
    note: '新增招标采集模块：collect_sources / collect_staging / collect_logs 与项目表溯源字段',
    run(db) {
      const created = [];

      db.exec(`CREATE TABLE IF NOT EXISTS collect_sources (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL,
        type           TEXT NOT NULL DEFAULT 'subscription',
        enabled        INTEGER NOT NULL DEFAULT 0,
        config_json    TEXT NOT NULL DEFAULT '{}',
        last_run_at    TEXT NOT NULL DEFAULT '',
        last_status    TEXT NOT NULL DEFAULT '',
        last_message   TEXT NOT NULL DEFAULT '',
        last_new_count INTEGER NOT NULL DEFAULT 0,
        last_upd_count INTEGER NOT NULL DEFAULT 0,
        fail_streak    INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        deleted_at     TEXT
      )`);
      created.push('collect_sources');

      db.exec(`CREATE TABLE IF NOT EXISTS collect_staging (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id          INTEGER,
        source_name        TEXT NOT NULL DEFAULT '',
        notice_id          TEXT NOT NULL DEFAULT '',
        title              TEXT NOT NULL DEFAULT '',
        project_name       TEXT NOT NULL DEFAULT '',
        project_code       TEXT NOT NULL DEFAULT '',
        region_code        TEXT NOT NULL DEFAULT '',
        region_name        TEXT NOT NULL DEFAULT '',
        location           TEXT NOT NULL DEFAULT '',
        amount             REAL,
        industry           TEXT NOT NULL DEFAULT '',
        tenderee           TEXT NOT NULL DEFAULT '',
        agency             TEXT NOT NULL DEFAULT '',
        design_institute   TEXT NOT NULL DEFAULT '',
        bid_date           TEXT NOT NULL DEFAULT '',
        notice_type        TEXT NOT NULL DEFAULT '',
        source_url         TEXT NOT NULL DEFAULT '',
        source_platform    TEXT NOT NULL DEFAULT '',
        mail_subject       TEXT NOT NULL DEFAULT '',
        mail_from          TEXT NOT NULL DEFAULT '',
        mail_date          TEXT NOT NULL DEFAULT '',
        mail_uid           TEXT NOT NULL DEFAULT '',
        raw_excerpt        TEXT NOT NULL DEFAULT '',
        has_personal_info  INTEGER NOT NULL DEFAULT 0,
        personal_fields    TEXT NOT NULL DEFAULT '',
        keyword_hits       TEXT NOT NULL DEFAULT '',
        matched_customer   TEXT NOT NULL DEFAULT '',
        match_score        INTEGER NOT NULL DEFAULT 0,
        content_hash       TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'pending',
        reject_reason      TEXT NOT NULL DEFAULT '',
        project_id         INTEGER,
        collected_at       TEXT NOT NULL,
        reviewed_at        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        deleted_at         TEXT
      )`);
      created.push('collect_staging');

      db.exec(`CREATE TABLE IF NOT EXISTS collect_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id   INTEGER,
        source_name TEXT NOT NULL DEFAULT '',
        level       TEXT NOT NULL DEFAULT 'info',
        action      TEXT NOT NULL DEFAULT '',
        message     TEXT NOT NULL DEFAULT '',
        detail      TEXT NOT NULL DEFAULT '',
        item_count  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      )`);
      created.push('collect_logs');

      /* 索引 */
      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_collect_sources_enabled  ON collect_sources(enabled, deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_status   ON collect_staging(status, deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_notice   ON collect_staging(notice_id)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_hash     ON collect_staging(content_hash)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_source   ON collect_staging(source_id)',
        'CREATE INDEX IF NOT EXISTS idx_collect_staging_collect  ON collect_staging(collected_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_logs_created     ON collect_logs(created_at)',
        'CREATE INDEX IF NOT EXISTS idx_collect_logs_source      ON collect_logs(source_id)'
      ]) db.exec(sql);

      /* 项目表溯源字段：采集入库的项目必须能追到来源 */
      const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
      const addCols = [
        ['source_url', "TEXT NOT NULL DEFAULT ''"],
        ['source_platform', "TEXT NOT NULL DEFAULT ''"],
        ['collected_at', "TEXT NOT NULL DEFAULT ''"],
        ['source_notice_id', "TEXT NOT NULL DEFAULT ''"],
        ['confidence', 'INTEGER NOT NULL DEFAULT 0']
      ];
      const added = [];
      for (const [name, def] of addCols) {
        if (!cols.includes(name)) {
          db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`);
          added.push(name);
        }
      }

      /* 采集来源初始全部禁用（附录 A.5 铁律二：默认关闭） */
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const preset = [
        ['新疆公共资源交易网 · 邮件订阅', '{"platform":"新疆公共资源交易网","keywords":"阀门,球阀,闸阀,蝶阀,截止阀,止回阀,调节阀","region":"新疆"}'],
        ['中国政府采购网 · 邮件订阅', '{"platform":"中国政府采购网","keywords":"阀门,球阀,闸阀","region":"新疆"}'],
        ['各地州公共资源交易网 · 邮件订阅', '{"platform":"地州交易网","keywords":"阀门,球阀,闸阀","region":"新疆"}']
      ];
      let presetAdded = 0;
      const exists = db.prepare('SELECT id FROM collect_sources WHERE name = ?');
      const ins = db.prepare(`INSERT INTO collect_sources (name, type, enabled, config_json, created_at, updated_at)
                              VALUES (?, 'subscription', 0, ?, ?, ?)`);
      for (const [name, cfg] of preset) {
        if (!exists.get(name)) { ins.run(name, cfg, now, now); presetAdded++; }
      }

      return `新增表 ${created.join('、')}；项目表新增列 ${added.join('、') || '无'}；预置来源 ${presetAdded} 个（默认禁用）`;
    }
  },

  /* v4 → v5：报价单管理
   * 新增 quotations（报价单主表）与 quotation_items（明细行）两张表。
   * 纯建表，不改动任何既有表的列，因此可安全回退（删表即可，数据无损失）。 */
  {
    version: 5,
    note: '新增报价单管理：quotations / quotation_items 两张表',
    run(db) {
      const created = [];

      db.exec(`CREATE TABLE IF NOT EXISTS quotations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id       INTEGER NOT NULL,
        customer_id      INTEGER,
        quote_no         TEXT NOT NULL DEFAULT '',
        version          INTEGER NOT NULL DEFAULT 1,
        parent_id        INTEGER,
        quote_date       TEXT NOT NULL DEFAULT '',
        valid_until      TEXT NOT NULL DEFAULT '',
        currency         TEXT NOT NULL DEFAULT '人民币',
        status           TEXT NOT NULL DEFAULT '草稿',
        total_amount     REAL NOT NULL DEFAULT 0,
        tax_note         TEXT NOT NULL DEFAULT '',
        delivery_note    TEXT NOT NULL DEFAULT '',
        payment_note     TEXT NOT NULL DEFAULT '',
        competitor       TEXT NOT NULL DEFAULT '',
        competitor_price REAL NOT NULL DEFAULT 0,
        lose_reason      TEXT NOT NULL DEFAULT '',
        remark           TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        deleted_at       TEXT
      )`);
      created.push('quotations');

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        quotation_id    INTEGER NOT NULL,
        seq             INTEGER NOT NULL DEFAULT 1,
        item_name       TEXT NOT NULL DEFAULT '',
        valve_type      TEXT NOT NULL DEFAULT '',
        size_range      TEXT NOT NULL DEFAULT '',
        pressure_rating TEXT NOT NULL DEFAULT '',
        body_material   TEXT NOT NULL DEFAULT '',
        connection_type TEXT NOT NULL DEFAULT '',
        quantity        REAL NOT NULL DEFAULT 0,
        unit            TEXT NOT NULL DEFAULT '台',
        unit_price      REAL NOT NULL DEFAULT 0,
        discount        REAL NOT NULL DEFAULT 0,
        subtotal        REAL NOT NULL DEFAULT 0,
        delivery_days   INTEGER NOT NULL DEFAULT 0,
        remark          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      )`);
      created.push('quotation_items');

      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_quotations_project   ON quotations(project_id)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_customer  ON quotations(customer_id)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_status    ON quotations(status)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_no        ON quotations(quote_no)',
        'CREATE INDEX IF NOT EXISTS idx_quotations_deleted   ON quotations(deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_quo_items_quotation  ON quotation_items(quotation_id, seq)'
      ]) db.exec(sql);

      /* 报价单状态字典：与客户状态等一样进字典表，便于后续自定义 */
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const statuses = [
        ['草稿', '#94a3b8', 10],
        ['已报出', '#3b82f6', 20],
        ['已中标', '#22c55e', 30],
        ['已落标', '#ef4444', 40],
        ['已过期', '#a8a29e', 50]
      ];
      let dictAdded = 0;
      const findDict = db.prepare('SELECT id, deleted_at FROM dict WHERE category = ? AND value = ?');
      const insDict = db.prepare(
        `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
         VALUES ('quotation_status', ?, ?, ?, 1, 1, ?, ?)`
      );
      for (const [v, color, sort] of statuses) {
        const hit = findDict.get('quotation_status', v);
        if (!hit) { insDict.run(v, color, sort, now, now); dictAdded++; }
        else if (hit.deleted_at) {
          db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?').run(now, hit.id);
          dictAdded++;
        }
      }

      return `新增表 ${created.join('、')}；预置报价单状态字典 ${dictAdded} 项`;
    }
  },

  /* v5 → v6：报价模板
   * 新增 quotation_templates / quotation_template_items 两张表。
   * 纯建表，不改动任何既有表的列，可安全回退（删表即可）。 */
  {
    version: 6,
    note: '新增报价模板：quotation_templates / quotation_template_items 两张表',
    run(db) {
      const created = [];

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_templates (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        category      TEXT NOT NULL DEFAULT '',
        description   TEXT NOT NULL DEFAULT '',
        unit          TEXT NOT NULL DEFAULT '台',
        use_count     INTEGER NOT NULL DEFAULT 0,
        last_used_at  TEXT NOT NULL DEFAULT '',
        sort          INTEGER NOT NULL DEFAULT 0,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        deleted_at    TEXT
      )`);
      created.push('quotation_templates');

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_template_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id     INTEGER NOT NULL,
        seq             INTEGER NOT NULL DEFAULT 1,
        item_name       TEXT NOT NULL DEFAULT '',
        valve_type      TEXT NOT NULL DEFAULT '',
        size_range      TEXT NOT NULL DEFAULT '',
        pressure_rating TEXT NOT NULL DEFAULT '',
        body_material   TEXT NOT NULL DEFAULT '',
        connection_type TEXT NOT NULL DEFAULT '',
        quantity        REAL NOT NULL DEFAULT 1,
        unit            TEXT NOT NULL DEFAULT '台',
        delivery_days   INTEGER NOT NULL DEFAULT 0,
        remark          TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      )`);
      created.push('quotation_template_items');

      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_quotation_templates_sort  ON quotation_templates(sort, id)',
        'CREATE INDEX IF NOT EXISTS idx_quotation_templates_del   ON quotation_templates(deleted_at)',
        'CREATE INDEX IF NOT EXISTS idx_quotation_templates_cat   ON quotation_templates(category)',
        'CREATE INDEX IF NOT EXISTS idx_quo_tpl_items_template    ON quotation_template_items(template_id, seq)'
      ]) db.exec(sql);

      return `新增表 ${created.join('、')}`;
    }
  },

  /* v6 → v7：报价自定义列
   *
   * 做两件事：
   *   1. 新增 quotation_fields（列定义表）
   *   2. 给 quotation_items / quotation_template_items 各加一列 extra（JSON 值）
   *
   * 纯新增（不改既有列、不回填、不动既有数据），旧版本读这两张表时
   * 多出的 extra 列不影响既有查询；即便不恢复备份，删掉 extra 列也能退回 v6。 */
  {
    version: 7,
    note: '报价自定义列：新增 quotation_fields 表，明细表加 extra 列',
    run(db) {
      const done = [];

      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all()
        .some((c) => c.name === col);

      for (const table of ['quotation_items', 'quotation_template_items']) {
        if (!hasCol(table, 'extra')) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`);
          done.push(`${table}.extra`);
        }
      }

      db.exec(`CREATE TABLE IF NOT EXISTS quotation_fields (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'text',
        options     TEXT NOT NULL DEFAULT '',
        unit        TEXT NOT NULL DEFAULT '',
        sort        INTEGER NOT NULL DEFAULT 0,
        enabled     INTEGER NOT NULL DEFAULT 1,
        remark      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )`);
      done.push('quotation_fields');

      db.exec('CREATE INDEX IF NOT EXISTS idx_quotation_fields_sort ON quotation_fields(deleted_at, sort, id)');

      return `新增列 ${done.join('、')}`;
    }
  },

  /* v7 → v8：移除「招标采集」与「报价」两个模块（按使用者的明确要求整体删除）
   *
   * 删掉的东西：
   *   - 采集 3 张表：collect_sources / collect_staging / collect_logs
   *   - 报价 5 张表：quotations / quotation_items / quotation_templates /
   *                 quotation_template_items / quotation_fields
   *   - 项目表上"招标采集溯源"用的 5 列
   *     （source_url / source_platform / collected_at / source_notice_id / confidence）
   *   - 配套的设置项与字典项（报价单状态）
   *
   * 迁移前 initDatabase 会**自动整库备份**（backups/before-migrate-v7-*.db），
   * 万一以后还要这些数据，从那份备份里取即可。 */
  {
    version: 8,
    note: '移除招标采集与报价模块：删 8 张表、项目表 5 列、相关设置与字典',
    run(db) {
      const dropped = [];
      const tables = ['collect_logs', 'collect_staging', 'collect_sources',
        'quotation_template_items', 'quotation_templates',
        'quotation_items', 'quotations', 'quotation_fields'];
      for (const t of tables) {
        const exists = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(t);
        if (!exists) continue;
        db.exec(`DROP TABLE IF EXISTS ${t}`);
        dropped.push(t);
      }

      const projectCols = ['source_url', 'source_platform', 'collected_at', 'source_notice_id', 'confidence'];
      const has = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
      for (const c of projectCols) {
        if (!has.has(c)) continue;
        db.exec(`ALTER TABLE projects DROP COLUMN ${c}`);
        dropped.push(`projects.${c}`);
      }

      const keys = ['wechat_extra_hosts', 'collect_wechat_day', 'collect_wechat_count',
        'quotation_column_order', 'quotation_column_labels', 'quotation_column_hidden',
        'quote_no_prefix', 'quote_company', 'quote_contact'];
      let settingsCleaned = 0;
      for (const k of keys) {
        const r = db.prepare('DELETE FROM settings WHERE key = ?').run(k);
        settingsCleaned += r.changes || 0;
      }

      const dict = db.prepare("DELETE FROM dict WHERE category = 'quotation_status'").run();

      return `删除 ${dropped.join('、')}；清理设置 ${settingsCleaned} 项、字典 ${dict.changes || 0} 项`;
    }
  },

  /* v8 → v9：成本台账（1.22 新增）
   *
   * 首页要算"利润 = 已收 − 采购成本 − 维护成本 − 差旅 − 其他"，
   * 原来只有回款（payments）没有成本，所以新增 costs 表。
   * 纯建表，不动既有数据，可安全回退（删表即可）。 */
  {
    version: 9,
    note: '新增成本台账 costs（采购成本 / 维护成本 / 差旅 / 其他）',
    run(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS costs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        project_id  INTEGER,
        category    TEXT NOT NULL DEFAULT '其他',
        amount      REAL NOT NULL DEFAULT 0,
        spent_at    TEXT NOT NULL DEFAULT '',
        supplier    TEXT NOT NULL DEFAULT '',
        remark      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_costs_customer  ON costs(customer_id, spent_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_costs_project   ON costs(project_id, spent_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_costs_spent     ON costs(spent_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_costs_category  ON costs(category)');
      /* 地图模块 1.22 移除，顺手清掉它的设置项 */
      db.prepare("DELETE FROM settings WHERE key = 'map_approval_no'").run();
      return '新建 costs 表与 4 个索引；清理 map_approval_no 设置';
    }
  },

  /* v9 → v10：客户系统简洁化（1.23 · 一客户一项目）
   *
   * 做六件事（全部幂等，可重入）：
   *   1. customers 新增 6 列：customer_no / contact_name / contact_position /
   *      contact_phone / contact_birthday / follow_cycle_days
   *   2. customers 删掉 47 个旧列（含 45 个业务冗余列 + deal_amount / last_order_at），
   *      industry 保留；删列前先删掉旧列上的索引（SQLite 不允许带索引直接删列）
   *   3. projects 加 archived 列；同一客户多条「当前项目」时只保留最新一条，
   *      其余标 archived=1（历史项目，只读）
   *   4. （1.27 / v16 已撤销）原本在这里建「一客户一项目」部分唯一索引
   *      uq_projects_customer_current；v16 会删除该索引，新库也不再创建
   *   5. 建 customer_no 索引（新列上的索引不能放在 INDEXES 里，老库迁移前还没有该列）
   *   6. 种入 5 个固定标签（重点客户 / 老客户 / 待回访 / 已成交 / 暂停合作）
   *
   * 注意：本版**不清空业务数据**（旧数据由使用者在 1.22 → 1.23 之间自行清空）。
   *       老库里的客户/项目会保留；多余项目转为历史归档，不丢数据。
   */
  {
    version: 10,
    note: '客户精简：加 6 列、删 47 个旧列、projects.archived、5 个固定标签（1.27 起不再建一客户一项目唯一索引）',
    run(db) {
      const done = [];

      /* ---------- 1. 新增客户列 ---------- */
      const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all()
        .some((c) => c.name === col);
      const addCols = [
        ['customer_no', "TEXT NOT NULL DEFAULT ''"],
        ['contact_name', "TEXT NOT NULL DEFAULT ''"],
        ['contact_position', "TEXT NOT NULL DEFAULT ''"],
        ['contact_phone', "TEXT NOT NULL DEFAULT ''"],
        ['contact_birthday', "TEXT NOT NULL DEFAULT ''"],
        ['follow_cycle_days', 'INTEGER NOT NULL DEFAULT 0']
      ];
      const added = [];
      for (const [name, def] of addCols) {
        if (!hasCol('customers', name)) {
          db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${def}`);
          added.push(name);
        }
      }
      if (added.length) done.push(`新增列 ${added.join('、')}`);

      /* ---------- 1b. 老客户回填客户编号（KH-YYYY-####，按建档年份排） ---------- */
      if (added.includes('customer_no')) {
        const empties = db.prepare(
          "SELECT id, created_at FROM customers WHERE customer_no IS NULL OR customer_no = '' ORDER BY id"
        ).all();
        if (empties.length) {
          const maxOf = db.prepare(
            "SELECT customer_no FROM customers WHERE customer_no LIKE ? ORDER BY LENGTH(customer_no) DESC, customer_no DESC LIMIT 1"
          );
          const upd = db.prepare('UPDATE customers SET customer_no = ? WHERE id = ?');
          const seq = {};
          for (const r of empties) {
            const year = String(r.created_at || '').slice(0, 4) || String(new Date().getFullYear());
            if (seq[year] === undefined) {
              const hit = maxOf.get(`KH-${year}-%`);
              const n = hit ? Number(String(hit.customer_no).split('-')[2]) || 0 : 0;
              seq[year] = n;
            }
            seq[year] += 1;
            upd.run(`KH-${year}-${String(seq[year]).padStart(4, '0')}`, r.id);
          }
          done.push(`回填客户编号 ${empties.length} 条`);
        }
      }

      /* ---------- 2. 删除旧列（先删这些列上的旧索引） ---------- */
      for (const idx of ['idx_customers_phone', 'idx_customers_status',
        'idx_customers_type', 'idx_customers_supplier_code']) {
        db.exec(`DROP INDEX IF EXISTS ${idx}`);
      }
      const dropped = [];
      for (const col of DROPPED_CUSTOMER_COLUMNS) {
        if (!hasCol('customers', col)) continue;
        db.exec(`ALTER TABLE customers DROP COLUMN ${col}`);
        dropped.push(col);
      }
      if (dropped.length) done.push(`删除旧列 ${dropped.length} 个`);

      /* ---------- 3. projects.archived + 归档多余项目 ---------- */
      if (!hasCol('projects', 'archived')) {
        db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
        done.push('projects 新增列 archived');
      }
      /* 每个客户只保留最新的一条「当前项目」，其余转历史（按 updated_at、id 倒序） */
      const rows = db.prepare(`
        SELECT id, customer_id FROM projects
        WHERE deleted_at IS NULL AND archived = 0
        ORDER BY customer_id ASC, updated_at DESC, id DESC
      `).all();
      const seen = new Set();
      const toArchive = [];
      for (const r of rows) {
        if (seen.has(r.customer_id)) toArchive.push(r.id);
        else seen.add(r.customer_id);
      }
      for (const id of toArchive) {
        db.prepare('UPDATE projects SET archived = 1 WHERE id = ?').run(id);
      }
      if (toArchive.length) done.push(`归档多余项目 ${toArchive.length} 个`);

      /* ---------- 4. 一客户一项目唯一索引（1.27 / v16 起撤销，不再创建） ----------
       * 历史说明：v10 曾在这里建部分唯一索引 uq_projects_customer_current；
       * 1.27 改成一个客户可同时有多个进行中项目，v16 迁移会 DROP 掉老库里的这个索引。
       * 新库走到这里时直接跳过，保持与 v16 之后的结构一致。 */

      /* ---------- 5. 新列上的索引 ---------- */
      db.exec('CREATE INDEX IF NOT EXISTS idx_customers_customer_no ON customers(customer_no)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_customers_contact_name ON customers(contact_name)');

      /* ---------- 6. 固定标签 ---------- */
      const ts = now();
      const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
      const insTag = db.prepare(
        'INSERT INTO tags (name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      const tagAdded = [];
      for (const t of FIXED_TAGS) {
        if (findTag.get(t.name)) continue;
        insTag.run(t.name, t.color, t.sort, ts, ts);
        tagAdded.push(t.name);
      }
      if (tagAdded.length) done.push(`种入固定标签 ${tagAdded.join('、')}`);

      return done.length ? done.join('；') : '结构已是最新，无需变更';
    }
  },

  /* v10 → v11：产品价目表（1.24）
   *
   * 纯新增，不动任何既有表：新建 product_categories / products 两张表 + 5 个索引，
   * 再灌入 6 个一级（is_system=1，不可删）+ 23 个二级示例（is_system=0，可删可改）。
   * 因为全是新表，迁移可安全回退（删表即可），旧数据一条不受影响。
   *
   * 注意：全新安装不会走到这里（fromVersion=0），由 initDatabase 里的
   * seedProductCategories(db) 负责灌同一份种子，两边逻辑共用、幂等。 */
  {
    version: 11,
    note: '新增产品价目表：product_categories / products 两张表 + 6 个一级 / 23 个二级示例分类',
    run(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS product_categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id  INTEGER,
        name       TEXT NOT NULL,
        sort       INTEGER NOT NULL DEFAULT 0,
        is_system  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )`);

      db.exec(`CREATE TABLE IF NOT EXISTS products (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id     INTEGER NOT NULL,
        name            TEXT NOT NULL,
        code            TEXT NOT NULL DEFAULT '',
        unit            TEXT NOT NULL DEFAULT '台',
        price           REAL NOT NULL DEFAULT 0,
        lead_time_days  INTEGER NOT NULL DEFAULT 0,
        body_material   TEXT NOT NULL DEFAULT '',
        pressure_rating TEXT NOT NULL DEFAULT '',
        discount        REAL NOT NULL DEFAULT 0,
        remark          TEXT NOT NULL DEFAULT '',
        enabled         INTEGER NOT NULL DEFAULT 1,
        sort            INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        deleted_at      TEXT
      )`);

      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_product_categories_parent ON product_categories(parent_id, sort)',
        'CREATE INDEX IF NOT EXISTS idx_products_category         ON products(category_id, sort)',
        'CREATE INDEX IF NOT EXISTS idx_products_name             ON products(name)',
        'CREATE INDEX IF NOT EXISTS idx_products_enabled          ON products(enabled)',
        'CREATE INDEX IF NOT EXISTS idx_products_deleted          ON products(deleted_at)'
      ]) db.exec(sql);

      const added = seedProductCategories(db);
      return `新增表 product_categories、products 与 5 个索引；灌入内置分类 ${added} 个`;
    }
  },

  /* v11 → v12：二级分类改为自定义（可删除）
   * 1.24 最初把 23 个二级示例也标成了 is_system=1（不可删）；使用者要求
   * 「产品子目录改成自定义、可删除」，因此只保留 6 个一级分类为系统分类，
   * 所有二级及以下一律降级为普通自定义分类（可改名、可挪位、可删除）。 */
  {
    version: 12,
    note: '产品二级分类改为自定义分类（is_system 1 → 0），可删除',
    run(db) {
      const before = db.prepare(`SELECT COUNT(*) AS n FROM product_categories
        WHERE parent_id IS NOT NULL AND is_system = 1`).get().n;
      if (!before) return '没有需要降级的二级分类';
      db.prepare(`UPDATE product_categories SET is_system = 0, updated_at = ?
        WHERE parent_id IS NOT NULL AND is_system = 1`).run(now());
      return `二级分类改为自定义 ${before} 个`;
    }
  },

  /* v12 → v13：分类扩为三级（1.24.2）
   *
   * 目标结构：一级＝阀门大类（6 个，固定）；二级＝按结构（22 个）；三级＝按连接/
   * 法兰安装方式（46 个），合计 74 个。二三级都是自定义分类（is_system=0）。
   *
   * 做两件事，全部幂等、可重入：
   *   1. 按种子路径逐层「缺则补」：一级按名称找，缺则插入；二级在对应一级下按名称
   *      找，缺则插入；三级同理。sort = 同级种子序号 × 10。一级补齐时确保 is_system=1。
   *   2. 归档 1.24 的旧二级示例（23 条旧路径，如「蝶阀 / 对夹式」）：只软删除
   *      **名字与父级都匹配旧种子**、**没有产品、没有未删除子分类**的行。
   *      - 用户改过名的 → 路径不匹配，保留；
   *      - 已挂产品的 → 保留（不硬删，产品照常可查）；
   *      - 加了子分类的 → 保留（避免连带丢失用户内容）；
   *      - 「执行器 / 附件」同时是新种子的二级节点 → 不在归档范围。
   *
   * 空库/纯种子库（v12 的 6 + 23）迁移完成后：6 + 22 + 46 = 74 个存活分类。 */
  {
    version: 13,
    note: '产品分类扩为三级（6 / 22 / 46 = 74）：补齐二级与三级，归档 1.24 的旧二级示例',
    run(db) {
      const ts = now();
      const added = { root: 0, second: 0, third: 0 };
      const find = db.prepare(`SELECT id, is_system FROM product_categories
        WHERE deleted_at IS NULL AND parent_id IS ? AND name = ? LIMIT 1`);
      const ins = db.prepare(`INSERT INTO product_categories
        (parent_id, name, sort, is_system, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const markSystem = db.prepare(
        'UPDATE product_categories SET is_system = 1, updated_at = ? WHERE id = ?'
      );

      /* ---------- 1. 递归补齐种子路径 ---------- */
      const walk = (nodes, parentId, depth) => {
        nodes.forEach((node, i) => {
          const name = seedName(node);
          const hit = find.get(parentId, name);
          let id;
          if (hit) {
            id = Number(hit.id);
            /* 一级必须是系统分类（老库里理论上是 1，这里兜底，幂等） */
            if (depth === 0 && Number(hit.is_system) !== 1) markSystem.run(ts, id);
          } else {
            const r = ins.run(parentId, name, (i + 1) * 10, depth === 0 ? 1 : 0, ts, ts);
            id = Number(r.lastInsertRowid);
            if (depth === 0) added.root++;
            else if (depth === 1) added.second++;
            else added.third++;
          }
          const children = seedChildren(node);
          if (children.length) walk(children, id, depth + 1);
        });
      };
      walk(PRODUCT_CATEGORY_SEED, null, 0);

      /* ---------- 2. 归档旧二级示例（软删除） ---------- */
      const newPaths = new Set();
      for (const root of PRODUCT_CATEGORY_SEED) {
        for (const child of seedChildren(root)) {
          newPaths.add(`${root.name} / ${seedName(child)}`);
        }
      }
      const findOldPath = db.prepare(`SELECT c.id
        FROM product_categories c
        JOIN product_categories p ON p.id = c.parent_id
        WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL
          AND p.name = ? AND c.name = ?`);
      const countProducts = db.prepare(`SELECT COUNT(*) AS n FROM products
        WHERE deleted_at IS NULL AND category_id = ?`);
      const countChildren = db.prepare(`SELECT COUNT(*) AS n FROM product_categories
        WHERE deleted_at IS NULL AND parent_id = ?`);
      const softDelete = db.prepare(
        'UPDATE product_categories SET deleted_at = ?, updated_at = ? WHERE id = ?'
      );

      let archived = 0;
      let kept = 0;
      for (const p of OLD_SECOND_LEVEL_PATHS) {
        if (newPaths.has(p)) continue;              // 新种子沿用的节点（执行器 / 附件）
        const [rootName, catName] = p.split(' / ');
        const row = findOldPath.get(rootName, catName);
        if (!row) continue;                          // 改过名 / 已删：保留现状
        if (countProducts.get(row.id).n > 0 || countChildren.get(row.id).n > 0) {
          kept++;                                    // 有产品或子级：保留，不硬删
          continue;
        }
        softDelete.run(ts, ts, row.id);
        archived++;
      }

      const total = db.prepare(
        'SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL'
      ).get().n;

      const parts = [];
      if (added.root) parts.push(`补一级 ${added.root} 个`);
      parts.push(`补二级 ${added.second} 个`, `补三级 ${added.third} 个`,
        `归档旧二级示例 ${archived} 个`);
      if (kept) parts.push(`保留有产品或子级的旧示例 ${kept} 个`);
      parts.push(`当前存活分类 ${total} 个`);
      return parts.join('、');
    }
  },

  /* v13 → v14：待办状态归一
   * 1.25 之前接口不校验 status，传「待处理」也能写库；而所有视图与首页统计只认「待办」，
   * 这类待办会彻底消失（列表、今日待办、项目计数都看不到）。这里把历史脏状态改成标准值。 */
  {
    version: 14,
    note: '待办状态归一（待处理/未完成/进行中 → 待办），修正状态不合法导致待办不可见',
    run(db) {
      const rows = db.prepare(`SELECT id, status FROM tasks
        WHERE status IS NULL OR status NOT IN ('待办', '已完成', '已取消')`).all();
      if (!rows.length) return '没有需要修正的待办状态';
      const alias = { 待处理: '待办', 未完成: '待办', 进行中: '待办', 完成: '已完成', 取消: '已取消' };
      const upd = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
      const ts = now();
      for (const r of rows) upd.run(alias[String(r.status || '').trim()] || '待办', ts, r.id);
      return `修正待办状态 ${rows.length} 条`;
    }
  },

  /* v14 → v15：产品货期按周精确存储（1.26.1）
   *
   * 背景：1.26.0 只存整天 lead_time_days，3.5 周写入 25 天后回显 25/7=3.6 周，
   * 与用户按周填写的值对不上。加一列 lead_time_weeks 原样保存周数；
   * lead_time_days 保留（兼容旧字段/导出），仍由周数换算。
   * 老数据按 ROUND(days / 7.0, 1) 回填，例如 15 天→2.1、28 天→4。
   * 迁移可重入：列已存在时不重复 ALTER，只做回填。 */
  {
    version: 15,
    note: '产品货期增加按周精确存储 lead_time_weeks，并用旧 lead_time_days 回填',
    run(db) {
      const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
      let added = false;
      if (!cols.includes('lead_time_weeks')) {
        db.exec('ALTER TABLE products ADD COLUMN lead_time_weeks REAL NOT NULL DEFAULT 0');
        added = true;
      }
      const info = db.prepare(`UPDATE products
        SET lead_time_weeks = ROUND(lead_time_days / 7.0, 1)
        WHERE lead_time_weeks = 0 AND lead_time_days > 0`).run();
      return `新增列 ${added ? 'lead_time_weeks' : '已存在'}，回填周数 ${Number(info.changes) || 0} 条`;
    }
  },

  /* v15 → v16：一个客户可以同时有多个进行中项目（1.27）
   *
   * 1.23 的「一客户一项目」是靠部分唯一索引 uq_projects_customer_current 兜底的：
   *   UNIQUE(customer_id) WHERE deleted_at IS NULL AND archived = 0
   * 1.27 起一个客户允许有多个进行中项目（1:N），必须删掉这个索引，否则第二次
   * 新建项目会直接撞唯一约束。除此之外不改表、不动数据：
   *   · archived 语义保留：archived=1 仍是「历史项目」，不计入进行中，可恢复归档；
   *   · 回款 / 成本 / 待办仍挂 project_id，各项目互不影响；
   *   · 项目名唯一性改由服务层按「同一客户 + 未删除 + 未归档」校验。
   * 迁移可重入：索引不存在时 DROP INDEX IF EXISTS 不报错，重复执行无副作用。 */
  {
    version: 16,
    note: '一个客户多个项目（1:N）：删除一客户一项目唯一索引 uq_projects_customer_current',
    run(db) {
      const had = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
      ).get();
      db.exec('DROP INDEX IF EXISTS uq_projects_customer_current');
      const left = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
      ).get();
      if (left) throw new Error('唯一索引 uq_projects_customer_current 删除失败');
      return had ? '已删除唯一索引 uq_projects_customer_current（项目改为 1:N）'
        : '唯一索引不存在，跳过（可重入）';
    }
  }
];

/** 按版本号逐级迁移，返回执行过的步骤说明 */
function runMigrations(db, fromVersion) {
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= fromVersion) continue;
    const ts = now();
    try {
      const detail = m.run(db) || '';
      db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)')
        .run(m.version, ts, m.note);
      applied.push(`v${m.version} ${m.note}${detail ? '（' + detail + '）' : ''}`);
    } catch (e) {
      throw new Error(`迁移到 v${m.version} 失败：${e.message}`);
    }
  }
  return applied;
}

/* ------------------------------------------------------------------ */
/* 字典初始数据 —— 18 类，全部可在界面增删改                              */
/* ------------------------------------------------------------------ */

const DICT_SEED = {
  /* A. 客户画像类 */
  industry: ['石油', '化工', '电力', '冶金', '水处理', '船舶', '造纸', '制糖', '食品饮料', '制药',
    '空分', '天然气', '煤化工', 'LNG', '热力供暖', '环保脱硫脱硝', '新能源', '核电', '矿山',
    '纺织印染', '水泥建材', '其他'],
  customer_type: ['终端用户', '设计院', '工程公司/EPC总包', '贸易商/经销商', '阀门厂家OEM配套',
    '市政水务单位', '其他'],
  purchase_mode: ['终端直采', 'EPC总包配套', '设计院上图', '贸易商分销', '框架协议', '年度招标', '电商平台'],
  enterprise_nature: ['央企', '国企', '民营企业', '外资企业', '合资企业', '上市公司', '政府机构', '事业单位', '其他'],
  customer_source: ['老客户介绍', '朋友推荐', '设计院推荐', '工程公司配套', '展会', 'B2B平台',
    '电话开发', '网络推广', '主动上门', '招投标', '其他'],

  /* B. 阀门产品参数类 */
  valve_type: ['球阀', '闸阀', '截止阀', '止回阀', '蝶阀', '调节阀', '安全阀', '疏水阀', '减压阀',
    '隔膜阀', '旋塞阀', '柱塞阀', '排污阀', '仪表阀', '其他'],
  drive_mode: ['手动', '气动', '电动', '液动', '电液联动', '气液联动', '涡轮传动'],
  body_material: ['碳钢 WCB', '不锈钢 304', '不锈钢 316', '不锈钢 316L', '双相钢 2205', '双相钢 2507',
    '合金钢 WC6/WC9', '低温钢 LCB', '铸铁', '球墨铸铁', '铜', '衬氟', '塑料 PVC/PP/CPVC', '钛材', '其他'],
  pressure_rating: ['PN10', 'PN16', 'PN25', 'PN40', 'PN64', 'PN100', 'PN160',
    'Class150', 'Class300', 'Class600', 'Class900', 'Class1500', 'Class2500', '10K', '20K'],
  size_range: ['DN15', 'DN20', 'DN25', 'DN32', 'DN40', 'DN50', 'DN65', 'DN80', 'DN100', 'DN125',
    'DN150', 'DN200', 'DN250', 'DN300', 'DN350', 'DN400', 'DN500', 'DN600', 'DN800', 'DN1000以上'],
  design_standard: ['GB', 'JB', 'HG', 'API', 'ANSI/ASME', 'DIN', 'JIS', 'EN', 'ISO', '其他'],
  connection_type: ['法兰连接', '对焊连接', '承插焊', '螺纹连接', '对夹式', '卡箍', '卡套'],
  cert_required: ['特种设备制造许可证 TS', 'API 6D', 'API 608', 'API 600', 'API 609', 'CE', 'PED',
    'SIL', '防爆认证 ATEX/IECEx', '防火认证 API 607/6FA', '饮用水卫生认证', '其他'],

  /* C. 商务与流程类 */
  account_period: ['款到发货', '预付30%+发货前付清', '预付30%+验收后付清', '月结30天',
    '月结60天', '月结90天', '货到付款', '按进度付款'],
  customer_level: ['A 重点客户', 'B 普通客户', 'C 潜在客户'],
  customer_status: ['潜在', '跟进中', '已报价', '已成交', '暂停合作', '已流失'],
  project_stage: ['信息收集', '初步接洽', '技术交流', '方案选型', '询价报价', '投标/议价',
    '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项', '质保期内', '已暂停', '已终止'],
  follow_method: ['电话', '微信', '邮件', '上门拜访', '技术交流', '参加展会', '投标/开标',
    '客户来访考察', '寄送样品/资料', '其他'],
  follow_result: ['有意向', '需再跟进', '已技术交流', '已选型', '已报价', '已投标', '待决策',
    '已中标', '已成交', '价格无优势', '技术不满足', '暂搁置', '无需求'],
  payment_method: ['银行转账', '承兑汇票', '电汇', '现金', '微信', '支付宝', '信用证 L/C', '其他'],

  /* D. 人员与联系人 */
  contact_position: ['总经理', '副总经理', '采购经理', '采购员', '技术总工', '技术工程师',
    '设计选型工程师', '设备部主管', '项目经理', '工程部经理', '库管', '财务', '其他'],
  contact_influence: ['关键决策', '技术把关', '推荐影响', '一般对接']
};

/* 字典分类的中文显示名 */
const DICT_LABEL = {
  industry: '下游行业',
  customer_type: '客户主体类型',
  purchase_mode: '采购模式',
  enterprise_nature: '企业性质',
  customer_source: '客户来源',
  valve_type: '阀门类型',
  drive_mode: '驱动方式',
  body_material: '阀体材质',
  pressure_rating: '压力等级',
  size_range: '公称口径',
  design_standard: '设计标准',
  connection_type: '连接方式',
  cert_required: '认证要求',
  account_period: '账期',
  customer_level: '客户等级',
  customer_status: '客户状态',
  project_stage: '项目阶段',
  follow_method: '跟进方式',
  follow_result: '跟进结果',
  payment_method: '收款方式',
  contact_position: '联系人职位',
  contact_influence: '联系人影响力'
};

/* ------------------------------------------------------------------ */
/* 系统设置初始值                                                       */
/* ------------------------------------------------------------------ */

const SETTINGS_SEED = [
  ['app_name', '客户管理系统', '软件名称'],
  ['company_name', '', '我方公司名称'],
  ['port', '8899', '服务端口'],
  ['follow_remind_days', '3', '跟进提醒提前天数'],
  ['follow_remind_time', '09:00', '每天开始提醒的时间'],
  ['follow_remind_quiet', '18:00', '几点后不再弹新提醒（角标保留）'],
  ['follow_remind_on_start', '1', '启动时立即检查一次（补未开机漏掉的）'],
  ['remind_email_on', '0', '是否启用邮件提醒（默认关闭）'],
  ['remind_email_time', '08:30', '每天发送提醒邮件的时间'],
  ['remind_email_to', '', '提醒邮件收件地址（留空则发给发件人自己）'],
  ['smtp_provider', 'qq', 'SMTP 服务商预设'],
  ['smtp_host', 'smtp.qq.com', 'SMTP 服务器地址'],
  ['smtp_port', '465', 'SMTP 端口（465 隐式 TLS）'],
  ['smtp_user', '', 'SMTP 登录账号（邮箱地址）'],
  ['smtp_pass', '', 'SMTP 授权码（不是登录密码）'],
  /* 邮件提醒的运行时状态（由 notify 模块维护，便于重启后仍能判断与降级） */
  ['remind_email_fail_streak', '0', '邮件提醒连续失败次数'],
  ['remind_email_last_at', '', '邮件提醒上次尝试时间'],
  ['remind_email_last_ok', '', '邮件提醒上次是否成功'],
  ['remind_email_last_msg', '', '邮件提醒上次结果说明'],
  ['remind_email_last_day', '', '邮件提醒上次发送日期（当日去重）'],
  ['payment_remind_days', '7', '回款提醒提前天数'],
  ['birthday_remind', '1', '是否启用生日提醒'],
  ['page_size', '20', '列表每页条数'],
  ['theme', 'light', '界面主题 light/dark'],
  ['backup_keep', '30', '主备份保留份数'],
  ['backup_mirror_keep', '7', '镜像备份保留份数'],
  ['backup_auto', '1', '是否启用每日自动备份'],
  ['attachment_max_mb', '50', '单个附件大小上限(MB)'],

  /* 1.25 登录与异地访问（默认关闭；不改表结构，全部走设置项） */
  ['auth_enabled', '0', '是否启用登录（默认关闭）'],
  ['auth_user', 'admin', '登录用户名'],
  ['auth_pass_hash', '', '登录密码 scrypt 哈希（只写不回传）'],
  ['auth_session_secret', '', '会话签名密钥（32 字节 hex，首次启用时生成）'],
  ['auth_fail_state', '{}', '防爆破状态（按 IP 记失败次数与锁定时间）'],
  ['auth_ip_allow', '', 'IP / CIDR 白名单（逗号分隔，空=不限制）'],
  ['listen_mode', 'local', '监听范围：local 仅本机 / lan 局域网 / all 全部网卡'],
  ['auth_totp_secret', '', '预留：二次验证 TOTP 密钥（本版不做）']
];

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 统一的本地时间字符串：YYYY-MM-DDTHH:mm:ss */
function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 node:sqlite 返回的 null-prototype 对象转成普通对象 */
function plain(row) {
  return row ? Object.assign({}, row) : row;
}
function plainAll(rows) {
  return rows.map(plain);
}

/* ------------------------------------------------------------------ */
/* 数据库初始化                                                        */
/* ------------------------------------------------------------------ */

/**
 * 打开数据库、建表、迁移、灌入初始数据。
 * @param {object} paths  { dataDir, dbFile, backupDir }
 * @returns {{ db: DatabaseSync, created: boolean, migrated: boolean, fromVersion: number,
 *             tables: number, dictCount: number, backedUpTo: string|null }}
 */
function initDatabase(paths) {
  const { dataDir, dbFile, backupDir } = paths;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const existedBefore = fs.existsSync(dbFile);

  /* 第一遍：只读探测现有结构版本，随即关闭 */
  let fromVersion = 0;
  if (existedBefore) {
    const probe = new DatabaseSync(dbFile);
    try {
      const has = probe.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_version'"
      ).get().n;
      if (has) {
        const v = probe.prepare('SELECT MAX(version) AS v FROM schema_version').get();
        fromVersion = (v && v.v) ? v.v : 0;
      }
    } catch (_) {
      fromVersion = 0;
    }
    try { probe.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* 忽略 */ }
    probe.close();
  }

  /* 需要升级旧库时：先备份，再打开并迁移 */
  let backedUpTo = null;
  if (existedBefore && fromVersion > 0 && fromVersion < SCHEMA_VERSION) {
    const stamp = now().replace(/[:T]/g, '-');
    backedUpTo = path.join(backupDir, `before-migrate-v${fromVersion}-${stamp}.db`);
    fs.copyFileSync(dbFile, backedUpTo);
  }

  /* 第二遍：正式打开并建表 / 迁移 */
  const db = new DatabaseSync(dbFile);

  db.exec('PRAGMA journal_mode = WAL');      // 读写并发，崩溃安全
  db.exec('PRAGMA busy_timeout = 5000');     // 锁等待 5 秒，避免瞬时 SQLITE_BUSY
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');    // WAL 下的推荐值：安全与速度平衡

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT ''
  )`);

  /* 建表 + 建索引（幂等）。新库这一步就已是最新结构 */
  for (const sql of TABLES) db.exec(sql);
  for (const sql of INDEXES) db.exec(sql);

  /* 旧库：按版本号逐级迁移结构（迁移脚本内部自己负责新增列上的索引） */
  const migrations = runMigrations(db, fromVersion);

  /* 灌入字典与设置（仅补充缺失项，不覆盖你已修改的内容） */
  const ts = now();
  const dictCount = seedDict(db, ts);
  seedSettings(db, ts);
  /* 行政区划（地图模块移除后改为纯本地种子，不再联网抓边界） */
  const regionAdded = seedRegion(db);
  /* 产品价目表的内置分类（1.24）：全新安装也必须灌入，仅当表为空时执行 */
  const productCategoryAdded = seedProductCategories(db);

  /* 全新数据库：直接记录为最新版本 */
  if (fromVersion === 0) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)')
      .run(SCHEMA_VERSION, ts, '初始建库');
  }

  const tableCount = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).get().n;

  const verRow = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  const finalVersion = (verRow && verRow.v) || SCHEMA_VERSION;

  return {
    db,
    created: !existedBefore,
    migrated: migrations.length > 0,
    migrations,
    fromVersion,
    schemaVersion: finalVersion,
    tables: tableCount,
    dictCount,
    productCategoryCount: productCategoryAdded,
    backedUpTo
  };
}

/** 补充缺失的字典项，返回本次新增条数 */
function seedDict(db, ts) {
  const exists = db.prepare(
    'SELECT id, enabled, deleted_at FROM dict WHERE category = ? AND value = ?'
  );
  const insert = db.prepare(
    `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
     VALUES (?, ?, '', ?, 1, 1, ?, ?)`
  );
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const [category, values] of Object.entries(DICT_SEED)) {
      values.forEach((value, i) => {
        const hit = exists.get(category, value);
        if (!hit) {
          insert.run(category, value, (i + 1) * 10, ts, ts);
          added++;
        } else if (hit.deleted_at) {
          // 曾被删除的系统项：恢复它，避免缺项
          db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
            .run(ts, hit.id);
        }
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/**
 * 灌入行政区划（仅当表为空时）。
 * 地图模块已移除，但"地址 → 地州"归属与客户分布环形图都还要这 121 行数据，
 * 所以改成仓库内的本地种子（server/data/region.json），全新安装也能离线可用。
 */
function seedRegion(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM region').get().n;
  if (n > 0) return 0;
  const file = path.join(__dirname, 'data', 'region.json');
  if (!fs.existsSync(file)) return 0;
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8')).rows || [];
  } catch (_) {
    return 0;
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO region
    (code, name, level, parent_code, longitude, latitude, geojson_path, sort, customer_count)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, 0)`);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      ins.run(r.code, r.name, r.level, r.parent_code || '', r.longitude == null ? null : r.longitude,
        r.latitude == null ? null : r.latitude, Number(r.sort) || 0);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/**
 * 灌入内置产品分类（仅当 product_categories 表为空时）。
 *
 * 为什么迁移里和 initDatabase 里都要调用：
 *   - 全新安装 fromVersion=0，迁移列表一步都不会跑，必须靠 initDatabase 灌种子；
 *   - 老库升级 v10 → v11 也走同一函数，保证两边的内置分类完全一致。
 * 幂等：只要表里已有任何一行（含软删除的）就整体跳过，绝不会重复插入。
 *
 * 1.24.2 起种子是三级嵌套（一级 6 / 二级 22 / 三级 46 = 74 个），
 * 递归插入；一级 is_system=1（固定不可删），二级及以下 is_system=0（自定义）。
 *
 * @returns {number} 本次灌入的分类条数（74）
 */
function seedProductCategories(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM product_categories').get().n;
  if (n > 0) return 0;

  const ts = now();
  const insert = db.prepare(`INSERT INTO product_categories
    (parent_id, name, sort, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  let added = 0;
  db.exec('BEGIN');
  try {
    const walk = (nodes, parentId, depth) => {
      nodes.forEach((node, i) => {
        const r = insert.run(parentId, seedName(node), (i + 1) * 10,
          depth === 0 ? 1 : 0, ts, ts);
        added++;
        const children = seedChildren(node);
        if (children.length) walk(children, Number(r.lastInsertRowid), depth + 1);
      });
    };
    walk(PRODUCT_CATEGORY_SEED, null, 0);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/** 补充缺失的设置项 */
function seedSettings(db, ts) {
  const exists = db.prepare('SELECT 1 AS x FROM settings WHERE key = ?');
  const insert = db.prepare(
    'INSERT INTO settings (key, value, remark, updated_at) VALUES (?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    for (const [key, value, remark] of SETTINGS_SEED) {
      if (!exists.get(key)) insert.run(key, value, remark, ts);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 读取全部设置，返回 { key: value } */
function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** 关闭数据库：先做 WAL 检查点，保证数据全部落盘 */
function closeDatabase(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (_) { /* 忽略 */ }
  try {
    db.close();
  } catch (_) { /* 忽略 */ }
}

module.exports = {
  SCHEMA_VERSION,
  DICT_LABEL,
  DICT_SEED,
  FIXED_TAGS,
  FIXED_TAG_NAMES,
  PRODUCT_CATEGORY_SEED,
  DROPPED_CUSTOMER_COLUMNS,
  initDatabase,
  seedProductCategories,
  getSettings,
  closeDatabase,
  plain,
  plainAll,
  now
};
