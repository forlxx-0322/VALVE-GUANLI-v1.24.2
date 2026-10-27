/**
 * 产品价目表服务（1.24 新增）
 *
 * 两块内容：
 *   1. 分类树 product_categories —— 任意层级；6 个一级分类 is_system=1（可改名/挪位，不可删），
 *      二级及以下都是自定义分类（is_system=0），可改名、可删除
 *   2. 产品 products —— 单价 / 货期 / 材质 / 压力等级 / 设定折扣 / 编号
 *
 * 口径与约定：
 *   · 全部软删除（deleted_at），列表与校验都不看已删除行
 *   · 折后价 net_price = round(price × (1 − discount/100), 2)，查询时计算、不落库
 *   · 同一分类下产品不重名；编号非空时全库唯一（软删除的不算）
 *   · 分类 product_count 含所有子孙分类的产品（点一级分类能看到整族产品）
 *   · 所有写操作都写 activity_logs（entity_type = product / product_category）
 *
 * SQL 一律参数化；更新走字段白名单，杜绝按请求体拼列名。
 */
'use strict';

const { plainAll, now } = require('../db');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

/** 业务异常：带 HTTP 状态与错误码，路由层原样透出 */
function bad(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}

/** 写一条审计日志 */
function log(db, entityType, entityId, action, summary, detail) {
  db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    entityType, entityId || null, action, summary || '',
    detail === undefined ? '' : JSON.stringify(detail), now()
  );
}

/* ================================================================== */
/* 分类                                                                */
/* ================================================================== */

function categoryRow(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.prepare('SELECT * FROM product_categories WHERE id = ? AND deleted_at IS NULL').get(n) || null;
}

/** 某父级下的同名分类（软删除的不算） */
function siblingByName(db, name, parentId, excludeId) {
  return db.prepare(`SELECT id FROM product_categories
    WHERE deleted_at IS NULL AND name = ? AND parent_id IS ? AND id <> ?`)
    .get(name, parentId === undefined ? null : parentId, excludeId || 0) || null;
}

function maxCategorySort(db, parentId) {
  return db.prepare(`SELECT COALESCE(MAX(sort), 0) AS s FROM product_categories
    WHERE deleted_at IS NULL AND parent_id IS ?`).get(parentId === undefined ? null : parentId).s;
}

/**
 * 分类树（嵌套）。
 * @returns {Array} [{ id, parent_id, name, sort, is_system, own_count, product_count, children }]
 *                  product_count = 自己 + 全部子孙分类的产品数
 */
function tree(db) {
  const rows = plainAll(db.prepare(`SELECT id, parent_id, name, sort, is_system,
      created_at, updated_at
    FROM product_categories WHERE deleted_at IS NULL ORDER BY sort, id`).all());

  const own = new Map();
  for (const r of db.prepare(`SELECT category_id, COUNT(*) AS n FROM products
      WHERE deleted_at IS NULL GROUP BY category_id`).all()) {
    own.set(Number(r.category_id), Number(r.n));
  }

  const nodes = new Map();
  for (const r of rows) {
    nodes.set(Number(r.id), Object.assign({}, r, {
      own_count: own.get(Number(r.id)) || 0,
      product_count: own.get(Number(r.id)) || 0,
      children: []
    }));
  }

  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id == null ? null : nodes.get(Number(node.parent_id));
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  /* 合计自下而上累加；用 visited 兜底历史脏数据里的环，避免死循环 */
  const visited = new Set();
  const sum = (node) => {
    if (visited.has(node.id)) return 0;
    visited.add(node.id);
    let total = node.own_count;
    for (const c of node.children) total += sum(c);
    node.product_count = total;
    return total;
  };
  for (const r of roots) sum(r);

  return roots;
}

