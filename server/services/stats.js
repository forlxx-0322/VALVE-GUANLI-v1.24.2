/**
 * 统计与报表服务（1.22 新增 · 替代地图模块）
 *
 * 提供四类数据：
 *   1. 客户分布（环形图）：按地区 / 行业 / 来源 / 标签
 *   2. 收入报表（按年 12 个月 / 按年汇总）：收入、采购成本、维护成本、差旅、其他、利润、毛利率
 *   3. 收入/成本明细（报表下钻对账用）
 *   4. 首页 v2 总览（指标卡 + 回访提醒 + 待办 + 动态 + 两张分布）
 *
 * 口径（与界面上的问号提示一致）：
 *   收入     = payments.type='实收' 的金额，按 actual_date 归月/归年
 *   成本     = costs.amount，按 spent_at 归月/归年（分类：采购成本/维护成本/差旅/其他）
 *   利润     = 收入 − 全部成本
 *   毛利率   = 利润 ÷ 收入（收入为 0 显示 —）
 *   应收未收 = Σ(回款计划 − 已核销实收)，只算大于 0 的
 */
'use strict';

const { plainAll } = require('../db');

const COST_CATEGORIES = ['采购成本', '维护成本', '差旅', '其他'];
const DIST_BY = ['region', 'industry', 'source', 'tag'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => new Date().toLocaleDateString('sv-SE');       // YYYY-MM-DD（本地时区）
const currentYear = () => Number(today().slice(0, 4));
const currentMonth = () => today().slice(0, 7);

/* ------------------------------------------------------------------ */
/* 1. 客户分布                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} db
 * @param {{ by?: 'region'|'industry'|'source'|'tag', top?: number }} opts
 * @returns {{ total:number, by:string, groups:Array<{key:string,label:string,count:number,percent:number}> }}
 */
function distribution(db, opts) {
  const o = opts || {};
  const by = DIST_BY.includes(o.by) ? o.by : 'region';
  const top = Math.max(1, Math.min(Number(o.top) || 8, 30));

  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL'
  ).get().n;

  let rows;
  if (by === 'tag') {
    rows = plainAll(db.prepare(`
      SELECT t.name AS label, COUNT(DISTINCT c.id) AS count
      FROM customers c
      JOIN customer_tags ct ON ct.customer_id = c.id
      JOIN tags t ON t.id = ct.tag_id
      WHERE c.deleted_at IS NULL
      GROUP BY t.id
      ORDER BY count DESC, t.name ASC
    `).all());
    const tagged = rows.reduce((s, r) => s + r.count, 0);
    const untagged = Math.max(0, total - db.prepare(`
      SELECT COUNT(DISTINCT c.id) AS n FROM customers c
      JOIN customer_tags ct ON ct.customer_id = c.id
      WHERE c.deleted_at IS NULL
    `).get().n);
    if (untagged > 0) rows.push({ label: '未打标签', count: untagged });
    void tagged;
  } else {
    const col = by === 'region' ? 'region_name' : by;
    const blank = by === 'region' ? '未归属' : '未填写';
    rows = plainAll(db.prepare(`
      SELECT COALESCE(NULLIF(${col}, ''), ?) AS label, COUNT(*) AS count
      FROM customers WHERE deleted_at IS NULL
      GROUP BY label
      ORDER BY count DESC, label ASC
    `).all(blank));
  }

  const head = rows.slice(0, top);
  const restCount = rows.slice(top).reduce((s, r) => s + r.count, 0);
  const groups = head.map((r) => ({
    key: r.label,
    label: r.label,
    count: r.count,
    percent: total ? Math.round((r.count / total) * 1000) / 10 : 0
  }));
  if (restCount > 0) {
    groups.push({
      key: '其他',
      label: `其他（${rows.length - top} 项）`,
      count: restCount,
      percent: total ? Math.round((restCount / total) * 1000) / 10 : 0
    });
  }
  return { total, by, groups };
}

/* ------------------------------------------------------------------ */
/* 2. 收入报表                                                          */
/* ------------------------------------------------------------------ */

