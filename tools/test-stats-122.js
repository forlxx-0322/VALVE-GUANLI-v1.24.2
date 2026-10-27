/**
 * 统计报表与成本台账（1.22 新增）
 *
 * 覆盖：
 *   - 客户分布：按地区 / 行业 / 来源 / 标签，Top N + 其他，合计与客户总数一致
 *   - 收入报表：按月 / 按年；收入、采购成本、维护成本、差旅、其他、利润、毛利率
 *   - 明细下钻：某月收入与成本逐笔可查
 *   - 成本台账：增删改查、分类校验、金额校验、只给项目自动带客户、按客户汇总
 *   - 首页 v2：指标卡口径（利润 = 收入 − 全部成本）、回访提醒、待办、动态
 *   - 行政区划接口：地州/县市清单（原 /api/map/regions 的替代）
 *
 * 前置：服务已启动（默认 127.0.0.1:8899，可用 CRM_TEST_BASE 覆盖）
 * 用法：node tools/test-stats-122.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const DB_FILE = path.join(ROOT, 'data', 'crm.db');
const TAG = '【统计测试' + Math.random().toString(36).slice(2, 8) + '】';
const today = new Date().toLocaleDateString('sv-SE');
const thisMonth = today.slice(0, 7);
const thisYear = today.slice(0, 4);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: !!j.ok, data: j.data, code: j.code, message: j.message };
}

const made = { customers: [], project: null, payment: null, costs: [] };

(async () => {
  console.log('=== 统计报表与成本台账（1.22）===\n');

  /* ---------------- 0. 健康检查 ---------------- */
  const health = await api('GET', '/api/health');
  check('服务可访问', health.ok === true, health.ok ? `v${health.data.version}` : (health.message || '无响应'));
  if (!health.ok) {
    console.error('服务未启动，请先运行 启动.bat 或 node server/server.js');
    process.exit(2);
  }

  /* ---------------- 1. 行政区划接口 ---------------- */
  const regions = await api('GET', '/api/regions');
  check('行政区划接口可用（替代原 /api/map/regions）',
    regions.ok && (regions.data.cities || []).length >= 14 && (regions.data.districts || []).length > 50,
    `地州 ${(regions.data.cities || []).length} 个，县市 ${(regions.data.districts || []).length} 个`);

  /* ---------------- 2. 基线（回归时其它套件可能已造数据，断言一律用增量） ---------------- */
  const baseMonth = (await api('GET', `/api/stats/income?by=month&year=${thisYear}`)).data
    .months.find((x) => x.month === thisMonth) || { income: 0, cost: 0, profit: 0, purchase: 0, maintain: 0, travel: 0, other: 0 };
  const baseCards = (await api('GET', `/api/dashboard/v2?month=${thisMonth}`)).data.cards;
  const baseYear = ((await api('GET', '/api/stats/income?by=year&span=5')).data.years || [])
    .find((x) => String(x.year) === thisYear) || { income: 0, cost: 0, profit: 0 };

  /* ---------------- 2.1 准备数据 ---------------- */
  const c1 = await api('POST', '/api/customers', {
    name: TAG + '甲石化', short_name: '统计甲', industry: '化工', source: '工程公司配套',
    province: '新疆维吾尔自治区', city: '克拉玛依市', district: '独山子区',
    next_follow_at: today + ' 10:00:00'
  });
  check('创建测试客户甲（化工 · 克拉玛依）', c1.ok && !!c1.data.id, c1.ok ? `#${c1.data.id}` : c1.message);
  if (c1.ok) made.customers.push(c1.data.id);

  const c2 = await api('POST', '/api/customers', {
    name: TAG + '乙电力', short_name: '统计乙', industry: '电力', source: '老客户介绍',
    province: '新疆维吾尔自治区', city: '乌鲁木齐市', district: '天山区'
  });
  check('创建测试客户乙（电力 · 乌鲁木齐）', c2.ok && !!c2.data.id, c2.ok ? `#${c2.data.id}` : c2.message);
  if (c2.ok) made.customers.push(c2.data.id);

  const p1 = await api('POST', '/api/projects', {
    name: TAG + '项目A', customer_id: c1.data.id, stage: '生产执行', progress: 50,
    contract_amount: 120000, signed_at: today
  });
  check('创建测试项目（合同额 120000）', p1.ok && !!p1.data.id, p1.ok ? `#${p1.data.id}` : p1.message);
  if (p1.ok) made.project = p1.data.id;

  const pay = await api('POST', '/api/payments', {
    project_id: made.project, customer_id: c1.data.id, type: '实收', amount: 80000,
    actual_date: today, method: '银行转账', remark: '统计测试实收'
  });
  check('登记实收 80000', pay.ok && !!pay.data.id, pay.ok ? `#${pay.data.id}` : pay.message);
  if (pay.ok) made.payment = pay.data.id;

  /* ---------------- 3. 成本台账 ---------------- */
  const badCat = await api('POST', '/api/costs', {
    customer_id: c1.data.id, category: '乱写分类', amount: 100
  });
  check('成本分类校验（只允许采购/维护/差旅/其他）',
    badCat.status === 400 && /分类/.test(badCat.message || ''),
    `HTTP ${badCat.status} ${badCat.message || ''}`);

  const badAmt = await api('POST', '/api/costs', {
    customer_id: c1.data.id, category: '采购成本', amount: -5
  });
  check('成本金额校验（不能为负）',
    badAmt.status === 400 && /金额/.test(badAmt.message || ''),
    `HTTP ${badAmt.status} ${badAmt.message || ''}`);

  const noOwner = await api('POST', '/api/costs', { category: '采购成本', amount: 100 });
  check('成本必须挂客户或项目',
    noOwner.status === 400 && /客户|项目/.test(noOwner.message || ''),
    `HTTP ${noOwner.status} ${noOwner.message || ''}`);

  const cost1 = await api('POST', '/api/costs', {
    customer_id: c1.data.id, project_id: made.project, category: '采购成本',
    amount: 30000, spent_at: today, supplier: '某阀门厂', remark: 'DN200 蝶阀 20 台'
  });
  check('登记采购成本 30000', cost1.ok && !!cost1.data.id,
    cost1.ok ? `#${cost1.data.id} ${cost1.data.category} ${cost1.data.amount}` : cost1.message);
  if (cost1.ok) made.costs.push(cost1.data.id);

  const cost2 = await api('POST', '/api/costs', {
    project_id: made.project, category: '维护成本', amount: 5000, spent_at: today
  });
  check('只给项目也能登记（自动带出客户）',
    cost2.ok && Number(cost2.data.customer_id) === Number(c1.data.id),
    cost2.ok ? `#${cost2.data.id} customer_id=${cost2.data.customer_id}` : cost2.message);
  if (cost2.ok) made.costs.push(cost2.data.id);

  const cost3 = await api('POST', '/api/costs', {
    customer_id: c2.data.id, category: '差旅', amount: 2000, spent_at: today, remark: '去乌鲁木齐出差'
  });
  check('登记差旅成本 2000（挂客户乙）', cost3.ok && !!cost3.data.id,
    cost3.ok ? `#${cost3.data.id}` : cost3.message);
  if (cost3.ok) made.costs.push(cost3.data.id);

  const cost4 = await api('POST', '/api/costs', {
    customer_id: c2.data.id, category: '其他', amount: 1000, spent_at: today
  });
  if (cost4.ok) made.costs.push(cost4.data.id);

  const upd = await api('PUT', `/api/costs/${made.costs[0]}`, { amount: 32000, remark: '改过一次金额' });
  check('修改成本金额生效', upd.ok && Number(upd.data.amount) === 32000,
    upd.ok ? `金额 ${upd.data.amount}` : upd.message);

  const list = await api('GET', `/api/costs?customer_id=${c1.data.id}&pageSize=50`);
  const byCat = (list.data.by_category || []).map((x) => `${x.category}:${x.amount}`).join(' / ');
  check('按客户查成本：合计与分类小计正确',
    list.ok && Number(list.data.amount) === 37000 && (list.data.list || []).length === 2,
    `合计 ${list.ok ? list.data.amount : '—'}（采购 32000 + 维护 5000）；分类：${byCat}`);

  /* ---------------- 4. 客户分布 ---------------- */
  const dInd = await api('GET', '/api/stats/distribution?by=industry');
  const indChem = (dInd.data.groups || []).find((g) => g.label === '化工');
  check('按行业分布包含「化工」且计数正确',
    dInd.ok && !!indChem && indChem.count >= 1,
    `化工 ${indChem ? indChem.count : '未找到'} 家；分组 ${(dInd.data.groups || []).length} 个`);

  const dReg = await api('GET', '/api/stats/distribution?by=region');
  const regKlmy = (dReg.data.groups || []).find((g) => g.label === '克拉玛依市');
  check('按地区分布包含「克拉玛依市」',
    dReg.ok && !!regKlmy && regKlmy.count >= 1,
    `克拉玛依 ${regKlmy ? regKlmy.count : '未找到'} 家`);

  const dSrc = await api('GET', '/api/stats/distribution?by=source');
  const srcHit = (dSrc.data.groups || []).find((g) => g.label === '老客户介绍');
  check('按来源分布包含「老客户介绍」',
    dSrc.ok && !!srcHit && srcHit.count >= 1,
    `老客户介绍 ${srcHit ? srcHit.count : '未找到'} 家`);

  const dTag = await api('GET', '/api/stats/distribution?by=tag');
  check('按标签分布可用（未打标签单独成组）',
    dTag.ok && Array.isArray(dTag.data.groups),
    `分组 ${(dTag.data.groups || []).length} 个：${(dTag.data.groups || []).map((g) => g.label).join('/')}`);

  const dTop1 = await api('GET', '/api/stats/distribution?by=industry&top=1');
  check('Top N 生效（其余归入「其他」）',
    dTop1.ok && (dTop1.data.groups || []).length <= 2,
    `top=1 返回 ${(dTop1.data.groups || []).length} 组：${(dTop1.data.groups || []).map((g) => g.label).join('/')}`);

  const total = (await api('GET', '/api/dashboard/v2')).data.cards.customer_total;
  check('分布合计与客户总数一致',
    dInd.data.total === total,
    `分布 ${dInd.data.total} 家 / 客户总数 ${total} 家`);

  /* ---------------- 5. 收入报表 ---------------- */
  const inc = await api('GET', `/api/stats/income?by=month&year=${thisYear}`);
  const m = (inc.data.months || []).find((x) => x.month === thisMonth);
  const delta = (k) => (m ? m[k] - (baseMonth[k] || 0) : 0);
  check('按月报表：本月收入 +80000、成本 +40000（增量断言，不受其它套件数据影响）',
    inc.ok && !!m && delta('income') === 80000 && delta('cost') === 40000
      && delta('purchase') === 32000 && delta('maintain') === 5000
      && delta('travel') === 2000 && delta('other') === 1000,
    m ? `增量：收入 +${delta('income')}，成本 +${delta('cost')}（采购 +${delta('purchase')} / 维护 +${delta('maintain')} / 差旅 +${delta('travel')} / 其他 +${delta('other')}）` : '未找到当月');

  check('按月报表：利润 = 收入 − 全部成本',
    !!m && m.profit === m.income - m.cost,
    m ? `收入 ${m.income} − 成本 ${m.cost} = 利润 ${m.profit}` : '—');

  const expectMargin = m && m.income > 0 ? Math.round(((m.income - m.cost) / m.income) * 1000) / 10 : null;
  check('按月报表：毛利率 = 利润 ÷ 收入',
    !!m && m.margin === expectMargin,
    m ? `毛利率 ${m.margin}%（期望 ${expectMargin}%）` : '—');

  check('按月报表固定 12 个月（无数据的月份为 0）',
    inc.ok && (inc.data.months || []).length === 12,
    `月份数 ${(inc.data.months || []).length}`);

  check('按月报表合计 = 各月相加（口径自洽）',
    inc.ok && inc.data.totals.income === inc.data.months.reduce((s, x) => s + x.income, 0)
      && inc.data.totals.profit === inc.data.totals.income - inc.data.totals.cost,
    inc.ok ? `合计：收入 ${inc.data.totals.income} 成本 ${inc.data.totals.cost} 利润 ${inc.data.totals.profit}` : '—');

  const incY = await api('GET', '/api/stats/income?by=year&span=5');
  const y = (incY.data.years || []).find((x) => String(x.year) === thisYear);
  check('按年报表：5 年跨度，本年增量 +80000 收入、+40000 成本',
    incY.ok && (incY.data.years || []).length === 5 && y
      && y.income - baseYear.income === 80000 && y.cost - baseYear.cost === 40000,
    y ? `本年增量：收入 +${y.income - baseYear.income} 成本 +${y.cost - baseYear.cost} 利润 +${y.profit - baseYear.profit}，共 ${(incY.data.years || []).length} 年` : '未找到本年');

  /* ---------------- 6. 明细下钻 ---------------- */
  const detail = await api('GET', `/api/stats/income/detail?month=${thisMonth}`);
  const myIncome = (detail.data.incomes || []).filter((x) => String(x.customer_name || '').includes(TAG));
  const myCosts = (detail.data.costs || []).filter((x) => String(x.customer_name || '').includes(TAG));
  check('明细：本次登记的收入能在当月明细里查到（金额 80000）',
    detail.ok && myIncome.length === 1 && myIncome[0].amount === 80000,
    `本月明细共 ${detail.data.incomes.length} 笔，其中本次 ${myIncome.length} 笔`);

  check('明细：本次 4 笔成本逐笔可查（含分类与供应商）',
    detail.ok && myCosts.length === 4
      && myCosts.some((x) => x.category === '采购成本' && x.supplier === '某阀门厂'),
    `本次成本 ${myCosts.length} 笔：${myCosts.map((x) => x.category + x.amount).join(' / ')}`);

  check('明细：合计 = 逐笔相加（口径自洽）',
    detail.ok
      && detail.data.totals.income === detail.data.incomes.reduce((s, x) => s + x.amount, 0)
      && detail.data.totals.cost === detail.data.costs.reduce((s, x) => s + x.amount, 0)
      && detail.data.totals.profit === detail.data.totals.income - detail.data.totals.cost,
    detail.ok ? `${detail.data.totals.income} / ${detail.data.totals.cost} / ${detail.data.totals.profit}` : '—');

  /* ---------------- 7. 首页 v2 ---------------- */
  const dash = await api('GET', `/api/dashboard/v2?month=${thisMonth}`);
  const cards = dash.data.cards;
  check('首页卡片：本月收入 +80000 / 成本 +40000 / 利润 +40000（增量）',
    cards.month_income - baseCards.month_income === 80000
      && cards.month_cost - baseCards.month_cost === 40000
      && cards.month_profit - baseCards.month_profit === 40000,
    `增量：收入 +${cards.month_income - baseCards.month_income}，成本 +${cards.month_cost - baseCards.month_cost}，利润 +${cards.month_profit - baseCards.month_profit}`);

  check('首页卡片：客户总数与待回访计数正确',
    cards.customer_total >= 2 && cards.follow_due >= 1,
    `客户 ${cards.customer_total} 家，待回访 ${cards.follow_due}（逾期 ${cards.follow_overdue}）`);

  check('首页带两张分布（地区 + 行业）',
    !!dash.data.dist_region && !!dash.data.dist_industry
      && Array.isArray(dash.data.dist_region.groups) && Array.isArray(dash.data.dist_industry.groups),
    `地区 ${dash.data.dist_region.groups.length} 组 / 行业 ${dash.data.dist_industry.groups.length} 组`);

  check('首页带回访提醒与最近动态',
    Array.isArray(dash.data.follow_customers) && Array.isArray(dash.data.recent_logs),
    `回访提醒 ${dash.data.follow_customers.length} 条，动态 ${dash.data.recent_logs.length} 条`);

  /* ---------------- 8. 删除与清理 ---------------- */
  const del = await api('DELETE', `/api/costs/${made.costs[2]}`);
  check('删除成本为软删除（删除后列表不再返回）',
    del.ok && del.data.deleted === true,
    del.ok ? `#${made.costs[2]} 已删除` : del.message);

  const listAfter = await api('GET', `/api/costs?customer_id=${c2.data.id}`);
  check('删除后该客户成本合计相应减少（差旅 2000 已不计入）',
    listAfter.ok && Number(listAfter.data.amount) === 1000,
    listAfter.ok ? `剩余合计 ${listAfter.data.amount}（其他 1000）` : '—');

  /* ---------------- 清理测试数据 ---------------- */
  try {
    const db = new DatabaseSync(DB_FILE);
    for (const id of made.costs) db.prepare('DELETE FROM costs WHERE id = ?').run(id);
    if (made.payment) db.prepare('DELETE FROM payments WHERE id = ?').run(made.payment);
    if (made.project) db.prepare('DELETE FROM projects WHERE id = ?').run(made.project);
    for (const id of made.customers) {
      db.prepare('DELETE FROM contacts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM followups WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'cost' OR summary LIKE ?").run(`%${TAG}%`);
    const left = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?").get(`%${TAG}%`).n;
    const leftCost = db.prepare("SELECT COUNT(*) AS n FROM costs WHERE id IN (" +
      made.costs.map(() => '?').join(',') + ')').get(...made.costs).n;
    db.close();
    check('测试数据已清理（不留客户与成本）', left === 0 && leftCost === 0,
      `残留客户 ${left} 家、成本 ${leftCost} 条`);
  } catch (e) {
    check('测试数据已清理（不留客户与成本）', false, e.message);
  }

  /* ---------------- 汇总 ---------------- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'stats-122-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('异常：', e.stack || e);
  process.exit(1);
});