/** 取单个分类节点（含 product_count 与 children） */
function getCategory(db, id) {
  const cur = categoryRow(db, id);
  if (!cur) return null;
  const find = (list) => {
    for (const n of list) {
      if (Number(n.id) === Number(id)) return n;
      const hit = find(n.children || []);
      if (hit) return hit;
    }
    return null;
  };
  return find(tree(db));
}

function createCategory(db, data) {
  const d = data || {};
  const name = str(d.name);
  if (!name) bad(400, 'BAD_NAME', '分类名称不能为空');

  let parentId = null;
  if (d.parent_id !== undefined && d.parent_id !== null && d.parent_id !== '') {
    parentId = Number(d.parent_id);
    if (!Number.isInteger(parentId) || parentId <= 0) bad(400, 'BAD_PARENT', '上级分类 ID 无效');
    if (!categoryRow(db, parentId)) bad(400, 'BAD_PARENT', '上级分类不存在或已删除');
  }

  if (siblingByName(db, name, parentId, 0)) {
    bad(409, 'DUPLICATE_NAME', `同一上级下已有同名分类：${name}`);
  }

  const ts = now();
  const sort = maxCategorySort(db, parentId) + 10;
  const r = db.prepare(`INSERT INTO product_categories
      (parent_id, name, sort, is_system, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)`).run(parentId, name, sort, ts, ts);
  const id = Number(r.lastInsertRowid);

  log(db, 'product_category', id, 'create',
    parentId ? `新增产品子分类：${name}` : `新增产品分类：${name}`,
    { parent_id: parentId, name });
  return getCategory(db, id);
}

/**
 * 更新分类：改名 / 改父级 / 改排序。
 * 不能把分类挂到自己的子孙下（会形成环）。
 */
function updateCategory(db, id, data) {
  const cur = categoryRow(db, id);
  if (!cur) bad(404, 'NOT_FOUND', '产品分类不存在或已删除');
  const d = data || {};
  const sets = {};
  const changes = [];

  if (d.name !== undefined) {
    const name = str(d.name);
    if (!name) bad(400, 'BAD_NAME', '分类名称不能为空');
    if (name !== cur.name) {
      if (siblingByName(db, name, cur.parent_id, cur.id)) {
        bad(409, 'DUPLICATE_NAME', `同一上级下已有同名分类：${name}`);
      }
      sets.name = name;
      changes.push(`名称 ${cur.name} → ${name}`);
    }
  }

  if (d.parent_id !== undefined) {
    let parentId = null;
    if (d.parent_id !== null && d.parent_id !== '') {
      parentId = Number(d.parent_id);
      if (!Number.isInteger(parentId) || parentId <= 0) bad(400, 'BAD_PARENT', '上级分类 ID 无效');
      if (parentId === Number(cur.id)) bad(400, 'BAD_PARENT', '不能把分类挂到自己下面');
      if (!categoryRow(db, parentId)) bad(400, 'BAD_PARENT', '上级分类不存在或已删除');
      /* 顺着新父级往上走，若碰到自己就是环 */
      const seen = new Set([Number(cur.id)]);
      let walk = parentId;
      while (walk) {
        if (seen.has(Number(walk))) bad(400, 'BAD_PARENT', '不能把分类移动到它自己的子分类下');
        seen.add(Number(walk));
        const row = db.prepare('SELECT parent_id FROM product_categories WHERE id = ?').get(walk);
        walk = row && row.parent_id != null ? Number(row.parent_id) : 0;
      }
    }
    if (Number(cur.parent_id || 0) !== Number(parentId || 0)) {
      const name = sets.name || cur.name;
      if (siblingByName(db, name, parentId, cur.id)) {
        bad(409, 'DUPLICATE_NAME', `同一上级下已有同名分类：${name}`);
      }
      sets.parent_id = parentId;
      changes.push(`上级 ${cur.parent_id == null ? '（无）' : '#' + cur.parent_id} → ${parentId == null ? '（无）' : '#' + parentId}`);
    }
  }

  if (d.sort !== undefined && d.sort !== null && d.sort !== '') {
    const s = Number(d.sort);
    if (!Number.isInteger(s)) bad(400, 'BAD_SORT', '排序必须是整数');
    if (s !== Number(cur.sort)) { sets.sort = s; changes.push(`排序 ${cur.sort} → ${s}`); }
  }

  /* 只改了父级、没给排序：排到新父级末尾，避免和目标的排序值撞在一起 */
  if (sets.parent_id !== undefined && sets.sort === undefined) {
    sets.sort = maxCategorySort(db, sets.parent_id) + 10;
    changes.push(`排序 → ${sets.sort}（末尾）`);
  }

  if (!Object.keys(sets).length) return getCategory(db, id);

  const ts = now();
  db.prepare(`UPDATE product_categories SET ${Object.keys(sets).map((k) => `${k} = ?`).join(', ')},
      updated_at = ? WHERE id = ?`).run(...Object.keys(sets).map((k) => sets[k]), ts, Number(id));

  log(db, 'product_category', Number(id), 'update',
    `修改产品分类：${sets.name || cur.name}`, { changes, fields: sets });
  return getCategory(db, id);
}

