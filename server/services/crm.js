/**
 * 业务服务层 —— 客户 / 联系人 / 标签 / 跟进记录
 *
 * 1.23 起客户模型精简；1.27 起一个客户可以同时有多个进行中项目（1:N）：
 *   - 客户表只保留 21 个基础列 + 6 个新增列（无 type/level/status/phone 等旧字段）
 *   - 主联系人内嵌在 customers.contact_* 四个列里，同时同步到 contacts 表（is_primary=1）
 *   - 项目列表（1:N）在 services/pm.js；客户详情的财务汇总取「进行中项目合计」
 *
 * 设计要点：
 *   1. 字段白名单写入：前端多传的字段一律忽略，避免写坏数据库
 *   2. SQL 全部参数化；排序字段走白名单映射，杜绝注入
 *   3. 派生字段（跟进次数 / 最近跟进）由本层统一维护
 *   4. 所有写操作写 activity_logs，支持详情页「变更记录」
 */

'use strict';

const { plain, plainAll, now, FIXED_TAG_NAMES } = require('../db');

/* ------------------------------------------------------------------ */
/* 字段白名单                                                          */
/* ------------------------------------------------------------------ */

/** 客户表可写字段（不含 id / 派生字段 / 软删除标记 / 时间戳） */
const CUSTOMER_FIELDS = [
  // 资料
  'name', 'short_name', 'customer_no', 'industry', 'source', 'email',
  // 主联系人（内嵌）
  'contact_name', 'contact_position', 'contact_phone', 'contact_birthday',
  // 回访
  'next_follow_at', 'follow_cycle_days',
  // 地址与备注
  'province', 'city', 'district', 'address', 'region_code',
  'longitude', 'latitude', 'remark'
];

const CONTACT_FIELDS = [
  'customer_id', 'name', 'position', 'department', 'mobile', 'phone', 'wechat',
  'email', 'is_decision', 'is_primary', 'influence', 'birthday', 'remark'
];

const FOLLOWUP_FIELDS = [
  'customer_id', 'project_id', 'followed_at', 'method', 'content', 'result',
  'next_plan', 'next_at'
];

const TAG_FIELDS = ['name', 'color', 'sort'];

/** 数值字段：非法值归一为 0 */
const NUMERIC_FIELDS = new Set([]);
/** 可为 NULL 的数值字段（未定位时保持 NULL） */
const NULLABLE_NUMERIC_FIELDS = new Set(['longitude', 'latitude']);
/** 整型字段 */
const INT_FIELDS = new Set(['follow_cycle_days', 'is_decision', 'is_primary', 'project_id']);
/** 允许排序的列（白名单映射，防注入） */
const SORT_MAP = {
  customer_no: 'c.customer_no',
  next_follow_at: 'c.next_follow_at',
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
  follow_count: 'c.follow_count',
  name: 'c.name'
};
/** 允许筛选的等值字段 */
const EQ_FILTERS = ['industry', 'source', 'province', 'city', 'district', 'region_code'];

/**
 * 中文排序器。
 * SQLite 默认 BINARY 排序按 UTF-8 字节序处理中文（中国 → 宝钢 → 新疆），
 * 不符合中文阅读习惯；这里用 ICU 的拼音排序在内存中处理。
 */
const ZH_COLLATOR = new Intl.Collator('zh-Hans-CN', { sensitivity: 'variant', numeric: true });

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function badRequest(message, code) {
  const e = new Error(message);
  e.code = code || 'BAD_REQUEST';
  e.status = 400;
  return e;
}

function notFound(message) {
  const e = new Error(message || '记录不存在');
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

/** 按白名单裁剪 payload，并做类型归一 */
function pick(payload, fields) {
  const out = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, f)) continue;
    let v = payload[f];
    if (v === undefined) continue;

    /* 可空数值字段（经纬度）：空值保留为 NULL，非法值也置 NULL */
    if (NULLABLE_NUMERIC_FIELDS.has(f)) {
      if (v === null || v === '' || v === 'null') { out[f] = null; continue; }
      const n = Number(v);
      out[f] = isFinite(n) ? n : null;
      continue;
    }

    /* 数值与整型字段：这些列是 NOT NULL DEFAULT 0，非法值必须归一为 0 而非 NULL */
    if (NUMERIC_FIELDS.has(f) || INT_FIELDS.has(f)) {
      if (v === null || v === '') { out[f] = 0; continue; }
      const n = Number(v);
      if (!isFinite(n)) { out[f] = 0; continue; }
      out[f] = INT_FIELDS.has(f) ? Math.trunc(n) : n;
      continue;
    }

    if (v === null) { out[f] = null; continue; }
    if (typeof v === 'boolean') { out[f] = v ? 1 : 0; continue; }
    if (typeof v === 'string') { out[f] = v.trim(); continue; }
    if (typeof v === 'number') { out[f] = v; continue; }
    out[f] = String(v).trim();
  }
  return out;
}

/** 写操作日志 */
function logActivity(db, entityType, entityId, action, summary, detail) {
  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entityType, entityId || null, action, summary || '', detail ? JSON.stringify(detail) : '', now());
}

/** 读取字典选项（按分类分组）
 *  @param {object} db
 *  @param {boolean} includeDisabled true=管理页用，返回全部分类的所有项（含 enabled 标记）；
 *                                   false=表单下拉用，只返回启用中的项
 */
