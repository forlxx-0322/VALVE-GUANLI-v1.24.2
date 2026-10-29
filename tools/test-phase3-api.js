/**
 * 阶段三 API 验收测试 —— 项目档案（1:1）/ 回款 / 成本 / 待办（1.23）
 *
 * 1.23 起没有独立「项目管理」模块：项目是客户详情里的 1:1 档案。
 * 本套件验证：
 *   - 一个客户多个项目（允许第二个进行中项目 / 归档后可再建 / 单项目开关不影响另一个）
 *   - 历史项目只读
 *   - 回款计划与实收：欠款、回款率、回款状态、核销、逾期、超收提醒
 *   - 成本台账：分类 / 金额校验 / 自动挂项目 / 增删改查
 *   - 财务汇总与项目汇总口径
 *   - 待办中心四视图、完成切换、优先级排序、按项目筛选
 *   - 字段白名单与软删除 / 回收站
 *
 * 用法：node tools/test-phase3-api.js
 */

'use strict';

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

/** 日期偏移 */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const created = {};

(async () => {
  console.log('=== 阶段三 API 验收测试（项目档案 / 回款 / 成本 / 待办）===\n');

  /* ---------- 0. 清理残留 ---------- */
  try {
    const ids = [];
    for (const k of ['阶段三测试', '回款测试', '一客户一项目']) {
      const c = await api('GET', '/api/customers?pageSize=100&q=' + encodeURIComponent(k));
      ids.push(...((c.data && c.data.list) || []).map((x) => x.id));
    }
    for (const id of [...new Set(ids)]) {
      const pl = await api('GET', `/api/projects?customer_id=${id}&pageSize=200&archived=all`);
      const pids = (pl.data.list || []).map((p) => p.id);
      if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
      await api('POST', '/api/customers/batch-delete', { ids: [id] });
    }
    if (ids.length) console.log(`（清理残留 ${new Set(ids).size} 条测试客户及其项目）\n`);
  } catch (_) { /* 首次运行 */ }

  /* ---------- 1. 阶段与字典 ---------- */
  const stages = await api('GET', '/api/projects/stages');
  check(1, '项目阶段接口返回 14 个阶段',
    stages.data && stages.data.stages.length === 14,
    `${stages.data && stages.data.stages.length} 个阶段：${(stages.data.stages || []).slice(0, 4).join('→')}…`);
  check(2, '进行中 / 已成交阶段清单正确',
    stages.data.active.length === 12 && stages.data.won.length === 6,
    `进行中 ${stages.data.active.length} 个（已排除已暂停/已终止），已成交 ${stages.data.won.length} 个`);

  /* ---------- 3. 建立测试客户 ---------- */
  const cust = await api('POST', '/api/customers', {
    name: '阶段三测试客户（中国石化塔河炼化）', short_name: '塔河炼化',
    industry: '石油', source: '工程公司配套',
    province: '新疆维吾尔自治区', city: '阿克苏地区',
    contact_name: '李工', contact_position: '采购经理', contact_phone: '13900001111'
  });
  created.customer = cust.data.id;
  check(3, '准备测试客户（新字段模型）',
    cust.data && cust.data.created === true && !!cust.data.id,
    `id=${cust.data && cust.data.id}`);

  /* ---------- 4. 建立项目档案（1:1） ---------- */
  const p1 = await api('PUT', `/api/customers/${created.customer}/project`, {
    name: '塔河炼化 2026 年大修阀门采购项目',
    stage: '投标/议价',
    progress: 30,
    quantity: 260,
    bid_date: dayOffset(-5),
    bid_result: '已投标待开标',
    remark: '阶段三测试项目'
  });
  created.project = p1.data && p1.data.id;
  check(4, '通过客户接口建立项目档案（1:1，含招投标字段）',
    p1.status === 200 && p1.data && p1.data.created === true && p1.data.project
      && p1.data.project.name === '塔河炼化 2026 年大修阀门采购项目',
    `project id=${created.project}`);

  const d1 = await api('GET', `/api/projects/${created.project}`);
  check(5, '项目档案详情返回完整字段与关联客户',
    d1.data && d1.data.name.includes('大修阀门采购') && d1.data.customer
      && d1.data.customer.short_name === '塔河炼化'
      && d1.data.bid_result === '已投标待开标'
      && d1.data.archived === 0,
    `客户=${d1.data.customer && d1.data.customer.short_name}，投标结果=${d1.data.bid_result}，archived=${d1.data.archived}`);

  check(6, '未签约项目的回款状态为「未签约」且欠款为 0',
    d1.data.payment_status === '未签约' && d1.data.debt_amount === 0,
    `回款状态=${d1.data.payment_status}，欠款=${d1.data.debt_amount}`);

  /* ---------- 7. 一个客户多个项目（1.27） ---------- */
  const second = await api('POST', '/api/projects', {
    name: '阶段三测试：第二个进行中项目', customer_id: created.customer, contract_amount: 88000
  });
  const twoActive = await api('GET', `/api/projects?customer_id=${created.customer}&pageSize=10&status=all`);
  check(7, '同一客户可以再建第二个进行中项目（1:N）',
    second.status === 200 && second.data.created === true
      && second.data.id !== created.project
      && twoActive.data.stats.active_count === 2,
    `HTTP ${second.status}，进行中 ${twoActive.data.stats.active_count} 个`);
  /* 清理第二个项目：后续用例继续围绕第一个项目验证回款/成本口径 */
  await api('DELETE', `/api/projects/${second.data.id}`);

  /* ---------- 8. 必填校验 ---------- */
  const bad1 = await api('POST', '/api/projects', { name: '' });
  const bad2 = await api('POST', '/api/projects', { name: '无客户项目' });
  check(8, '项目名称与所属客户必填校验',
    bad1.status === 400 && bad2.status === 400 && bad2.json.code === 'CUSTOMER_REQUIRED',
    `空名称→${bad1.status}/${bad1.json.code}，无客户→${bad2.status}/${bad2.json.code}`);

  /* ---------- 9. 阶段流转 ---------- */
  const mv = await api('POST', `/api/projects/${created.project}/move-stage`, { stage: '已中标/已签约' });
  const afterMv = await api('GET', `/api/projects/${created.project}`);
  check(9, '改阶段成功，进入签约阶段自动补签约日期',
    mv.data.changed === true && afterMv.data.stage === '已中标/已签约' && !!afterMv.data.signed_at,
    `${mv.data.from} → ${mv.data.stage}，签约日期=${afterMv.data.signed_at}`);

  const badStage = await api('POST', `/api/projects/${created.project}/move-stage`, { stage: '不存在的阶段' });
  check(10, '非法阶段被拒绝', badStage.status === 400, `HTTP ${badStage.status} ${badStage.json.message}`);

  /* ---------- 11. 合同额与欠款 ---------- */
  await api('PUT', `/api/projects/${created.project}`, { contract_amount: 1860000, progress: 40 });
  const afterAmount = await api('GET', `/api/projects/${created.project}`);
  check(11, '合同额写入后欠款 = 合同额（尚未收款）',
    afterAmount.data.contract_amount === 1860000 && afterAmount.data.debt_amount === 1860000
      && afterAmount.data.payment_status === '未开始',
    `合同额=${afterAmount.data.contract_amount}，欠款=${afterAmount.data.debt_amount}，状态=${afterAmount.data.payment_status}`);

  /* ---------- 12. 回款计划 ---------- */
  const plan1 = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 558000,
    plan_date: dayOffset(-10), remark: '预付款 30%'
  });
  const plan2 = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 930000,
    plan_date: dayOffset(20), remark: '发货前付清 50%'
  });
  const plan3 = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 372000,
    plan_date: dayOffset(60), remark: '质保金 20%'
  });
  created.plan1 = plan1.data.id;
  created.plan2 = plan2.data.id;
  created.plan3 = plan3.data.id;
  check(12, '新增 3 条回款计划（30% / 50% / 20%）',
    plan1.data.created && plan2.data.created && plan3.data.created,
    `计划合计 ${558000 + 930000 + 372000} = 合同额 ${1860000}`);

  const tasksAfterPlan = await api('GET', `/api/tasks?view=all&project_id=${created.project}`);
  const planTasks = (tasksAfterPlan.data.list || []).filter((t) => t.source === '回款计划');
  check(13, '新建回款计划自动生成待办（按提醒天数提前）',
    planTasks.length === 3,
    planTasks.map((t) => `${t.due_at.slice(0, 10)}(${t.priority})`).join(' / '));

  const ov = await api('GET', '/api/projects?quick=overdue_payment');
  const ovRow = (ov.data.list || []).find((p) => p.id === created.project);
  check(14, '逾期回款计划被正确识别',
    !!ovRow && ovRow.overdue_date === dayOffset(-10),
    ovRow ? `项目标记逾期，最早逾期计划日=${ovRow.overdue_date}` : '未识别到逾期');

  /* ---------- 15. 登记实收 ---------- */
  const rec1 = await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 558000,
    actual_date: dayOffset(-8), method: '银行转账', plan_id: created.plan1, remark: '预付款到账'
  });
  created.receipt1 = rec1.data.id;
  const s1 = await api('GET', `/api/projects/${created.project}`);
  check(15, '登记实收后欠款与回款率自动重算',
    s1.data.received_amount === 558000 && s1.data.debt_amount === 1302000
      && s1.data.payment_rate === 30 && s1.data.payment_status === '部分回款',
    `已收=${s1.data.received_amount}，欠款=${s1.data.debt_amount}，回款率=${s1.data.payment_rate}%，状态=${s1.data.payment_status}`);

  const plan1After = s1.data.plans.find((p) => p.id === created.plan1);
  check(16, '实收关联计划后该计划显示已核销',
    plan1After.is_settled === true && plan1After.settled_amount === 558000 && plan1After.remain === 0,
    `计划 558000 已核销=${plan1After.is_settled}，已收 ${plan1After.settled_amount}，余 ${plan1After.remain}`);

  check(17, '项目汇总正确（计划/已核销/未核销/逾期数）',
    s1.data.summary.planned_amount === 1860000
      && s1.data.summary.settled_amount === 558000
      && s1.data.summary.unsettled_amount === 1302000
      && s1.data.summary.overdue_count === 0,
    `计划 ${s1.data.summary.planned_amount}，已核销 ${s1.data.summary.settled_amount}，未核销 ${s1.data.summary.unsettled_amount}，逾期 ${s1.data.summary.overdue_count}`);

  /* ---------- 18. 超收提醒 ---------- */
  const over = await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 1500000,
    actual_date: dayOffset(-1), method: '银行转账'
  });
  check(18, '实收超过合同额时给出超收提醒（但仍允许登记）',
    over.data && over.data.warning && over.data.warning.includes('超过合同金额'),
    over.data.warning || '未提示');
  created.receiptOver = over.data.id;

  await api('DELETE', `/api/payments/${created.receiptOver}`);
  const s2 = await api('GET', `/api/projects/${created.project}`);
  check(19, '删除实收后金额自动回退',
    s2.data.received_amount === 558000 && s2.data.debt_amount === 1302000,
    `已收回到 ${s2.data.received_amount}，欠款 ${s2.data.debt_amount}`);

  /* ---------- 20. 收满 ---------- */
  const rec2 = await api('POST', '/api/payments', {
    project_id: created.project, type: '实收', amount: 1302000,
    actual_date: dayOffset(0), method: '承兑汇票', plan_id: created.plan2
  });
  created.receipt2 = rec2.data.id;
  const s3 = await api('GET', `/api/projects/${created.project}`);
  check(20, '收满合同额后状态自动变为「已结清」',
    s3.data.payment_status === '已结清' && s3.data.debt_amount === 0 && s3.data.payment_rate === 100,
    `状态=${s3.data.payment_status}，欠款=${s3.data.debt_amount}，回款率=${s3.data.payment_rate}%`);

  /* ---------- 21. 参数校验 ---------- */
  const badAmt1 = await api('POST', '/api/payments', { project_id: created.project, type: '实收', amount: 0 });
  const badAmt2 = await api('POST', '/api/payments', { project_id: created.project, type: '计划', amount: 100 });
  check(21, '金额与计划日期必填校验',
    badAmt1.status === 400 && badAmt1.json.code === 'AMOUNT_REQUIRED'
      && badAmt2.status === 400 && badAmt2.json.code === 'PLAN_DATE_REQUIRED',
    `金额0→${badAmt1.json.code}，计划缺日期→${badAmt2.json.code}`);

  /* ---------- 22. 列表与筛选 ---------- */
  const listAll = await api('GET', '/api/projects?pageSize=50');
  const listStage = await api('GET', '/api/projects?stage=' + encodeURIComponent('已中标/已签约'));
  const listPay = await api('GET', '/api/projects?payment_status=' + encodeURIComponent('已结清'));
  const listDebt = await api('GET', '/api/projects?payment_status=' + encodeURIComponent('有欠款'));
  check(22, '项目列表与筛选（阶段 / 回款状态）',
    listAll.data.total >= 1 && listStage.data.total >= 1 && listPay.data.total >= 1
      && !(listDebt.data.list || []).some((p) => p.id === created.project),
    `全部 ${listAll.data.total}，已签约阶段 ${listStage.data.total}，已结清 ${listPay.data.total}，有欠款 ${listDebt.data.total}`);

  check(23, '列表返回合同额与已收汇总',
    listAll.data.summary && typeof listAll.data.summary.debt_total === 'number',
    `合同总额 ${listAll.data.summary.contract_total}，已收 ${listAll.data.summary.received_total}，欠款 ${listAll.data.summary.debt_total}`);

  const search = await api('GET', '/api/projects?q=' + encodeURIComponent('塔河炼化'));
  check(24, '项目搜索覆盖客户名',
    search.data.total >= 1,
    `按客户名命中 ${search.data.total}`);

  const board = await api('GET', '/api/projects/board');
  const col = (board.data.columns || []).find((c) => c.stage === '已中标/已签约');
  check(25, '看板接口仍可用（API 兼容，前端已无入口）：按 14 个阶段分组',
    board.data.columns.length === 14 && col && col.count >= 1,
    `14 列；「已中标/已签约」列 ${col && col.count} 个项目`);

  /* ---------- 26. 回款总览 ---------- */
  const ovPlan = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 88000,
    plan_date: dayOffset(-3), remark: '阶段三测试：逾期未收计划'
  });
  const ovUpPlan = await api('POST', '/api/payments', {
    project_id: created.project, type: '计划', amount: 66000,
    plan_date: dayOffset(12), remark: '阶段三测试：近期计划'
  });
  const overview = await api('GET', '/api/payment-overview?days=30');
  const ovHit = overview.data.overdue.find((x) => x.id === ovPlan.data.id);
  const upHit = overview.data.upcoming.find((x) => x.id === ovUpPlan.data.id);
  check(26, '回款总览列出未核销的逾期计划与近期计划',
    !!ovHit && ovHit.remain === 88000 && ovHit.overdue_days === 3
      && !!upHit && upHit.remain === 66000
      && overview.data.overdue_amount >= 88000,
    ovHit
      ? `逾期：${ovHit.project_name} 余 ${ovHit.remain} 元；近期：余 ${upHit && upHit.remain} 元`
      : '逾期计划未被列出');
  check('26b', '已核销的计划不再计入逾期（避免误报）',
    !overview.data.overdue.some((x) => x.id === created.plan1),
    '已收款的计划已从逾期列表移除');

  await api('DELETE', `/api/payments/${ovPlan.data.id}`);
  await api('DELETE', `/api/payments/${ovUpPlan.data.id}`);

  /* ---------- 27. 成本台账 ---------- */
  const cost1 = await api('POST', '/api/costs', {
    customer_id: created.customer, category: '采购成本', amount: 900000,
    spent_at: dayOffset(-5), supplier: '某阀门制造厂', remark: '阶段三测试采购成本'
  });
  const cost2 = await api('POST', '/api/costs', {
    customer_id: created.customer, category: '维护成本', amount: 20000, spent_at: dayOffset(-4)
  });
  const cost3 = await api('POST', '/api/costs', {
    customer_id: created.customer, category: '差旅', amount: 5000, spent_at: dayOffset(-3)
  });
  const costNoProject = await api('GET', `/api/customers/${created.customer}/project`);
  check(27, '成本台账可登记（只给客户时自动归属到项目档案）',
    cost1.status === 200 && cost2.status === 200 && cost3.status === 200
      && cost1.data.customer_id === created.customer
      && cost1.data.project_id === created.project
      && costNoProject.data.project.id === created.project,
    `成本 #${cost1.data.id} 项目=${cost1.data.project_id}，客户当前项目=${costNoProject.data.project.id}`);

  const badCat = await api('POST', '/api/costs', { customer_id: created.customer, category: '随便', amount: 1 });
  const badCostAmt = await api('POST', '/api/costs', { customer_id: created.customer, category: '其他', amount: -5 });
  const noOwner = await api('POST', '/api/costs', { category: '其他', amount: 1 });
  check(28, '成本分类 / 金额 / 归属校验',
    badCat.status === 400 && /分类/.test(badCat.json.message || '')
      && badCostAmt.status === 400 && /金额/.test(badCostAmt.json.message || '')
      && noOwner.status === 400,
    `分类→HTTP ${badCat.status}，金额→HTTP ${badCostAmt.status}，无归属→HTTP ${noOwner.status}`);

  const costList = await api('GET', `/api/costs?customer_id=${created.customer}`);
  check(29, '成本列表按客户筛选并分类汇总',
    costList.data.total === 3 && costList.data.amount === 925000
      && costList.data.by_category.length === 3,
    `共 ${costList.data.total} 笔 ${costList.data.amount} 元，分类 ${costList.data.by_category.map((x) => x.category + ':' + x.amount).join(' / ')}`);

  const costUpd = await api('PUT', `/api/costs/${cost3.data.id}`, { amount: 8000 });
  const costDel = await api('DELETE', `/api/costs/${cost2.data.id}`);
  check(30, '成本可修改与删除（软删除）',
    costUpd.status === 200 && costUpd.data.amount === 8000
      && costDel.status === 200 && costDel.data.deleted === true,
    `修改后差旅=${costUpd.data.amount}，删除维护成本 #${cost2.data.id}`);

  /* ---------- 31. 财务汇总 ---------- */
  const fin = await api('GET', `/api/customers/${created.customer}/finance`);
  const f = fin.data || {};
  check(31, '客户财务汇总与回款/成本口径一致',
    fin.status === 200
      && f.contract_amount === 1860000 && f.received_amount === 1860000
      && f.receivable_amount === 0 && f.purchase_cost === 900000
      && f.maintain_cost === 0 && f.other_cost === 8000
      && f.total_cost === 908000 && f.profit === 952000
      && Math.abs(f.margin - 51.2) < 0.06,
    `合同额=${f.contract_amount} 已收=${f.received_amount} 应收=${f.receivable_amount} 采购=${f.purchase_cost} 其他=${f.other_cost} 毛利=${f.profit} 毛利率=${f.margin}%`);

  /* ---------- 32. 转为历史 + 历史只读 ---------- */
  const arch = await api('POST', `/api/customers/${created.customer}/project/archive`);
  const afterArch = await api('GET', `/api/customers/${created.customer}/project`);
  const hist = await api('GET', `/api/customers/${created.customer}/history-projects`);
  check(32, '当前项目可「转为历史」，转后客户没有当前项目、历史里能查到',
    arch.status === 200 && arch.data.archived === true
      && afterArch.data.project === null
      && hist.data.length === 1 && hist.data[0].id === created.project
      && hist.data[0].archived === 1,
    `归档 id=${arch.data.id}，历史 ${hist.data.length} 条`);

  const editArchived = await api('PUT', `/api/projects/${created.project}`, { name: '试图修改历史项目' });
  const delArchived = await api('PUT', `/api/customers/${created.customer}/project`, {
    id: created.project, name: '通过客户接口改历史'
  });
  check(33, '历史项目只读（普通接口与客户接口都拒绝修改）',
    editArchived.status === 400 && editArchived.json.code === 'ARCHIVED_READONLY'
      && delArchived.status === 400 && delArchived.json.code === 'ARCHIVED_READONLY',
    `普通接口 HTTP ${editArchived.status} ${editArchived.json && editArchived.json.code}；客户接口 HTTP ${delArchived.status} ${delArchived.json && delArchived.json.code}`);

  /* ---------- 34. 归档后可再建新进行中项目 ---------- */
  const p2 = await api('PUT', `/api/customers/${created.customer}/project`, {
    name: '阶段三测试：归档后新项目', stage: '技术交流', contract_amount: 250000
  });
  const listAfter = await api('GET', '/api/customers?q=' + encodeURIComponent('塔河炼化'));
  const rowAfter = (listAfter.data.list || []).find((x) => x.id === created.customer);
  check(34, '归档后可以建立新的进行中项目（多项目，列表项目数 1）',
    p2.data.created === true && p2.data.id !== created.project
      && rowAfter && rowAfter.project_count === 1,
    `新进行中项目 id=${p2.data.id}，列表项目数=${rowAfter && rowAfter.project_count}`);
  created.project2 = p2.data.id;

  /* 1.27 财务口径：客户汇总按进行中项目合计，历史项目不计入但仍可查看 */
  const finAfter = await api('GET', `/api/customers/${created.customer}/finance`);
  const sumAfter = await api('GET', `/api/customers/${created.customer}/projects`);
  const archivedDetail = await api('GET', `/api/projects/${created.project}`);
  check('34b', '客户财务只算进行中项目合计；历史项目仍可只读查看',
    finAfter.data.contract_amount === 250000 && finAfter.data.received_amount === 0
      && finAfter.data.total_cost === 0 && finAfter.data.profit === 0
      && finAfter.data.active_project_count === 1 && finAfter.data.archived_project_count === 1
      && sumAfter.data.totals.contract_amount === 250000
      && sumAfter.data.archived.length === 1
      && archivedDetail.status === 200
      && archivedDetail.data.archived === 1
      && archivedDetail.data.received_amount === 1860000,
    `进行中合计 合同额=${finAfter.data.contract_amount} 已收=${finAfter.data.received_amount}；`
      + `历史项目已收=${archivedDetail.data.received_amount}`);

  /* ---------- 36. 第一次登记回款自动建档案 ---------- */
  const custB = await api('POST', '/api/customers', {
    name: '阶段三测试客户-自动建档（回款测试）', industry: '化工'
  });
  const payAuto = await api('POST', '/api/payments', {
    customer_id: custB.data.id, type: '实收', amount: 10000, actual_date: dayOffset(0)
  });
  const custBProject = await api('GET', `/api/customers/${custB.data.id}/project`);
  check(36, '第一次登记回款时自动建一条空项目档案（财务数据有归属）',
    payAuto.status === 200 && custBProject.data.project
      && custBProject.data.project.id === payAuto.data.project_id,
    `回款 project_id=${payAuto.data.project_id}，客户当前项目=${custBProject.data.project && custBProject.data.project.id}`);

  const costAuto = await api('POST', '/api/costs', {
    customer_id: custB.data.id, category: '采购成本', amount: 4000
  });
  check('36b', '只登记成本时也自动归属到项目档案',
    costAuto.status === 200 && costAuto.data.project_id === payAuto.data.project_id,
    `成本 project_id=${costAuto.data.project_id}`);
  created.custB = custB.data.id;

  /* ---------- 37. 待办中心 ---------- */
  const tToday = await api('GET', '/api/tasks?view=today');
  const tWeek = await api('GET', '/api/tasks?view=week');
  const tOverdue = await api('GET', '/api/tasks?view=overdue');
  const tDone = await api('GET', '/api/tasks?view=done');
  check(37, '待办四视图均可查询并带计数',
    tToday.status === 200 && tWeek.status === 200 && tOverdue.status === 200 && tDone.status === 200
      && tToday.data.counts && typeof tToday.data.counts.overdue === 'number',
    `今日 ${tToday.data.list.length}，本周 ${tWeek.data.list.length}，逾期 ${tOverdue.data.list.length}，已完成 ${tDone.data.list.length}`);

  const manual = await api('POST', '/api/tasks', {
    title: '阶段三测试：给塔河炼化寄送技术方案与报价单',
    customer_id: created.customer,
    project_id: created.project2,
    due_at: dayOffset(2) + ' 10:00:00',
    priority: '高',
    remark: '阶段三测试待办'
  });
  created.task = manual.data.id;
  check(38, '手动新增待办（自动带出客户）',
    manual.data.created === true,
    `id=${manual.data.id}`);

  const done = await api('POST', `/api/tasks/${created.task}/toggle`, { done: true });
  const undone = await api('POST', `/api/tasks/${created.task}/toggle`, { done: false });
  const done2 = await api('POST', `/api/tasks/${created.task}/toggle`, {});
  check(39, '待办完成与取消完成切换正常',
    done.data.status === '已完成' && !!done.data.done_at
      && undone.data.status === '待办' && undone.data.done_at === null
      && done2.data.status === '已完成',
    `完成→${done.data.status}，取消→${undone.data.status}，再次切换→${done2.data.status}`);

  const badTask = await api('POST', '/api/tasks', { title: '   ' });
  check(40, '待办标题必填校验',
    badTask.status === 400 && badTask.json.code === 'TITLE_REQUIRED',
    `HTTP ${badTask.status} code=${badTask.json.code}`);

  const sorted = await api('GET', '/api/tasks?view=all');
  const prioOrder = { '高': 1, '中': 2, '低': 3 };
  const prios = sorted.data.list.map((t) => prioOrder[t.priority] || 4);
  check(41, '待办按优先级排序（高→中→低）',
    prios.every((v, i) => i === 0 || prios[i - 1] <= v),
    `优先级序列：${sorted.data.list.slice(0, 6).map((t) => t.priority).join('')}`);

  const projTasks = await api('GET', `/api/tasks?view=done&project_id=${created.project2}`);
  check(42, '按项目筛选待办（项目档案仍挂待办）',
    projTasks.data.list.length >= 1 && projTasks.data.list.every((t) => t.project_id === created.project2),
    `本项目已完成待办 ${projTasks.data.list.length} 条`);

  /* ---------- 43. 项目日志 ---------- */
  const full = await api('GET', `/api/projects/${created.project}`);
  const hasOps = full.data.logs.some((l) => l.action === 'create')
    && full.data.logs.some((l) => l.action === 'payment')
    && full.data.logs.some((l) => l.action === 'update');
  check(43, '项目档案操作日志记录新建/修改/回款',
    hasOps,
    `日志动作：${[...new Set(full.data.logs.map((l) => l.action))].join(', ')}`);

  /* ---------- 44. 项目白名单 ---------- */
  await api('PUT', `/api/projects/${created.project2}`, {
    name: '阶段三测试：归档后新项目',
    received_amount: 999999, deleted_at: '2020-01-01T00:00:00', archived: 1, created_at: '1999-01-01'
  });
  const afterHack = await api('GET', `/api/projects/${created.project2}`);
  check(44, '项目字段白名单拦截越权写入（received_amount / deleted_at / archived / created_at）',
    afterHack.data.received_amount === 0 && afterHack.data.deleted_at === null
      && afterHack.data.archived === 0 && !String(afterHack.data.created_at).startsWith('1999'),
    `received_amount=${afterHack.data.received_amount}，archived=${afterHack.data.archived}，deleted_at=${afterHack.data.deleted_at}`);

  /* ---------- 45. 软删除与回收站 ---------- */
  const p3 = await api('PUT', `/api/customers/${created.custB}/project`, { name: '待删除项目档案' });
  const delP = await api('DELETE', `/api/projects/${p3.data.id}`);
  const getDel = await api('GET', `/api/projects/${p3.data.id}`);
  const trash = await api('GET', '/api/trash?type=project');
  const inTrash = (trash.data || []).some((x) => x.id === p3.data.id);
  const restore = await api('POST', '/api/trash/restore', { ids: [p3.data.id], type: 'project' });
  const afterRestore = await api('GET', `/api/projects/${p3.data.id}`);
  check(45, '项目删除为软删除，回收站可见并还原',
    delP.data.count === 1 && getDel.status === 404 && inTrash
      && restore.data.count === 1 && afterRestore.status === 200,
    `删除 ${delP.data.count}，详情 HTTP ${getDel.status}，回收站可见=${inTrash}，还原=${restore.data.count}`);

  /* ---------- 46. 不存在的项目 ---------- */
  const nf = await api('GET', '/api/projects/99999999');
  check(46, '查询不存在项目返回 404',
    nf.status === 404 && nf.json.code === 'NOT_FOUND',
    `HTTP ${nf.status} code=${nf.json.code}`);

  /* ---------- 47. 清理已完成待办 ---------- */
  const purge = await api('POST', '/api/tasks/purge-done', { keepDays: 30 });
  check(47, '清理已完成待办接口可用（保留最近 30 天）',
    purge.status === 200 && typeof purge.data.removed === 'number',
    `清理 ${purge.data.removed} 条（保留 ${purge.data.keepDays} 天）`);

  /* ---------- 清理测试数据 ---------- */
  for (const cid of [created.customer, created.custB]) {
    const pl = await api('GET', `/api/projects?customer_id=${cid}&pageSize=200&archived=all`);
    const pids = (pl.data.list || []).map((p) => p.id);
    /* 先删回款（无软删除），再删成本，避免污染报表 */
    for (const pid of pids) {
      const d = await api('GET', `/api/projects/${pid}`);
      const rows = [].concat((d.data && d.data.plans) || [], (d.data && d.data.receipts) || []);
      for (const row of rows) await api('DELETE', `/api/payments/${row.id}`);
    }
    const cl = await api('GET', `/api/costs?customer_id=${cid}&pageSize=200`);
    for (const row of (cl.data && cl.data.list) || []) await api('DELETE', `/api/costs/${row.id}`);
    if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
    const tl = await api('GET', `/api/tasks?view=all&customer_id=${cid}`);
    const tids = (tl.data.list || []).map((t) => t.id);
    if (tids.length) await api('POST', '/api/tasks/batch-delete', { ids: tids });
    await api('POST', '/api/customers/batch-delete', { ids: [cid] });
  }
  console.log('\n（已清理测试数据：2 个客户及其项目 / 回款 / 成本 / 待办）');

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