function incomeByMonth(db, year) {
  const y = Number(year) || currentYear();
  const prefix = `${y}-`;
  const incomeRows = db.prepare(`
    SELECT substr(actual_date, 1, 7) AS m, COALESCE(SUM(amount), 0) AS s
    FROM payments
    WHERE type = '实收' AND actual_date IS NOT NULL AND actual_date <> ''
      AND substr(actual_date, 1, 4) = ?
    GROUP BY m
  `).all(String(y));
  const costRows = db.prepare(`
    SELECT substr(spent_at, 1, 7) AS m, category, COALESCE(SUM(amount), 0) AS s
    FROM costs
    WHERE deleted_at IS NULL AND spent_at IS NOT NULL AND spent_at <> ''
      AND substr(spent_at, 1, 4) = ?
    GROUP BY m, category
  `).all(String(y));

  const income = Object.fromEntries(incomeRows.map((r) => [r.m, round2(r.s)]));
  const cost = {};
  for (const r of costRows) {
    cost[r.m] = cost[r.m] || {};
    cost[r.m][r.category] = round2(r.s);
  }

  const months = Array.from({ length: 12 }, (_, i) => `${prefix}${pad2(i + 1)}`);
  const series = months.map((m) => {
    const c = cost[m] || {};
    const inc = income[m] || 0;
    const purchase = c['采购成本'] || 0;
    const maintain = c['维护成本'] || 0;
    const travel = c['差旅'] || 0;
    const other = c['其他'] || 0;
    const costTotal = round2(purchase + maintain + travel + other);
    const profit = round2(inc - costTotal);
    return {
      month: m,
      income: inc,
      purchase,
      maintain,
      travel,
      other,
      cost: costTotal,
      profit,
      margin: inc > 0 ? Math.round((profit / inc) * 1000) / 10 : null
    };
  });

  const sum = (k) => round2(series.reduce((s, r) => s + r[k], 0));
  const totalIncome = sum('income');
  const totalCost = sum('cost');
  return {
    by: 'month',
    year: y,
    months: series,
    totals: {
      income: totalIncome,
      purchase: sum('purchase'),
      maintain: sum('maintain'),
      travel: sum('travel'),
      other: sum('other'),
      cost: totalCost,
      profit: round2(totalIncome - totalCost),
      margin: totalIncome > 0 ? Math.round(((totalIncome - totalCost) / totalIncome) * 1000) / 10 : null
    }
  };
}

function incomeByYear(db, span) {
  const n = Math.max(1, Math.min(Number(span) || 5, 10));
  const end = currentYear();
  const start = end - n + 1;
  const incomeRows = db.prepare(`
    SELECT substr(actual_date, 1, 4) AS y, COALESCE(SUM(amount), 0) AS s
    FROM payments
    WHERE type = '实收' AND actual_date IS NOT NULL AND actual_date <> ''
      AND CAST(substr(actual_date, 1, 4) AS INTEGER) >= ?
    GROUP BY y
  `).all(start);
  const costRows = db.prepare(`
    SELECT substr(spent_at, 1, 4) AS y, category, COALESCE(SUM(amount), 0) AS s
    FROM costs
    WHERE deleted_at IS NULL AND spent_at IS NOT NULL AND spent_at <> ''
      AND CAST(substr(spent_at, 1, 4) AS INTEGER) >= ?
    GROUP BY y, category
  `).all(start);

  const income = Object.fromEntries(incomeRows.map((r) => [r.y, round2(r.s)]));
  const cost = {};
  for (const r of costRows) {
    cost[r.y] = cost[r.y] || {};
    cost[r.y][r.category] = round2(r.s);
  }
  const years = [];
  for (let y = start; y <= end; y++) {
    const key = String(y);
    const c = cost[key] || {};
    const inc = income[key] || 0;
    const costTotal = round2((c['采购成本'] || 0) + (c['维护成本'] || 0) + (c['差旅'] || 0) + (c['其他'] || 0));
    const profit = round2(inc - costTotal);
    years.push({
      year: y,
      income: inc,
      purchase: c['采购成本'] || 0,
      maintain: c['维护成本'] || 0,
      travel: c['差旅'] || 0,
      other: c['其他'] || 0,
      cost: costTotal,
      profit,
      margin: inc > 0 ? Math.round((profit / inc) * 1000) / 10 : null
    });
  }
  const sum = (k) => round2(years.reduce((s, r) => s + r[k], 0));
  const totalIncome = sum('income');
  const totalCost = sum('cost');
  return {
    by: 'year',
    from: start,
    to: end,
    years,
    totals: {
      income: totalIncome,
      purchase: sum('purchase'),
      maintain: sum('maintain'),
      travel: sum('travel'),
      other: sum('other'),
      cost: totalCost,
      profit: round2(totalIncome - totalCost),
      margin: totalIncome > 0 ? Math.round(((totalIncome - totalCost) / totalIncome) * 1000) / 10 : null
    }
  };
}