/** 改名（updateCategory 的语义化包装） */
function renameCategory(db, id, name) {
  return updateCategory(db, id, { name });
}

/**
 * 同父级内上移 / 下移。
 * 直接把同父级所有节点的 sort 归一为 10/20/30…，再交换目标两位，
 * 这样即使历史数据 sort 重复或为 0，顺序也是稳定的。
 */
function moveCategory(db, id, dir) {
  const cur = categoryRow(db, id);
  if (!cur) bad(404, 'NOT_FOUND', '产品分类不存在或已删除');
  const d = String(dir || '').toLowerCase();
  if (d !== 'up' && d !== 'down') bad(400, 'BAD_DIR', '移动方向只能是 up（上移）或 down（下移）');

  const siblings = plainAll(db.prepare(`SELECT id, name, sort FROM product_categories
    WHERE deleted_at IS NULL AND parent_id IS ? ORDER BY sort, id`).all(cur.parent_id));
  const idx = siblings.findIndex((s) => Number(s.id) === Number(cur.id));
  if (idx < 0) bad(404, 'NOT_FOUND', '产品分类不存在或已删除');

  const target = d === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= siblings.length) {
    return {
      id: Number(id),
      moved: false,
      dir: d,
      message: d === 'up' ? '已经在最前面了' : '已经是最后一个了'
    };
  }

  const order = siblings.slice();
  const [moved] = order.splice(idx, 1);
  order.splice(target, 0, moved);

  const ts = now();
  const upd = db.prepare('UPDATE product_categories SET sort = ?, updated_at = ? WHERE id = ?');
  order.forEach((s, i) => upd.run((i + 1) * 10, ts, Number(s.id)));

  log(db, 'product_category', Number(id), 'move',
    `调整产品分类排序：${cur.name} ${d === 'up' ? '上移' : '下移'}`,
    { dir: d, from: idx + 1, to: target + 1 });
  return { id: Number(id), moved: true, dir: d, sort: (target + 1) * 10 };
}

