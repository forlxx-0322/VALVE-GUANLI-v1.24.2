/**
 * 阶段二 API 验收测试 —— 客户管理模块（1.23 精简模型）
 *
 * 覆盖：
 *   - 字典接口与内联新增（行业 / 来源）
 *   - 标签：自定义增删 + 5 个固定标签
 *   - 客户 CRUD、字段白名单、查重（名称 / 主联系人手机）
 *   - 客户编号自动生成 KH-YYYY-#### 与唯一校验
 *   - 主联系人内嵌 + 同步 contacts（is_primary=1）、附加联系人
 *   - 跟进记录回填、回访周期自动排下次
 *   - 列表：分页 / 关键词 / 行业·来源·地州筛选 / 快捷筛选 / 标签 / 排序
 *   - 软删除、回收站还原、操作日志
 *   - 财务汇总（合同额 / 已收 / 应收 / 采购 / 维护 / 其他 / 毛利 / 毛利率）
 *   - 注入防护与容错
 *
 * 用法：node tools/test-phase2-api.js
 * 前置：服务已在 127.0.0.1:8899 运行（沙箱模式由运行器指定端口）
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
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

const created = {};
const TEST_DICT_VALUE = '测试自定义行业';

/**
 * 把测试用字典项恢复到「未创建」的干净状态。
 * 注意：删除是软删除，被删的行仍占用 (category,value) 唯一约束，
 * 所以「删除后再新增」会走"复活"路径（existed=true）。
 */