/** @param {{ by?:'month'|'year', year?:number, span?:number }} opts */
function income(db, opts) {
  const o = opts || {};
  return o.by === 'year' ? incomeByYear(db, o.span) : incomeByMonth(db, o.year);
}

/* ------------------------------------------------------------------ */
/* 3. 明细（下钻对账）                                                   */
/* ------------------------------------------------------------------ */

function incomeDetail(db, opts) {
  const o = opts || {};
  const prefix = String(o.month || o.year || currentMonth());   // 'YYYY-MM' 或 'YYYY'
  const like = prefix.length === 4 ? `${prefix}%` : `${prefix}%`;

  const incomes = plainAll(db.prepare(`
    SELECT pm.id, pm.amount, pm.actual_date AS date, pm.method, pm.remark,
           c.id AS customer_id, c.name AS customer_name,
           p.id AS project_id, p.name AS project_name
    FROM payments pm
    LEFT JOIN customers c ON c.id = pm.customer_id
    LEFT JOIN projects p ON p.id = pm.project_id
    WHERE pm.type = '实收' AND pm.actual_date IS NOT NULL AND pm.actual_date <> ''
      AND pm.actual_date LIKE ?
    ORDER BY pm.actual_date DESC, pm.id DESC
    LIMIT 500
  `).all(like)).map((r) => Object.assign(r, { amount: round2(r.amount) }));

  const costs = plainAll(db.prepare(`
    SELECT ct.id, ct.amount, ct.spent_at AS date, ct.category, ct.supplier, ct.remark,
           c.id AS customer_id, c.name AS customer_name,
           p.id AS project_id, p.name AS project_name
    FROM costs ct
    LEFT JOIN customers c ON c.id = ct.customer_id
    LEFT JOIN projects p ON p.id = ct.project_id
    WHERE ct.deleted_at IS NULL AND ct.spent_at LIKE ?
    ORDER BY ct.spent_at DESC, ct.id DESC
    LIMIT 500
  `).all(like)).map((r) => Object.assign(r, { amount: round2(r.amount) }));

  const incomeTotal = round2(incomes.reduce((s, r) => s + r.amount, 0));
  const costTotal = round2(costs.reduce((s, r) => s + r.amount, 0));
  return {
    range: prefix,
    incomes,
    costs,
    totals: {
      income: incomeTotal,
      cost: costTotal,
      profit: round2(incomeTotal - costTotal),
      margin: incomeTotal > 0 ? Math.round(((incomeTotal - costTotal) / incomeTotal) * 1000) / 10 : null
    }
  };
}

/* ------------------------------------------------------------------ */
/* 4. 首页 v2 总览                                                      */
/* ------------------------------------------------------------------ */

