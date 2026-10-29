/**
 * 成本台账服务（1.22 新增）
 *
 * 成本分四类：采购成本 / 维护成本 / 差旅 / 其他。
 * 每笔可挂客户与项目（二选一或都挂）；挂项目时自动带出客户。
 * 全部软删除；每次增删改写一条审计日志。
 */
'use strict';

const { plainAll, now } = require('../db');
const { COST_CATEGORIES } = require('./stats');

const FIELDS = ['customer_id', 'project_id', 'category', 'amount', 'spent_at', 'supplier', 'remark'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toLocaleDateString('sv-SE');

function log(db, action, id, summary, detail) {
  db.prepare(`INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
    VALUES ('cost', ?, ?, ?, ?, ?)`).run(id, action, summary, JSON.stringify(detail || {}), now());
}

function normalize(db, data) {
  const d = data || {};
  const out = {};
  if (d.customer_id !== undefined) out.customer_id = d.customer_id ? Number(d.customer_id) : null;
  if (d.project_id !== undefined) out.project_id = d.project_id ? Number(d.project_id) : null;
  if (d.category !== undefined) {
    const c = String(d.category || '').trim();
    if (!COST_CATEGORIES.includes(c)) {
      const e = new Error('成本分类不合法（只能是：' + COST_CATEGORIES.join(' / ') + '）');
      e.status = 400; e.code = 'BAD_CATEGORY'; throw e;
    }
    out.category = c;
  }
  if (d.amount !== undefined) {
    const a = Number(d.amount);
    if (!Number.isFinite(a) || a < 0) {
      const e = new Error('金额必须是不小于 0 的数字');
      e.status = 400; e.code = 'BAD_AMOUNT'; throw e;
    }
    out.amount = round2(a);
  }
  if (d.spent_at !== undefined) out.spent_at = String(d.spent_at || '').slice(0, 10) || today();
  if (d.supplier !== undefined) out.supplier = String(d.supplier || '').trim();
  if (d.remark !== undefined) out.remark = String(d.remark || '').trim();

  /* 项目归属校验（1.27 校验收紧）：
     项目必须存在且未删除、不能是历史项目；同时给客户时项目必须属于该客户。
     只给项目时自动带出客户。 */
  if (out.project_id) {
    const p = db.prepare(
      'SELECT id, customer_id, archived FROM projects WHERE id = ? AND deleted_at IS NULL'
    ).get(out.project_id);
    if (!p) {
      const e = new Error('关联项目不存在或已删除');
      e.status = 400; e.code = 'PROJECT_NOT_FOUND'; throw e;
    }
    if (Number(p.archived) === 1) {
      const e = new Error('历史项目只读，不能登记成本；如需继续请先「恢复归档」');
      e.status = 400; e.code = 'ARCHIVED_READONLY'; throw e;
    }
    if (out.customer_id && Number(out.customer_id) !== Number(p.customer_id)) {
      const e = new Error('关联项目不属于所选客户');
      e.status = 400; e.code = 'PROJECT_CUSTOMER_MISMATCH'; throw e;
    }
    if (!out.customer_id) out.customer_id = Number(p.customer_id);
  } else if (out.customer_id) {
    const c = db.prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL').get(out.customer_id);
    if (!c) {
      const e = new Error('关联客户不存在或已删除');
      e.status = 400; e.code = 'CUSTOMER_NOT_FOUND'; throw e;
    }
  }
  return out;
}

function list(db, q) {
  const o = q || {};
  const where = ['ct.deleted_at IS NULL'];
  const params = [];
  if (o.customer_id) { where.push('ct.customer_id = ?'); params.push(Number(o.customer_id)); }
  if (o.project_id) { where.push('ct.project_id = ?'); params.push(Number(o.project_id)); }
  if (o.category) { where.push('ct.category = ?'); params.push(String(o.category)); }
  if (o.from) { where.push('ct.spent_at >= ?'); params.push(String(o.from)); }
  if (o.to) { where.push('ct.spent_at <= ?'); params.push(String(o.to)); }
  const whereSql = 'WHERE ' + where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM costs ct ${whereSql}`).get(...params).n;
  const amount = db.prepare(`SELECT COALESCE(SUM(ct.amount), 0) AS s FROM costs ct ${whereSql}`)
    .get(...params).s;

  const pageSize = Math.max(1, Math.min(Number(o.pageSize) || 20, 200));
  const page = Math.max(1, Number(o.page) || 1);
  const listRows = plainAll(db.prepare(`
    SELECT ct.*, c.name AS customer_name, p.name AS project_name
    FROM costs ct
    LEFT JOIN customers c ON c.id = ct.customer_id
    LEFT JOIN projects p ON p.id = ct.project_id
    ${whereSql}
    ORDER BY ct.spent_at DESC, ct.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize));

  const byCategory = plainAll(db.prepare(`
    SELECT ct.category, COUNT(*) AS count, COALESCE(SUM(ct.amount), 0) AS amount
    FROM costs ct ${whereSql} GROUP BY ct.category ORDER BY amount DESC
  `).all(...params)).map((r) => Object.assign(r, { amount: round2(r.amount) }));

  return { total, amount: round2(amount), page, pageSize, list: listRows, by_category: byCategory };
}