/** 删除分类（软删除）：一级内置分类不可删；有子分类或产品时拒绝 */
function removeCategory(db, id) {
  const cur = categoryRow(db, id);
  if (!cur) bad(404, 'NOT_FOUND', '产品分类不存在或已删除');
  if (Number(cur.is_system) === 1) {
    bad(400, 'SYSTEM_CATEGORY', '一级分类不可删除（可改名、可调整排序）；二级分类可自由删除');
  }

  const children = db.prepare(`SELECT COUNT(*) AS n FROM product_categories
    WHERE deleted_at IS NULL AND parent_id = ?`).get(Number(id)).n;
  if (children > 0) {
    bad(400, 'HAS_CHILDREN', `「${cur.name}」下还有 ${children} 个子分类，请先移走或删除`);
  }
  const products = db.prepare(`SELECT COUNT(*) AS n FROM products
    WHERE deleted_at IS NULL AND category_id = ?`).get(Number(id)).n;
  if (products > 0) {
    bad(400, 'HAS_PRODUCTS', `「${cur.name}」下还有 ${products} 个产品，请先移走或删除`);
  }

  const ts = now();
  db.prepare('UPDATE product_categories SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(ts, ts, Number(id));
  log(db, 'product_category', Number(id), 'delete', `删除产品分类：${cur.name}`, { name: cur.name });
  return { id: Number(id), deleted: true };
}

/* ================================================================== */
/* 产品                                                                */
/* ================================================================== */

/** 分类 id → "蝶阀 / 对夹式" 全路径（含已软删除的分类，历史产品也能显示路径） */
function loadCategoryPaths(db) {
  const rows = plainAll(db.prepare('SELECT id, parent_id, name FROM product_categories').all());
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const cache = new Map();

  const build = (id, seen) => {
    if (cache.has(id)) return cache.get(id);
    const row = byId.get(Number(id));
    if (!row) return '';
    if (!seen) seen = new Set();
    if (seen.has(Number(id))) return row.name;
    seen.add(Number(id));
    const parentPath = row.parent_id == null ? '' : build(Number(row.parent_id), seen);
    const path = parentPath ? `${parentPath} / ${row.name}` : row.name;
    cache.set(Number(id), path);
    return path;
  };
  for (const r of rows) build(Number(r.id));
  return cache;
}

function netPrice(price, discount) {
  return round2((Number(price) || 0) * (1 - (Number(discount) || 0) / 100));
}

function decorate(row, paths) {
  if (!row) return row;
  return Object.assign({}, row, {
    net_price: netPrice(row.price, row.discount),
    category_path: paths.get(Number(row.category_id)) || row.category_name || ''
  });
}

/** 分类及其全部子孙分类的 id（用于「默认包含子分类」筛选） */
function categoryWithDescendants(db, rootId) {
  const rows = plainAll(db.prepare(
    'SELECT id, parent_id FROM product_categories WHERE deleted_at IS NULL'
  ).all());
  const children = new Map();
  for (const r of rows) {
    const key = r.parent_id == null ? 0 : Number(r.parent_id);
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(Number(r.id));
  }
  const out = [];
  const seen = new Set();
  const stack = [Number(rootId)];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) || []) stack.push(c);
  }
  return out;
}

