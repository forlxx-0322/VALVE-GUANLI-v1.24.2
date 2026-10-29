/**
 * 1.27 一个客户多个项目（1:N）专项验收
 *
 * 覆盖（真实 HTTP + 直读 SQLite）：
 *   1~7    两个客户 / 建 3 个进行中项目 / 列表分页与统计 / 客户项目汇总 / 客户详情字段 / 列表 project_count
 *   8~12   同客户重名拒绝（去空格、忽略大小写）/ 改名重名拒绝 / 跨客户同名允许
 *   13~20  每个项目独立回款 / 成本 / 毛利 / 回款状态；客户汇总 = 各项目之和；财务接口口径一致
 *   21~28  归档与恢复：列表、汇总、历史项目、只读校验、恢复归档、恢复时重名冲突
 *   29~33  待办关联项目：可空 / 自动带客户 / 跨客户项目拒绝 / 不存在项目拒绝 / 列表带项目名
 *   34~39  删除一个项目只影响自己（回款不再计入、成本软删除、另一个项目照旧）
 *   40~45  客户删除级联所有项目/成本，还原整体恢复；v16 唯一索引已删除 / 版本号 16
 *   46~48  旧 v15 库自动升级到 v16：索引删除、数据不丢、可建第二个项目、可重入
 *   49     测试数据自清理
 *
 * 用法：node tools/test-projects-multi-127.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const DB_FILE = path.join(ROOT, 'data', 'crm.db');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json && json.data, code: json && json.code, message: json && json.message };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  console.log('=== 1.27 一个客户多个项目（1:N）专项验收 ===\n');

  const tag = Date.now().toString().slice(-6);
  const db = new DatabaseSync(DB_FILE);
  const created = { customers: [], projects: [] };
  let A = null;
  let B = null;

  const mkCustomer = async (name) => {
    const r = await api('POST', '/api/customers', { name, industry: '石油' });
    if (r.data && r.data.id) {
      created.customers.push(r.data.id);
    }
    return r;
  };

  const cleanup = async () => {
    try {
      for (const cid of [...new Set(created.customers)]) {
        const pl = await api('GET', `/api/projects?customer_id=${cid}&pageSize=200&status=all`);
        const pids = ((pl.data && pl.data.list) || []).map((p) => p.id);
        for (const pid of pids) {
          const d = await api('GET', `/api/projects/${pid}`);
          if (d.status === 200) {
            const rows = [].concat((d.data && d.data.plans) || [], (d.data && d.data.receipts) || []);
            for (const row of rows) await api('DELETE', `/api/payments/${row.id}`);
          }
        }
        const cl = await api('GET', `/api/costs?customer_id=${cid}&pageSize=200`);
        for (const row of ((cl.data && cl.data.list) || [])) await api('DELETE', `/api/costs/${row.id}`);
        if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
        const tl = await api('GET', `/api/tasks?view=all&customer_id=${cid}`);
        const tids = ((tl.data && tl.data.list) || []).map((t) => t.id);
        if (tids.length) await api('POST', '/api/tasks/batch-delete', { ids: tids });
        await api('POST', '/api/customers/batch-delete', { ids: [cid] });
      }
    } catch (_) { /* 忽略 */ }
  };

  try {
    /* ================= 1. 建 3 个项目 ================= */
    const ca = await mkCustomer(`【多项目127${tag}】客户A`);
    const cb = await mkCustomer(`【多项目127${tag}】客户B`);
    A = ca.data && ca.data.id;
    B = cb.data && cb.data.id;
    check('1. 准备两个客户', ca.status === 200 && cb.status === 200 && !!A && !!B && A !== B,
      `A=${A}，B=${B}`);

    const P1 = await api('POST', '/api/projects', {
      name: `【127】项目一${tag}`, customer_id: A, stage: '投标/议价',
      progress: 30, contract_amount: 100000
    });
    const P2 = await api('POST', '/api/projects', {
      name: `【127】项目二${tag}`, customer_id: A, stage: '技术交流',
      progress: 20, contract_amount: 200000
    });
    const P3 = await api('POST', '/api/projects', {
      name: `【127】项目三${tag}`, customer_id: A, stage: '方案选型',
      progress: 10, contract_amount: 300000
    });
    if (P1.data && P1.data.id) created.projects.push(P1.data.id);
    if (P2.data && P2.data.id) created.projects.push(P2.data.id);
    if (P3.data && P3.data.id) created.projects.push(P3.data.id);
    check('2. 同一客户连续建 3 个进行中项目都成功（不再有 PROJECT_EXISTS）',
      P1.status === 200 && P2.status === 200 && P3.status === 200
        && P1.data.created && P2.data.created && P3.data.created
        && new Set([P1.data.id, P2.data.id, P3.data.id]).size === 3,
      `id=${P1.data.id}/${P2.data.id}/${P3.data.id}`);

    const listActive = await api('GET', `/api/projects?customer_id=${A}&pageSize=10`);
    check('3. 项目列表默认只返回进行中，分页与 total 正确',
      listActive.status === 200 && listActive.data.total === 3
        && listActive.data.list.length === 3
        && listActive.data.list.every((p) => p.archived === 0),
      `total=${listActive.data.total}`);

    const listStats = await api('GET', `/api/projects?customer_id=${A}&pageSize=2&status=all`);
    check('4. 列表返回分页字段 + stats（进行中/归档数量）+ 合同额汇总',
      listStats.data.page === 1 && listStats.data.pageSize === 2
        && listStats.data.pages === 2
        && listStats.data.stats.active_count === 3
        && listStats.data.stats.archived_count === 0
        && listStats.data.stats.total_count === 3
        && listStats.data.summary.contract_total === 600000,
      `pages=${listStats.data.pages}，active=${listStats.data.stats.active_count}，合同额=${listStats.data.summary.contract_total}`);

    const sum0 = await api('GET', `/api/customers/${A}/projects`);
    check('5. 客户项目汇总：active 3 个 / archived 0 个 / totals 合同额 600000',
      sum0.status === 200 && sum0.data.active.length === 3
        && sum0.data.archived.length === 0
        && sum0.data.totals.contract_amount === 600000
        && sum0.data.totals.received_amount === 0
        && sum0.data.totals.cost_amount === 0,
      JSON.stringify(sum0.data.totals));

    const detail0 = await api('GET', `/api/customers/${A}`);
    check('6. 客户详情带 active_projects 与 summary 项目计数（1:N）',
      detail0.status === 200 && Array.isArray(detail0.data.active_projects)
        && detail0.data.active_projects.length === 3
        && detail0.data.summary.project_count === 3
        && detail0.data.summary.active_project_count === 3
        && detail0.data.project && detail0.data.project.id === detail0.data.active_projects[0].id,
      `active_projects=${detail0.data.active_projects.length}，summary=${JSON.stringify(detail0.data.summary)}`);

    const rowN = (await api('GET', '/api/customers?q=' + encodeURIComponent(`【多项目127${tag}】客户A`))).data.list[0];
    check('7. 客户列表 project_count 统计进行中项目数（3）',
      !!rowN && rowN.project_count === 3,
      `project_count=${rowN && rowN.project_count}`);

    /* ================= 同客户重名 / 跨客户同名 ================= */
    const dup1 = await api('POST', '/api/projects', {
      name: `  ${`【127】项目一${tag}`}  `, customer_id: A
    });
    check('8. 同客户重名被拒绝（去首尾空格，NAME_DUPLICATE）',
      dup1.status === 400 && dup1.code === 'NAME_DUPLICATE',
      `HTTP ${dup1.status} code=${dup1.code}`);

    const asciiName = `Valve Project ${tag}`;
    const P4 = await api('POST', '/api/projects', {
      name: asciiName, customer_id: A, contract_amount: 1
    });
    if (P4.data && P4.data.id) created.projects.push(P4.data.id);
    const dup2 = await api('POST', '/api/projects', {
      name: ` ${asciiName.toLowerCase()} `, customer_id: A
    });
    check('9. 同客户重名忽略大小写（Valve Project / valve project）',
      P4.status === 200 && dup2.status === 400 && dup2.code === 'NAME_DUPLICATE',
      `HTTP ${dup2.status} code=${dup2.code}`);
    /* 删除第 4 个项目，后续按 3 个项目算账 */
    await api('DELETE', `/api/projects/${P4.data.id}`);

    const renameDup = await api('PUT', `/api/projects/${P2.data.id}`, { name: `【127】项目一${tag}` });
    check('10. 改名成同客户已在进行中的项目名也被拒绝',
      renameDup.status === 400 && renameDup.code === 'NAME_DUPLICATE',
      `HTTP ${renameDup.status} code=${renameDup.code}`);

    const renameOk = await api('PUT', `/api/projects/${P2.data.id}`, { name: `【127】项目二改名${tag}` });
    check('11. 改成不重复的名称可以保存',
      renameOk.status === 200 && Array.isArray(renameOk.data.changed),
      `HTTP ${renameOk.status}`);
    const P2row = await api('GET', `/api/projects/${P2.data.id}`);
    const p2Name = P2row.data.name;

    const BP = await api('POST', '/api/projects', {
      name: `【127】项目一${tag}`, customer_id: B, contract_amount: 88000
    });
    check('12. 跨客户允许同名项目',
      BP.status === 200 && BP.data.created === true && BP.data.id !== P1.data.id,
      `客户B 项目 id=${BP.data.id}`);

    /* ================= 回款 / 成本 / 毛利（逐项目独立） ================= */
    await api('POST', '/api/payments', { project_id: P1.data.id, type: '计划', amount: 40000, plan_date: '2026-11-01' });
    await api('POST', '/api/payments', { project_id: P1.data.id, type: '实收', amount: 30000, actual_date: '2026-10-20' });
    await api('POST', '/api/payments', { project_id: P2.data.id, type: '实收', amount: 50000, actual_date: '2026-10-21' });
    await api('POST', '/api/payments', { project_id: P3.data.id, type: '实收', amount: 60000, actual_date: '2026-10-22' });
    await api('POST', '/api/costs', { project_id: P1.data.id, category: '采购成本', amount: 10000, spent_at: '2026-10-20' });
    await api('POST', '/api/costs', { project_id: P2.data.id, category: '采购成本', amount: 20000, spent_at: '2026-10-21' });
    await api('POST', '/api/costs', { project_id: P3.data.id, category: '维护成本', amount: 30000, spent_at: '2026-10-22' });

    const d1 = (await api('GET', `/api/projects/${P1.data.id}`)).data;
    const d2 = (await api('GET', `/api/projects/${P2.data.id}`)).data;
    const d3 = (await api('GET', `/api/projects/${P3.data.id}`)).data;
    check('13. 每个项目各自回款（30k / 50k / 60k）',
      d1.received_amount === 30000 && d2.received_amount === 50000 && d3.received_amount === 60000,
      `${d1.received_amount} / ${d2.received_amount} / ${d3.received_amount}`);
    check('14. 每个项目各自成本（10k / 20k / 30k）',
      d1.cost_amount === 10000 && d2.cost_amount === 20000 && d3.cost_amount === 30000,
      `${d1.cost_amount} / ${d2.cost_amount} / ${d3.cost_amount}`);
    check('15. 每个项目各自毛利 = 已回款 − 成本',
      d1.profit === 20000 && d2.profit === 30000 && d3.profit === 30000,
      `${d1.profit} / ${d2.profit} / ${d3.profit}`);
    check('16. 各项目回款状态独立计算（部分回款 / 部分回款 / 部分回款）',
      d1.payment_status === '部分回款' && d2.payment_status === '部分回款' && d3.payment_status === '部分回款'
        && d1.debt_amount === 70000 && d2.debt_amount === 150000 && d3.debt_amount === 240000,
      `${d1.payment_status}/${d2.payment_status}/${d3.payment_status}`);

    const sum1 = (await api('GET', `/api/customers/${A}/projects`)).data;
    const activeSum = (arr, k) => round2(arr.reduce((s, x) => s + (Number(x[k]) || 0), 0));
    check('17. 客户汇总 totals = 各进行中项目逐行相加',
      sum1.totals.contract_amount === 600000
        && sum1.totals.received_amount === 140000
        && sum1.totals.cost_amount === 60000
        && sum1.totals.profit === 80000
        && sum1.totals.contract_amount === activeSum(sum1.active, 'contract_amount')
        && sum1.totals.received_amount === activeSum(sum1.active, 'received_amount')
        && sum1.totals.cost_amount === activeSum(sum1.active, 'cost_amount'),
      JSON.stringify(sum1.totals));

    const fin1 = (await api('GET', `/api/customers/${A}/finance`)).data;
    check('18. 财务接口与本项目汇总 totals 完全一致',
      fin1.contract_amount === sum1.totals.contract_amount
        && fin1.received_amount === sum1.totals.received_amount
        && fin1.total_cost === sum1.totals.cost_amount
        && fin1.profit === sum1.totals.profit
        && fin1.active_project_count === 3 && fin1.archived_project_count === 0,
      `合同额=${fin1.contract_amount} 已回款=${fin1.received_amount} 成本=${fin1.total_cost} 毛利=${fin1.profit}`);

    check('19. 财务应收 = 进行中项目回款计划 − 已回款',
      fin1.planned_amount === 40000 && fin1.receivable_amount === 0,
      `计划=${fin1.planned_amount} 已回款=${fin1.received_amount} 应收=${fin1.receivable_amount}`);

    check('20. 项目详情汇总含成本 / 毛利字段（逐项目维护用）',
      d1.summary && d1.summary.cost_amount === 10000 && d1.summary.profit === 20000
        && d2.summary.cost_amount === 20000 && d2.summary.profit === 30000,
      `P1 成本=${d1.summary && d1.summary.cost_amount}，P2 毛利=${d2.summary && d2.summary.profit}`);

    /* ================= 归档 / 恢复 ================= */
    const arch2 = await api('POST', `/api/projects/${P2.data.id}/archive`);
    const listAfterArch = await api('GET', `/api/projects?customer_id=${A}&pageSize=10&status=all`);
    const sum2 = (await api('GET', `/api/customers/${A}/projects`)).data;
    const fin2 = (await api('GET', `/api/customers/${A}/finance`)).data;
    check('21. 归档一个项目：列表 active 2 / archived 1',
      arch2.status === 200 && arch2.data.archived === true
        && listAfterArch.data.stats.active_count === 2
        && listAfterArch.data.stats.archived_count === 1,
      `active=${listAfterArch.data.stats.active_count}, archived=${listAfterArch.data.stats.archived_count}`);

    check('22. 归档后客户汇总/财务只算剩下 2 个进行中项目',
      sum2.totals.active_count === 2 && sum2.totals.archived_count === 1
        && sum2.totals.contract_amount === 400000
        && sum2.totals.received_amount === 90000
        && sum2.totals.cost_amount === 40000
        && sum2.totals.profit === 50000
        && fin2.contract_amount === 400000 && fin2.received_amount === 90000
        && fin2.profit === 50000,
      JSON.stringify(sum2.totals));

    const oldApi = (await api('GET', `/api/customers/${A}/project`)).data;
    check('23. 旧接口兼容：project 返回最近创建的进行中项目，history 含归档项目',
      !!oldApi.project && oldApi.project.id !== P2.data.id
        && oldApi.project.archived === 0
        && Array.isArray(oldApi.history) && oldApi.history.length === 1
        && oldApi.history[0].id === P2.data.id
        && Array.isArray(oldApi.projects) && oldApi.projects.length === 2,
      `project=${oldApi.project && oldApi.project.id}，history=${oldApi.history.length}`);

    const hist = (await api('GET', `/api/customers/${A}/history-projects`)).data;
    check('24. 历史项目列表保留归档项目（archived=1 + 已回款/成本）',
      hist.length === 1 && hist[0].id === P2.data.id && hist[0].archived === 1
        && hist[0].received_amount === 50000 && hist[0].cost_amount === 20000,
      JSON.stringify(hist[0] && { id: hist[0].id, archived: hist[0].archived, received: hist[0].received_amount }));

    const payArch = await api('POST', '/api/payments', {
      project_id: P2.data.id, type: '实收', amount: 1, actual_date: '2026-10-23'
    });
    const costArch = await api('POST', '/api/costs', {
      project_id: P2.data.id, category: '差旅', amount: 1, spent_at: '2026-10-23'
    });
    const editArch = await api('PUT', `/api/projects/${P2.data.id}`, { name: '改历史' });
    check('25. 归档项目只读：回款 / 成本 / 编辑都拒绝（ARCHIVED_READONLY）',
      payArch.status === 400 && payArch.code === 'ARCHIVED_READONLY'
        && costArch.status === 400 && costArch.code === 'ARCHIVED_READONLY'
        && editArch.status === 400 && editArch.code === 'ARCHIVED_READONLY',
      `${payArch.code} / ${costArch.code} / ${editArch.code}`);

    const unarch2 = await api('POST', `/api/projects/${P2.data.id}/unarchive`);
    const sum3 = (await api('GET', `/api/customers/${A}/projects`)).data;
    check('26. 恢复归档后重新计入进行中合计',
      unarch2.status === 200 && unarch2.data.archived === false
        && sum3.totals.active_count === 3 && sum3.totals.archived_count === 0
        && sum3.totals.contract_amount === 600000
        && sum3.totals.received_amount === 140000,
      JSON.stringify(sum3.totals));

    /* 恢复归档时项目名冲突：先归档 P3，把 P1 改成 P3 的名字，再恢复 P3 */
    await api('POST', `/api/projects/${P3.data.id}/archive`);
    const renP1 = await api('PUT', `/api/projects/${P1.data.id}`, { name: d3.name });
    const conflict = await api('POST', `/api/projects/${P3.data.id}/unarchive`);
    check('27. 恢复归档时与进行中项目重名会被拒绝（NAME_DUPLICATE）',
      renP1.status === 200 && conflict.status === 400 && conflict.code === 'NAME_DUPLICATE',
      `HTTP ${conflict.status} code=${conflict.code}`);
    /* 改回原名并成功恢复 */
    await api('PUT', `/api/projects/${P1.data.id}`, { name: `【127】项目一${tag}` });
    const unarch3 = await api('POST', `/api/projects/${P3.data.id}/unarchive`);
    check('28. 改名后可正常恢复归档', unarch3.status === 200 && unarch3.data.archived === false,
      `HTTP ${unarch3.status}`);

    /* ================= 待办关联项目 ================= */
    const task1 = await api('POST', '/api/tasks', {
      title: `【127】跟进项目一${tag}`, customer_id: A, project_id: P1.data.id,
      due_at: '2026-11-05 10:00:00', priority: '高'
    });
    const taskList = await api('GET', `/api/tasks?view=all&customer_id=${A}`);
    check('29. 待办可关联项目，列表返回项目名',
      task1.status === 200 && task1.data.created === true
        && (taskList.data.list || []).some((t) => t.id === task1.data.id && t.project_id === P1.data.id
          && t.project_name === `【127】项目一${tag}`),
      `task id=${task1.data.id}`);

    const task2 = await api('POST', '/api/tasks', {
      title: `【127】只给项目自动带客户${tag}`, project_id: P1.data.id
    });
    const task2row = (await api('GET', `/api/tasks?view=all&project_id=${P1.data.id}`)).data.list
      .find((t) => t.id === task2.data.id);
    check('30. 只给项目时自动带出客户',
      task2.status === 200 && task2row && task2row.customer_id === A,
      `customer_id=${task2row && task2row.customer_id}`);

    const taskBad = await api('POST', '/api/tasks', {
      title: `【127】跨客户项目${tag}`, customer_id: B, project_id: P1.data.id
    });
    check('31. 待办同时给客户和项目时，项目必须属于该客户（拒绝）',
      taskBad.status === 400 && taskBad.code === 'PROJECT_CUSTOMER_MISMATCH',
      `HTTP ${taskBad.status} code=${taskBad.code}`);

    const taskNoProj = await api('POST', '/api/tasks', {
      title: `【127】不关联项目${tag}`, customer_id: A
    });
    const taskNoProjRow = (await api('GET', `/api/tasks?view=all&customer_id=${A}`)).data.list
      .find((t) => t.id === taskNoProj.data.id);
    check('32. 待办的 project_id 可空（只关联客户）',
      taskNoProj.status === 200 && taskNoProjRow && !taskNoProjRow.project_id,
      `project_id=${JSON.stringify(taskNoProjRow && taskNoProjRow.project_id)}`);

    const taskGhost = await api('POST', '/api/tasks', {
      title: `【127】不存在的项目${tag}`, customer_id: A, project_id: 99999999
    });
    check('33. 待办关联不存在的项目被拒绝（PROJECT_NOT_FOUND）',
      taskGhost.status === 400 && taskGhost.code === 'PROJECT_NOT_FOUND',
      `HTTP ${taskGhost.status} code=${taskGhost.code}`);

    /* ================= 删除一个项目 ================= */
    const del3 = await api('DELETE', `/api/projects/${P3.data.id}`);
    const sum4 = (await api('GET', `/api/customers/${A}/projects`)).data;
    const p1AfterDel = (await api('GET', `/api/projects/${P1.data.id}`)).data;
    const p3Gone = await api('GET', `/api/projects/${P3.data.id}`);
    const p3Costs = await api('GET', `/api/costs?project_id=${P3.data.id}&pageSize=50`);
    check('34. 删除一个项目：只少它自己，另外两个项目照旧',
      del3.status === 200 && del3.data.count === 1
        && p3Gone.status === 404
        && sum4.totals.active_count === 2
        && p1AfterDel.received_amount === 30000 && p1AfterDel.cost_amount === 10000,
      `active=${sum4.totals.active_count}，P1 已回款=${p1AfterDel.received_amount}`);

    check('35. 删除项目后客户汇总 = 剩余项目之和（合同 300000 / 回款 80000 / 成本 30000）',
      sum4.totals.contract_amount === 300000
        && sum4.totals.received_amount === 80000
        && sum4.totals.cost_amount === 30000
        && sum4.totals.profit === 50000,
      JSON.stringify(sum4.totals));

    check('36. 删除项目的成本一并软删除（成本列表查不到），其它项目成本仍在',
      p3Costs.status === 200 && p3Costs.data.total === 0
        && (await api('GET', `/api/costs?project_id=${P1.data.id}&pageSize=50`)).data.total === 1,
      `被删项目成本 ${p3Costs.data.total} 条`);

    check('37. 删除项目的回款不再计入任何汇总',
      sum4.totals.received_amount === 80000,
      `汇总已回款=${sum4.totals.received_amount}`);

    const fin4 = (await api('GET', `/api/customers/${A}/finance`)).data;
    check('38. 财务接口随项目删除同步（与汇总一致）',
      fin4.contract_amount === sum4.totals.contract_amount
        && fin4.received_amount === sum4.totals.received_amount
        && fin4.profit === sum4.totals.profit,
      `合同额=${fin4.contract_amount} 已回款=${fin4.received_amount} 毛利=${fin4.profit}`);

    check('39. 被删项目在回收站可见（项目软删除）',
      (await api('GET', '/api/trash?type=project')).data.some((x) => x.id === P3.data.id),
      `trash 含项目 ${P3.data.id}`);

    /* ================= 客户删除级联 ================= */
    const otherBefore = (await api('GET', `/api/projects/${BP.data.id}`)).data;
    const delCust = await api('DELETE', `/api/customers/${A}`);
    const dbProjects = db.prepare(
      'SELECT COUNT(*) AS n FROM projects WHERE customer_id = ? AND deleted_at IS NULL'
    ).get(A).n;
    const dbCosts = db.prepare(
      'SELECT COUNT(*) AS n FROM costs WHERE customer_id = ? AND deleted_at IS NULL'
    ).get(A).n;
    const otherAfter = (await api('GET', `/api/projects/${BP.data.id}`)).data;
    check('40. 删除客户级联软删该客户所有剩余项目与成本',
      delCust.status === 200 && delCust.data.project_count === 2
        && delCust.data.cost_count === 2
        && dbProjects === 0 && dbCosts === 0
        && (await api('GET', `/api/projects?customer_id=${A}&pageSize=10&status=all`)).data.total === 0,
      `级联项目 ${delCust.data.project_count} / 成本 ${delCust.data.cost_count}`);

    check('41. 删除客户不影响其它客户的项目与回款',
      otherAfter.id === otherBefore.id
        && otherAfter.customer_id === B
        && otherAfter.received_amount === otherBefore.received_amount,
      `B 项目 id=${otherAfter.id}`);

    const restoreCust = await api('POST', '/api/trash/restore', { ids: [A], type: 'customer' });
    const sumRestored = (await api('GET', `/api/customers/${A}/projects`)).data;
    const p1Restored = (await api('GET', `/api/projects/${P1.data.id}`)).data;
    check('42. 还原客户时项目与成本整体恢复，回款随之回来',
      restoreCust.status === 200 && restoreCust.data.project_count === 2
        && sumRestored.totals.active_count === 2
        && sumRestored.totals.received_amount === 80000
        && sumRestored.totals.cost_amount === 30000
        && p1Restored.received_amount === 30000 && p1Restored.cost_amount === 10000,
      `还原项目 ${restoreCust.data.project_count} 个，汇总已回款 ${sumRestored.totals.received_amount}`);

    check('43. 已被单独删除的项目不随客户还原（回收站语义）',
      (await api('GET', `/api/projects/${P3.data.id}`)).status === 404
        && sumRestored.archived.length === 0,
      `P3=${(await api('GET', `/api/projects/${P3.data.id}`)).status}`);

    /* ================= v16 索引 / 旧库升级 ================= */
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
    ).get();
    check('44. 当前库（v16）sqlite_master 里已查不到 uq_projects_customer_current',
      !idx, `index=${JSON.stringify(idx)}`);

    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    check('45. 数据库结构版本为 16', version === 16, `schema_version=${version}`);

    /* 用临时库模拟 v15：当前结构 + 手工重建旧唯一索引 + schema_version=15 */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi127-'));
    let v15db = null;
    try {
      const dbMod = require(path.join(ROOT, 'server', 'db.js'));
      const dataDir = path.join(tmp, 'data');
      const dbFile = path.join(dataDir, 'crm.db');
      const backupDir = path.join(dataDir, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const boot = dbMod.initDatabase({ dataDir, dbFile, backupDir });
      dbMod.closeDatabase(boot.db);

      const raw = new DatabaseSync(dbFile);
      raw.exec(`CREATE UNIQUE INDEX uq_projects_customer_current
                ON projects(customer_id) WHERE deleted_at IS NULL AND archived = 0`);
      const ts = '2026-10-29T10:00:00';
      const cid = Number(raw.prepare(`INSERT INTO customers (name, customer_no, created_at, updated_at)
        VALUES ('v15 升级客户', 'KH-2026-9101', ?, ?)`).run(ts, ts).lastInsertRowid);
      const pid = Number(raw.prepare(`INSERT INTO projects
        (name, customer_id, stage, progress, contract_amount, archived, created_at, updated_at)
        VALUES ('v15 升级项目', ?, '投标/议价', 50, 123456, 0, ?, ?)`).run(cid, ts, ts).lastInsertRowid);
      raw.prepare(`INSERT INTO payments (project_id, customer_id, type, amount, actual_date, created_at, updated_at)
        VALUES (?, ?, '实收', 65432, '2026-10-01', ?, ?)`).run(pid, cid, ts, ts);
      raw.prepare('DELETE FROM schema_version WHERE version >= 15').run();
      raw.prepare(`INSERT OR REPLACE INTO schema_version (version, applied_at, note)
        VALUES (15, '2026-10-01T00:00:00', 'v15 fixture')`).run();
      raw.close();

      const mig = dbMod.initDatabase({ dataDir, dbFile, backupDir });
      v15db = mig.db;
      const idxAfterUpgrade = v15db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
      ).get();
      const projRow = v15db.prepare('SELECT name, contract_amount FROM projects WHERE id = ?').get(pid);
      const payRow = v15db.prepare('SELECT amount FROM payments WHERE project_id = ?').get(pid);
      const projCount = v15db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
      check('46. 旧 v15 库自动升级到 v16：执行 1 步、唯一索引删除、数据完整',
        mig.fromVersion === 15 && mig.schemaVersion === 16 && mig.migrations.length === 1
          && !idxAfterUpgrade
          && projCount === 1
          && projRow && projRow.name === 'v15 升级项目'
          && Number(projRow.contract_amount) === 123456
          && payRow && Number(payRow.amount) === 65432,
        `v${mig.fromVersion} → v${mig.schemaVersion}，索引=${!!idxAfterUpgrade}，项目 ${projCount}`);

      /* 升级后可建第二个进行中项目（旧索引已不在） */
      let secondOk = false;
      try {
        v15db.prepare(`INSERT INTO projects (name, customer_id, stage, progress, archived, created_at, updated_at)
          VALUES ('v16 第二个进行中项目', ?, '技术交流', 10, 0, ?, ?)`).run(cid, ts, ts);
        secondOk = true;
      } catch (_) { secondOk = false; }
      check('47. 升级后同一客户可以插入第二个进行中项目',
        secondOk, `第二个项目插入=${secondOk}`);
      dbMod.closeDatabase(v15db);
      v15db = null;

      const again = dbMod.initDatabase({ dataDir, dbFile, backupDir });
      check('48. v16 迁移可重入：重复启动 0 步迁移、索引仍不存在、数据仍完整',
        again.fromVersion === 16 && again.migrations.length === 0
          && !again.db.prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
          ).get()
          && again.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n === 2,
        `v${again.fromVersion}，${again.migrations.length} 步，项目 ${again.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n}`);
      dbMod.closeDatabase(again.db);
    } catch (e) {
      check('旧 v15 库自动升级到 v16（专项）', false, e.message);
    } finally {
      if (v15db) { try { require(path.join(ROOT, 'server', 'db.js')).closeDatabase(v15db); } catch (_) { /* 忽略 */ } }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
  } finally {
    await cleanup();
    const left = db.prepare(
      "SELECT COUNT(*) AS n FROM customers WHERE name LIKE ? AND deleted_at IS NULL"
    ).get(`【多项目127${tag}】%`).n;
    check('49. 测试数据已自清理（客户 / 项目 / 回款 / 成本 / 待办）',
      left === 0, `残留 ${left} 条客户`);
    db.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  try {
    fs.writeFileSync(
      path.join(ROOT, '.fixtures', 'projects-multi-127-result.json'),
      JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
      'utf8'
    );
  } catch (_) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e && e.stack ? e.stack : e); process.exit(1); });
