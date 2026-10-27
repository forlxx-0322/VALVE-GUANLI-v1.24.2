/**
 * 阶段二 前端数据契约测试（1.23 精简模型）
 *
 * 目的：页面模板依赖的每个字段，后端必须真的返回。
 * 这类问题在浏览器里表现为「表格空白」「undefined」，很难排查，
 * 所以用脚本按模板实际取用的字段逐项断言。
 *
 * 用法：node tools/test-phase2-ui-contract.js
 */

'use strict';

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

/** 断言对象含有一组键 */
function hasKeys(obj, keys) {
  if (!obj) return { ok: false, missing: keys };
  const missing = keys.filter((k) => !(k in obj));
  return { ok: missing.length === 0, missing };
}

(async () => {
  console.log('=== 阶段二 前端数据契约测试（1.23）===\n');

  /* ---------- 1. 字典结构 ---------- */
  const dict = await api('GET', '/api/dict');
  const d = dict.data || {};
  const needCats = [
    'industry', 'customer_source', 'project_stage',
    'follow_method', 'follow_result', 'payment_method',
    'contact_position', 'contact_influence',
    'valve_type', 'drive_mode', 'body_material', 'pressure_rating', 'size_range',
    'design_standard', 'connection_type', 'cert_required'
  ];
  const missCat = needCats.filter((c) => !Array.isArray(d.options && d.options[c]));
  check('字典 options 覆盖客户表单与项目/跟进用到的下拉分类',
    missCat.length === 0,
    missCat.length ? '缺少：' + missCat.join(', ') : `${needCats.length} 类齐备`);

  const arrOk = needCats.every((c) => (d.options[c] || []).every((v) => typeof v === 'string'));
  check('字典 options 的内容是字符串数组（可直接 v-for 渲染）', arrOk,
    arrOk ? '全部为字符串' : '存在非字符串项');

  const itemKeys = hasKeys((d.items.industry || [])[0], ['id', 'category', 'value', 'color', 'sort', 'is_system']);
  check('字典 items 含 id/color/is_system（设置页与管理功能需要）', itemKeys.ok,
    itemKeys.ok ? '字段完整' : '缺少：' + itemKeys.missing.join(', '));

  /* ---------- 2. 客户列表行字段 ---------- */
  const c = await api('POST', '/api/customers', {
    name: '契约测试客户', short_name: '契约测试', industry: '石油', source: '展会',
    email: 'contract@example.com',
    contact_name: '契约联系人', contact_position: '采购经理', contact_phone: '13900001111',
    contact_birthday: '1982-03-04', follow_cycle_days: 45,
    province: '新疆维吾尔自治区', city: '乌鲁木齐市', district: '天山区',
    address: '天山区某路 8 号', next_follow_at: '2026-03-01 10:00:00',
    remark: '契约测试备注'
  });
  const cid = c.data.id;

  await api('POST', '/api/contacts', {
    customer_id: cid, name: '附加联系人', mobile: '13900002222', is_decision: 1,
    position: '技术工程师', department: '设备部', influence: '技术把关'
  });
  await api('POST', '/api/followups', {
    customer_id: cid, method: '电话', content: '契约测试跟进', result: '有意向',
    next_plan: '报价', next_at: '2026-03-05 10:00:00'
  });
  await api('PUT', `/api/customers/${cid}/project`, {
    name: '契约测试项目', stage: '询价报价', progress: 20, contract_amount: 100000
  });
  await api('POST', '/api/payments', {
    customer_id: cid, type: '计划', amount: 60000, plan_date: '2026-04-01'
  });
  await api('POST', '/api/costs', {
    customer_id: cid, category: '采购成本', amount: 30000, spent_at: '2026-03-10'
  });

  const list = await api('GET', '/api/customers?q=' + encodeURIComponent('契约测试'));
  const row = (list.data.list || [])[0];
  const rowKeys = [
    'id', 'name', 'short_name', 'customer_no', 'industry', 'source', 'contact_name',
    'contact_position', 'contact_phone', 'contact_birthday', 'follow_cycle_days',
    'province', 'city', 'district', 'address', 'region_code', 'region_name',
    'next_follow_at', 'last_follow_at', 'follow_count', 'overdue',
    'tags', 'contact_count', 'project_count'
  ];
  const rk = hasKeys(row, rowKeys);
  check('客户列表行含列表页模板用到的全部字段', rk.ok,
    rk.ok ? `${rowKeys.length} 个字段齐备` : '缺少：' + rk.missing.join(', '));

  check('列表行的标签数组可直接渲染（含 id/name/color）',
    row && Array.isArray(row.tags) && row.tags.every((t) => 'id' in t && 'name' in t && 'color' in t),
    `tags=${JSON.stringify((row && row.tags) || [])}`);

  check('列表行 overdue 布尔标记可用（列表标红依赖它）',
    row && typeof row.overdue === 'boolean',
    `overdue=${row && row.overdue} (${typeof (row && row.overdue)})`);

  /* ---------- 3. 客户详情：4 个标签页依赖的字段 ---------- */
  const detail = await api('GET', `/api/customers/${cid}`);
  const cd = detail.data || {};

  const detailKeys = [
    'id', 'name', 'short_name', 'customer_no', 'industry', 'source', 'email',
    'contact_name', 'contact_position', 'contact_phone', 'contact_birthday',
    'follow_cycle_days', 'province', 'city', 'district', 'address',
    'region_code', 'region_name', 'longitude', 'latitude',
    'next_follow_at', 'last_follow_at', 'follow_count', 'remark',
    'contacts', 'tags', 'followups', 'project', 'history_projects', 'finance',
    'tasks', 'logs', 'summary', 'primary_contact'
  ];
  const dk = hasKeys(cd, detailKeys);
  check('客户详情含 4 个标签页依赖的全部字段', dk.ok,
    dk.ok ? `${detailKeys.length} 个字段齐备` : '缺少：' + dk.missing.join(', '));

  const sumKeys = hasKeys(cd.summary, [
    'contact_count', 'extra_contact_count', 'follow_count', 'task_count', 'history_project_count'
  ]);
  check('summary 汇总对象字段完整（详情页顶部数字依赖）', sumKeys.ok,
    sumKeys.ok ? JSON.stringify(cd.summary) : '缺少：' + sumKeys.missing.join(', '));

  const pcKeys = hasKeys(cd.primary_contact, ['name', 'position', 'phone', 'birthday']);
  check('primary_contact 主联系人对象字段完整', pcKeys.ok,
    pcKeys.ok ? JSON.stringify(cd.primary_contact) : '缺少：' + pcKeys.missing.join(', '));

  const finKeys = hasKeys(cd.finance, [
    'project_id', 'contract_amount', 'planned_amount', 'received_amount', 'receivable_amount',
    'purchase_cost', 'maintain_cost', 'other_cost', 'total_cost', 'profit', 'margin', 'expected_profit'
  ]);
  check('finance 财务汇总字段完整（资料页财务栏依赖）', finKeys.ok,
    finKeys.ok ? JSON.stringify(cd.finance) : '缺少：' + finKeys.missing.join(', '));

  const ct = (cd.contacts || [])[0] || {};
  const ctKeys = hasKeys(ct, [
    'id', 'name', 'position', 'department', 'mobile', 'phone', 'wechat', 'email',
    'is_decision', 'is_primary', 'influence', 'birthday'
  ]);
  check('联系人卡片字段完整', ctKeys.ok,
    ctKeys.ok ? `共 ${cd.contacts.length} 人` : '缺少：' + ctKeys.missing.join(', '));

  const f = (cd.followups || [])[0] || {};
  const fKeys = hasKeys(f, ['id', 'method', 'result', 'content', 'next_plan', 'next_at', 'followed_at', 'project_name']);
  check('跟进时间轴字段完整（含 project_name 关联展示）', fKeys.ok,
    fKeys.ok ? '字段齐备' : '缺少：' + fKeys.missing.join(', '));

  check('跟进记录写入后已回填客户统计',
    cd.follow_count === 1 && !!cd.last_follow_at && String(cd.next_follow_at).startsWith('2026-03-05'),
    `次数=${cd.follow_count} 最近=${cd.last_follow_at} 下次=${cd.next_follow_at}`);

  const log = (cd.logs || [])[0] || {};
  const logKeys = hasKeys(log, ['id', 'action', 'summary', 'created_at']);
  check('变更记录字段完整（详情页时间轴依赖）', logKeys.ok,
    logKeys.ok ? `共 ${cd.logs.length} 条` : '缺少：' + logKeys.missing.join(', '));

  const tagOk = (cd.tags || []).every((t) => 'id' in t && 'name' in t && 'color' in t && 'fixed' in t);
  check('客户标签字段完整（含 fixed 标记，界面据此禁用删除）', tagOk,
    `${(cd.tags || []).length} 个标签`);

  /* ---------- 4. 表单可写字段：编辑抽屉提交后必须完整回读 ---------- */
  const FORM_FIELDS = [
    'name', 'short_name', 'customer_no', 'industry', 'source', 'email',
    'contact_name', 'contact_position', 'contact_phone', 'contact_birthday',
    'follow_cycle_days', 'province', 'city', 'district', 'address', 'region_code',
    'longitude', 'latitude', 'next_follow_at', 'remark'
  ];
  const fk = hasKeys(cd, FORM_FIELDS);
  check(`详情返回表单全部 ${FORM_FIELDS.length} 个可写字段（编辑抽屉回填依赖）`, fk.ok,
    fk.ok ? `${FORM_FIELDS.length} 个字段齐备` : '缺少：' + fk.missing.join(', '));

  const REMOVED = ['type', 'level', 'status', 'owner', 'phone', 'supplier_code',
    'deal_amount', 'annual_demand', 'design_institute', 'reg_capital'];
  check('1.23 删掉的旧字段不再出现在接口返回中',
    REMOVED.every((k) => !(k in cd)),
    `仍存在：${REMOVED.filter((k) => k in cd).join('、') || '无'}`);

  /* ---------- 5. 项目档案接口（1:1） ---------- */
  const proj = await api('GET', `/api/customers/${cid}/project`);
  const projKeys = hasKeys(proj.data, ['project', 'history', 'finance']);
  const pj = proj.data.project || {};
  const pjKeys = hasKeys(pj, [
    'id', 'name', 'stage', 'progress', 'contract_amount', 'signed_at', 'bid_date',
    'bid_result', 'delivery_date', 'archived', 'plans', 'receipts', 'summary'
  ]);
  check('GET /api/customers/:id/project 返回当前档案 + 历史 + 财务',
    proj.status === 200 && projKeys.ok && pjKeys.ok && pj.name === '契约测试项目'
      && Array.isArray(pj.plans) && Array.isArray(pj.receipts),
    `project=${pj.name || '空'}，plans=${(pj.plans || []).length}，history=${proj.data.history.length}`);

  const hist = await api('GET', `/api/customers/${cid}/history-projects`);
  check('GET /api/customers/:id/history-projects 返回数组（历史项目只读）',
    hist.status === 200 && Array.isArray(hist.data),
    `${hist.data.length} 条历史项目`);

  const finApi = await api('GET', `/api/customers/${cid}/finance`);
  check('GET /api/customers/:id/finance 与详情里的财务汇总一致',
    finApi.status === 200 && finApi.data.received_amount === 0
      && finApi.data.planned_amount === 60000 && finApi.data.receivable_amount === 60000
      && finApi.data.purchase_cost === 30000 && finApi.data.profit === -30000,
    `应收=${finApi.data.receivable_amount}，采购=${finApi.data.purchase_cost}，毛利=${finApi.data.profit}`);

  /* ---------- 6. 标签接口 ---------- */
  const tags = await api('GET', '/api/tags');
  const t0 = (tags.data || [])[0] || {};
  const tk = hasKeys(t0, ['id', 'name', 'color', 'sort', 'customer_count', 'fixed']);
  check('标签接口字段完整（含 customer_count / fixed）', tags.data.length === 0 || tk.ok,
    tags.data.length ? `${tags.data.length} 个标签` : '暂无标签');

  /* ---------- 7. 回收站接口 ---------- */
  await api('DELETE', `/api/customers/${cid}`);
  const trash = await api('GET', '/api/trash?type=customer');
  const tr = (trash.data || []).find((x) => x.id === cid) || {};
  const trk = hasKeys(tr, ['id', 'title', 'sub', 'deleted_at']);
  check('回收站条目字段完整（title/sub/deleted_at）', trk.ok,
    trk.ok ? `title=${tr.title}，sub=${tr.sub}` : '缺少：' + trk.missing.join(', '));
  await api('POST', '/api/trash/restore', { ids: [cid] });

  /* ---------- 8. 错误响应结构 ---------- */
  const err404 = await api('GET', '/api/customers/99999999');
  check('错误响应含 code 与 message（前端 toast 展示依赖）',
    err404.json && err404.json.ok === false && !!err404.json.code && !!err404.json.message,
    `code=${err404.json && err404.json.code}, message=${err404.json && err404.json.message}`);

  const err400 = await api('POST', '/api/customers', { name: '' });
  check('校验错误可读（展示给用户的中文提示）',
    err400.status === 400 && /必填|名称/.test(err400.json.message),
    `HTTP ${err400.status} message=${err400.json.message}`);

  /* ---------- 清理 ---------- */
  {
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
    await api('POST', '/api/customers/batch-delete', { ids: [cid] });
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