function create(db, data) {
  const v = normalize(db, data);
  if (!v.customer_id && !v.project_id) {
    const e = new Error('请至少指定客户或项目');
    e.status = 400; e.code = 'NO_OWNER'; throw e;
  }
  /* 1.23：只登记到客户时，保证该客户有一条项目档案，成本才有项目归属 */
  if (v.customer_id && !v.project_id) {
    try {
      const pm = require('./pm');
      v.project_id = pm.ensureProjectForCustomer(db, v.customer_id);
    } catch (_) { /* 项目档案建立失败不阻断成本登记 */ }
  }
  const ts = now();
  const r = db.prepare(`INSERT INTO costs
    (customer_id, project_id, category, amount, spent_at, supplier, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    v.customer_id || null, v.project_id || null, v.category || '其他', v.amount || 0,
    v.spent_at || today(), v.supplier || '', v.remark || '', ts, ts
  );
  const id = Number(r.lastInsertRowid);
  log(db, 'create', id, `登记成本：${v.category || '其他'} ${v.amount || 0} 元`, v);
  return getOne(db, id);
}

function update(db, id, data) {
  const cur = db.prepare('SELECT * FROM costs WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!cur) { const e = new Error('成本记录不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const v = normalize(db, data);
  const keys = Object.keys(v);
  if (!keys.length) return getOne(db, id);
  db.prepare(`UPDATE costs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => v[k]), now(), Number(id));
  log(db, 'update', Number(id), `修改成本记录 #${id}`, v);
  return getOne(db, id);
}

function remove(db, id) {
  const cur = db.prepare('SELECT * FROM costs WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!cur) { const e = new Error('成本记录不存在或已删除'); e.status = 404; e.code = 'NOT_FOUND'; throw e; }
  const ts = now();
  db.prepare('UPDATE costs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, Number(id));
  log(db, 'delete', Number(id), `删除成本记录 #${id}（${cur.category} ${cur.amount} 元）`, {});
  return { id: Number(id), deleted: true };
}

function getOne(db, id) {
  return plainAll(db.prepare(`
    SELECT ct.*, c.name AS customer_name, p.name AS project_name
    FROM costs ct
    LEFT JOIN customers c ON c.id = ct.customer_id
    LEFT JOIN projects p ON p.id = ct.project_id
    WHERE ct.id = ? AND ct.deleted_at IS NULL
  `).all(Number(id)))[0] || null;
}

module.exports = { FIELDS, COST_CATEGORIES, list, create, update, remove, getOne };
