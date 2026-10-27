/**
 * 产品价目表路由（1.24 新增）
 *
 * 分类：
 *   GET    /api/product-categories?tree=1        分类树（带 product_count）
 *   POST   /api/product-categories               新增分类（parent_id 可选）
 *   PUT    /api/product-categories/:id           改名 / 改父级 / 改排序
 *   POST   /api/product-categories/:id/move      同父级上移 / 下移（{ dir: up|down }）
 *   DELETE /api/product-categories/:id           删除（内置不可删；有子分类或产品拒绝）
 *
 * 产品：
 *   GET    /api/products                          列表（分页 + 分类/关键字/材质/压力/启用筛选）
 *   GET    /api/products/export-data              导出用扁平数据（含 category_path 与 net_price）
 *   POST   /api/products                          新增
 *   GET    /api/products/:id                      详情
 *   PUT    /api/products/:id                      修改
 *   POST   /api/products/:id/copy                 复制（名称加「副本」）
 *   DELETE /api/products/:id                      删除（软删除）
 *
 * 错误沿用全局 ok/fail 风格：{ ok:false, status, code, message }。
 */
'use strict';

const products = require('../services/products');

/** 取路径中的数字 ID 段：/api/products/12 → 12；非数字返回 null */
function idAt(segments, offset) {
  const raw = segments[offset];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = async function productRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const guard = (fn) => {
    try {
      return ok(fn());
    } catch (e) {
      return fail(e.status || 500, e.code || 'PRODUCT_FAILED', e.message);
    }
  };

  /* ================= 产品分类 ================= */
  if (segments[1] === 'product-categories') {
    const rawId = segments[2];
    const id = idAt(segments, 2);
    const sub = segments[3] || '';

    /* GET /api/product-categories?tree=1 —— 目前只有树形态（tree 参数保留以便将来加平铺） */
    if (method === 'GET' && rawId === undefined) {
      return guard(() => products.tree(db));
    }

    if (method === 'POST' && rawId === undefined) {
      return guard(() => products.createCategory(db, body || {}));
    }

    if (method === 'POST' && id && sub === 'move') {
      return guard(() => products.moveCategory(db, id, (body || {}).dir));
    }

    if (id && (method === 'PUT' || method === 'PATCH') && sub === '') {
      return guard(() => products.updateCategory(db, id, body || {}));
    }

    if (id && method === 'DELETE' && sub === '') {
      return guard(() => products.removeCategory(db, id));
    }

    if (rawId !== undefined && id === null) {
      return fail(400, 'BAD_ID', '分类 ID 无效');
    }
    return null;
  }

  /* ================= 产品 ================= */
  if (segments[1] === 'products') {
    const rawId = segments[2];
    const id = idAt(segments, 2);
    const sub = segments[3] || '';

    /* 导出数据：必须排在 /:id 之前，否则 "export-data" 会被当 ID */
    if (method === 'GET' && rawId === 'export-data') {
      return guard(() => products.exportData(db, query));
    }

    if (method === 'GET' && rawId === undefined) {
      return guard(() => products.list(db, query));
    }

    if (method === 'POST' && rawId === undefined) {
      return guard(() => products.create(db, body || {}));
    }

    if (method === 'GET' && id && sub === '') {
      const row = products.getOne(db, id);
      return row ? ok(row) : fail(404, 'NOT_FOUND', '产品不存在或已删除');
    }

    if (method === 'POST' && id && sub === 'copy') {
      return guard(() => products.copy(db, id));
    }

    if (id && method === 'PUT' && sub === '') {
      return guard(() => products.update(db, id, body || {}));
    }

    if (id && method === 'DELETE' && sub === '') {
      return guard(() => products.remove(db, id));
    }

    if (rawId !== undefined && id === null) {
      return fail(400, 'BAD_ID', '产品 ID 无效');
    }
    return null;
  }

  return null;
};
