/**
 * 产品分类模块 / 产品价目表专项（1.24 新增，结构 v11；1.24.1 起 v12；1.24.2 起 v13）
 * 注：1.25 起本套件的版本断言改为「≥ 1.24」，避免每次升版本都要跟着改。
 *
 * 覆盖：
 *   · 结构：product_categories / products 两张表与 5 个索引、schema_version = 13
 *   · 分类种子：一级 6 个（is_system=1，不可删）+ 二级 22 个 + 三级 46 个（is_system=0，可删可改），
 *     三级抽样「蝶阀 → 三偏心蝶阀 → 对夹 / 法兰 / 支耳」；均可改名/上下移
 *   · 分类：新增一级/子级、同级重名拒绝、改名、上移下移、有子分类/有产品拒绝删除、
 *           二级与三级自定义分类均可改名、可删除
 *   · 产品：CRUD、名称必填、分类必须存在、单价 ≥0 两位小数、折扣 0~100、
 *           货期非负整数、单位默认台、同分类不重名（跨分类可同名）、编号全库唯一
 *   · 筛选：分类（默认含子孙，可关；一级筛选默认带出三级产品）、关键字（名称/编号/备注）、材质、压力、启用
 *   · 分页：page/pageSize、pageSize 上限 200
 *   · 折后价：0 / 50 / 100 折扣与小数折扣，net_price = round(price×(1−discount/100),2)
 *   · 复制：名称加「（副本）」、重名自动加序号、编号自动加后缀、sort 排末尾
 *   · 导出：category_path 形如「蝶阀 / 三偏心蝶阀 / 对夹」、字段齐全、行数与筛选一致
 *   · 审计日志：product / product_category 的 create / update / delete / move / copy
 *   · 自清理：跑完不留测试产品与测试分类，种子分类 74 个（6 + 22 + 46）原样保留
 *
 * 前置：服务已启动（默认 127.0.0.1:8899，可用 CRM_TEST_BASE 覆盖）
 * 用法：node tools/test-products-124.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const DB_FILE = path.join(ROOT, 'data', 'crm.db');
const TAG = '【产品测试' + Math.random().toString(36).slice(2, 8) + '】';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: !!j.ok, data: j.data, code: j.code, message: j.message };
}

/** 直接读库做结构断言（只读） */
function withDb(fn) {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

/**
 * 物理清掉本套件的残留（含上次失败留下的），只动名字带 TAG 的自定义分类与产品。
 * 6 个一级分类 is_system=1，永远不在这里被删；二级 / 三级是自定义分类，但名字不带 TAG，也不会被误删。
 */
function purgeTag() {
  const db = new DatabaseSync(DB_FILE);
  try {
    db.prepare(`DELETE FROM products WHERE category_id IN
      (SELECT id FROM product_categories WHERE name LIKE ?)`).run(`%${TAG}%`);
    db.prepare('DELETE FROM products WHERE name LIKE ?').run(`%${TAG}%`);
    db.prepare('DELETE FROM product_categories WHERE name LIKE ? AND is_system = 0').run(`%${TAG}%`);
    db.prepare('DELETE FROM activity_logs WHERE summary LIKE ? OR detail LIKE ?').run(`%${TAG}%`, `%${TAG}%`);
  } finally {
    db.close();
  }
}

const made = { products: [], categories: [] };

/** 建立分类后登记，便于清理 */
async function createCat(payload) {
  const r = await api('POST', '/api/product-categories', payload);
  if (r.ok && r.data && r.data.id) made.categories.push(r.data.id);
  return r;
}

async function createProduct(payload) {
  const r = await api('POST', '/api/products', payload);
  if (r.ok && r.data && r.data.id) made.products.push(r.data.id);
  return r;
}

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (Number(n.id) === Number(id)) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

(async () => {
  console.log('=== 产品分类模块 / 产品价目表专项（1.24.2 · v13）===\n');
  console.log(`测试标记：${TAG}\n`);

  /* ---------------- 0. 健康检查与预清理 ---------------- */
  const health = await api('GET', '/api/health');
  check('服务可访问且版本 ≥ 1.24（产品模块随 1.24 上线）',
    (() => {
      const v = String(health.data.version || '').split('.').map(Number);
      return health.ok === true && v[0] === 1 && (v[1] || 0) >= 24;
    })(),
    health.ok ? `v${health.data.version}` : (health.message || '无响应'));
  if (!health.ok) {
    console.error('服务未启动，请先运行 启动.bat 或 node server/server.js');
    process.exit(2);
  }

  try { purgeTag(); } catch (e) { console.log('（预清理失败，继续：' + e.message + '）'); }

  /* ---------------- 1. 结构（v13） ---------------- */
  const struct = withDb((db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all().map((r) => r.name);
    const catCols = db.prepare('PRAGMA table_info(product_categories)').all().map((c) => c.name);
    const prodCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('product_categories','products')")
      .all().map((r) => r.name);
    const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    return { tables, catCols, prodCols, indexes, ver };
  });

  const SCHEMA_VERSION = require('../server/db').SCHEMA_VERSION;
  check('结构版本已升到最新（v' + SCHEMA_VERSION + '）',
    struct.ver === SCHEMA_VERSION, `schema_version = ${struct.ver}（代码 v${SCHEMA_VERSION}）`);
  check('product_categories 与 products 两张表已建',
    struct.tables.includes('product_categories') && struct.tables.includes('products'),
    `当前 ${struct.tables.length} 张表（含 schema_version）`);

  const CAT_COLS = ['id', 'parent_id', 'name', 'sort', 'is_system', 'created_at', 'updated_at', 'deleted_at'];
  const PROD_COLS = ['id', 'category_id', 'name', 'code', 'unit', 'price', 'lead_time_days',
    'body_material', 'pressure_rating', 'discount', 'remark', 'enabled', 'sort',
    'created_at', 'updated_at', 'deleted_at'];
  check('product_categories 列齐全（8 列）',
    CAT_COLS.every((c) => struct.catCols.includes(c)) && struct.catCols.length === CAT_COLS.length,
    struct.catCols.join(', '));
  check('products 列齐全（16 列）',
    PROD_COLS.every((c) => struct.prodCols.includes(c)) && struct.prodCols.length === PROD_COLS.length,
    `${struct.prodCols.length} 列：${struct.prodCols.join(', ')}`);

  const NEED_IDX = ['idx_product_categories_parent', 'idx_products_category', 'idx_products_name',
    'idx_products_enabled', 'idx_products_deleted'];
  check('5 个产品相关索引均已建立',
    NEED_IDX.every((n) => struct.indexes.includes(n)),
    NEED_IDX.filter((n) => !struct.indexes.includes(n)).join('、') || NEED_IDX.join('、'));

  /* ---------------- 2. 分类种子（6 个一级 + 22 个二级 + 46 个三级 = 74） ---------------- */
  const tree0 = await api('GET', '/api/product-categories?tree=1');
  const roots = tree0.data || [];
  check('分类树接口可用且一级分类为 6 个',
    tree0.ok && roots.length === 6, `一级 ${roots.length} 个：${roots.map((n) => n.name).join(' / ')}`);

  const ROOT_NAMES = ['蝶阀', '球阀', '止回阀', '隔膜阀', '刀闸阀', '执行器'];
  check('6 个一级分类名称正确（蝶阀/球阀/止回阀/隔膜阀/刀闸阀/执行器）',
    ROOT_NAMES.every((n) => roots.some((x) => x.name === n))
      && roots.every((x) => Number(x.is_system) === 1),
    roots.map((n) => `${n.name}(${n.is_system})`).join(' '));

  /* 二级＝按结构 */
  const EXPECT_SECOND = {
    蝶阀: ['衬胶蝶阀', '双偏心蝶阀', '三偏心蝶阀'],
    球阀: ['浮动球阀', '固定球阀', '三通球阀', '全焊接球阀'],
    止回阀: ['旋启式止回阀', '升降式止回阀', '对夹式止回阀', '双瓣式止回阀'],
    隔膜阀: ['堰式隔膜阀', '直通式隔膜阀', '衬氟隔膜阀'],
    刀闸阀: ['手动刀闸阀', '气动刀闸阀', '电动刀闸阀', '浆液专用刀闸阀'],
    执行器: ['气动执行器', '电动执行器', '电液联动执行器', '附件']
  };
  const secondTotal = roots.reduce((s, n) => s + (n.children || []).length, 0);
  check('二级分类共 22 个且各一级按结构的分类齐全',
    secondTotal === 22 && Object.entries(EXPECT_SECOND).every(([root, list]) => {
      const hit = roots.find((n) => n.name === root);
      return hit && list.length === (hit.children || []).length
        && list.every((c) => (hit.children || []).some((x) => x.name === c));
    }),
    `二级合计 ${secondTotal} 个：` + roots.map((n) => `${n.name}-${(n.children || []).length}`).join(' '));

  /* 三级＝按连接 / 法兰安装方式 */
  const thirdTotal = roots.reduce((s, n) => s
    + (n.children || []).reduce((t, c) => t + (c.children || []).length, 0), 0);
  check('三级分类共 46 个（按连接 / 法兰安装方式）',
    thirdTotal === 46,
    `三级合计 ${thirdTotal} 个：` + roots.map((n) => `${n.name}-${(n.children || [])
      .reduce((t, c) => t + (c.children || []).length, 0)}`).join(' '));

  const die = roots.find((n) => n.name === '蝶阀');
  const sanBian = (die.children || []).find((c) => c.name === '三偏心蝶阀');
  const sanLinks = (sanBian && sanBian.children || []).map((c) => c.name);
  check('三级名称正确（蝶阀 → 三偏心蝶阀 → 对夹 / 法兰 / 支耳）',
    sanLinks.join(',') === '对夹,法兰,支耳',
    `三偏心蝶阀下：${sanLinks.join(' / ') || '（缺失）'}`);

  const allSecond = roots.flatMap((n) => n.children || []);
  const allThird = allSecond.flatMap((c) => c.children || []);
  check('二级、三级都是自定义分类（is_system=0，可改名、可删除）',
    allSecond.length === 22 && allThird.length === 46
      && allSecond.every((c) => Number(c.is_system) === 0)
      && allThird.every((c) => Number(c.is_system) === 0),
    `二级 ${allSecond.length} 个 / 三级 ${allThird.length} 个，is_system 全为 0`);

  const actuator = roots.find((n) => n.name === '执行器');
  const fujian = (actuator.children || []).find((c) => c.name === '附件');
  check('执行器 → 附件 没有三级（附件为叶子分类）',
    !!fujian && (fujian.children || []).length === 0,
    fujian ? `附件下 ${(fujian.children || []).length} 个三级` : '未找到附件');

  const sysDel = await api('DELETE', `/api/product-categories/${die.id}`);
  check('一级分类不可删除（400 SYSTEM_CATEGORY）',
    sysDel.status === 400 && sysDel.code === 'SYSTEM_CATEGORY' && /不可删除/.test(sysDel.message || ''),
    `HTTP ${sysDel.status} ${sysDel.code} ${sysDel.message}`);

  /* 二级分类可删除：建一个临时子分类 → 删除 → 树上不再出现 */
  const tmpChild = await createCat({ name: TAG + '可删子类', parent_id: die.id });
  const childDel = tmpChild.ok ? await api('DELETE', `/api/product-categories/${tmpChild.data.id}`) : { ok: false, status: 0 };
  const treeAfterChildDel = await api('GET', '/api/product-categories?tree=1');
  const dieAfter = (treeAfterChildDel.data || []).find((n) => Number(n.id) === Number(die.id));
  check('二级分类可删除（自定义子分类删除成功）',
    tmpChild.ok && childDel.ok && dieAfter
      && !(dieAfter.children || []).some((c) => Number(c.id) === Number(tmpChild.data.id)),
    `新增 #${tmpChild.data && tmpChild.data.id} → 删除 HTTP ${childDel.status}`);

  /* 三级分类可删除：建临时二级 → 其下建临时三级 → 删三级 → 树上消失 → 再删临时二级 */
  const tmpParent = await createCat({ name: TAG + '三级父类', parent_id: die.id });
  const tmpThird = tmpParent.ok
    ? await createCat({ name: TAG + '三级可删', parent_id: tmpParent.data.id })
    : { ok: false, data: null };
  const thirdDel = tmpThird.ok
    ? await api('DELETE', `/api/product-categories/${tmpThird.data.id}`)
    : { ok: false, status: 0 };
  const treeAfterThirdDel = await api('GET', '/api/product-categories?tree=1');
  const parentAfterDel = tmpParent.ok ? findNode(treeAfterThirdDel.data, tmpParent.data.id) : null;
  check('三级分类可删除（建临时三级 → 删除 → 树上消失）',
    tmpParent.ok && tmpThird.ok && thirdDel.ok && parentAfterDel
      && !(parentAfterDel.children || []).some((c) => Number(c.id) === Number(tmpThird.data.id)),
    `临时二级 #${tmpParent.data && tmpParent.data.id} → 临时三级 #${tmpThird.data && tmpThird.data.id} → 删除 HTTP ${thirdDel.status}`);
  if (tmpParent.ok) await api('DELETE', `/api/product-categories/${tmpParent.data.id}`);

  /* 三级分类可改名（挑种子里的「蝶阀 / 三偏心蝶阀 / 对夹」，改完立刻改回） */
  const sanJia = (sanBian.children || []).find((c) => c.name === '对夹');
  const renThird = await api('PUT', `/api/product-categories/${sanJia.id}`, { name: '对夹' + TAG });
  const backThird = renThird.ok
    ? await api('PUT', `/api/product-categories/${sanJia.id}`, { name: '对夹' })
    : { ok: false };
  check('三级分类可改名（改名后名称生效，随后改回）',
    renThird.ok && renThird.data.name === '对夹' + TAG
      && backThird.ok && backThird.data.name === '对夹',
    renThird.ok ? `改名返回 ${renThird.data.name}` : (renThird.message || '改名失败'));

  /* 内置分类可改名（改完立刻改回来，尽量不留痕） */
  const renamed = await api('PUT', `/api/product-categories/${die.id}`, { name: '蝶阀' + TAG });
  const backRenamed = renamed.ok
    ? await api('PUT', `/api/product-categories/${die.id}`, { name: '蝶阀' })
    : { ok: false };
  check('内置分类可改名（改名后名称生效，随后改回）',
    renamed.ok && renamed.data.name === '蝶阀' + TAG && backRenamed.ok && backRenamed.data.name === '蝶阀',
    renamed.ok ? `改名返回 ${renamed.data.name}` : (renamed.message || '改名失败'));

  /* 上下移：新建两个兄弟分类，B 上移后应排在 A 之前 */
  const catRoot = await createCat({ name: TAG + '根分类' });
  const catA = await createCat({ name: TAG + '子类甲', parent_id: catRoot.data.id });
  const catB = await createCat({ name: TAG + '子类乙', parent_id: catRoot.data.id });
  const treeAfterCreate = await api('GET', '/api/product-categories?tree=1');
  const createdRoot = findNode(treeAfterCreate.data, catRoot.data.id);
  check('可新增自定义一级分类与二级子分类',
    catRoot.ok && catA.ok && catB.ok
      && Number(catA.data.parent_id) === Number(catRoot.data.id)
      && Number(catB.data.parent_id) === Number(catRoot.data.id)
      && (createdRoot.children || []).length === 2,
    catRoot.ok ? `根 #${catRoot.data.id}，子 #${catA.data.id} / #${catB.data.id}` : catRoot.message);

  const moveUp = await api('POST', `/api/product-categories/${catB.data.id}/move`, { dir: 'up' });
  const treeAfterMove = await api('GET', '/api/product-categories?tree=1');
  const rootNode = findNode(treeAfterMove.data, catRoot.data.id);
  const orderAfterUp = (rootNode.children || []).map((c) => Number(c.id));
  const moveDown = await api('POST', `/api/product-categories/${catB.data.id}/move`, { dir: 'down' });
  const treeAfterDown = await api('GET', '/api/product-categories?tree=1');
  const orderAfterDown = (findNode(treeAfterDown.data, catRoot.data.id).children || []).map((c) => Number(c.id));
  check('分类上移/下移生效（同父级内换位）',
    moveUp.ok && moveUp.data.moved === true
      && orderAfterUp.indexOf(Number(catB.data.id)) === 0
      && orderAfterDown.indexOf(Number(catB.data.id)) === 1,
    `上移后顺序 ${orderAfterUp.join(',')}；下移后 ${orderAfterDown.join(',')}`);

  const atEdge = await api('POST', `/api/product-categories/${catB.data.id}/move`, { dir: 'down' });
  check('已在末尾时下移返回 moved=false（不报错）',
    atEdge.ok && atEdge.data.moved === false,
    atEdge.ok ? atEdge.data.message : atEdge.message);

  const dupCat = await api('POST', '/api/product-categories', {
    name: TAG + '子类甲', parent_id: catRoot.data.id
  });
  check('同一上级下分类重名被拒（409 DUPLICATE_NAME）',
    dupCat.status === 409 && dupCat.code === 'DUPLICATE_NAME',
    `HTTP ${dupCat.status} ${dupCat.message}`);

  const renameCat = await api('PUT', `/api/product-categories/${catA.data.id}`, { name: TAG + '子类甲改' });
  check('自定义分类可改名',
    renameCat.ok && renameCat.data.name === TAG + '子类甲改',
    renameCat.ok ? renameCat.data.name : renameCat.message);

  /* ---------------- 3. 产品新增与校验 ---------------- */
  const p1 = await createProduct({
    category_id: catA.data.id, name: TAG + 'DN200 蝶阀', code: 'T-CODE-1',
    unit: '台', price: 1200, lead_time_days: 15,
    body_material: '碳钢 WCB', pressure_rating: 'PN16', discount: 30,
    remark: '测试备注甲'
  });
  check('新增产品成功（折后价 840、分类名与全路径正确）',
    p1.ok && Number(p1.data.net_price) === 840
      && p1.data.category_name === TAG + '子类甲改'
      && String(p1.data.category_path).includes(TAG + '根分类'),
    p1.ok ? `#${p1.data.id} ${p1.data.category_path} / ${p1.data.price} × (1−${p1.data.discount}%) = ${p1.data.net_price}` : p1.message);

  const p2 = await createProduct({
    category_id: catA.data.id, name: TAG + 'DN100 蝶阀', price: 100.555,
    lead_time_days: 0, body_material: '不锈钢 304', pressure_rating: 'PN16', discount: 0
  });
  check('单价保留两位小数（100.555 → 100.56）',
    p2.ok && Number(p2.data.price) === 100.56, p2.ok ? `单价 ${p2.data.price}` : p2.message);

  const p3 = await createProduct({
    category_id: catB.data.id, name: TAG + '球阀示例', code: 'T-CODE-2',
    price: 500, discount: 50, enabled: 0
  });
  check('新增停用产品（enabled=0）并返回折后价 250',
    p3.ok && Number(p3.data.enabled) === 0 && Number(p3.data.net_price) === 250,
    p3.ok ? `enabled=${p3.data.enabled} net=${p3.data.net_price}` : p3.message);

  const p4 = await createProduct({
    category_id: catRoot.data.id, name: TAG + '跨类同名', price: 100, discount: 100
  });
  check('单位留空默认「台」，100% 折扣折后价为 0',
    p4.ok && p4.data.unit === '台' && Number(p4.data.net_price) === 0,
    p4.ok ? `unit=${p4.data.unit} net=${p4.data.net_price}` : p4.message);

  const p5 = await createProduct({
    category_id: catRoot.data.id, name: TAG + 'DN200 蝶阀', price: 800, discount: 0
  });
  check('跨分类允许同名产品',
    p5.ok && Number(p5.data.id) !== Number(p1.data.id),
    p5.ok ? `#${p5.data.id} 与 #${p1.data.id} 同名不同分类` : p5.message);

  const p6 = await createProduct({
    category_id: catRoot.data.id, name: TAG + '精度测试', price: 99.99, discount: 33.33
  });
  check('小数折扣折后价正确（99.99 × 66.67% = 66.66）',
    p6.ok && Number(p6.data.net_price) === 66.66,
    p6.ok ? `net=${p6.data.net_price}` : p6.message);

  /* -- 校验分支 -- */
  const noName = await api('POST', '/api/products', { category_id: catA.data.id, name: '   ' });
  check('产品名称必填（400 BAD_NAME）',
    noName.status === 400 && noName.code === 'BAD_NAME', `HTTP ${noName.status} ${noName.message}`);

  const noCat = await api('POST', '/api/products', { name: TAG + '无分类' });
  check('产品分类必填（400 BAD_CATEGORY）',
    noCat.status === 400 && noCat.code === 'BAD_CATEGORY', `HTTP ${noCat.status} ${noCat.message}`);

  const badCat = await api('POST', '/api/products', { category_id: 999999, name: TAG + '分类不存在' });
  check('分类必须存在且未删除（400 BAD_CATEGORY）',
    badCat.status === 400 && badCat.code === 'BAD_CATEGORY', `HTTP ${badCat.status} ${badCat.message}`);

  const negPrice = await api('POST', '/api/products', {
    category_id: catA.data.id, name: TAG + '负价', price: -1
  });
  check('单价不能为负（400 BAD_PRICE）',
    negPrice.status === 400 && negPrice.code === 'BAD_PRICE', `HTTP ${negPrice.status} ${negPrice.message}`);

  const badDiscountHi = await api('POST', '/api/products', {
    category_id: catA.data.id, name: TAG + '折扣超限', discount: 101
  });
  const badDiscountLo = await api('POST', '/api/products', {
    category_id: catA.data.id, name: TAG + '折扣负数', discount: -1
  });
  check('折扣必须在 0~100（101 与 −1 均拒绝）',
    badDiscountHi.status === 400 && badDiscountHi.code === 'BAD_DISCOUNT'
      && badDiscountLo.status === 400 && badDiscountLo.code === 'BAD_DISCOUNT',
    `${badDiscountHi.status}/${badDiscountHi.code} 与 ${badDiscountLo.status}/${badDiscountLo.code}`);

  const badLead1 = await api('POST', '/api/products', {
    category_id: catA.data.id, name: TAG + '小数货期', lead_time_days: 1.5
  });
  const badLead2 = await api('POST', '/api/products', {
    category_id: catA.data.id, name: TAG + '负货期', lead_time_days: -1
  });
  check('货期必须是非负整数（1.5 与 −1 均拒绝）',
    badLead1.status === 400 && badLead1.code === 'BAD_LEAD_TIME'
      && badLead2.status === 400 && badLead2.code === 'BAD_LEAD_TIME',
    `${badLead1.status}/${badLead1.code} 与 ${badLead2.status}/${badLead2.code}`);

  const dupName = await api('POST', '/api/products', {
    category_id: catA.data.id, name: TAG + 'DN200 蝶阀'
  });
  check('同一分类下重名被拒（409 DUPLICATE_NAME）',
    dupName.status === 409 && dupName.code === 'DUPLICATE_NAME',
    `HTTP ${dupName.status} ${dupName.message}`);

  const dupCode = await api('POST', '/api/products', {
    category_id: catB.data.id, name: TAG + '编号冲突', code: 'T-CODE-1'
  });
  check('产品编号全库唯一（跨分类也拒绝，409 DUPLICATE_CODE）',
    dupCode.status === 409 && dupCode.code === 'DUPLICATE_CODE',
    `HTTP ${dupCode.status} ${dupCode.message}`);

  const updDupCode = await api('PUT', `/api/products/${p3.data.id}`, { code: 'T-CODE-1' });
  check('修改时编号冲突同样被拒',
    updDupCode.status === 409 && updDupCode.code === 'DUPLICATE_CODE',
    `HTTP ${updDupCode.status} ${updDupCode.message}`);

  /* ---------------- 4. 分类树的产品数（含子孙） ---------------- */
  const tree1 = await api('GET', '/api/product-categories?tree=1');
  const rootA1 = findNode(tree1.data, catRoot.data.id);
  const rootAchildren = rootA1.children || [];
  const childA1 = findNode(tree1.data, catA.data.id);
  check('分类树 product_count 含子分类合计（父 6 = 自己 3 + 子 3）',
    Number(rootA1.product_count) === 6 && Number(rootA1.own_count) === 3
      && Number(childA1.product_count) === 2 && rootAchildren.length === 2,
    `父 product_count=${rootA1.product_count} own=${rootA1.own_count}；子甲=${childA1.product_count}`);

  /* ---------------- 5. 列表筛选 ---------------- */
  const listRoot = await api('GET', `/api/products?category_id=${catRoot.data.id}&pageSize=50`);
  check('按分类筛选默认包含全部子孙分类（6 条）',
    listRoot.ok && listRoot.data.total === 6,
    listRoot.ok ? `total=${listRoot.data.total}` : listRoot.message);

  const listRootOnly = await api('GET', `/api/products?category_id=${catRoot.data.id}&include_children=false&pageSize=50`);
  check('include_children=false 时只查本分类（3 条）',
    listRootOnly.ok && listRootOnly.data.total === 3,
    listRootOnly.ok ? `total=${listRootOnly.data.total}` : listRootOnly.message);

  const listChild = await api('GET', `/api/products?category_id=${catA.data.id}&pageSize=50`);
  check('子分类筛选只含自己的产品（2 条）',
    listChild.ok && listChild.data.total === 2,
    listChild.ok ? `total=${listChild.data.total}` : listChild.message);

  const kwName = await api('GET', `/api/products?keyword=${encodeURIComponent('DN200')}&pageSize=50`);
  check('关键字按名称模糊匹配（DN200 → 2 条）',
    kwName.ok && kwName.data.total === 2, kwName.ok ? `total=${kwName.data.total}` : kwName.message);

  const kwCode = await api('GET', '/api/products?keyword=T-CODE-2&pageSize=50');
  check('关键字也匹配产品编号（T-CODE-2 → 1 条）',
    kwCode.ok && kwCode.data.total === 1, kwCode.ok ? `total=${kwCode.data.total}` : kwCode.message);

  const kwRemark = await api('GET', `/api/products?keyword=${encodeURIComponent('测试备注甲')}&pageSize=50`);
  check('关键字也匹配备注（测试备注甲 → 1 条）',
    kwRemark.ok && kwRemark.data.total === 1, kwRemark.ok ? `total=${kwRemark.data.total}` : kwRemark.message);

  const byMaterial = await api('GET', `/api/products?body_material=${encodeURIComponent('碳钢 WCB')}&pageSize=50`);
  check('按材质筛选（碳钢 WCB → 1 条）',
    byMaterial.ok && byMaterial.data.total === 1 && byMaterial.data.list[0].name === TAG + 'DN200 蝶阀',
    byMaterial.ok ? `total=${byMaterial.data.total}` : byMaterial.message);

  const byPressure = await api('GET', '/api/products?pressure_rating=PN16&pageSize=50');
  check('按压力等级筛选（PN16 → 2 条）',
    byPressure.ok && byPressure.data.total === 2,
    byPressure.ok ? `total=${byPressure.data.total}` : byPressure.message);

  const enabledOn = await api('GET', `/api/products?enabled=1&keyword=${encodeURIComponent(TAG)}&pageSize=50`);
  const enabledOff = await api('GET', `/api/products?enabled=0&keyword=${encodeURIComponent(TAG)}&pageSize=50`);
  check('按启用状态筛选（启用 5 条 / 停用 1 条）',
    enabledOn.ok && enabledOn.data.total === 5 && enabledOff.ok && enabledOff.data.total === 1,
    `启用 ${enabledOn.data && enabledOn.data.total} / 停用 ${enabledOff.data && enabledOff.data.total}`);

  /* ---------------- 6. 分页 ---------------- */
  const page1 = await api('GET', `/api/products?category_id=${catRoot.data.id}&page=1&pageSize=2`);
  const page3 = await api('GET', `/api/products?category_id=${catRoot.data.id}&page=3&pageSize=2`);
  check('分页正确（6 条 / pageSize 2 → 3 页，第 3 页 2 条）',
    page1.ok && page1.data.total === 6 && page1.data.pageSize === 2
      && page1.data.pages === 3 && (page1.data.list || []).length === 2
      && (page3.data.list || []).length === 2,
    `total=${page1.data && page1.data.total} pages=${page1.data && page1.data.pages}`);

  const pageSup = await api('GET', '/api/products?pageSize=999');
  check('pageSize 上限 200（超出按 200 处理）',
    pageSup.ok && pageSup.data.pageSize === 200,
    pageSup.ok ? `pageSize=${pageSup.data.pageSize}` : pageSup.message);

  /* ---------------- 7. 修改与详情 ---------------- */
  const upd = await api('PUT', `/api/products/${p6.data.id}`, {
    price: 200, discount: 12.5, remark: '改过备注', lead_time_days: 30
  });
  check('修改产品生效（单价/折扣/货期/备注，折后价随动 175）',
    upd.ok && Number(upd.data.price) === 200 && Number(upd.data.discount) === 12.5
      && Number(upd.data.net_price) === 175 && upd.data.remark === '改过备注'
      && Number(upd.data.lead_time_days) === 30,
    upd.ok ? `net=${upd.data.net_price}` : upd.message);

  const detail = await api('GET', `/api/products/${p1.data.id}`);
  check('产品详情带 category_name / category_path / net_price',
    detail.ok && detail.data.category_name && detail.data.category_path
      && detail.data.net_price !== undefined,
    detail.ok ? detail.data.category_path : detail.message);

  const notFound = await api('GET', '/api/products/999999');
  check('不存在的产品返回 404',
    notFound.status === 404 && notFound.code === 'NOT_FOUND',
    `HTTP ${notFound.status} ${notFound.code}`);

  /* ---------------- 8. 复制 ---------------- */
  const copy1 = await api('POST', `/api/products/${p1.data.id}/copy`);
  if (copy1.ok) made.products.push(copy1.data.id);
  check('复制产品：名称加「（副本）」，字段原样复制，sort 排到末尾',
    copy1.ok && copy1.data.name === TAG + 'DN200 蝶阀（副本）'
      && Number(copy1.data.price) === 1200 && Number(copy1.data.discount) === 30
      && copy1.data.body_material === '碳钢 WCB' && Number(copy1.data.lead_time_days) === 15
      && Number(copy1.data.sort) > Number(p1.data.sort),
    copy1.ok ? `${copy1.data.name} sort=${copy1.data.sort}（原 ${p1.data.sort}）` : copy1.message);

  const copy2 = await api('POST', `/api/products/${p1.data.id}/copy`);
  if (copy2.ok) made.products.push(copy2.data.id);
  check('同分类重复复制自动加序号（副本 2）',
    copy2.ok && copy2.data.name === TAG + 'DN200 蝶阀（副本 2）',
    copy2.ok ? copy2.data.name : copy2.message);

  check('复制后编号仍全库唯一（T-CODE-1-2 / T-CODE-1-3）',
    copy1.ok && copy2.ok && copy1.data.code === 'T-CODE-1-2' && copy2.data.code === 'T-CODE-1-3',
    `${copy1.data && copy1.data.code} / ${copy2.data && copy2.data.code}`);

  const listAfterCopy = await api('GET', `/api/products?category_id=${catA.data.id}&pageSize=50`);
  check('复制后子分类产品数 +2（2 → 4）',
    listAfterCopy.ok && listAfterCopy.data.total === 4,
    listAfterCopy.ok ? `total=${listAfterCopy.data.total}` : listAfterCopy.message);

  /* ---------------- 9. 删除（软删除） ---------------- */
  const p8 = await createProduct({
    category_id: catB.data.id, name: TAG + '待删除产品', code: 'T-CODE-DEL', price: 10
  });
  const delProduct = await api('DELETE', `/api/products/${p8.data.id}`);
  const detailAfterDel = await api('GET', `/api/products/${p8.data.id}`);
  const softRow = withDb((db) => db.prepare('SELECT deleted_at FROM products WHERE id = ?').get(Number(p8.data.id)));
  check('删除产品为软删除（接口 404，库里 deleted_at 有值）',
    delProduct.ok && delProduct.data.deleted === true
      && detailAfterDel.status === 404 && !!softRow && !!softRow.deleted_at,
    softRow ? `deleted_at=${softRow.deleted_at}` : '行不存在');

  const listAfterDel = await api('GET', `/api/products?keyword=${encodeURIComponent('待删除产品')}`);
  check('软删除的产品不再出现在列表（total=0）',
    listAfterDel.ok && listAfterDel.data.total === 0,
    listAfterDel.ok ? `total=${listAfterDel.data.total}` : listAfterDel.message);

  /* ---------------- 10. 有产品的分类不能删 ---------------- */
  const delWithProducts = await api('DELETE', `/api/product-categories/${catA.data.id}`);
  check('有产品的分类拒绝删除（提示先移走或删除）',
    delWithProducts.status === 400 && delWithProducts.code === 'HAS_PRODUCTS'
      && /先移走或删除/.test(delWithProducts.message || ''),
    `HTTP ${delWithProducts.status} ${delWithProducts.message}`);

  const delWithChildren = await api('DELETE', `/api/product-categories/${catRoot.data.id}`);
  check('有子分类的分类拒绝删除（HAS_CHILDREN）',
    delWithChildren.status === 400 && delWithChildren.code === 'HAS_CHILDREN',
    `HTTP ${delWithChildren.status} ${delWithChildren.message}`);

  /* ---------------- 11. 导出数据 ---------------- */
  const expRoot = await api('GET', `/api/products/export-data?category_id=${catRoot.data.id}`);
  check('导出数据行数与筛选一致（8 条：原 6 + 副本 2）',
    expRoot.ok && Array.isArray(expRoot.data) && expRoot.data.length === 8,
    expRoot.ok ? `rows=${expRoot.data.length}` : expRoot.message);

  const expRow = expRoot.ok ? expRoot.data.find((r) => r.code === 'T-CODE-1') : null;
  const EXP_FIELDS = ['category_path', 'name', 'code', 'unit', 'price', 'lead_time_days',
    'body_material', 'pressure_rating', 'discount', 'net_price', 'remark', 'enabled'];
  check('导出字段齐全（12 个）且折后价与接口一致',
    !!expRow && EXP_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(expRow, k))
      && Number(expRow.net_price) === 840 && Number(expRow.enabled) === 1,
    expRow ? `${EXP_FIELDS.length} 个字段，net=${expRow.net_price}` : '未找到导出行的产品');

  check('导出 category_path 为完整路径（…根分类 / …子类甲改）',
    !!expRow && expRow.category_path === TAG + '根分类 / ' + TAG + '子类甲改',
    expRow ? expRow.category_path : '—');

  /* 再在三级分类「蝶阀 / 三偏心蝶阀 / 对夹」下建产品，验证三级路径与含子孙筛选 */
  const p7 = await createProduct({
    category_id: sanJia.id, name: TAG + '三级分类产品', price: 10
  });
  const expDie = await api('GET', `/api/products/export-data?category_id=${die.id}&keyword=${encodeURIComponent(TAG)}`);
  const dieRow = expDie.ok ? expDie.data.find((r) => r.name === TAG + '三级分类产品') : null;
  check('三级分类路径导出为「蝶阀 / 三偏心蝶阀 / 对夹」且行数正确（1 条）',
    p7.ok && expDie.ok && expDie.data.length === 1 && dieRow
      && dieRow.category_path === '蝶阀 / 三偏心蝶阀 / 对夹',
    dieRow ? `${dieRow.category_path}（${expDie.data.length} 条）` : '未找到');

  const listDie = await api('GET', `/api/products?category_id=${die.id}&keyword=${encodeURIComponent(TAG)}&pageSize=50`);
  check('按一级分类筛选默认包含三级产品（含全部子孙）',
    listDie.ok && listDie.data.total === 1
      && listDie.data.list[0].category_path === '蝶阀 / 三偏心蝶阀 / 对夹',
    listDie.ok ? `total=${listDie.data.total}，${(listDie.data.list[0] || {}).category_path}` : listDie.message);

  const listSan = await api('GET', `/api/products?category_id=${sanBian.id}&keyword=${encodeURIComponent(TAG)}&pageSize=50`);
  check('按二级分类筛选同样包含其三级产品',
    listSan.ok && listSan.data.total === 1,
    listSan.ok ? `total=${listSan.data.total}` : listSan.message);

  const listDieOnly = await api('GET', `/api/products?category_id=${die.id}&include_children=false&keyword=${encodeURIComponent(TAG)}&pageSize=50`);
  check('include_children=false 时不含三级产品（只查该分类本身）',
    listDieOnly.ok && listDieOnly.data.total === 0,
    listDieOnly.ok ? `total=${listDieOnly.data.total}` : listDieOnly.message);

  /* ---------------- 12. 审计日志 ---------------- */
  const prodLogs = await api('GET', `/api/logs?entity_type=product&q=${encodeURIComponent(TAG)}&pageSize=200`);
  const prodActions = new Set((prodLogs.data && prodLogs.data.list || []).map((l) => l.action));
  check('产品审计日志：create / update / delete / copy 都有',
    prodLogs.ok && ['create', 'update', 'delete', 'copy'].every((a) => prodActions.has(a)),
    `${[...prodActions].join(' / ')}，共 ${prodLogs.data && prodLogs.data.total} 条`);

  const createLog = (prodLogs.data && prodLogs.data.list || [])
    .find((l) => l.action === 'create' && /新增产品/.test(l.summary || ''));
  check('新增日志 summary 可读（形如「新增产品：… 元 / 台」）',
    !!createLog && /^新增产品：.+ \d+(\.\d+)? 元 \/ 台$/.test(createLog.summary),
    createLog ? createLog.summary : '未找到');

  const copyLog = (prodLogs.data && prodLogs.data.list || [])
    .find((l) => l.action === 'copy');
  check('复制日志记录「源名称 → 新名称」',
    !!copyLog && /复制产品：.+→.+（副本/.test(String(copyLog.summary).replace(/ → /g, '→')),
    copyLog ? copyLog.summary : '未找到');

  const catLogs = await api('GET', `/api/logs?entity_type=product_category&q=${encodeURIComponent(TAG)}&pageSize=200`);
  const catActions = new Set((catLogs.data && catLogs.data.list || []).map((l) => l.action));
  check('分类审计日志：create / update / move 都有',
    catLogs.ok && ['create', 'update', 'move'].every((a) => catActions.has(a)),
    `${[...catActions].join(' / ')}，共 ${catLogs.data && catLogs.data.total} 条`);

  /* ---------------- 13. 清理与收尾 ---------------- */
  /* 13.1 通过接口删掉产品（走软删除），再删自定义分类 */
  for (const id of made.products) await api('DELETE', `/api/products/${id}`);
  const delCatA = await api('DELETE', `/api/product-categories/${catA.data.id}`);
  const delCatB = await api('DELETE', `/api/product-categories/${catB.data.id}`);
  const delCatRoot = await api('DELETE', `/api/product-categories/${catRoot.data.id}`);
  check('自定义分类可删除（先删产品后逐个删空分类）',
    delCatA.ok && delCatB.ok && delCatRoot.ok,
    `${delCatA.status}/${delCatB.status}/${delCatRoot.status}`);

  const catLogs2 = await api('GET', `/api/logs?entity_type=product_category&q=${encodeURIComponent(TAG)}&pageSize=200`);
  const catActions2 = new Set((catLogs2.data && catLogs2.data.list || []).map((l) => l.action));
  check('分类删除也写审计日志（delete）',
    catLogs2.ok && catActions2.has('delete'),
    `${[...catActions2].join(' / ')}，共 ${catLogs2.data && catLogs2.data.total} 条`);

  const treeAfterClean = await api('GET', '/api/product-categories?tree=1');
  const cleanRoots = treeAfterClean.data || [];
  const cleanSecond = cleanRoots.reduce((s, n) => s + (n.children || []).length, 0);
  const cleanThird = cleanRoots.reduce((s, n) => s
    + (n.children || []).reduce((t, c) => t + (c.children || []).length, 0), 0);
  check('删除后分类树恢复为 6 个一级 / 22 个二级 / 46 个三级（共 74）',
    treeAfterClean.ok && cleanRoots.length === 6 && cleanSecond === 22 && cleanThird === 46
      && cleanRoots.reduce((s, n) => s + Number(n.product_count || 0), 0) === 0,
    `一级 ${cleanRoots.length}，二级 ${cleanSecond}，三级 ${cleanThird}，合计 ${cleanRoots.length + cleanSecond + cleanThird}`);

  /* 13.2 物理清理残留（软删除的测试产品、测试分类、测试日志） */
  let leftovers = { products: -1, categories: -1 };
  try {
    purgeTag();
    leftovers = withDb((db) => ({
      products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE name LIKE ?').get(`%${TAG}%`).n,
      categories: db.prepare('SELECT COUNT(*) AS n FROM product_categories WHERE name LIKE ?').get(`%${TAG}%`).n
    }));
  } catch (e) {
    check('测试数据已清理（不留产品与自定义分类）', false, e.message);
  }
  check('测试数据已清理（不留产品与自定义分类）',
    leftovers.products === 0 && leftovers.categories === 0,
    `残留产品 ${leftovers.products} 个、分类 ${leftovers.categories} 个`);

  const builtin = withDb((db) => ({
    total: db.prepare('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL').get().n,
    sys: db.prepare('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL AND is_system = 1').get().n,
    sysChildren: db.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1 AND parent_id IS NOT NULL`).get().n,
    roots: db.prepare('SELECT COUNT(*) AS n FROM product_categories WHERE deleted_at IS NULL AND parent_id IS NULL').get().n,
    second: db.prepare(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.parent_id IS NOT NULL
        AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NULL`).get().n,
    third: db.prepare(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.parent_id IS NOT NULL
        AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NOT NULL`).get().n
  }));
  check('种子分类 74 个（6 个一级内置 + 22 个二级 + 46 个三级）原样保留，is_system=1 仅 6 个',
    builtin.total === 74 && builtin.sys === 6 && builtin.sysChildren === 0
      && builtin.roots === 6 && builtin.second === 22 && builtin.third === 46,
    `分类 ${builtin.total} 个（一级内置 ${builtin.sys} / 一级 ${builtin.roots} / 二级 ${builtin.second} / 三级 ${builtin.third}）`);

  /* ---------------- 汇总 ---------------- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  try {
    fs.writeFileSync(
      path.join(ROOT, '.fixtures', 'products-124-result.json'),
      JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
      'utf8'
    );
  } catch (_) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常：', e.stack || e);
  try { purgeTag(); } catch (_) { /* 忽略 */ }
  process.exit(1);
});