async function resetTestDictItem() {
  for (const val of [TEST_DICT_VALUE, '测试全新行业XYZ', '测试即时生效行业']) {
    const d = await api('GET', '/api/dict');
    const hits = (d.data.items.industry || []).filter((x) => x.value === val);
    for (const h of hits) await api('DELETE', '/api/dict/' + h.id);
    const fresh = await api('POST', '/api/dict', { category: 'industry', value: val });
    if (fresh.data && fresh.data.id) await api('DELETE', '/api/dict/' + fresh.data.id);
  }
  return true;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  console.log('=== 阶段二 API 验收测试（客户管理 · 1.23 精简模型）===');
  console.log('目标服务：' + BASE + '\n');

  /* ---------- 0. 清理上次运行残留（保证可重复运行） ---------- */
  try {
    const ids = [];
    for (const kw of ['测试', '独山子', '天成阀门', '调试客户', '容错测试', '还原验证', '特殊字符']) {
      const r = await api('GET', '/api/customers?pageSize=200&q=' + encodeURIComponent(kw));
      ids.push(...((r.data && r.data.list) || []).map((x) => x.id));
    }
    if (ids.length) {
      await api('POST', '/api/customers/batch-delete', { ids: [...new Set(ids)] });
      console.log(`（清理残留 ${new Set(ids).size} 条测试客户）`);
    }

    const tagsNow = await api('GET', '/api/tags');
    const staleTags = (tagsNow.data || []).filter((t) => t.name === '重点跟进' || t.name === '待开发');
    for (const t of staleTags) await api('DELETE', '/api/tags/' + t.id);
    if (staleTags.length) console.log(`（清理残留 ${staleTags.length} 个测试标签）`);

    await resetTestDictItem();
    if (ids.length || staleTags.length) console.log('');
  } catch (_) { /* 首次运行无残留 */ }

  /* ---------- 1. 字典接口 ---------- */
  const dict = await api('GET', '/api/dict');
  const cats = dict.data ? dict.data.categories : [];
  check(1, '字典接口返回 22 类选项',
    dict.status === 200 && cats.length === 22,
    `返回 ${cats.length} 类，选项文本数组可直接用于下拉框`);
  check(2, '行业与来源字典内容正确（客户只用到这两类客户字典）',
    dict.data && dict.data.options.industry.includes('石油') && dict.data.options.industry.includes('空分')
      && dict.data.options.customer_source.includes('老客户介绍')
      && dict.data.options.project_stage.length === 14,
    `行业 ${dict.data.options.industry.length} 项，来源 ${dict.data.options.customer_source.length} 项，项目阶段 ${dict.data.options.project_stage.length} 阶段`);

  /* ---------- 3. 字典内联新增 / 删除 / 重建 ---------- */
  const qa1 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: TEST_DICT_VALUE });
  const qa2 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: TEST_DICT_VALUE });
  check(3, '字典内联新增：已删除过的同名项会被复活而非重复建',
    qa1.data && qa1.data.existed === true && qa1.data.restored === true
      && qa2.data && qa2.data.existed === true && qa1.data.id === qa2.data.id,
    `首次 restored=${qa1.data && qa1.data.restored} id=${qa1.data && qa1.data.id}，再次 existed=${qa2.data && qa2.data.existed}`);

  {
    const d0 = await api('GET', '/api/dict');
    const ghosts = (d0.data.items.industry || []).filter((x) => x.value === '测试全新行业XYZ');
    for (const gh of ghosts) await api('DELETE', '/api/dict/' + gh.id);
    const f = await api('POST', '/api/dict', { category: 'industry', value: '测试全新行业XYZ' });
    if (f.data && f.data.id) await api('DELETE', '/api/dict/' + f.data.id);
  }
  const brandNew = await api('POST', '/api/dict/quick-add', { category: 'industry', value: '测试全新行业XYZ' });
  const brandNew2 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: '测试全新行业XYZ' });
  check('3a', '同一字典项重复调用只保留一条（id 相同，不会建出重复项）',
    brandNew2.data && brandNew.data && brandNew.data.id === brandNew2.data.id
      && brandNew2.data.existed === true,
    `两次调用返回同一 id=${brandNew.data && brandNew.data.id}`);
  await api('DELETE', '/api/dict/' + brandNew.data.id);

  const delDict = await api('DELETE', '/api/dict/' + qa1.data.id);
  const reAdd = await api('POST', '/api/dict', { category: 'industry', value: TEST_DICT_VALUE });
  const delAgain = reAdd.data && reAdd.data.id ? await api('DELETE', '/api/dict/' + reAdd.data.id) : null;
  check('3b', '自建字典项删除后可用同名重新建立（唯一约束正确让出）',
    delDict.data && delDict.data.deleted === true
      && reAdd.data && reAdd.data.existed === false && reAdd.data.id !== qa1.data.id
      && delAgain && delAgain.data.deleted === true,
    `删除 deleted=${delDict.data && delDict.data.deleted}，同名重建成功 新 id=${reAdd.data && reAdd.data.id}`);

  const sysItem = dict.data.items.industry.find((x) => x.value === '石油');
  const delSys = await api('DELETE', '/api/dict/' + sysItem.id);
  check('3c', '系统内置字典项只停用不删除（防误删核心选项）',
    delSys.data && delSys.data.deleted === false && delSys.data.disabled === true && delSys.data.isSystem === true,
    `返回 deleted=${delSys.data && delSys.data.deleted}, disabled=${delSys.data && delSys.data.disabled}`);
  await api('PUT', '/api/dict/' + sysItem.id, { enabled: 1 });

  const before4 = await api('GET', '/api/dict');
  const beforeCount = before4.data.options.industry.length;
  const fresh4 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: '测试即时生效行业' });
  const after4 = await api('GET', '/api/dict');
  const present4 = after4.data.options.industry.includes('测试即时生效行业');
  check(4, '新增的行业立即出现在字典中（无需重启，下拉框即可读到）',
    !!fresh4.data.id && present4 && after4.data.options.industry.length === beforeCount + 1,
    `行业数 ${beforeCount} → ${after4.data.options.industry.length}，新选项已可读=${present4}`);
  await api('DELETE', '/api/dict/' + fresh4.data.id);

  /* ---------- 5. 标签：自定义 + 5 个固定标签 ---------- */
  const t1 = await api('POST', '/api/tags', { name: '重点跟进', color: '#dc3545' });
  const t2 = await api('POST', '/api/tags', { name: '待开发', color: '#12a150' });
  const t3 = await api('POST', '/api/tags', { name: '重点跟进', color: '#000000' });
  check(5, '新建标签成功且同名标签被拒绝',
    t1.data && t1.data.created === true && t2.data && t3.status === 400,
    `新建 id=${t1.data && t1.data.id}，重名返回 HTTP ${t3.status}`);
  created.tag1 = t1.data.id;
  created.tag2 = t2.data.id;

  const tagsAll = await api('GET', '/api/tags');
  const FIXED = ['重点客户', '老客户', '待回访', '已成交', '暂停合作'];
  const fixedHit = tagsAll.data.filter((t) => FIXED.includes(t.name));
  check('5a', '5 个固定标签已内置且标记为 fixed（界面据此禁用删除）',
    fixedHit.length === 5 && fixedHit.every((t) => t.fixed === true),
    fixedHit.map((t) => t.name + (t.fixed ? '(fixed)' : '')).join('、'));

  /* ---------- 6. 必填校验 ---------- */
  const bad = await api('POST', '/api/customers', { name: '' });
  check(6, '客户名称必填校验生效',
    bad.status === 400 && bad.json.code === 'NAME_REQUIRED',
    `HTTP ${bad.status} code=${bad.json && bad.json.code}`);

  /* ---------- 7. 新建客户（1.23 全字段） ---------- */
  const custA = {
    name: '中国石油天然气股份有限公司独山子石化分公司',
    short_name: '独山子石化',
    industry: '石油',
    source: '设计院推荐',
    email: 'procurement@example.com',
    province: '新疆维吾尔自治区',
    city: '克拉玛依市',
    district: '独山子区',
    address: '独山子区大庆路 1 号',
    contact_name: '王建国',
    contact_position: '采购经理',
    contact_phone: '13909920001',
    contact_birthday: '1975-06-18',
    follow_cycle_days: 30,
    next_follow_at: '2026-11-05 10:00:00',
    remark: '重点客户，年度框架协议于 3 月续签',
    tag_ids: [t1.data.id]
  };
  const a = await api('POST', '/api/customers', custA);
  check(7, '新建客户成功（全部可写字段写入）',
    a.data && a.data.created === true && a.data.id > 0,
    `新增 id=${a.data && a.data.id}，重复提醒 ${a.data && a.data.duplicates.length} 条`);
  created.custA = a.data.id;

  /* ---------- 8. 读回并核对新字段 ---------- */
  const detailA = await api('GET', `/api/customers/${created.custA}`);
  const c = detailA.data;
  const fieldOk = c && c.short_name === '独山子石化' && c.industry === '石油'
    && c.source === '设计院推荐' && c.email === 'procurement@example.com'
    && c.contact_name === '王建国' && c.contact_position === '采购经理'
    && c.contact_phone === '13909920001' && c.contact_birthday === '1975-06-18'
    && c.follow_cycle_days === 30
    && c.city === '克拉玛依市' && c.district === '独山子区';
  check(8, '读回客户并核对新字段（资料/地址/主联系人/回访周期）', fieldOk,
    fieldOk ? `编号=${c.customer_no} 行业=${c.industry} 联系人=${c.contact_name} 周期=${c.follow_cycle_days}天` : '字段值不符');

  check(9, '归属地州按地址自动匹配',
    !!c.region_code && c.region_name === '克拉玛依市',
    `region_code=${c.region_code} region_name=${c.region_name}`);

  /* ---------- 10. 客户编号自动生成 ---------- */
  const year = new Date().getFullYear();
  check(10, '客户编号自动生成 KH-YYYY-#### 格式',
    new RegExp(`^KH-${year}-\\d{4}$`).test(String(c.customer_no || '')),
    `customer_no=${c.customer_no}`);

  /* ---------- 11. 主联系人同步到 contacts ---------- */
  const primaries = c.contacts.filter((x) => x.is_primary === 1);
  check(11, '主联系人自动同步到 contacts（is_primary=1，且只有一条）',
    primaries.length === 1 && primaries[0].name === '王建国'
      && primaries[0].mobile === '13909920001' && primaries[0].position === '采购经理'
      && primaries[0].birthday === '1975-06-18',
    `${primaries.length} 条主联系人：${primaries.map((x) => x.name + '/' + x.mobile).join(',')}`);
  check(12, '标签关联成功',
    c.tags && c.tags.length === 1 && c.tags[0].name === '重点跟进',
    `标签：${(c.tags || []).map((t) => t.name).join('/')}`);

  /* ---------- 13. 查重：同名 / 同主联系人手机 ---------- */
  const dupName = await api('GET', `/api/customers/check-duplicate?name=${encodeURIComponent(custA.name)}`);
  const dupSave = await api('POST', '/api/customers', {
    name: custA.name, industry: '石油', contact_name: '王建国', contact_phone: '13909920001'
  });
  const dupPhone = await api('GET', `/api/customers/check-duplicate?phone=${encodeURIComponent('13909920001')}`);
  check(13, '同名 / 同主联系人手机查重提醒生效',
    dupName.data && dupName.data.length >= 1
      && dupSave.data && dupSave.data.duplicates.length >= 1
      && dupPhone.data && dupPhone.data.length >= 1,
    `名称命中 ${dupName.data && dupName.data.length}，保存时提醒 ${dupSave.data && dupSave.data.duplicates.length}，手机命中 ${dupPhone.data && dupPhone.data.length}`);
  created.dupCust = dupSave.data.id;

  /* ---------- 14. 客户编号唯一校验 ---------- */
  const dupNo = await api('POST', '/api/customers', { name: '编号重复测试客户', customer_no: c.customer_no });
  check(14, '手填客户编号重复时被拒绝',
    dupNo.status === 400 && dupNo.json.code === 'DUPLICATE',
    `HTTP ${dupNo.status} code=${dupNo.json && dupNo.json.code}`);

  const manualNo = `KH-${year}-9001`;
  const manual = await api('POST', '/api/customers', {
    name: '手填编号测试客户', customer_no: manualNo, industry: '电力', source: '展会'
  });
  const manualDetail = manual.data && manual.data.id ? await api('GET', `/api/customers/${manual.data.id}`) : null;
  check(15, '客户编号可手改（唯一即可）',
    manual.status === 200 && manualDetail && manualDetail.data.customer_no === manualNo,
    `customer_no=${manualDetail && manualDetail.data.customer_no}`);
  if (manual.data && manual.data.id) created.manual = manual.data.id;

  /* ---------- 16. 第二家客户自动递增编号 ---------- */
  const b = await api('POST', '/api/customers', {
    name: '新疆天成阀门销售有限公司', short_name: '天成阀门',
    industry: '化工', source: '展会', city: '乌鲁木齐市', province: '新疆维吾尔自治区',
    contact_name: '赵敏', contact_position: '采购员', contact_phone: '13909920002',
    tag_ids: [t2.data.id]
  });
  const bDetail = await api('GET', `/api/customers/${b.data.id}`);
  check(16, '第二家客户编号在同一序列上递增且不重复',
    bDetail.data.customer_no !== c.customer_no
      && new RegExp(`^KH-${year}-\\d{4}$`).test(bDetail.data.customer_no),
    `A=${c.customer_no}，B=${bDetail.data.customer_no}`);
  created.custB = b.data.id;

  /* ---------- 17. 附加联系人 + 联系人编辑 ---------- */
  const ct2 = await api('POST', '/api/contacts', {
    customer_id: created.custA, name: '刘工', position: '技术工程师', department: '设备部',
    mobile: '13909920003', is_decision: 1, influence: '技术把关'
  });
  const afterExtra = await api('GET', `/api/customers/${created.custA}`);
  const extras = afterExtra.data.contacts.filter((x) => !x.is_primary);
  check(17, '附加联系人可新增（不影响主联系人）',
    ct2.data && ct2.data.created === true && extras.length === 1 && extras[0].name === '刘工'
      && afterExtra.data.contact_name === '王建国',
    `附加 ${extras.length} 人，主联系人仍为 ${afterExtra.data.contact_name}`);

  const updContact = await api('PUT', `/api/customers/${created.custA}`, {
    contact_name: '王建军', contact_position: '采购部长', contact_phone: '13909920009'
  });
  const afterContactUpd = await api('GET', `/api/customers/${created.custA}`);
  const primaryAfter = afterContactUpd.data.contacts.filter((x) => x.is_primary === 1);
  check(18, '修改内嵌主联系人后 contacts 表主联系人同步更新',
    updContact.status === 200
      && primaryAfter.length === 1 && primaryAfter[0].name === '王建军'
      && primaryAfter[0].mobile === '13909920009'
      && primaryAfter[0].position === '采购部长',
    `contacts 主联系人：${primaryAfter.map((x) => x.name + '/' + x.mobile).join(',')}`);

  /* ---------- 19. 跟进记录 + 回填 ---------- */
  const f1 = await api('POST', '/api/followups', {
    customer_id: created.custA, followed_at: '2026-02-10 09:30:00', method: '上门拜访',
    content: '拜访采购部王经理，沟通 2026 年度框架协议续签事宜，客户关注交货期与质保期。',
    result: '有意向', next_plan: '准备技术方案与报价单', next_at: '2026-11-05 10:00:00'
  });
  const afterFollow = await api('GET', `/api/customers/${created.custA}`);
  const fa = afterFollow.data;
  check(19, '跟进记录写入成功（含方式/结果/下次计划）',
    f1.data && f1.data.created === true && fa.followups.length === 1,
    `共 ${fa.followups.length} 条`);
  check(20, '跟进后自动回填客户统计（次数/最近跟进）',
    fa.follow_count === 1 && String(fa.last_follow_at).startsWith('2026-02-10'),
    `次数=${fa.follow_count} 最近=${fa.last_follow_at}`);

  /* ---------- 21. 填了 next_at 就用它 ---------- */
  check(21, '跟进填写 next_at 时，下次回访取该时间',
    String(fa.next_follow_at).startsWith('2026-11-05'),
    `next_follow_at=${fa.next_follow_at}`);

  /* ---------- 22. 回访周期自动排下次 ---------- */
  const f2 = await api('POST', '/api/followups', {
    customer_id: created.custA, followed_at: '2026-10-20 14:00:00', method: '电话',
    content: '电话确认技术参数，客户要求阀体材质改为 316L。', result: '已技术交流'
  });
  const afterCycle = await api('GET', `/api/customers/${created.custA}`);
  check(22, '没填 next_at 时，按回访周期自动排下次（跟进日 + 30 天）',
    f2.data && f2.data.next_follow_at
      && String(f2.data.next_follow_at).startsWith('2026-11-19')
      && String(afterCycle.data.next_follow_at).startsWith('2026-11-19'),
    `返回=${f2.data && f2.data.next_follow_at}，客户=${afterCycle.data.next_follow_at}`);

  /* ---------- 23. 跟进内容必填 ---------- */
  const badFollow = await api('POST', '/api/followups', { customer_id: created.custA, content: '' });
  check(23, '跟进内容必填校验生效',
    badFollow.status === 400 && badFollow.json.code === 'CONTENT_REQUIRED',
    `HTTP ${badFollow.status} code=${badFollow.json && badFollow.json.code}`);

  /* ---------- 24. 详情返回结构 ---------- */
  check(24, '客户详情返回新字段 + 主联系人 + 标签 + 项目（1:1）+ 财务汇总结构',
    detailA.data.primary_contact && detailA.data.primary_contact.name === '王建国'
      && Array.isArray(detailA.data.history_projects)
      && Object.prototype.hasOwnProperty.call(detailA.data, 'project')
      && detailA.data.finance && typeof detailA.data.finance.profit === 'number'
      && Array.isArray(detailA.data.followups),
    `主联系人=${detailA.data.primary_contact && detailA.data.primary_contact.name}，项目=${detailA.data.project ? '有' : '空'}，财务字段 ${Object.keys(detailA.data.finance || {}).length} 个`);

  /* ---------- 24. 快捷筛选用的客户 ---------- */
  const mk = async (name, extra) => {
    const r = await api('POST', '/api/customers', Object.assign({ name, industry: '其他', source: '其他' }, extra));
    return r.data && r.data.id;
  };
  const todayId = await mk('快捷筛选客户-今日', { next_follow_at: '2026-10-27 09:00:00' });
  const overdueId = await mk('快捷筛选客户-逾期', { next_follow_at: '2026-01-05 09:00:00' });
  const noFollowId = await mk('快捷筛选客户-从未跟进');
  const staleId = await mk('快捷筛选客户-超30天', { contact_name: '陈工', contact_phone: '13909920005' });
  await api('POST', '/api/followups', { customer_id: staleId, followed_at: '2026-01-01 10:00:00', content: '很久以前的跟进' });
  created.quick = [todayId, overdueId, noFollowId, staleId];

  /* ---------- 25. 列表分页 ---------- */
  const list = await api('GET', '/api/customers?pageSize=50');
  check(25, '客户列表返回分页数据',
    list.data && Array.isArray(list.data.list) && list.data.list.length >= 5 && list.data.pageSize === 50,
    `共 ${list.data.total} 家，本页 ${list.data.list.length} 条，${list.data.pages} 页`);

  /* ---------- 26~28. 关键词搜索 ---------- */
  const s1 = await api('GET', '/api/customers?q=' + encodeURIComponent('独山子'));
  const s2 = await api('GET', '/api/customers?q=' + encodeURIComponent('13909920009'));
  const s3 = await api('GET', '/api/customers?q=' + encodeURIComponent(c.customer_no));
  check(26, '关键词搜索覆盖公司名称 / 主联系人手机 / 客户编号',
    s1.data.total >= 1 && s2.data.total === 1 && s3.data.total === 1,
    `名称命中 ${s1.data.total}，手机命中 ${s2.data.total}，编号命中 ${s3.data.total}`);

  /* ---------- 27. 行业 / 来源 / 地州筛选 ---------- */
  const fIndustry = await api('GET', '/api/customers?industry=' + encodeURIComponent('石油'));
  const fSource = await api('GET', '/api/customers?source=' + encodeURIComponent('展会'));
  const fRegion = await api('GET', '/api/customers?region_code=' + encodeURIComponent(c.region_code));
  check(27, '等值筛选生效（行业 / 来源 / 归属地州）',
    fIndustry.data.total >= 1 && fSource.data.total >= 1 && fRegion.data.total >= 1,
    `石油 ${fIndustry.data.total} 家，展会来源 ${fSource.data.total} 家，克拉玛依 ${fRegion.data.total} 家`);
  check(28, '多条件组合筛选生效',
    (await api('GET', `/api/customers?industry=${encodeURIComponent('石油')}&region_code=${encodeURIComponent(c.region_code)}`))
      .data.total >= 1,
    '石油 + 克拉玛依 → 至少 1 家');

  /* ---------- 29. 快捷筛选（新口径） ---------- */
  const qToday = await api('GET', '/api/customers?quick=today');
  const qOverdue = await api('GET', '/api/customers?quick=overdue');
  const qNoFollow = await api('GET', '/api/customers?quick=no_follow');
  const qMonthNew = await api('GET', '/api/customers?quick=month_new');
  const qStale = await api('GET', '/api/customers?quick=stale30');
  const todayHit = qToday.data.list.some((x) => x.id === todayId);
  const overdueHit = qOverdue.data.list.some((x) => x.id === overdueId);
  const noFollowHit = qNoFollow.data.list.some((x) => x.id === noFollowId);
  const staleHit = qStale.data.list.some((x) => x.id === staleId);
  check(29, '快捷筛选生效（今日待跟进 / 已逾期 / 从未跟进 / 本月新增 / 超30天未跟进）',
    todayHit && overdueHit && noFollowHit && staleHit && qMonthNew.data.total >= 5,
    `今日=${qToday.data.total} 逾期=${qOverdue.data.total} 从未跟进=${qNoFollow.data.total} 本月新增=${qMonthNew.data.total} 超30天=${qStale.data.total}`);

  /* ---------- 30. 标签筛选与统计 ---------- */
  const fTag = await api('GET', `/api/customers?tag_id=${t1.data.id}`);
  const tags2 = await api('GET', '/api/tags');
  const tagWithCount = tags2.data.find((x) => x.id === t1.data.id);
  check(30, '标签筛选与统计生效',
    fTag.data.total === 1 && tagWithCount.customer_count === 1,
    `标签「重点跟进」筛选 ${fTag.data.total} 家，统计 ${tagWithCount.customer_count} 家`);

  /* ---------- 31. 排序 ---------- */
  const sortName = await api('GET', '/api/customers?sort=name&order=asc&pageSize=100');
  const names = sortName.data.list.map((x) => x.name);
  const expected = [...names].sort((x, y) => x.localeCompare(y, 'zh-Hans-CN'));
  check(31, '按名称排序使用中文拼音序（非 UTF-8 字节序）',
    names.length >= 2 && names.every((n, i) => n === expected[i]),
    `前 3 家：${names.slice(0, 3).map((n) => n.slice(0, 8)).join(' / ')}`);

  const sortNo = await api('GET', '/api/customers?sort=customer_no&order=asc&pageSize=100');
  const nos = sortNo.data.list.map((x) => x.customer_no);
  check(32, '按客户编号排序生效',
    nos.length >= 2 && nos.every((n, i) => i === 0 || String(nos[i - 1]) <= String(n)),
    `首尾：${nos[0]} → ${nos[nos.length - 1]}`);

  /* ---------- 33. 局部更新不影响其他字段 ---------- */
  const upd = await api('PUT', `/api/customers/${created.custA}`, { industry: '煤化工', source: '老客户介绍' });
  const afterUpd = await api('GET', `/api/customers/${created.custA}`);
  check(33, '局部更新生效且未影响其他字段',
    upd.status === 200 && upd.data && upd.data.created === false
      && afterUpd.data.industry === '煤化工' && afterUpd.data.source === '老客户介绍'
      && afterUpd.data.short_name === '独山子石化'
      && afterUpd.data.contact_name === '王建军'
      && afterUpd.data.customer_no === c.customer_no,
    `行业→${afterUpd.data.industry}，来源→${afterUpd.data.source}（简称/联系人/编号保持不变）`);

  /* ---------- 34. 操作日志 ---------- */
  const logs = afterUpd.data.logs;
  const hasCreate = logs.some((l) => l.action === 'create');
  const hasUpdate = logs.some((l) => l.action === 'update' && l.summary.includes('修改'));
  const hasFollow = logs.some((l) => l.action === 'followup');
  check(34, '操作日志完整记录（新建/修改/跟进）',
    hasCreate && hasUpdate && hasFollow,
    `共 ${logs.length} 条日志：${logs.map((l) => l.action).join(',')}`);
  const updLog = logs.find((l) => l.action === 'update');
  check(35, '修改日志含字段中文名与变更前后值',
    !!updLog && updLog.summary.includes('→') && updLog.summary.includes('行业'),
    updLog ? updLog.summary.slice(0, 70) : '未找到修改日志');

  /* ---------- 36. 批量打标签 ---------- */
  const bulkTag = await api('POST', '/api/customers/bulk', {
    ids: [created.custA, created.custB], type: 'tag', tag_id: t2.data.id
  });
  const afterBulk = await api('GET', `/api/customers/${created.custB}`);
  check(36, '批量打标签生效',
    bulkTag.data.count === 2 && afterBulk.data.tags.some((x) => x.name === '待开发'),
    `处理 ${bulkTag.data.count} 家，客户B标签：${afterBulk.data.tags.map((x) => x.name).join('/')}`);
  const bulkBad = await api('POST', '/api/customers/bulk', { ids: [created.custA], type: 'status', value: '跟进中' });
  check(37, '旧的批量改状态已下线（请求被拒绝，接口只支持标签）',
    bulkBad.status === 400,
    `HTTP ${bulkBad.status}：${bulkBad.json && bulkBad.json.message}`);

  /* ---------- 38. 删除附加联系人 ---------- */
  const delContact = await api('DELETE', `/api/contacts/${ct2.data.id}`);
  const afterDelContact = await api('GET', `/api/customers/${created.custA}`);
  check(38, '删除附加联系人（软删除）',
    delContact.data.count === 1 && afterDelContact.data.contacts.filter((x) => !x.is_primary).length === 0
      && afterDelContact.data.contact_name === '王建军',
    `剩余联系人 ${afterDelContact.data.contacts.length} 人（主联系人保留）`);

  /* ---------- 39. 删除跟进记录并回填统计 ---------- */
  const delFollow = await api('DELETE', `/api/followups/${f2.data.id}`);
  const afterDelFollow = await api('GET', `/api/customers/${created.custA}`);
  check(39, '删除跟进后跟进次数自动回退',
    delFollow.data.count === 1 && afterDelFollow.data.follow_count === 1,
    `跟进次数 2 → ${afterDelFollow.data.follow_count}`);

  /* ---------- 40. 财务汇总 ---------- */
  const proj = await api('PUT', `/api/customers/${created.custA}/project`, {
    name: '独山子石化 2026 年大修阀门采购项目', stage: '投标/议价', progress: 40,
    contract_amount: 500000, signed_at: '2026-10-01', bid_date: '2026-09-20',
    bid_result: '已中标', delivery_date: '2026-12-31'
  });
  await api('POST', '/api/payments', { customer_id: created.custA, type: '计划', amount: 300000, plan_date: '2026-11-01' });
  await api('POST', '/api/payments', { project_id: proj.data.id, type: '实收', amount: 200000, actual_date: '2026-10-20' });
  await api('POST', '/api/costs', { customer_id: created.custA, category: '采购成本', amount: 130000, spent_at: '2026-10-10' });
  await api('POST', '/api/costs', { customer_id: created.custA, category: '维护成本', amount: 10000, spent_at: '2026-10-11' });
  await api('POST', '/api/costs', { customer_id: created.custA, category: '差旅', amount: 2000, spent_at: '2026-10-12' });
  await api('POST', '/api/costs', { customer_id: created.custA, category: '其他', amount: 1000, spent_at: '2026-10-13' });
  const fin = await api('GET', `/api/customers/${created.custA}/finance`);
  const f = fin.data || {};
  check(40, '财务汇总口径正确（合同额 / 已收 / 应收 / 采购 / 维护 / 其他 / 毛利 / 毛利率）',
    fin.status === 200
      && f.contract_amount === 500000 && f.received_amount === 200000
      && f.receivable_amount === 100000 && f.purchase_cost === 130000
      && f.maintain_cost === 10000 && f.other_cost === 3000
      && f.total_cost === 143000 && f.profit === 57000 && f.margin === 28.5
      && f.expected_profit === 370000,
    `合同额=${f.contract_amount} 已收=${f.received_amount} 应收=${f.receivable_amount} 采购=${f.purchase_cost} 维护=${f.maintain_cost} 其他=${f.other_cost} 毛利=${f.profit} 毛利率=${f.margin}% 预计毛利=${f.expected_profit}`);

  const finNoIncome = await api('GET', `/api/customers/${created.custB}/finance`);
  check(41, '没有收入时毛利率显示为 null（界面显示「—」），不会除零',
    finNoIncome.status === 200 && finNoIncome.data.margin === null
      && finNoIncome.data.received_amount === 0 && finNoIncome.data.profit === 0,
    `margin=${JSON.stringify(finNoIncome.data.margin)}，profit=${finNoIncome.data.profit}`);

  /* ---------- 41a / 41b：一个客户多个项目（1.27） ---------- */
  const secondProject = await api('POST', '/api/projects', {
    name: '阶段二测试：第二个进行中项目', customer_id: created.custA, contract_amount: 88000
  });
  const twoProjects = await api('GET', `/api/projects?customer_id=${created.custA}&pageSize=10&status=all`);
  check('41a', '同一客户允许再建第二个进行中项目（1:N，不再报 PROJECT_EXISTS）',
    secondProject.status === 200 && secondProject.data.created === true
      && secondProject.data.id !== proj.data.id
      && twoProjects.data.stats.active_count === 2,
    `HTTP ${secondProject.status}，进行中 ${twoProjects.data.stats.active_count} 个`);

  const projectOf = await api('GET', `/api/customers/${created.custA}/project`);
  check('41b', '客户项目接口兼容：project=最近进行中项目 + history 数组 + projects 汇总',
    projectOf.status === 200 && projectOf.data.project
      && projectOf.data.project.id === secondProject.data.id
      && Array.isArray(projectOf.data.history)
      && Array.isArray(projectOf.data.projects) && projectOf.data.projects.length === 2
      && projectOf.data.summary.totals.contract_amount === 588000,
    `project=${projectOf.data.project && projectOf.data.project.id}，projects=${projectOf.data.projects.length} 条`);

  const delSecond = await api('DELETE', `/api/projects/${secondProject.data.id}`);
  const afterDelSecond = await api('GET', `/api/customers/${created.custA}/project`);
  check('41c', '删除第二个项目后第一个项目仍在（互不影响）',
    delSecond.data.count === 1 && afterDelSecond.data.project
      && afterDelSecond.data.project.id === proj.data.id
      && afterDelSecond.data.projects.length === 1,
    `剩余项目 id=${afterDelSecond.data.project && afterDelSecond.data.project.id}`);

  /* ---------- 42. 软删除客户 ---------- */
  const del = await api('DELETE', `/api/customers/${created.dupCust}`);
  const afterDelete = await api('GET', `/api/customers/${created.dupCust}`);
  check(42, '删除客户为软删除（列表不可见、详情返回 404）',
    del.data.count === 1 && afterDelete.status === 404,
    `删除 ${del.data.count} 家，详情查询 HTTP ${afterDelete.status}`);

  /* ---------- 43. 回收站与还原 ---------- */
  const rc = await api('POST', '/api/customers', {
    name: '还原验证客户', industry: '电力', contact_name: '还原联系人', contact_phone: '13000000001'
  });
  const restoreCustId = rc.data.id;
  await api('POST', '/api/followups', { customer_id: restoreCustId, method: '邮件', content: '还原验证用跟进记录' });
  const beforeDel = await api('GET', `/api/customers/${restoreCustId}`);
  const delRc = await api('DELETE', `/api/customers/${restoreCustId}`);
  const trash = await api('GET', '/api/trash?type=customer');
  const inTrash = trash.data.some((x) => x.id === restoreCustId);
  const restore = await api('POST', '/api/trash/restore', { ids: [restoreCustId] });
  const afterRestore = await api('GET', `/api/customers/${restoreCustId}`);
  check(43, '回收站可见并可还原（联系人与跟进一并还原）',
    delRc.data.count === 1 && inTrash && restore.data.count === 1 && afterRestore.status === 200
      && beforeDel.data.contacts.length === 1 && afterRestore.data.contacts.length === 1
      && beforeDel.data.followups.length === 1 && afterRestore.data.followups.length === 1
      && afterRestore.data.follow_count === 1
      && afterRestore.data.customer_no === beforeDel.data.customer_no,
    `回收站可见=${inTrash}，还原后 联系人 ${afterRestore.data.contacts.length} / 跟进 ${afterRestore.data.followups.length}`);

  /* ---------- 44. 404 ---------- */
  const nf = await api('GET', '/api/customers/99999999');
  check(44, '查询不存在的客户返回 404',
    nf.status === 404 && nf.json.code === 'NOT_FOUND',
    `HTTP ${nf.status} code=${nf.json && nf.json.code}`);

  /* ---------- 45. 白名单拦截 ---------- */
  const hack = await api('PUT', `/api/customers/${created.custB}`, {
    name: '新疆天成阀门销售有限公司', deleted_at: '2020-01-01T00:00:00',
    follow_count: 9999, created_at: '1999-01-01T00:00:00', customer_no: ''
  });
  const afterHack = await api('GET', `/api/customers/${created.custB}`);
  check(45, '字段白名单拦截越权写入（deleted_at / follow_count / created_at）',
    hack.status === 200 && afterHack.data.deleted_at === null && afterHack.data.follow_count !== 9999
      && !String(afterHack.data.created_at).startsWith('1999')
      && afterHack.data.customer_no === bDetail.data.customer_no,
    `deleted_at=${afterHack.data.deleted_at}, follow_count=${afterHack.data.follow_count}, 编号仍为 ${afterHack.data.customer_no}`);

  /* ---------- 46. SQL 注入防护 ---------- */
  const inj = await api('GET', '/api/customers?q=' + encodeURIComponent("' OR 1=1; DROP TABLE customers;--"));
  const stillAlive = await api('GET', '/api/customers?pageSize=1');
  check(46, 'SQL 注入攻击被参数化查询挡住',
    inj.status === 200 && inj.data.total === 0 && stillAlive.data.total >= 5,
    `注入查询返回 ${inj.data.total} 条，customers 表仍可查（${stillAlive.data.total} 家）`);

  const badSort = await api('GET', '/api/customers?sort=' + encodeURIComponent('id; DROP TABLE customers'));
  const alive2 = await api('GET', '/api/customers?pageSize=1');
  check(47, '排序字段白名单挡住注入',
    badSort.status === 200 && alive2.data.total >= 5,
    `非法排序字段回退默认排序，表仍可查（${alive2.data.total} 家）`);

  /* ---------- 48. 特殊字符与超长文本 ---------- */
  const special = await api('POST', '/api/customers', {
    name: "测试<客户>&\"'公司\u0000换行\n测试", industry: '其他', remark: 'x'.repeat(5000)
  });
  const readSpecial = special.data && special.data.id
    ? await api('GET', `/api/customers/${special.data.id}`) : null;
  check(48, '特殊字符与超长文本正确存储',
    readSpecial && readSpecial.data.name.includes('<客户>') && readSpecial.data.remark.length === 5000,
    `名称含特殊字符=${readSpecial && readSpecial.data.name.includes('<客户>')}, remark 长度=${readSpecial && readSpecial.data.remark.length}`);
  if (special.data && special.data.id) created.special = special.data.id;

  /* ---------- 49. 空值与非数字容错 ---------- */
  const messy = await api('POST', '/api/customers', {
    name: '容错测试客户', industry: '其他',
    follow_cycle_days: 'abc', longitude: null, latitude: ''
  });
  const readMessy = messy.data && messy.data.id ? await api('GET', `/api/customers/${messy.data.id}`) : null;
  const mv = readMessy ? readMessy.data : {};
  check(49, '数字字段传非法值归一为 0，经纬度归一为 NULL（不再 500）',
    !!readMessy && mv.follow_cycle_days === 0
      && (mv.longitude === null || mv.longitude === undefined),
    readMessy
      ? `follow_cycle_days=${JSON.stringify(mv.follow_cycle_days)}, longitude=${JSON.stringify(mv.longitude)}`
      : `写入失败：HTTP ${messy.status} ${messy.json && messy.json.message}`);
  if (messy.data && messy.data.id) created.messy = messy.data.id;

  /* ---------- 50. 列表聚合与标签 ---------- */
  const listA = await api('GET', '/api/customers?q=' + encodeURIComponent('独山子石化'));
  const row = listA.data.list.find((x) => x.id === created.custA);
  check(50, '列表行带联系人/标签/项目数，且不返回旧字段',
    row && row.contact_count === 1 && row.project_count === 1
      && Array.isArray(row.tags) && row.tags.length >= 1
      && row.contact_name === '王建军'
      && row.type === undefined && row.level === undefined && row.status === undefined,
    `联系人 ${row && row.contact_count}，项目 ${row && row.project_count}，标签 ${row && row.tags.length}，旧字段已无`);

  /* ---------- 清理测试数据 ---------- */
  const cleanupIds = [
    created.custA, created.custB, created.dupCust, created.manual, created.special,
    created.messy, rc.data && rc.data.id, ...(created.quick || [])
  ].filter(Boolean);

  /* 先清掉回款 / 成本 / 项目档案，避免污染后续套件的首页与报表统计 */
  for (const cid of cleanupIds) {
    const pl = await api('GET', `/api/projects?customer_id=${cid}&pageSize=200&archived=all`);
    const pids = ((pl.data && pl.data.list) || []).map((p) => p.id);
    for (const pid of pids) {
      const d = await api('GET', `/api/projects/${pid}`);
      const rows = [].concat((d.data && d.data.plans) || [], (d.data && d.data.receipts) || []);
      for (const row of rows) await api('DELETE', `/api/payments/${row.id}`);
    }
    if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
    const cl = await api('GET', `/api/costs?customer_id=${cid}&pageSize=200`);
    for (const row of (cl.data && cl.data.list) || []) await api('DELETE', `/api/costs/${row.id}`);
  }

  await resetTestDictItem();
  await api('DELETE', `/api/tags/${t1.data.id}`);
  await api('DELETE', `/api/tags/${t2.data.id}`);
  await api('POST', '/api/customers/batch-delete', { ids: cleanupIds });
  console.log(`\n（已清理 ${cleanupIds.length} 条测试客户与测试标签/字典项，客户可在回收站还原）`);

  /* ---------- 汇总 ---------- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