function readDict(db, includeDisabled) {
  const rows = db.prepare(
    `SELECT id, category, value, color, sort, enabled, is_system
     FROM dict
     WHERE deleted_at IS NULL ${includeDisabled ? '' : 'AND enabled = 1'}
     ORDER BY category, sort, id`
  ).all();
  const map = {};
  for (const r of rows) {
    (map[r.category] = map[r.category] || []).push(plain(r));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* 列表查询                                                            */
/* ------------------------------------------------------------------ */

/**
 * 客户列表
 * @param {object} db
 * @param {object} q  查询参数
 */
function listCustomers(db, q) {
  const where = ['c.deleted_at IS NULL'];
  const params = [];

  /* 关键词：客户名 / 简称 / 客户编号 / 主联系人姓名与手机 / 邮箱 / 附加联系人 */
  if (q.q) {
    const kw = `%${String(q.q).trim()}%`;
    where.push(`(c.name LIKE ? OR c.short_name LIKE ? OR c.customer_no LIKE ?
                 OR c.contact_name LIKE ? OR c.contact_phone LIKE ? OR c.email LIKE ?
                 OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.customer_id = c.id
                            AND ct.deleted_at IS NULL AND (ct.name LIKE ? OR ct.mobile LIKE ?)))`);
    params.push(kw, kw, kw, kw, kw, kw, kw, kw);
  }

  /* 等值筛选 */
  for (const f of EQ_FILTERS) {
    if (q[f]) { where.push(`c.${f} = ?`); params.push(q[f]); }
  }

  /* 标签筛选（命中任一） */
  if (q.tag_id) {
    where.push(`EXISTS (SELECT 1 FROM customer_tags ctg WHERE ctg.customer_id = c.id AND ctg.tag_id = ?)`);
    params.push(Number(q.tag_id));
  }

  /* 快捷筛选（1.23 新口径：没有等级/主体类型这类旧概念了） */
  if (q.quick === 'today')      where.push(`(c.next_follow_at IS NOT NULL AND date(c.next_follow_at) <= date('now','localtime'))`);
  if (q.quick === 'overdue')    where.push(`(c.next_follow_at IS NOT NULL AND date(c.next_follow_at) < date('now','localtime'))`);
  if (q.quick === 'stale30')    where.push(`(c.last_follow_at IS NULL OR date(c.last_follow_at) < date('now','localtime','-30 days'))`);
  if (q.quick === 'no_follow')  where.push(`c.follow_count = 0`);
  if (q.quick === 'month_new')  where.push(`date(c.created_at) >= date('now','localtime','start of month')`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /* 总数 */
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${whereSql}`).get(...params).n;

  /* 分页参数 */
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 20, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const offset = (page - 1) * pageSize;

  /* ------------------------------------------------------------------
   * 按名称排序：SQLite 默认 BINARY 按 UTF-8 字节序排中文（中国→宝钢→新疆），
   * 不符合中文阅读习惯。改为两段式：先只取 id 在内存中按拼音排序，
   * 再按页取详情。仅对 name 走这条路，其余排序仍在数据库内完成。
   * ---------------------------------------------------------------- */
  let idPage = null;
  if (q.sort === 'name') {
    const dir = String(q.order || 'asc').toLowerCase() === 'asc' ? 1 : -1;
    const idRows = db.prepare(`SELECT c.id, c.name FROM customers c ${whereSql}`).all(...params);
    idRows.sort((a, b) => {
      const r = ZH_COLLATOR.compare(String(a.name || ''), String(b.name || ''));
      return r !== 0 ? r * dir : (b.id - a.id) * dir;
    });
    idPage = idRows.slice(offset, offset + pageSize).map((r) => r.id);
  }

  /* 组装排序子句（非名称排序时使用） */
  let orderSql;
  if (SORT_MAP[q.sort] && q.sort !== 'name') {
    const dir = String(q.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    /* 下次回访时间：无值的排最后 */
    const nulls = q.sort === 'next_follow_at' ? `(c.next_follow_at IS NULL) ASC,` : '';
    orderSql = `${nulls} ${SORT_MAP[q.sort]} ${dir}, c.id DESC`;
  } else if (q.sort === 'name') {
    orderSql = 'c.id ASC';  // 占位；实际顺序由 idPage 决定
  } else {
    orderSql = 'c.updated_at DESC, c.id DESC';
  }

  /* 无匹配结果时直接返回，避免无效查询 */
  if (idPage && idPage.length === 0) {
    return { list: [], total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  const pageClause = idPage
    ? `c.id IN (${idPage.map(() => '?').join(', ')})`
    : '1 = 1';
  const listParams = idPage ? params.concat(idPage) : params.concat([pageSize, offset]);

  /* 列表行字段：列表列 + 编辑表单字段的并集（编辑用同一份数据，避免覆盖丢字段） */
  const rows = plainAll(db.prepare(`
    SELECT c.id, c.name, c.short_name, c.customer_no, c.industry, c.source, c.email,
           c.contact_name, c.contact_position, c.contact_phone, c.contact_birthday,
           c.follow_cycle_days, c.province, c.city, c.district, c.address,
           c.region_code, c.region_name, c.longitude, c.latitude,
           c.next_follow_at, c.last_follow_at, c.follow_count, c.remark,
           c.updated_at, c.created_at,
           (SELECT COUNT(*) FROM contacts ct
              WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL) AS contact_count,
           (SELECT COUNT(*) FROM projects p
              WHERE p.customer_id = c.id AND p.deleted_at IS NULL AND p.archived = 0) AS project_count
    FROM customers c
    ${whereSql}
    ${idPage ? `AND ${pageClause}` : ''}
    ORDER BY ${orderSql}
    ${idPage ? '' : 'LIMIT ? OFFSET ?'}
  `).all(...listParams));

  /* 标签：一次查完再按客户分组，避免 N+1 */
  const tagMap = new Map();
  if (rows.length) {
    const marks = rows.map(() => '?').join(', ');
    const tagRows = plainAll(db.prepare(`
      SELECT ct.customer_id, t.id, t.name, t.color
      FROM customer_tags ct JOIN tags t ON t.id = ct.tag_id
      WHERE ct.customer_id IN (${marks})
      ORDER BY t.sort, t.id
    `).all(...rows.map((r) => r.id)));
    for (const t of tagRows) {
      if (!tagMap.has(t.customer_id)) tagMap.set(t.customer_id, []);
      tagMap.get(t.customer_id).push({ id: t.id, name: t.name, color: t.color });
    }
  }

  let list = rows.map((r) => {
    r.tags = tagMap.get(r.id) || [];
    r.overdue = !!(r.next_follow_at && new Date(String(r.next_follow_at).replace(' ', 'T')).getTime() < Date.now());
    return r;
  });

  /* 名称排序时按内存中的 id 顺序重排 */
  if (idPage) {
    const pos = new Map(idPage.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  }

  return { list, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/* ------------------------------------------------------------------ */
/* 详情                                                                */
/* ------------------------------------------------------------------ */

/**
 * 客户财务汇总（1.27：按「进行中项目合计」）
 *
 * 口径（与界面上的说明一致）：
 *   合同额   = Σ 进行中项目（archived=0）的 contract_amount
 *   已收     = Σ 进行中项目的 payments.type='实收'
 *   应收     = Σ 进行中项目的回款计划 − 已收，负数按 0 显示
 *   成本     = Σ 进行中项目的成本台账（采购 / 维护 / 差旅 / 其他）
 *   毛利     = 已收 − 成本（实际口径，不是合同额）
 *   毛利率   = 毛利 ÷ 已收（已收为 0 时为 null，界面显示「—」）
 *   预计毛利 = 合同额 − 采购成本（报价/投标时看这个）
 *
 * 历史（已归档）项目不计入上述合计，但仍可在客户详情里只读查看；
 * 数字与 GET /api/customers/:id/projects 的 totals 完全一致。
 */
function getCustomerFinance(db, customerId) {
  const cid = Number(customerId);
  const cust = db.prepare('SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL').get(cid);
  if (!cust) throw notFound('客户不存在或已删除');

  /* 延迟 require：pm 也 require 本文件，顶层互相 require 会拿到半成品 exports */
  const pm = require('./pm');
  const summary = pm.projectsSummary(db, cid);
  const totals = summary.totals;
  const latest = summary.active[0] || null;

  const pay = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN pm2.type = '计划' THEN pm2.amount ELSE 0 END), 0) AS planned
    FROM payments pm2
    JOIN projects p ON p.id = pm2.project_id AND p.deleted_at IS NULL
    WHERE p.customer_id = ? AND p.archived = 0
  `).get(cid);

  const costRows = db.prepare(`
    SELECT ct.category, COALESCE(SUM(ct.amount), 0) AS amount
    FROM costs ct
    JOIN projects p ON p.id = ct.project_id AND p.deleted_at IS NULL
    WHERE ct.deleted_at IS NULL AND p.customer_id = ? AND p.archived = 0
    GROUP BY ct.category
  `).all(cid);
  const costOf = (name) => {
    const hit = costRows.find((r) => r.category === name);
    return round2(hit ? hit.amount : 0);
  };

  const contract = round2(totals.contract_amount);
  const received = round2(totals.received_amount);
  const planned = round2(pay.planned);
  const purchase = costOf('采购成本');
  const maintain = costOf('维护成本');
  const other = round2(costOf('差旅') + costOf('其他'));
  const totalCost = round2(totals.cost_amount);
  const profit = round2(totals.profit);

  return {
    /* 兼容旧字段：取最近创建的进行中项目（多项目时仅供参考，汇总看 totals） */
    project_id: latest ? latest.id : null,
    project_name: latest ? latest.name : '',
    project_count: totals.active_count,
    active_project_count: totals.active_count,
    archived_project_count: totals.archived_count,
    contract_amount: contract,
    planned_amount: planned,
    received_amount: received,
    receivable_amount: Math.max(0, round2(planned - received)),
    purchase_cost: purchase,
    maintain_cost: maintain,
    other_cost: other,
    total_cost: totalCost,
    cost_amount: totalCost,
    profit,
    margin: totals.margin,
    expected_profit: round2(contract - purchase)
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function getCustomer(db, id) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
  if (!c || c.deleted_at) throw notFound('客户不存在或已删除');
  const customer = plain(c);

  customer.contacts = plainAll(db.prepare(
    `SELECT * FROM contacts WHERE customer_id = ? AND deleted_at IS NULL
     ORDER BY is_primary DESC, is_decision DESC, id ASC`
  ).all(customer.id));

  customer.tags = plainAll(db.prepare(
    `SELECT t.id, t.name, t.color FROM tags t
     JOIN customer_tags ct ON ct.tag_id = t.id WHERE ct.customer_id = ?
     ORDER BY t.sort, t.id`
  ).all(customer.id)).map((t) => Object.assign(t, { fixed: FIXED_TAG_NAMES.includes(t.name) }));

  customer.followups = plainAll(db.prepare(
    `SELECT f.*, p.name AS project_name FROM followups f
     LEFT JOIN projects p ON p.id = f.project_id
     WHERE f.customer_id = ? AND f.deleted_at IS NULL
     ORDER BY f.followed_at DESC, f.id DESC LIMIT 200`
  ).all(customer.id));

  /* 进行中项目（1.27：可能有多个；这里给「最近创建的一个」做旧字段兼容） */
  const project = db.prepare(`
    SELECT p.*, COALESCE((SELECT SUM(pm.amount) FROM payments pm
                          WHERE pm.project_id = p.id AND pm.type = '实收'), 0) AS received
    FROM projects p
    WHERE p.customer_id = ? AND p.deleted_at IS NULL AND p.archived = 0
    ORDER BY p.created_at DESC, p.id DESC LIMIT 1
  `).get(customer.id);
  customer.project = project ? plain(project) : null;
  if (customer.project) {
    const contract = Number(customer.project.contract_amount) || 0;
    customer.project.received = round2(customer.project.received);
    customer.project.debt = round2(contract - customer.project.received);
    customer.project.rate = contract > 0
      ? Math.round((customer.project.received / contract) * 1000) / 10 : 0;
  }

  /* 进行中项目数量的轻量列表（详情页不用再额外查一次就能显示「进行中 N 个」） */
  const activeProjects = plainAll(db.prepare(`
    SELECT p.id, p.name, p.stage, p.progress, p.contract_amount, p.created_at,
           COALESCE((SELECT SUM(pm.amount) FROM payments pm
                     WHERE pm.project_id = p.id AND pm.type = '实收'), 0) AS received_amount
    FROM projects p
    WHERE p.customer_id = ? AND p.deleted_at IS NULL AND p.archived = 0
    ORDER BY p.created_at DESC, p.id DESC
  `).all(customer.id)).map((p) => Object.assign(p, {
    received_amount: round2(p.received_amount),
    debt_amount: round2((Number(p.contract_amount) || 0) - (Number(p.received_amount) || 0))
  }));
  customer.active_projects = activeProjects;

  /* 历史项目（已归档，只读） */
  customer.history_projects = plainAll(db.prepare(
    `SELECT p.id, p.name, p.stage, p.progress, p.contract_amount, p.signed_at, p.archived,
            p.created_at, p.updated_at,
            COALESCE((SELECT SUM(pm.amount) FROM payments pm
                      WHERE pm.project_id = p.id AND pm.type = '实收'), 0) AS received_amount
     FROM projects p WHERE p.customer_id = ? AND p.deleted_at IS NULL AND p.archived = 1
     ORDER BY p.updated_at DESC, p.id DESC`
  ).all(customer.id)).map((p) => Object.assign(p, {
    received_amount: round2(p.received_amount)
  }));

  customer.tasks = plainAll(db.prepare(
    `SELECT id, title, due_at, priority, status, source FROM tasks
     WHERE customer_id = ? AND deleted_at IS NULL AND status = '待办'
     ORDER BY (due_at IS NULL) ASC, due_at ASC LIMIT 50`
  ).all(customer.id));

  customer.logs = plainAll(db.prepare(
    `SELECT id, action, summary, created_at FROM activity_logs
     WHERE entity_type = 'customer' AND entity_id = ?
     ORDER BY id DESC LIMIT 100`
  ).all(customer.id));

  /* 主联系人：客户表内嵌字段为准（contacts 表里有同名副本，is_primary=1） */
  customer.primary_contact = {
    name: customer.contact_name || '',
    position: customer.contact_position || '',
    phone: customer.contact_phone || '',
    birthday: customer.contact_birthday || ''
  };

  customer.finance = getCustomerFinance(db, customer.id);

  customer.summary = {
    contact_count: customer.contacts.length,
    extra_contact_count: customer.contacts.filter((x) => !x.is_primary).length,
    follow_count: customer.follow_count || 0,
    task_count: customer.tasks.length,
    project_count: customer.active_projects.length,
    active_project_count: customer.active_projects.length,
    history_project_count: customer.history_projects.length
  };

  return customer;
}

/* ------------------------------------------------------------------ */
/* 保存客户                                                            */
/* ------------------------------------------------------------------ */

/** 生成客户编号：KH-YYYY-####（当年已有最大编号 +1，含回收站里的记录，避免复用） */
function nextCustomerNo(db, year) {
  const y = String(year || new Date().getFullYear());
  const prefix = `KH-${y}-`;
  const rows = db.prepare(
    'SELECT customer_no FROM customers WHERE customer_no LIKE ?'
  ).all(prefix + '%');
  const re = new RegExp(`^KH-${y}-(\\d+)$`);
  let max = 0;
  for (const r of rows) {
    const m = re.exec(String(r.customer_no || ''));
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/** 客户编号唯一校验（含回收站，避免还原时撞号） */
function assertCustomerNoUnique(db, customerNo, excludeId) {
  const hit = db.prepare(
    `SELECT id, name FROM customers WHERE customer_no = ? ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`
  ).get(...(excludeId ? [customerNo, excludeId] : [customerNo]));
  if (hit) throw badRequest(`客户编号「${customerNo}」已被「${hit.name}」占用`, 'DUPLICATE');
}

/** 查重：同名 / 同联系人手机（排除自身） */
function findDuplicates(db, name, phone, excludeId) {
  const hits = [];
  const ex = excludeId ? 'AND id <> ?' : '';
  const cols = 'id, name, short_name, contact_name, contact_phone, customer_no';
  if (name) {
    const rows = db.prepare(
      `SELECT ${cols} FROM customers WHERE deleted_at IS NULL AND name = ? ${ex} LIMIT 5`
    ).all(...(excludeId ? [name, excludeId] : [name]));
    for (const r of rows) hits.push(Object.assign(plain(r), { match: 'name' }));
  }
  if (phone) {
    const rows = db.prepare(
      `SELECT ${cols} FROM customers WHERE deleted_at IS NULL AND contact_phone = ? AND contact_phone <> '' ${ex} LIMIT 5`
    ).all(...(excludeId ? [phone, excludeId] : [phone]));
    for (const r of rows) {
      if (!hits.some((h) => h.id === r.id)) hits.push(Object.assign(plain(r), { match: 'phone' }));
    }
  }
  return hits;
}

/**
 * 主联系人同步：客户表内嵌 contact_* → contacts 表里 is_primary=1 的那一条。
 * 没有主联系人且填了姓名时新建一条；客户没填姓名时不动已有联系人。
 */
function syncPrimaryContact(db, customerId, ts) {
  const c = db.prepare(
    'SELECT contact_name, contact_position, contact_phone, contact_birthday FROM customers WHERE id = ?'
  ).get(customerId);
  if (!c) return;
  const primary = db.prepare(
    `SELECT id FROM contacts WHERE customer_id = ? AND deleted_at IS NULL AND is_primary = 1
     ORDER BY id ASC LIMIT 1`
  ).get(customerId);
  if (primary) {
    db.prepare(
      `UPDATE contacts SET name = ?, position = ?, mobile = ?, birthday = ?, updated_at = ? WHERE id = ?`
    ).run(c.contact_name || '', c.contact_position || '', c.contact_phone || '',
      c.contact_birthday || null, ts, primary.id);
    return;
  }
  if (!String(c.contact_name || '').trim()) return;
  const info = db.prepare(
    `INSERT INTO contacts (customer_id, name, position, mobile, birthday, is_primary, is_decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
  ).run(customerId, c.contact_name, c.contact_position || '', c.contact_phone || '',
    c.contact_birthday || null, ts, ts);
  db.prepare('UPDATE contacts SET is_primary = 0 WHERE customer_id = ? AND id <> ?')
    .run(customerId, Number(info.lastInsertRowid));
}

/**
 * 新增或更新客户（1.23 字段模型）
 * @returns {{id:number, created:boolean, duplicates:Array, changed:string[]}}
 */
function saveCustomer(db, payload) {
  const data = pick(payload, CUSTOMER_FIELDS);
  const id = payload.id ? Number(payload.id) : null;

  const ts = now();

  db.exec('BEGIN');
  try {
    if (id) {
      /* ---------- 更新：允许局部更新，只校验本次提交的字段 ---------- */
      const before = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!before) throw notFound('客户不存在或已删除');

      /* 若本次提交了名称，则名称不允许改成空 */
      if (Object.prototype.hasOwnProperty.call(data, 'name') && !(data.name || '').trim()) {
        throw badRequest('客户名称（全称）为必填项', 'NAME_REQUIRED');
      }

      /* 编号：允许手改；空值表示「不改」，非空必须唯一 */
      if (Object.prototype.hasOwnProperty.call(data, 'customer_no')) {
        if (!String(data.customer_no || '').trim()) {
          delete data.customer_no;
        } else {
          assertCustomerNoUnique(db, data.customer_no, id);
        }
      }

      const duplicates = findDuplicates(db, data.name || before.name, data.contact_phone || '', id);

      const keys = Object.keys(data);
      if (keys.length) {
        db.prepare(
          `UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
        ).run(...keys.map((k) => data[k]), ts, id);
      }

      /* 主联系人内嵌字段 → contacts 表（is_primary=1） */
      if (keys.some((k) => k.startsWith('contact_'))) syncPrimaryContact(db, id, ts);

      /* 记录变更明细，便于详情页「变更记录」展示 */
      const changed = [];
      for (const k of keys) {
        const oldV = before[k];
        const newV = data[k];
        const a = oldV === null || oldV === undefined ? '' : String(oldV);
        const b = newV === null || newV === undefined ? '' : String(newV);
        if (a !== b) changed.push({ field: k, from: a, to: b });
      }
      if (changed.length) {
        const FIELD_LABEL = {
          name: '名称', short_name: '简称', customer_no: '客户编号',
          industry: '行业', source: '来源', email: '邮箱',
          contact_name: '联系人', contact_position: '职务', contact_phone: '手机',
          contact_birthday: '生日', follow_cycle_days: '回访周期',
          province: '省', city: '市', district: '区县', address: '详细地址',
          region_code: '归属地州', next_follow_at: '下次回访', remark: '备注'
        };
        const summary = changed.slice(0, 3)
          .map((c) => `${FIELD_LABEL[c.field] || c.field}：${c.from || '空'} → ${c.to || '空'}`)
          .join('；');
        logActivity(db, 'customer', id, 'update',
          `修改 ${changed.length} 项 —— ${summary}${changed.length > 3 ? ' 等' : ''}`, changed);
      }

      /* 标签 */
      if (Array.isArray(payload.tag_ids)) applyTags(db, id, payload.tag_ids);

      /* 地址变化后，重新匹配归属地州 */
      if (keys.some((k) => ['city', 'district', 'province', 'region_code'].includes(k))) {
        if (data.region_code) {
          /* 前端明确指定了归属，按 code 补齐名称。历史上前端下拉把「地州名」当值传过，
             这里统一纠正成编码；名字也认不出时才回退到按地址匹配。 */
          const resolved = resolveRegionInput(db, data.region_code);
          if (resolved) {
            db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
              .run(resolved.code, resolved.name, id);
          } else {
            db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
              .run('', '', id);
            syncCustomerRegion(db, id);
          }
        } else {
          syncCustomerRegion(db, id);
        }
      }

      db.exec('COMMIT');
      return { id, created: false, duplicates, changed: changed.map((c) => c.field) };
    }

    /* ---------- 新增 ---------- */
    const name = (data.name || '').trim();
    if (!name) throw badRequest('客户名称（全称）为必填项', 'NAME_REQUIRED');
    const duplicates = findDuplicates(db, name, data.contact_phone || '', null);

    /* 客户编号：留空自动生成 KH-YYYY-0001；手填则校验唯一 */
    if (!String(data.customer_no || '').trim()) {
      data.customer_no = nextCustomerNo(db);
    } else {
      assertCustomerNoUnique(db, data.customer_no, null);
    }

    data.created_at = ts;
    data.updated_at = ts;
    const keys = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO customers (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
    ).run(...keys.map((k) => data[k]));

    const newId = Number(info.lastInsertRowid);
    if (Array.isArray(payload.tag_ids)) applyTags(db, newId, payload.tag_ids);
    syncPrimaryContact(db, newId, ts);
    logActivity(db, 'customer', newId, 'create', `新建客户：${name}（${data.customer_no}）`, null);

    /* 归属地州：优先用指定的 code，否则按地址文本匹配 */
    if (data.region_code) {
      const resolved = resolveRegionInput(db, data.region_code);
      if (resolved) {
        db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
          .run(resolved.code, resolved.name, newId);
      } else {
        db.prepare("UPDATE customers SET region_code = '', region_name = '' WHERE id = ?").run(newId);
        syncCustomerRegion(db, newId);
      }
    } else {
      syncCustomerRegion(db, newId);
    }

    db.exec('COMMIT');
    return { id: newId, created: true, duplicates, changed: [] };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 覆盖式设置客户标签 */
function applyTags(db, customerId, tagIds) {
  db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(customerId);
  const ins = db.prepare('INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, created_at) VALUES (?, ?, ?)');
  const ts = now();
  for (const t of tagIds) {
    const tid = Number(t);
    if (Number.isInteger(tid) && tid > 0) ins.run(customerId, tid, ts);
  }
}

/**
 * 依据客户的省/市/区县自动归属到地州（region_code）
 *
 * 说明：region 表里地州是 level='city'、县市区是 level='district'。
 * 客户在界面上填的是「市 / 地区」与「区 / 县」，这里做名称匹配后写入 region_code，
 * 供地图统计与按区域筛选使用。匹配不到就保持为空（不猜）。
 *
 * 真实填法很随意，因此匹配顺序按「越具体越优先」排：
 *   ① 区县字段 → 二级区划（如「天山区」「库车市」「莎车县」）
 *   ② 区县字段 → 地州（有人把地州填在区县里）
 *   ③ 市字段   → 二级区划（**关键**：库尔勒/独山子/乌鲁木齐县这类本身是县级，
 *                用户很自然会把它们填在「市/地区」里，区县留空）
 *   ④ 市字段   → 地州（含简称：昌吉州、巴州）
 *   ⑤ 兜底：把地址全字段拼起来做包含匹配
 * 匹配到的二级区划用它的 parent_code 作为地州；若 parent 与用户填的地州不一致，
 * 则以用户填的地州为准（避免「昌吉州/库尔勒市」这种矛盾填法把客户归错地方）。
 */

/** 去括号补充说明：「乌鲁木齐市高新区（新市区）」→「乌鲁木齐市高新区」 */
function stripParen(s) {
  return String(s || '').replace(/[（(][^）)]*[）)]/g, '').trim();
}

/**
 * 把用户传来的「归属地州」值解析成 { code, name }。
 *
 * 为什么要这层：该字段应存地州编码（地图按 code 聚合），
 * 但早期前端下拉把「地州名」当值传，库里因此出现过 region_code='克拉玛依市' 这种数据。
 * 这里同时接受编码与名称，统一返回编码；两者都认不出返回 null（由调用方回退到按地址匹配）。
 */
function resolveRegionInput(db, input) {
  const v = String(input == null ? '' : input).trim();
  if (!v) return null;
  /* 1) 就是编码 */
  const byCode = db.prepare('SELECT code, name FROM region WHERE code = ?').get(v);
  if (byCode) return { code: byCode.code, name: byCode.name };
  /* 2) 是地州名（含简称） */
  const byName = db.prepare(
    "SELECT code, name FROM region WHERE level = 'city' AND name = ? LIMIT 1"
  ).get(v);
  if (byName) return { code: byName.code, name: byName.name };
  const short = stripParen(v).replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|自治州|地区|市|州)$/, '');
  if (short && short !== v) {
    const byShort = db.prepare(
      "SELECT code, name FROM region WHERE level = 'city' AND (name = ? OR name LIKE ?) LIMIT 1"
    ).get(short, short + '%');
    if (byShort) return { code: byShort.code, name: byShort.name };
  }
  /* 3) 干脆就是简称、且没带任何后缀（如「乌鲁木齐」「巴音郭楞」）：
        用地州名前缀匹配，取最短的一条避免误配到更长的名字。 */
  const bare = stripParen(v);
  if (bare.length >= 2) {
    const byPrefix = db.prepare(
      `SELECT code, name FROM region
       WHERE level = 'city' AND name LIKE ?
       ORDER BY LENGTH(name) ASC LIMIT 1`
    ).get(bare + '%');
    if (byPrefix) return { code: byPrefix.code, name: byPrefix.name };
  }
  return null;
}

/**
 * 纠历史脏数据：region_code 里存了地州名而不是编码的行，统一改成编码。
 * 幂等，可在启动时安全调用。
 */
function fixLegacyRegionCodes(db) {
  const bad = db.prepare(
    `SELECT c.id, c.region_code FROM customers c
     WHERE c.region_code <> ''
       AND NOT EXISTS (SELECT 1 FROM region r WHERE r.code = c.region_code)`
  ).all();
  let fixed = 0;
  const upd = db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?');
  for (const row of bad) {
    const r = resolveRegionInput(db, row.region_code);
    if (r) { upd.run(r.code, r.name, row.id); fixed++; }
  }
  return fixed;
}

function syncCustomerRegion(db, customerId) {
  const c = db.prepare(
    'SELECT id, province, city, district, address, region_code FROM customers WHERE id = ?'
  ).get(Number(customerId));
  if (!c) return null;

  const hasRegion = !!c.region_code;

  const cityText = String(c.city || '').trim();
  const distText = String(c.district || '').trim();
  const addrText = String(c.address || '').trim();
  const provText = String(c.province || '').trim();

  if (!cityText && !distText && !addrText) {
    if (hasRegion) {
      db.prepare("UPDATE customers SET region_code = '', region_name = '' WHERE id = ?").run(c.id);
    }
    return null;
  }

  /* ---------- 匹配用的查表语句 ---------- */
  const byDistrictName = db.prepare(
    "SELECT code, name, parent_code FROM region WHERE level = 'district' AND name = ? LIMIT 1"
  );
  const byCityName = db.prepare(
    "SELECT code, name FROM region WHERE level = 'city' AND name = ? LIMIT 1"
  );
  const byCityLike = db.prepare(
    "SELECT code, name FROM region WHERE level = 'city' AND name LIKE ? ORDER BY code LIMIT 1"
  );
  const nameOf = db.prepare('SELECT name FROM region WHERE code = ?');
  const parentOf = db.prepare('SELECT code, name FROM region WHERE code = ?');

  /** 找二级区划（县市区），支持去掉「区/县/市」后缀再试一次 */
  function findDistrict(text) {
    const t = stripParen(text);
    if (!t) return null;
    let hit = byDistrictName.get(t);
    if (!hit) {
      const bare = t.replace(/(区|县|市)$/, '');
      if (bare && bare !== t) hit = byDistrictName.get(bare);
    }
    /* 再试去掉空白与"自治县/自治旗"等后缀 */
    if (!hit) {
      const bare2 = t.replace(/(自治县|自治旗|新区|经济开发区|经济技术开发区|工业园区)$/, '').trim();
      if (bare2 && bare2 !== t) hit = byDistrictName.get(bare2);
    }
    return hit || null;
  }

  /** 找地州，支持常见简称 */
  function findPrefecture(text) {
    const t = stripParen(text);
    if (!t) return null;
    let hit = byCityName.get(t);
    if (hit) return hit;
    const short = t.replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|自治州|地区|市|州)$/, '');
    if (short && short !== t) {
      hit = byCityName.get(short) || byCityLike.get(short + '%');
      if (hit) return hit;
    }
    /* 「乌鲁木齐市高新区」这类：取前 3~4 个字试地州前缀 */
    for (const n of [4, 3]) {
      if (t.length > n) {
        const p = t.slice(0, n);
        const h = byCityName.get(p) || byCityLike.get(p + '%');
        if (h) return h;
      }
    }
    return null;
  }

  /* ---------- 依次尝试 ---------- */
  let code = '';
  let name = '';
  let via = '';

  /* ③④ 先看市字段（最常见的错填位置），保证「用户明确填了地州」时以它为准 */
  const preFromCity = cityText ? findPrefecture(cityText) : null;
  /* ① 区县字段的二级区划 */
  const distHit = distText ? findDistrict(distText) : null;
  /* 区县字段直接就是地州（有人把地州填在区县里） */
  const preFromDist = distText ? findPrefecture(distText) : null;
  /* 市字段其实是二级区划（库尔勒市 / 独山子区 / 乌鲁木齐县） */
  const distFromCity = cityText ? findDistrict(cityText) : null;

  if (distHit) {
    /* 区县是明确的二级区划：默认归到它的上级地州；
       但若用户同时填了地州且与上级不一致，以用户填的地州为准。 */
    if (preFromCity && preFromCity.code !== distHit.parent_code) {
      code = preFromCity.code; name = preFromCity.name; via = 'city';
    } else {
      code = distHit.parent_code;
      const p = parentOf.get(code);
      name = p ? p.name : '';
      via = 'district';
    }
  } else if (preFromCity) {
    code = preFromCity.code; name = preFromCity.name; via = 'city';
  } else if (distFromCity) {
    /* 用户把县级市/区/县填在了「市/地区」里，区县留空 */
    code = distFromCity.parent_code;
    const p = parentOf.get(code);
    name = p ? p.name : '';
    via = 'city-as-district';
  } else if (preFromDist) {
    code = preFromDist.code; name = preFromDist.name; via = 'district-as-city';
  } else {
    /* ⑤ 兜底：把 province/city/district/address 拼起来做包含匹配 */
    const blob = [provText, cityText, distText, addrText].filter(Boolean).join(' ');
    const shortBlob = stripParen(blob);
    if (shortBlob) {
      for (const r of db.prepare("SELECT code, name FROM region WHERE level = 'city' ORDER BY LENGTH(name) DESC").all()) {
        const bare = r.name.replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|自治州|地区|市)$/, '');
        if (shortBlob.includes(r.name) || (bare.length >= 2 && shortBlob.includes(bare))) {
          code = r.code; name = r.name; via = 'blob';
          break;
        }
      }
    }
  }

  if (code) {
    if (code !== c.region_code) {
      db.prepare('UPDATE customers SET region_code = ?, region_name = ? WHERE id = ?')
        .run(code, name || (nameOf.get(code) || {}).name || '', c.id);
    }
    return { code, name, via };
  }

  if (hasRegion) {
    /* 地址改了但匹配不上，清空旧归属，避免统计错位 */
    db.prepare("UPDATE customers SET region_code = '', region_name = '' WHERE id = ?").run(c.id);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 删除 / 还原                                                         */
/* ------------------------------------------------------------------ */

/**
 * 删除客户（软删除，1.27 多项目级联）：
 *   - 客户本身软删除；
 *   - 该客户**所有**进行中/历史项目一起软删除（不再只处理一个项目）；
 *   - 这些项目下的成本、以及只挂在客户上的成本一并软删除（回收站还原时按删除时间恢复）；
 *   - 回款没有独立软删除列，随项目一起不可见（项目/客户还原后自动回来）。
 * @returns {{count:number, names:string[], project_count:number, cost_count:number}}
 */
function deleteCustomers(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要删除的客户');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, name FROM customers WHERE id = ? AND deleted_at IS NULL');
    const upd = db.prepare('UPDATE customers SET deleted_at = ?, updated_at = ? WHERE id = ?');
    const updProjects = db.prepare(
      'UPDATE projects SET deleted_at = ?, updated_at = ? WHERE customer_id = ? AND deleted_at IS NULL'
    );
    const updCosts = db.prepare(
      `UPDATE costs SET deleted_at = ?, updated_at = ?
       WHERE deleted_at IS NULL
         AND (customer_id = ? OR project_id IN (SELECT id FROM projects WHERE customer_id = ?))`
    );
    const undone = [];
    let projectCount = 0;
    let costCount = 0;
    for (const id of list) {
      const c = get.get(id);
      if (!c) continue;
      /* 先记录本次要级联的项目/成本 ID，还原时按 ID 恢复（避免同秒删除的时间戳歧义） */
      const projectIds = db.prepare(
        'SELECT id FROM projects WHERE customer_id = ? AND deleted_at IS NULL'
      ).all(id).map((r) => Number(r.id));
      const costIds = db.prepare(
        `SELECT id FROM costs WHERE deleted_at IS NULL
           AND (customer_id = ? OR project_id IN (SELECT id FROM projects WHERE customer_id = ?))`
      ).all(id, id).map((r) => Number(r.id));
      upd.run(ts, ts, id);
      projectCount += Number(updProjects.run(ts, ts, id).changes || 0);
      costCount += Number(updCosts.run(ts, ts, id, id).changes || 0);
      logActivity(db, 'customer', id, 'delete',
        `删除客户：${c.name}（项目与回款/成本一并移入回收站，可整体还原）`,
        { cascade: 'customer_delete', project_ids: projectIds, cost_ids: costIds });
      undone.push(c.name);
    }
    db.exec('COMMIT');
    return { count: undone.length, names: undone, project_count: projectCount, cost_count: costCount };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/**
 * 还原客户（1.27）：客户 + 删除时一起级联软删的项目/成本按删除时间恢复；
 * 单独删过的项目（删除时间不同）不跟着回来，保持回收站语义。
 */
function restoreCustomers(db, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要还原的客户');
  const ts = now();

  db.exec('BEGIN');
  try {
    const get = db.prepare('SELECT id, name, deleted_at FROM customers WHERE id = ?');
    const upd = db.prepare('UPDATE customers SET deleted_at = NULL, updated_at = ? WHERE id = ?');
    const restoreProject = db.prepare(
      'UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL'
    );
    const restoreCost = db.prepare(
      'UPDATE costs SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL'
    );
    const updCosts = db.prepare(
      `UPDATE costs SET deleted_at = NULL, updated_at = ?
       WHERE deleted_at = ?
         AND (customer_id = ? OR project_id IN (SELECT id FROM projects WHERE customer_id = ?))`
    );
    const updProjects = db.prepare(
      'UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE customer_id = ? AND deleted_at = ?'
    );
    let count = 0;
    let projectCount = 0;
    let costCount = 0;
    for (const id of list) {
      const c = get.get(id);
      if (!c) continue;
      /* 删除时写进日志的级联 ID：精确还原，避免同秒删除的历史项目被一起拉回来 */
      let projectIds = [];
      let costIds = [];
      try {
        const log = db.prepare(
          `SELECT detail FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?
             AND action = 'delete' ORDER BY id DESC LIMIT 1`
        ).get(id);
        const d = log && log.detail ? JSON.parse(log.detail) : null;
        if (d) {
          if (Array.isArray(d.project_ids)) projectIds = d.project_ids.map(Number).filter(Number.isInteger);
          if (Array.isArray(d.cost_ids)) costIds = d.cost_ids.map(Number).filter(Number.isInteger);
        }
      } catch (_) { projectIds = []; costIds = []; }

      upd.run(ts, id);
      if (projectIds.length || costIds.length) {
        for (const pid of projectIds) projectCount += Number(restoreProject.run(ts, pid).changes || 0);
        for (const cid of costIds) costCount += Number(restoreCost.run(ts, cid).changes || 0);
      } else if (c.deleted_at) {
        projectCount += Number(updProjects.run(ts, id, c.deleted_at).changes || 0);
        costCount += Number(updCosts.run(ts, c.deleted_at, id, id).changes || 0);
      }
      logActivity(db, 'customer', id, 'restore', `还原客户：${c.name}`, null);
      count++;
    }
    db.exec('COMMIT');
    return { count, project_count: projectCount, cost_count: costCount };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 批量操作：打标签 / 取消标签（1.23 起没有等级/状态/归属等旧概念） */
function bulkUpdate(db, ids, action) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未选中任何客户');
  const ts = now();

  db.exec('BEGIN');
  try {
    let count = 0;
    if (action.type === 'tag') {
      if (!action.tag_id) throw badRequest('未指定标签');
      const ins = db.prepare('INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, created_at) VALUES (?, ?, ?)');
      for (const id of list) { ins.run(id, Number(action.tag_id), ts); count++; }
      logActivity(db, 'customer', null, 'bulk', `批量打标签，共 ${count} 家客户`, null);
    } else if (action.type === 'untag') {
      if (!action.tag_id) throw badRequest('未指定标签');
      const del = db.prepare('DELETE FROM customer_tags WHERE customer_id = ? AND tag_id = ?');
      for (const id of list) { del.run(id, Number(action.tag_id)); count++; }
    } else {
      throw badRequest('不支持的批量操作类型：' + action.type);
    }
    db.exec('COMMIT');
    return { count };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 联系人                                                              */
/* ------------------------------------------------------------------ */

function saveContact(db, payload) {
  const data = pick(payload, CONTACT_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const customerId = Number(data.customer_id || payload.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw badRequest('缺少所属客户');
  data.customer_id = customerId;
  if (!(data.name || '').trim()) throw badRequest('联系人姓名为必填项', 'NAME_REQUIRED');

  const ts = now();
  db.exec('BEGIN');
  try {
    let savedId = id;
    if (id) {
      const keys = Object.keys(data);
      db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => data[k]), ts, id);
      if (data.is_primary === 1) clearOtherPrimary(db, customerId, id);
      logActivity(db, 'contact', customerId, 'update', `更新联系人：${data.name}`, null);
    } else {
      data.created_at = ts;
      data.updated_at = ts;
      const keys = Object.keys(data);
      const info = db.prepare(
        `INSERT INTO contacts (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      ).run(...keys.map((k) => data[k]));
      savedId = Number(info.lastInsertRowid);
      if (data.is_primary === 1) clearOtherPrimary(db, customerId, savedId);
      logActivity(db, 'contact', customerId, 'create', `新增联系人：${data.name}${data.position ? '（' + data.position + '）' : ''}`, null);
    }
    /* 主联系人反向同步到客户表的内嵌字段，避免列表里的「联系人（职务）」陈旧 */
    syncCustomerFromPrimaryContact(db, customerId, savedId, ts);
    db.exec('COMMIT');
    return { id: savedId, created: !id };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 保证一个客户只有一个主联系人 */
function clearOtherPrimary(db, customerId, keepId) {
  db.prepare('UPDATE contacts SET is_primary = 0 WHERE customer_id = ? AND id <> ?').run(customerId, keepId);
}

/** contacts 表的主联系人 → 客户表内嵌 contact_* 字段（反向同步） */
function syncCustomerFromPrimaryContact(db, customerId, contactId, ts) {
  const ct = db.prepare(
    'SELECT * FROM contacts WHERE id = ? AND customer_id = ? AND deleted_at IS NULL'
  ).get(Number(contactId), Number(customerId));
  if (!ct || !ct.is_primary) return;
  db.prepare(
    `UPDATE customers SET contact_name = ?, contact_position = ?, contact_phone = ?,
            contact_birthday = ?, updated_at = ? WHERE id = ?`
  ).run(ct.name || '', ct.position || '', ct.mobile || '', ct.birthday || '', ts || now(), customerId);
}

function deleteContact(db, id) {
  const ts = now();
  const c = db.prepare('SELECT id, name, customer_id, is_primary FROM contacts WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!c) throw notFound('联系人不存在');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, c.id);
    /* 删掉的是主联系人：把客户表内嵌字段一并清空，避免详情页还显示已删除的人 */
    if (c.is_primary) {
      db.prepare(
        `UPDATE customers SET contact_name = '', contact_position = '', contact_phone = '',
                contact_birthday = '', updated_at = ? WHERE id = ?`
      ).run(ts, c.customer_id);
    }
    logActivity(db, 'contact', c.customer_id, 'delete', `删除联系人：${c.name}`, null);
    db.exec('COMMIT');
    return { count: 1 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 跟进记录                                                            */
/* ------------------------------------------------------------------ */

/**
 * 保存跟进记录，并同步回填客户的：
 *   last_follow_at / follow_count / next_follow_at
 * 若填写了下次跟进时间，自动生成一条待办。
 */
function saveFollowup(db, payload) {
  const data = pick(payload, FOLLOWUP_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  const customerId = Number(data.customer_id || payload.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) throw badRequest('缺少所属客户');
  data.customer_id = customerId;
  if (!(data.content || '').trim()) throw badRequest('跟进内容为必填项', 'CONTENT_REQUIRED');
  if (!data.followed_at) data.followed_at = now();
  if (!data.method) data.method = '电话';

  const ts = now();
  let taskCreated = false;
  let newId = null;

  db.exec('BEGIN');
  try {
    if (id) {
      const keys = Object.keys(data);
      db.prepare(`UPDATE followups SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...keys.map((k) => data[k]), ts, id);
    } else {
      data.created_at = ts;
      data.updated_at = ts;
      const keys = Object.keys(data);
      const info = db.prepare(
        `INSERT INTO followups (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      ).run(...keys.map((k) => data[k]));
      newId = Number(info.lastInsertRowid);
    }

    const fid = id || newId;
    syncCustomerFollowStats(db, customerId, ts);

    /* 回访周期（1.23）：没填下次时间时，按客户的「定期提醒天数」自动排下次
       有填 next_at 的走上面的 syncCustomerFollowStats（以跟进记录为准） */
    let autoNext = null;
    if (!data.next_at) {
      const cust = db.prepare('SELECT follow_cycle_days FROM customers WHERE id = ?').get(customerId);
      const cycle = Number(cust && cust.follow_cycle_days) || 0;
      if (cycle > 0) {
        const base = String(data.followed_at || ts).slice(0, 10);
        autoNext = addDaysToDate(base, cycle);
        if (autoNext) {
          autoNext = `${autoNext} 09:00:00`;
          db.prepare('UPDATE customers SET next_follow_at = ?, updated_at = ? WHERE id = ?')
            .run(autoNext, ts, customerId);
        }
      }
    }

    logActivity(db, 'customer', customerId, 'followup',
      `记录跟进（${data.method}）：${(data.content || '').slice(0, 40)}${(data.content || '').length > 40 ? '…' : ''}`, null);

    /* 下次跟进时间 → 自动生成待办 */
    if (data.next_at) {
      const dup = db.prepare(
        `SELECT id FROM tasks WHERE customer_id = ? AND source = '跟进计划' AND status = '待办'
         AND due_at = ? AND deleted_at IS NULL`
      ).get(customerId, data.next_at);
      if (!dup) {
        const title = data.next_plan
          ? `跟进计划：${String(data.next_plan).slice(0, 60)}`
          : '客户跟进提醒';
        db.prepare(
          `INSERT INTO tasks (title, customer_id, project_id, due_at, priority, status, source, remark, created_at, updated_at)
           VALUES (?, ?, ?, ?, '中', '待办', '跟进计划', '', ?, ?)`
        ).run(title, customerId, data.project_id || null, data.next_at, ts, ts);
        taskCreated = true;
      }
    }

    db.exec('COMMIT');
    return { id: fid, created: !id, taskCreated, next_follow_at: autoNext || data.next_at || null };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/** 日期加天数：'YYYY-MM-DD...' → 'YYYY-MM-DD'（本地时区，不用 toISOString 以免跨时区偏一天） */
function addDaysToDate(dateStr, days) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(days || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 依据跟进记录重算客户的跟进统计与下次跟进时间 */
function syncCustomerFollowStats(db, customerId, ts) {
  const agg = db.prepare(
    `SELECT COUNT(*) AS n, MAX(followed_at) AS last_at FROM followups
     WHERE customer_id = ? AND deleted_at IS NULL`
  ).get(customerId);

  /* 下次跟进时间取最近一条「有下次时间」的跟进记录 */
  const next = db.prepare(
    `SELECT next_at FROM followups
     WHERE customer_id = ? AND deleted_at IS NULL AND next_at IS NOT NULL AND next_at <> ''
     ORDER BY next_at ASC LIMIT 1`
  ).get(customerId);

  const derived = next ? next.next_at : null;

  /* 关键：不为空才覆盖客户上的 next_follow_at。
     因为该字段也可由用户在客户表单上手动设置（如「三个月后再联系」），
     若无条件覆盖，用户手动设的日期会在记录一条不带下次时间的跟进后被清空——
     导致首页「今日待跟进」与列表逾期标红失效。 */
  db.prepare(
    `UPDATE customers
        SET follow_count = ?,
            last_follow_at = ?,
            next_follow_at = COALESCE(?, next_follow_at),
            updated_at = ?
      WHERE id = ?`
  ).run(agg.n || 0, agg.last_at || null, derived, ts || now(), customerId);

  const current = db.prepare('SELECT next_follow_at FROM customers WHERE id = ?').get(customerId);
  return {
    follow_count: agg.n || 0,
    last_follow_at: agg.last_at || null,
    next_follow_at: current ? current.next_follow_at : derived
  };
}

function deleteFollowup(db, id) {
  const ts = now();
  const f = db.prepare('SELECT id, customer_id, content FROM followups WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!f) throw notFound('跟进记录不存在');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE followups SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, f.id);
    syncCustomerFollowStats(db, f.customer_id, ts);
    logActivity(db, 'customer', f.customer_id, 'followup_delete',
      `删除一条跟进记录：${String(f.content || '').slice(0, 30)}`, null);
    db.exec('COMMIT');
    return { count: 1 };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 标签                                                                */
/* ------------------------------------------------------------------ */

function listTags(db) {
  return plainAll(db.prepare(`
    SELECT t.id, t.name, t.color, t.sort,
           (SELECT COUNT(*) FROM customer_tags ct
              JOIN customers c ON c.id = ct.customer_id AND c.deleted_at IS NULL
            WHERE ct.tag_id = t.id) AS customer_count
    FROM tags t ORDER BY t.sort, t.id
  `).all()).map((t) => Object.assign(t, { fixed: FIXED_TAG_NAMES.includes(t.name) }));
}

function saveTag(db, payload) {
  const data = pick(payload, TAG_FIELDS);
  const id = payload.id ? Number(payload.id) : null;
  if (!(data.name || '').trim()) throw badRequest('标签名称不能为空');
  const ts = now();
  if (id) {
    db.prepare('UPDATE tags SET name = ?, color = ?, sort = ?, updated_at = ? WHERE id = ?')
      .run(data.name, data.color || '#4b7bec', Number(data.sort) || 0, ts, id);
    return { id, created: false };
  }
  const dup = db.prepare('SELECT id FROM tags WHERE name = ?').get(data.name);
  if (dup) throw badRequest('标签「' + data.name + '」已存在', 'DUPLICATE');
  const info = db.prepare('INSERT INTO tags (name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(data.name, data.color || '#4b7bec', Number(data.sort) || 0, ts, ts);
  return { id: Number(info.lastInsertRowid), created: true };
}

function deleteTag(db, id) {
  const tid = Number(id);
  const t = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(tid);
  if (!t) throw notFound('标签不存在');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM customer_tags WHERE tag_id = ?').run(tid);
    db.prepare('DELETE FROM tags WHERE id = ?').run(tid);
    db.exec('COMMIT');
    return { count: 1, name: t.name };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 字典：完整增删改（表单内联新增 + 设置页管理共用）                     */
/* ------------------------------------------------------------------ */

/**
 * 新增字典选项（支持表单内联新增）
 * @returns {{id:number, value:string, existed:boolean, reenabled?:boolean, restored?:boolean}}
 */
function quickAddDict(db, category, value, options) {
  const opts = options || {};
  const cat = String(category || '').trim();
  const val = String(value || '').trim();
  if (!cat) throw badRequest('缺少字典分类');
  if (!val) throw badRequest('选项名称不能为空');
  if (val.length > 60) throw badRequest('选项名称过长（最多 60 字）');

  const dup = db.prepare(
    'SELECT id, value, enabled, deleted_at FROM dict WHERE category = ? AND value = ?'
  ).get(cat, val);

  const ts = now();

  if (dup && !dup.deleted_at) {
    if (opts.forceNew) {
      /* 设置页「新增」遇到同名：明确拒绝，避免用户以为建了两条 */
      throw badRequest(`「${val}」已存在`, 'DUPLICATE');
    }
    /* 已存在但被停用 → 重新启用，避免用户以为「点了没反应」 */
    if (!dup.enabled) {
      db.prepare('UPDATE dict SET enabled = 1, updated_at = ? WHERE id = ?').run(ts, dup.id);
      return { id: dup.id, value: dup.value, existed: true, reenabled: true };
    }
    return { id: dup.id, value: dup.value, existed: true };
  }

  if (dup && dup.deleted_at) {
    if (!opts.forceNew) {
      /* 历史上引用过该选项的数据仍在 → 复活原记录，保证显示不乱 */
      db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
        .run(ts, dup.id);
      return { id: dup.id, value: dup.value, existed: true, restored: true };
    }
    /* 强制新建：先把旧的软删除行改名，让出唯一约束，再插入新行 */
    db.prepare('UPDATE dict SET value = ?, updated_at = ? WHERE id = ?')
      .run(`__deleted_${dup.id}__${dup.value}`.slice(0, 120), ts, dup.id);
  }

  const maxSort = db.prepare(
    'SELECT COALESCE(MAX(sort), 0) AS s FROM dict WHERE category = ?'
  ).get(cat).s;
  const info = db.prepare(
    `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?)`
  ).run(cat, val, String(opts.color || ''), Number(maxSort) + 10, ts, ts);

  logActivity(db, 'dict', Number(info.lastInsertRowid), 'create',
    `新增字典选项：${cat} → ${val}`, null);
  return { id: Number(info.lastInsertRowid), value: val, existed: false };
}

/** 更新字典选项。改名不影响历史数据（历史数据存的是选项文本，改名后各表同步刷新） */
function updateDict(db, id, payload) {
  const did = Number(id);
  const row = db.prepare('SELECT * FROM dict WHERE id = ?').get(did);
  if (!row || row.deleted_at) throw notFound('字典选项不存在');

  const sets = [];
  const params = [];
  let newVal = row.value;

  if (payload.value !== undefined) {
    const v = String(payload.value).trim();
    if (!v) throw badRequest('选项名称不能为空');
    const dup = db.prepare(
      'SELECT id FROM dict WHERE category = ? AND value = ? AND id <> ? AND deleted_at IS NULL'
    ).get(row.category, v, did);
    if (dup) throw badRequest(`同一分类下已存在「${v}」`, 'DUPLICATE');
    sets.push('value = ?'); params.push(v);
    newVal = v;
  }
  if (payload.color !== undefined) { sets.push('color = ?'); params.push(String(payload.color || '')); }
  if (payload.sort !== undefined) { sets.push('sort = ?'); params.push(Number(payload.sort) || 0); }
  if (payload.enabled !== undefined) { sets.push('enabled = ?'); params.push(payload.enabled ? 1 : 0); }

  if (!sets.length) return { id: did, changed: 0, value: newVal };

  sets.push('updated_at = ?');
  params.push(now(), did);
  db.prepare(`UPDATE dict SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  /* 改名时同步刷新业务表中的历史值，避免出现「老数据仍是旧名字」 */
  let synced = 0;
  if (newVal !== row.value) {
    synced = renameInBusinessTables(db, row.category, row.value, newVal);
    logActivity(db, 'dict', did, 'update',
      `字典改名：${row.value} → ${newVal}（同步更新 ${synced} 条历史数据）`, null);
  } else {
    logActivity(db, 'dict', did, 'update', `更新字典选项：${newVal}`, null);
  }

  return { id: did, changed: sets.length - 1, value: newVal, synced };
}

/** 字典改名后同步业务表中的历史值 */
function renameInBusinessTables(db, category, oldVal, newVal) {
  const MAPPING = {
    industry:            ['customers', 'industry'],
    customer_source:     ['customers', 'source'],
    project_stage:       ['projects', 'stage'],
    bid_result:          ['projects', 'bid_result'],
    follow_method:       ['followups', 'method'],
    follow_result:       ['followups', 'result'],
    contact_position:    ['contacts', 'position'],
    contact_influence:   ['contacts', 'influence'],
    payment_method:      ['payments', 'method']
  };
  const hit = MAPPING[category];
  if (!hit) return 0;
  const [table, column] = hit;
  const info = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(newVal, oldVal);
  return Number(info.changes || 0);
}

/**
 * 删除字典选项。
 * 系统内置选项（is_system=1）只允许停用，不允许删除，避免误删行业/阶段等核心选项。
 */
function deleteDict(db, id) {
  const did = Number(id);
  const row = db.prepare('SELECT * FROM dict WHERE id = ?').get(did);
  if (!row || row.deleted_at) throw notFound('字典选项不存在');

  if (row.is_system) {
    db.prepare('UPDATE dict SET enabled = 0, updated_at = ? WHERE id = ?').run(now(), did);
    logActivity(db, 'dict', did, 'disable',
      `系统内置选项「${row.value}」已停用（内置项不可删除）`, null);
    return { id: did, deleted: false, disabled: true, value: row.value, isSystem: true };
  }

  const ts = now();
  db.prepare('UPDATE dict SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?').run(ts, ts, did);
  logActivity(db, 'dict', did, 'delete', `删除字典选项：${row.value}`, null);
  return { id: did, deleted: true, disabled: true, value: row.value, isSystem: false };
}

/** 统计某字典选项被业务数据引用的次数（删除前提示用） */
function countDictUsage(db, category, value) {
  const MAPPING = {
    industry:          ['customers', 'industry'],
    customer_source:   ['customers', 'source'],
    project_stage:     ['projects', 'stage'],
    follow_method:     ['followups', 'method'],
    follow_result:     ['followups', 'result']
  };
  const hit = MAPPING[category];
  if (!hit) return 0;
  const [table, column] = hit;
  return db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ? AND deleted_at IS NULL`
  ).get(value).n;
}

/* ------------------------------------------------------------------ */
/* 操作日志查询                                                        */
/* ------------------------------------------------------------------ */

const ENTITY_LABEL = {
  customer: '客户', contact: '联系人', project: '项目', task: '待办',
  dict: '字典', tag: '标签', import: '导入', payment: '回款',
  cost: '成本', product: '产品', product_category: '产品分类'
};
const ACTION_LABEL = {
  create: '新建', update: '修改', delete: '删除', restore: '还原',
  followup: '跟进', followup_delete: '删除跟进', payment: '回款',
  bulk: '批量', disable: '停用', import: '导入', move: '排序', copy: '复制'
};

function listLogs(db, q) {
  const where = ['1 = 1'];
  const params = [];

  if (q.entity_type) { where.push('entity_type = ?'); params.push(q.entity_type); }
  if (q.action) { where.push('action = ?'); params.push(q.action); }
  if (q.entity_id) { where.push('entity_id = ?'); params.push(Number(q.entity_id)); }
  if (q.q) {
    const kw = `%${String(q.q).trim()}%`;
    where.push('(summary LIKE ? OR detail LIKE ?)');
    params.push(kw, kw);
  }
  if (q.date_from) { where.push('date(created_at) >= ?'); params.push(q.date_from); }
  if (q.date_to) { where.push('date(created_at) <= ?'); params.push(q.date_to); }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM activity_logs ${whereSql}`).get(...params).n;

  const pageSize = Math.min(Math.max(Number(q.pageSize) || 50, 1), 500);
  const page = Math.max(Number(q.page) || 1, 1);
  const offset = (page - 1) * pageSize;

  const rows = plainAll(db.prepare(`
    SELECT id, entity_type, entity_id, action, summary, created_at
    FROM activity_logs ${whereSql}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset)).map((r) => Object.assign(r, {
    entity_label: ENTITY_LABEL[r.entity_type] || r.entity_type,
    action_label: ACTION_LABEL[r.action] || r.action
  }));

  /* 统计各类型数量（用于界面筛选下拉） */
  const byEntity = plainAll(db.prepare(
    'SELECT entity_type, COUNT(*) AS n FROM activity_logs GROUP BY entity_type ORDER BY n DESC'
  ).all());
  const byAction = plainAll(db.prepare(
    'SELECT action, COUNT(*) AS n FROM activity_logs GROUP BY action ORDER BY n DESC'
  ).all());

  return {
    list: rows,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    stats: {
      by_entity: byEntity.map((r) => Object.assign(r, { label: ENTITY_LABEL[r.entity_type] || r.entity_type })),
      by_action: byAction.map((r) => Object.assign(r, { label: ACTION_LABEL[r.action] || r.action }))
    }
  };
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

function listTrash(db, entityType) {
  const type = entityType || 'customer';
  if (type === 'customer') {
    return plainAll(db.prepare(
      `SELECT id, name AS title, short_name AS sub, deleted_at FROM customers
       WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'followup') {
    return plainAll(db.prepare(
      `SELECT f.id, f.content AS title, c.name AS sub, f.deleted_at
       FROM followups f LEFT JOIN customers c ON c.id = f.customer_id
       WHERE f.deleted_at IS NOT NULL ORDER BY f.deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'contact') {
    return plainAll(db.prepare(
      `SELECT ct.id, ct.name AS title, c.name AS sub, ct.deleted_at
       FROM contacts ct LEFT JOIN customers c ON c.id = ct.customer_id
       WHERE ct.deleted_at IS NOT NULL ORDER BY ct.deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'project') {
    return plainAll(db.prepare(
      `SELECT p.id, p.name AS title, c.name AS sub, p.deleted_at
       FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
       WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 200`
    ).all());
  }
  if (type === 'task') {
    return plainAll(db.prepare(
      `SELECT t.id, t.title AS title, t.source AS sub, t.deleted_at
       FROM tasks t WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC LIMIT 200`
    ).all());
  }
  return [];
}

module.exports = {
  CUSTOMER_FIELDS,
  CONTACT_FIELDS,
  FOLLOWUP_FIELDS,
  readDict,
  listCustomers,
  getCustomer,
  getCustomerFinance,
  saveCustomer,
  nextCustomerNo,
  deleteCustomers,
  restoreCustomers,
  bulkUpdate,
  saveContact,
  deleteContact,
  saveFollowup,
  deleteFollowup,
  syncCustomerFollowStats,
  syncPrimaryContact,
  listTags,
  saveTag,
  deleteTag,
  quickAddDict,
  updateDict,
  deleteDict,
  countDictUsage,
  listTrash,
  listLogs,
  syncCustomerRegion,
  fixLegacyRegionCodes,
  ENTITY_LABEL,
  ACTION_LABEL,
  logActivity,
  findDuplicates
};
