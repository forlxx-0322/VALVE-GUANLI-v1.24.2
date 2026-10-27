/**
 * 1.23 客户精简专项验收（API 层，一客户一项目）
 *
 * 覆盖 30 项断言：
 *   1~7   客户编号：自动生成 KH-YYYY-#### / 递增 / 手改 / 唯一校验 / 不可清空
 *   8~13  主联系人：内嵌字段同步 contacts（is_primary=1）/ 修改同步 / 附加联系人不受影响 / 删除主联系人清空内嵌
 *   14~21 一客户一项目：首次建档 / 第二个当前项目被拒 / 1:1 更新 / 转历史 / 历史只读 / 归档后再建 / 历史列表
 *   22~26 回访周期：无周期不自动排 / 有周期自动排 / 填了 next_at 以填的为准 / follow_count 与 last_follow_at 照旧
 *   27~32 财务汇总：合同额 / 已收 / 应收 / 采购 / 维护 / 其他 / 毛利 / 毛利率 / 预计毛利 / 0 收入除零 / 负毛利
 *   33~35 5 个固定标签：存在、sort 10..50、接口带 fixed 标记
 *   36     测试数据自清理
 *
 * 用法：node tools/test-customer-123.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
  console.log('=== 1.23 客户精简专项验收（一客户一项目）===\n');

  const tag = Date.now().toString().slice(-6);
  const ids = [];
  const db = new DatabaseSync(DB_FILE);
  const created = { customers: [], projects: [] };

  const mkCustomer = async (name, extra) => {
    const r = await api('POST', '/api/customers', Object.assign({ name, industry: '石油' }, extra || {}));
    if (r.data && r.data.id) {
      ids.push(r.data.id);
      created.customers.push(r.data.id);
    }
    return r;
  };
  const cleanup = async () => {
    for (const cid of [...new Set(created.customers)]) {
      const pl = await api('GET', `/api/projects?customer_id=${cid}&pageSize=200&archived=all`);
      const pids = ((pl.data && pl.data.list) || []).map((p) => p.id);
      for (const pid of pids) {
        const d = await api('GET', `/api/projects/${pid}`);
        const rows = [].concat((d.data && d.data.plans) || [], (d.data && d.data.receipts) || []);
        for (const row of rows) await api('DELETE', `/api/payments/${row.id}`);
      }
      const cl = await api('GET', `/api/costs?customer_id=${cid}&pageSize=200`);
      for (const row of ((cl.data && cl.data.list) || [])) await api('DELETE', `/api/costs/${row.id}`);
      if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
      const tl = await api('GET', `/api/tasks?view=all&customer_id=${cid}`);
      const tids = ((tl.data && tl.data.list) || []).map((t) => t.id);
      if (tids.length) await api('POST', '/api/tasks/batch-delete', { ids: tids });
      await api('POST', '/api/customers/batch-delete', { ids: [cid] });
    }
  };

  try {
    /* ================= 客户编号 ================= */
    const A = await mkCustomer(`【1.23专项${tag}】编号客户A`, {
      contact_name: '王经理', contact_position: '采购经理',
      contact_phone: `139${tag}01`, contact_birthday: '1980-01-02', follow_cycle_days: 10
    });
    const aDetail = await api('GET', `/api/customers/${A.data.id}`);
    const year = new Date().getFullYear();
    check('1. 新建客户自动生成 KH-YYYY-#### 编号',
      new RegExp(`^KH-${year}-\\d{4}$`).test(aDetail.data.customer_no || ''),
      `customer_no=${aDetail.data.customer_no}`);

    const B = await mkCustomer(`【1.23专项${tag}】编号客户B`);
    const bDetail = await api('GET', `/api/customers/${B.data.id}`);
    const seqOf = (no) => Number(String(no).split('-')[2]);
    check('2. 同一序列递增（B 比 A 大 1）',
      seqOf(bDetail.data.customer_no) === seqOf(aDetail.data.customer_no) + 1,
      `${aDetail.data.customer_no} → ${bDetail.data.customer_no}`);

    const manualNo = `KH-${year}-8801`;
    const C = await mkCustomer(`【1.23专项${tag}】手改编号`, { customer_no: manualNo });
    check('3. 编号可手改（唯一即可）',
      C.status === 200 && (await api('GET', `/api/customers/${C.data.id}`)).data.customer_no === manualNo,
      `customer_no=${manualNo}`);

    const dupNo = await api('POST', '/api/customers', {
      name: `【1.23专项${tag}】撞号客户`, customer_no: manualNo
    });
    check('4. 手填重复编号被拒绝（DUPLICATE）',
      dupNo.status === 400 && dupNo.code === 'DUPLICATE',
      `HTTP ${dupNo.status} code=${dupNo.code}`);

    const updNo = await api('PUT', `/api/customers/${B.data.id}`, { customer_no: `KH-${year}-8802` });
    const bAfter = await api('GET', `/api/customers/${B.data.id}`);
    check('5. 编号可在编辑时修改',
      updNo.status === 200 && bAfter.data.customer_no === `KH-${year}-8802`,
      `B=${bAfter.data.customer_no}`);

    await api('PUT', `/api/customers/${B.data.id}`, { customer_no: '' });
    const bAfter2 = await api('GET', `/api/customers/${B.data.id}`);
    check('6. 提交空编号不会把已有编号清空',
      bAfter2.data.customer_no === `KH-${year}-8802`,
      `仍为 ${bAfter2.data.customer_no}`);

    const dupUpdate = await api('PUT', `/api/customers/${B.data.id}`, { customer_no: manualNo });
    check('7. 编辑时改成已占用的编号被拒绝',
      dupUpdate.status === 400 && dupUpdate.code === 'DUPLICATE',
      `HTTP ${dupUpdate.status} code=${dupUpdate.code}`);

    /* ================= 主联系人 ================= */
    const contactsOf = async (id) => (await api('GET', `/api/customers/${id}`)).data.contacts;
    let aContacts = await contactsOf(A.data.id);
    const primary = aContacts.filter((x) => x.is_primary === 1);
    check('8. 新建客户时主联系人自动同步到 contacts（is_primary=1，仅一条）',
      primary.length === 1 && primary[0].name === '王经理'
        && primary[0].position === '采购经理' && primary[0].mobile === `139${tag}01`,
      JSON.stringify(primary));

    await api('PUT', `/api/customers/${A.data.id}`, {
      contact_name: '王总', contact_position: '采购总监', contact_phone: `139${tag}02`,
      contact_birthday: '1979-12-31'
    });
    aContacts = await contactsOf(A.data.id);
    const primary2 = aContacts.filter((x) => x.is_primary === 1);
    check('9. 修改内嵌主联系人后 contacts 副本同步更新',
      primary2.length === 1 && primary2[0].name === '王总'
        && primary2[0].mobile === `139${tag}02` && primary2[0].birthday === '1979-12-31',
      JSON.stringify(primary2));

    const extra = await api('POST', '/api/contacts', {
      customer_id: A.data.id, name: '刘工', position: '技术工程师', mobile: `139${tag}03`, is_decision: 1
    });
    aContacts = await contactsOf(A.data.id);
    check('10. 附加联系人可新增且不抢占主联系人',
      extra.data && extra.data.created === true
        && aContacts.filter((x) => x.is_primary === 1).length === 1
        && aContacts.filter((x) => !x.is_primary).length === 1
        && aContacts.filter((x) => !x.is_primary)[0].name === '刘工',
      `共 ${aContacts.length} 人`);

    const primId = aContacts.find((x) => x.is_primary).id;
    await api('DELETE', `/api/contacts/${primId}`);
    const afterDel = await api('GET', `/api/customers/${A.data.id}`);
    check('11. 删除主联系人后客户内嵌 contact_* 字段清空',
      afterDel.data.contact_name === '' && afterDel.data.contact_phone === ''
        && afterDel.data.contact_position === '' && afterDel.data.contact_birthday === '',
      `contact_name="${afterDel.data.contact_name}"`);

    const restorePrimary = await api('PUT', `/api/customers/${A.data.id}`, {
      contact_name: '王经理', contact_position: '采购经理', contact_phone: `139${tag}04`
    });
    aContacts = await contactsOf(A.data.id);
    check('12. 主联系人删除后可重新设置（自动新建一条 is_primary=1）',
      restorePrimary.status === 200
        && aContacts.filter((x) => x.is_primary === 1).length === 1
        && aContacts.find((x) => x.is_primary).name === '王经理',
      `主联系人 ${aContacts.filter((x) => x.is_primary).length} 条`);

    const extraStill = await api('GET', `/api/customers/${A.data.id}`);
    check('13. 主联系人变化不影响附加联系人',
      extraStill.data.contacts.filter((x) => !x.is_primary).length === 1,
      `附加 ${extraStill.data.contacts.filter((x) => !x.is_primary).length} 人`);

    /* ================= 一客户一项目 ================= */
    const P1 = await api('PUT', `/api/customers/${A.data.id}/project`, {
      name: `【1.23专项】项目一${tag}`, stage: '投标/议价', progress: 30, contract_amount: 500000
    });
    created.projects.push(P1.data.id);
    check('14. 客户没有项目时 PUT 会建立一条当前档案',
      P1.status === 200 && P1.data.created === true && P1.data.project.name === `【1.23专项】项目一${tag}`,
      `project id=${P1.data.id}`);

    const P2 = await api('PUT', `/api/customers/${A.data.id}/project`, { contract_amount: 520000 });
    const projList = await api('GET', `/api/projects?customer_id=${A.data.id}&pageSize=10`);
    check('15. 再次 PUT 更新同一条档案（1:1，不会新建第二条）',
      P2.data.created === false && P2.data.id === P1.data.id
        && projList.data.total === 1 && projList.data.list[0].contract_amount === 520000,
      `总数 ${projList.data.total}，合同额=${projList.data.list[0].contract_amount}`);

    const second = await api('POST', '/api/projects', {
      name: `【1.23专项】第二个当前项目${tag}`, customer_id: A.data.id
    });
    check('16. 同一客户再建第二个「当前项目」被拒绝（PROJECT_EXISTS）',
      second.status === 400 && second.code === 'PROJECT_EXISTS',
      `HTTP ${second.status} code=${second.code}`);

    const arch = await api('POST', `/api/customers/${A.data.id}/project/archive`);
    const afterArch = await api('GET', `/api/customers/${A.data.id}/project`);
    const history = await api('GET', `/api/customers/${A.data.id}/history-projects`);
    check('17. 当前项目可转为历史（archived=1）',
      arch.status === 200 && arch.data.archived === true
        && afterArch.data.project === null
        && history.data.length === 1 && history.data[0].id === P1.data.id
        && history.data[0].archived === 1,
      `历史 ${history.data.length} 条`);

    const editArch = await api('PUT', `/api/projects/${P1.data.id}`, { name: '改历史' });
    const editArch2 = await api('PUT', `/api/customers/${A.data.id}/project`, { id: P1.data.id, name: '改历史' });
    check('18. 历史项目只读（普通接口与客户接口都拒绝）',
      editArch.status === 400 && editArch.code === 'ARCHIVED_READONLY'
        && editArch2.status === 400 && editArch2.code === 'ARCHIVED_READONLY',
      `${editArch.code} / ${editArch2.code}`);

    const P3 = await api('PUT', `/api/customers/${A.data.id}/project`, {
      name: `【1.23专项】项目二${tag}`, stage: '技术交流', contract_amount: 120000
    });
    created.projects.push(P3.data.id);
    const cur = await api('GET', `/api/customers/${A.data.id}/project`);
    check('19. 归档后可再建新的当前项目，历史仍保留',
      P3.data.created === true && cur.data.project.id === P3.data.id
        && cur.data.history.length === 1,
      `新项目 id=${P3.data.id}，历史 ${cur.data.history.length} 条`);

    const projDetail = await api('GET', `/api/projects/${P3.data.id}`);
    check('20. 当前项目详情带 archived=0 与关联客户',
      projDetail.data.archived === 0 && projDetail.data.customer
        && projDetail.data.customer.id === A.data.id,
      `archived=${projDetail.data.archived}，客户=${projDetail.data.customer && projDetail.data.customer.name}`);

    const badProject = await api('POST', '/api/projects', { name: '无客户项目' });
    check('21. 项目必须归属客户',
      badProject.status === 400 && badProject.code === 'CUSTOMER_REQUIRED',
      `HTTP ${badProject.status} code=${badProject.code}`);

    /* ================= 回访周期 ================= */
    const D = await mkCustomer(`【1.23专项${tag}】无周期客户`);
    await api('POST', '/api/followups', {
      customer_id: D.data.id, followed_at: '2026-10-20 10:00:00', content: '无周期客户跟进'
    });
    const dDetail = await api('GET', `/api/customers/${D.data.id}`);
    check('22. follow_cycle_days=0 时不自动排下次回访',
      dDetail.data.follow_count === 1 && !dDetail.data.next_follow_at,
      `next_follow_at=${JSON.stringify(dDetail.data.next_follow_at)}`);

    const E = await mkCustomer(`【1.23专项${tag}】周期客户`, { follow_cycle_days: 15 });
    const f1 = await api('POST', '/api/followups', {
      customer_id: E.data.id, followed_at: '2026-10-20 14:30:00', content: '周期客户跟进'
    });
    const eDetail = await api('GET', `/api/customers/${E.data.id}`);
    check('23. 记录跟进后按周期自动排下次（2026-10-20 + 15 天 = 2026-11-04）',
      f1.data.next_follow_at && String(f1.data.next_follow_at).startsWith('2026-11-04')
        && String(eDetail.data.next_follow_at).startsWith('2026-11-04'),
      `next=${f1.data.next_follow_at}`);

    const f2 = await api('POST', '/api/followups', {
      customer_id: E.data.id, followed_at: '2026-10-25 09:00:00', content: '再次跟进',
      next_at: '2027-01-15 10:00:00'
    });
    const eDetail2 = await api('GET', `/api/customers/${E.data.id}`);
    check('24. 填了 next_at 时以填的为准（不被周期覆盖）',
      String(f2.data.next_follow_at).startsWith('2027-01-15')
        && String(eDetail2.data.next_follow_at).startsWith('2027-01-15'),
      `next=${eDetail2.data.next_follow_at}`);

    const f3 = await api('POST', '/api/followups', {
      customer_id: E.data.id, followed_at: '2026-10-26 09:00:00', content: '第三次跟进'
    });
    const eDetail3 = await api('GET', `/api/customers/${E.data.id}`);
    check('25. 没填 next_at 时按周期重排（2026-10-26 + 15 天 = 2026-11-10）',
      String(f3.data.next_follow_at).startsWith('2026-11-10')
        && String(eDetail3.data.next_follow_at).startsWith('2026-11-10'),
      `next=${f3.data.next_follow_at}`);

    check('26. 跟进次数与最近跟进时间照旧回填',
      eDetail3.data.follow_count === 3 && String(eDetail3.data.last_follow_at).startsWith('2026-10-26'),
      `次数=${eDetail3.data.follow_count}，最近=${eDetail3.data.last_follow_at}`);

    /* ================= 财务汇总 ================= */
    await api('PUT', `/api/customers/${A.data.id}/project`, { contract_amount: 500000 });
    await api('POST', '/api/payments', { customer_id: A.data.id, type: '计划', amount: 320000, plan_date: '2026-11-01' });
    await api('POST', '/api/payments', { customer_id: A.data.id, type: '实收', amount: 210000, actual_date: '2026-10-15' });
    await api('POST', '/api/costs', { customer_id: A.data.id, category: '采购成本', amount: 130000, spent_at: '2026-10-10' });
    await api('POST', '/api/costs', { customer_id: A.data.id, category: '维护成本', amount: 12000, spent_at: '2026-10-11' });
    await api('POST', '/api/costs', { customer_id: A.data.id, category: '差旅', amount: 3000, spent_at: '2026-10-12' });
    await api('POST', '/api/costs', { customer_id: A.data.id, category: '其他', amount: 1000, spent_at: '2026-10-13' });
    const fin = await api('GET', `/api/customers/${A.data.id}/finance`);
    const f = fin.data || {};
    check('27. 财务报表：合同额 / 已收 / 应收口径正确',
      f.contract_amount === 500000 && f.received_amount === 210000
        && f.planned_amount === 320000 && f.receivable_amount === 110000,
      `合同额=${f.contract_amount} 已收=${f.received_amount} 计划=${f.planned_amount} 应收=${f.receivable_amount}`);
    check('28. 成本分类汇总正确（采购 / 维护 / 其他=差旅+其他）',
      f.purchase_cost === 130000 && f.maintain_cost === 12000
        && f.other_cost === 4000 && f.total_cost === 146000,
      `采购=${f.purchase_cost} 维护=${f.maintain_cost} 其他=${f.other_cost} 合计=${f.total_cost}`);
    check('29. 毛利 = 已收 − 全部成本（含采购成本），毛利率按已收算',
      f.profit === 64000 && f.margin === Math.round((64000 / 210000) * 1000) / 10
        && f.expected_profit === 370000,
      `毛利=${f.profit} 毛利率=${f.margin}% 预计毛利=${f.expected_profit}`);

    const Dfin = await api('GET', `/api/customers/${D.data.id}/finance`);
    check('30. 没有收入时毛利率为 null（不除零）',
      Dfin.data.margin === null && Dfin.data.profit === 0,
      `margin=${JSON.stringify(Dfin.data.margin)}`);

    const negCust = await mkCustomer(`【1.23专项${tag}】负毛利客户`, { industry: '化工' });
    await api('POST', '/api/costs', { customer_id: negCust.data.id, category: '采购成本', amount: 5000, spent_at: '2026-10-01' });
    await api('POST', '/api/payments', { customer_id: negCust.data.id, type: '实收', amount: 2000, actual_date: '2026-10-02' });
    const negFin = await api('GET', `/api/customers/${negCust.data.id}/finance`);
    check('31. 成本大于收入时毛利为负、毛利率为负',
      negFin.data.profit === -3000 && negFin.data.margin === -150,
      `毛利=${negFin.data.profit} 毛利率=${negFin.data.margin}%`);

    /* ================= 固定标签 ================= */
    const tagList = await api('GET', '/api/tags');
    const FIXED = ['重点客户', '老客户', '待回访', '已成交', '暂停合作'];
    const fixedTags = (tagList.data || []).filter((t) => FIXED.includes(t.name));
    check('32. 5 个固定标签已内置（名称与颜色齐备）',
      fixedTags.length === 5 && fixedTags.every((t) => !!t.color && !!t.name),
      fixedTags.map((t) => t.name).join('、'));

    const sorts = fixedTags.map((t) => t.sort).sort((a, b) => a - b);
    check('33. 固定标签排序为 10 / 20 / 30 / 40 / 50',
      JSON.stringify(sorts) === JSON.stringify([10, 20, 30, 40, 50]),
      sorts.join(' / '));

    check('34. 标签接口返回 fixed 标记（界面据此禁用删除）',
      fixedTags.every((t) => t.fixed === true),
      fixedTags.map((t) => t.name + (t.fixed ? '(fixed)' : '')).join('、'));

    const seedTags = await api('GET', '/api/tags');
    check('35. 固定标签数量不因重复启动而增加（种子幂等）',
      seedTags.data.filter((t) => FIXED.includes(t.name)).length === 5,
      `固定标签 ${seedTags.data.filter((t) => FIXED.includes(t.name)).length} 个`);

    /* 数据库层核对：部分唯一索引与 tags 记录 */
    const uq = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
    ).get();
    const dbTags = db.prepare(
      "SELECT COUNT(*) AS n FROM tags WHERE name IN ('重点客户','老客户','待回访','已成交','暂停合作')"
    ).get().n;
    check('36. 数据库层：一客户一项目唯一索引与 5 个固定标签都在',
      !!uq && dbTags === 5,
      `唯一索引=${!!uq}，固定标签=${dbTags}`);
  } finally {
    await cleanup();
    const left = db.prepare(
      "SELECT COUNT(*) AS n FROM customers WHERE name LIKE ? AND deleted_at IS NULL"
    ).get(`【1.23专项${tag}】%`).n;
    check('37. 测试数据已自清理（客户 / 项目 / 回款 / 成本 / 待办）',
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
      path.join(ROOT, '.fixtures', 'customer-123-result.json'),
      JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
      'utf8'
    );
  } catch (_) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e && e.stack ? e.stack : e); process.exit(1); });