/** 查询条件 → { whereSql, params }，列表与导出共用同一口径 */
function buildWhere(db, q) {
  const o = q || {};
  const where = ['p.deleted_at IS NULL'];
  const params = [];

  if (o.category_id !== undefined && o.category_id !== null && o.category_id !== '') {
    const cid = Number(o.category_id);
    if (!Number.isInteger(cid) || cid <= 0) bad(400, 'BAD_CATEGORY', '分类 ID 无效');
    /* include_children 默认 true；显式 false / 0 时只查该分类本身 */
    const includeChildren = !(o.include_children === false || o.include_children === 'false'
      || o.include_children === 0 || o.include_children === '0');
    const ids = includeChildren ? categoryWithDescendants(db, cid) : [cid];
    where.push(`p.category_id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }

  if (str(o.keyword)) {
    const kw = `%${str(o.keyword)}%`;
    where.push('(p.name LIKE ? OR p.code LIKE ? OR p.remark LIKE ?)');
    params.push(kw, kw, kw);
  }
  if (str(o.body_material)) { where.push('p.body_material = ?'); params.push(str(o.body_material)); }
  if (str(o.pressure_rating)) { where.push('p.pressure_rating = ?'); params.push(str(o.pressure_rating)); }
  if (o.enabled !== undefined && o.enabled !== null && o.enabled !== '') {
    const on = !(o.enabled === 0 || o.enabled === '0' || o.enabled === false || o.enabled === 'false');
    where.push('p.enabled = ?');
    params.push(on ? 1 : 0);
  }

  return { whereSql: 'WHERE ' + where.join(' AND '), params };
}

/**
 * 产品列表（分页）。
 * @param {object} q { category_id, include_children, keyword, body_material,
 *                     pressure_rating, enabled, page, pageSize }
 */
function list(db, q) {
  const o = q || {};
  const { whereSql, params } = buildWhere(db, o);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p ${whereSql}`).get(...params).n;
  const pageSize = Math.min(Math.max(Number(o.pageSize) || 20, 1), 200);
  const page = Math.max(Number(o.page) || 1, 1);

  const rows = plainAll(db.prepare(`
    SELECT p.*, c.name AS category_name
    FROM products p
    LEFT JOIN product_categories c ON c.id = p.category_id
    ${whereSql}
    ORDER BY p.sort, p.id
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize));

  const paths = loadCategoryPaths(db);
  return {
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    list: rows.map((r) => decorate(r, paths))
  };
}

function getOne(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const row = db.prepare(`
    SELECT p.*, c.name AS category_name
    FROM products p
    LEFT JOIN product_categories c ON c.id = p.category_id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).get(n);
  if (!row) return null;
  return decorate(Object.assign({}, row), loadCategoryPaths(db));
}

/** 字段白名单 + 校验：只返回请求里确实给了的字段 */
function normalize(db, data, current) {
  const d = data || {};
  const cur = current || null;
  const has = (k) => d[k] !== undefined;
  const out = {};

  if (has('category_id')) {
    const cid = Number(d.category_id);
    if (!Number.isInteger(cid) || cid <= 0) bad(400, 'BAD_CATEGORY', '请选择有效的产品分类');
    if (!categoryRow(db, cid)) bad(400, 'BAD_CATEGORY', '产品分类不存在或已删除');
    out.category_id = cid;
  } else if (!cur) {
    bad(400, 'BAD_CATEGORY', '请选择产品分类');
  }

  if (has('name')) {
    const name = str(d.name);
    if (!name) bad(400, 'BAD_NAME', '产品名称不能为空');
    out.name = name;
  } else if (!cur) {
    bad(400, 'BAD_NAME', '产品名称不能为空');
  }

  if (has('code')) out.code = str(d.code);
  if (has('unit')) out.unit = str(d.unit) || '台';

  if (has('price')) {
    if (d.price === null || d.price === '') out.price = 0;
    else {
      const n = Number(d.price);
      if (!Number.isFinite(n) || n < 0) bad(400, 'BAD_PRICE', '单价必须是不小于 0 的数字');
      out.price = round2(n);
    }
  }

  if (has('discount')) {
    if (d.discount === null || d.discount === '') out.discount = 0;
    else {
      const n = Number(d.discount);
      if (!Number.isFinite(n) || n < 0 || n > 100) bad(400, 'BAD_DISCOUNT', '折扣必须在 0~100 之间');
      out.discount = round2(n);
    }
  }

  if (has('lead_time_days')) {
    if (d.lead_time_days === null || d.lead_time_days === '') out.lead_time_days = 0;
    else {
      const n = Number(d.lead_time_days);
      if (!Number.isInteger(n) || n < 0) bad(400, 'BAD_LEAD_TIME', '货期必须是不小于 0 的整数（天）');
      out.lead_time_days = n;
    }
  }

  if (has('body_material')) out.body_material = str(d.body_material);
  if (has('pressure_rating')) out.pressure_rating = str(d.pressure_rating);
  if (has('remark')) out.remark = str(d.remark);

  if (has('enabled')) {
    out.enabled = (d.enabled === 0 || d.enabled === '0' || d.enabled === false || d.enabled === 'false') ? 0 : 1;
  }

  if (has('sort')) {
    const n = Number(d.sort);
    if (!Number.isInteger(n)) bad(400, 'BAD_SORT', '排序必须是整数');
    out.sort = n;
  }

  return out;
}

/** 同分类不重名 + 编号全库唯一（软删除的不算） */
function assertUnique(db, v, current) {
  const categoryId = v.category_id !== undefined ? v.category_id
    : (current ? Number(current.category_id) : 0);
  const name = v.name !== undefined ? v.name : (current ? current.name : '');
  const code = v.code !== undefined ? v.code : (current ? current.code : '');
  const selfId = current ? Number(current.id) : 0;

  const nameHit = db.prepare(`SELECT id FROM products
    WHERE deleted_at IS NULL AND category_id = ? AND name = ? AND id <> ?`)
    .get(categoryId, name, selfId);
  if (nameHit) bad(409, 'DUPLICATE_NAME', `同一分类下已有同名产品：${name}`);

  if (code) {
    const codeHit = db.prepare(`SELECT id, name FROM products
      WHERE deleted_at IS NULL AND code = ? AND id <> ?`).get(code, selfId);
    if (codeHit) bad(409, 'DUPLICATE_CODE', `产品编号已被「${codeHit.name}」占用：${code}`);
  }
}

function maxProductSort(db, categoryId) {
  return db.prepare(`SELECT COALESCE(MAX(sort), 0) AS s FROM products
    WHERE deleted_at IS NULL AND category_id = ?`).get(Number(categoryId)).s;
}

function create(db, data) {
  const v = normalize(db, data, null);
  assertUnique(db, v, null);

  const row = {
    category_id: v.category_id,
    name: v.name,
    code: v.code || '',
    unit: v.unit || '台',
    price: v.price === undefined ? 0 : v.price,
    lead_time_days: v.lead_time_days === undefined ? 0 : v.lead_time_days,
    body_material: v.body_material || '',
    pressure_rating: v.pressure_rating || '',
    discount: v.discount === undefined ? 0 : v.discount,
    remark: v.remark || '',
    enabled: v.enabled === undefined ? 1 : v.enabled,
    sort: v.sort === undefined ? maxProductSort(db, v.category_id) + 10 : v.sort
  };

  const ts = now();
  const r = db.prepare(`INSERT INTO products
    (category_id, name, code, unit, price, lead_time_days, body_material,
     pressure_rating, discount, remark, enabled, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.category_id, row.name, row.code, row.unit, row.price, row.lead_time_days,
    row.body_material, row.pressure_rating, row.discount, row.remark, row.enabled,
    row.sort, ts, ts
  );
  const id = Number(r.lastInsertRowid);

  log(db, 'product', id, 'create',
    `新增产品：${row.name} ${row.price} 元 / ${row.unit}`, row);
  return getOne(db, id);
}

function update(db, id, data) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!cur) bad(404, 'NOT_FOUND', '产品不存在或已删除');

  const v = normalize(db, data, cur);
  if (!Object.keys(v).length) return getOne(db, id);
  assertUnique(db, v, cur);

  /* 换了分类又没指定排序：排到新分类末尾（与新建一致） */
  if (v.category_id !== undefined && Number(v.category_id) !== Number(cur.category_id)
    && v.sort === undefined) {
    v.sort = maxProductSort(db, v.category_id) + 10;
  }

  const keys = Object.keys(v);
  const ts = now();
  db.prepare(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
    WHERE id = ?`).run(...keys.map((k) => v[k]), ts, Number(id));

  const name = v.name !== undefined ? v.name : cur.name;
  const price = v.price !== undefined ? v.price : cur.price;
  const unit = v.unit !== undefined ? v.unit : cur.unit;
  log(db, 'product', Number(id), 'update',
    `修改产品：${name}（${price} 元 / ${unit}）`, { changes: v });
  return getOne(db, id);
}

function remove(db, id) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!cur) bad(404, 'NOT_FOUND', '产品不存在或已删除');

  const ts = now();
  db.prepare('UPDATE products SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .run(ts, ts, Number(id));
  log(db, 'product', Number(id), 'delete',
    `删除产品：${cur.name}（${cur.price} 元 / ${cur.unit}）`, { name: cur.name });
  return { id: Number(id), deleted: true };
}

/**
 * 复制产品（同系列改口径/材质时用）：
 *   · 名称加「（副本）」，同分类重名时自动加序号（副本 2 / 副本 3 …）
 *   · 其余字段原样复制；编号因全库唯一，故自动加 -2 / -3 后缀（原编号为空则保持为空）
 *   · sort 排到该分类末尾
 */
function copy(db, id) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!cur) bad(404, 'NOT_FOUND', '产品不存在或已删除');

  const nameOf = (n) => `${cur.name}（副本${n > 1 ? ' ' + n : ''}）`;
  let name = nameOf(1);
  let seq = 2;
  while (db.prepare('SELECT 1 AS x FROM products WHERE deleted_at IS NULL AND category_id = ? AND name = ?')
    .get(Number(cur.category_id), name)) {
    name = nameOf(seq);
    seq++;
    if (seq > 999) bad(500, 'COPY_FAILED', '同名副本过多，请先整理产品名称');
  }

  let code = cur.code || '';
  if (code) {
    const base = code;
    let candidate = `${base}-2`;
    let n = 2;
    while (db.prepare('SELECT 1 AS x FROM products WHERE deleted_at IS NULL AND code = ?').get(candidate)) {
      n++;
      candidate = `${base}-${n}`;
      if (n > 999) bad(500, 'COPY_FAILED', '编号后缀过多，请先整理产品编号');
    }
    code = candidate;
  }

  const ts = now();
  const r = db.prepare(`INSERT INTO products
    (category_id, name, code, unit, price, lead_time_days, body_material,
     pressure_rating, discount, remark, enabled, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    Number(cur.category_id), name, code, cur.unit, cur.price, cur.lead_time_days,
    cur.body_material, cur.pressure_rating, cur.discount, cur.remark, cur.enabled,
    maxProductSort(db, cur.category_id) + 10, ts, ts
  );
  const newId = Number(r.lastInsertRowid);

  log(db, 'product', newId, 'copy', `复制产品：${cur.name} → ${name}`,
    { from: Number(id), to: newId, code_from: cur.code || '', code_to: code });
  return getOne(db, newId);
}

/**
 * 导出数据（扁平，供前端 SheetJS 生成 xlsx）。
 * category_path 形如「蝶阀 / 对夹式」；不含软删除与分类已删的产品。
 */
function exportData(db, q) {
  const { whereSql, params } = buildWhere(db, q);
  const rows = plainAll(db.prepare(`
    SELECT p.category_id, p.name, p.code, p.unit, p.price, p.lead_time_days,
           p.body_material, p.pressure_rating, p.discount, p.remark, p.enabled, p.sort, p.id
    FROM products p
    ${whereSql}
    ORDER BY p.sort, p.id
  `).all(...params));

  const paths = loadCategoryPaths(db);
  return rows.map((r) => ({
    category_path: paths.get(Number(r.category_id)) || '',
    name: r.name,
    code: r.code || '',
    unit: r.unit || '',
    price: round2(r.price),
    lead_time_days: Number(r.lead_time_days) || 0,
    body_material: r.body_material || '',
    pressure_rating: r.pressure_rating || '',
    discount: round2(r.discount),
    net_price: netPrice(r.price, r.discount),
    remark: r.remark || '',
    enabled: Number(r.enabled) === 1 ? 1 : 0
  })).sort((a, b) => {
    if (a.category_path !== b.category_path) return a.category_path.localeCompare(b.category_path, 'zh');
    return a.name.localeCompare(b.name, 'zh');
  });
}

module.exports = {
  /* 分类 */
  tree,
  getCategory,
  createCategory,
  updateCategory,
  renameCategory,
  moveCategory,
  removeCategory,
  /* 产品 */
  list,
  getOne,
  create,
  update,
  remove,
  copy,
  exportData
};