function dashboardV2(db, opts) {
  const o = opts || {};
  const month = /^\d{4}-\d{2}$/.test(String(o.month || '')) ? String(o.month) : currentMonth();
  const t = today();
  const year = month.slice(0, 4);
  const monthStart = `${month}-01`;
  const nextMonth = (() => {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    return m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
  })();

  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const customerTotal = n('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL');
  const newThisMonth = n(
    "SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND date(created_at) >= ? AND date(created_at) < ?",
    monthStart, nextMonth
  );

  const followDue = n(`SELECT COUNT(*) AS n FROM customers
    WHERE deleted_at IS NULL AND next_follow_at IS NOT NULL AND next_follow_at <> ''
      AND date(next_follow_at) <= ?`, t);
  const followOverdue = n(`SELECT COUNT(*) AS n FROM customers
    WHERE deleted_at IS NULL AND next_follow_at IS NOT NULL AND next_follow_at <> ''
      AND date(next_follow_at) < ?`, t);

  const monthIncome = round2(db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM payments
    WHERE type = '实收' AND actual_date IS NOT NULL AND actual_date <> ''
      AND date(actual_date) >= ? AND date(actual_date) < ?
  `).get(monthStart, nextMonth).s);

  const costRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s FROM costs
    WHERE deleted_at IS NULL AND spent_at IS NOT NULL AND spent_at <> ''
      AND date(spent_at) >= ? AND date(spent_at) < ?
  `).get(monthStart, nextMonth);
  const monthCost = round2(costRow.s);
  const monthProfit = round2(monthIncome - monthCost);

  const receivable = round2(db.prepare(`
    SELECT COALESCE(SUM(remain), 0) AS s FROM (
      SELECT pm.amount - COALESCE((SELECT SUM(pm2.amount) FROM payments pm2
               WHERE pm2.type = '实收' AND pm2.plan_id = pm.id), 0) AS remain
      FROM payments pm
      WHERE pm.type = '计划' AND pm.plan_date IS NOT NULL AND pm.plan_date <> ''
    ) WHERE remain > 0
  `).get().s);

  const followCustomers = plainAll(db.prepare(`
    SELECT c.id, c.name, c.short_name, c.industry, c.source,
           c.next_follow_at, c.last_follow_at, c.follow_count,
           CAST(julianday(date(c.next_follow_at)) - julianday(date('now','localtime')) AS INTEGER) AS days_left,
           (SELECT ct.name FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_contact,
           (SELECT ct.mobile FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_mobile
    FROM customers c
    WHERE c.deleted_at IS NULL AND c.next_follow_at IS NOT NULL AND c.next_follow_at <> ''
      AND date(c.next_follow_at) <= date('now','localtime','+3 days')
    ORDER BY c.next_follow_at ASC
    LIMIT 20
  `).all());

  const todayTasks = plainAll(db.prepare(`
    SELECT t.id, t.title, t.due_at, t.priority, t.status, t.source, t.customer_id, t.project_id,
           c.short_name AS customer_short, p.name AS project_name
    FROM tasks t
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.deleted_at IS NULL AND t.status = '待办'
      AND t.due_at IS NOT NULL AND t.due_at <> ''
      AND date(t.due_at) <= date('now','localtime')
    ORDER BY CASE t.priority WHEN '高' THEN 1 WHEN '中' THEN 2 ELSE 3 END, t.due_at ASC
    LIMIT 20
  `).all());

  const recentLogs = plainAll(db.prepare(`
    SELECT id, entity_type, entity_id, action, summary, created_at
    FROM activity_logs ORDER BY id DESC LIMIT 10
  `).all());

  return {
    month,
    cards: {
      customer_total: customerTotal,
      customer_new_this_month: newThisMonth,
      follow_due: followDue,
      follow_overdue: followOverdue,
      month_income: monthIncome,
      month_cost: monthCost,
      month_profit: monthProfit,
      month_margin: monthIncome > 0 ? Math.round((monthProfit / monthIncome) * 1000) / 10 : null,
      receivable
    },
    follow_customers: followCustomers,
    today_tasks: todayTasks,
    recent_logs: recentLogs,
    dist_region: distribution(db, { by: 'region', top: 8 }),
    dist_industry: distribution(db, { by: 'industry', top: 8 })
  };
}

module.exports = {
  COST_CATEGORIES,
  DIST_BY,
  distribution,
  income,
  incomeDetail,
  dashboardV2
};
