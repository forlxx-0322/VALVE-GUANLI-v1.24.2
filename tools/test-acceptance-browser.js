/**
 * 阶段七 · 最终验收测试（浏览器部分，1.23 一客户一项目）
 *
 * 在真实浏览器（Chrome，另可选 Edge）里做端到端验收：
 *   10 首页 v2（6 指标卡 / 回访提醒 / 收入报表按月按年 / 两张环形图）
 *   8  客户精简模型（4 区块表单、主联系人、编号、标签、回访周期）
 *   9  筛选与排序（行业 / 来源 / 地州 / 关键词 / 快捷筛选）
 *   11 客户详情里的项目档案（建立 / 回款 / 成本 / 财务栏 / 转为历史）
 *   12 软删除与还原（关联数据完整恢复）
 *   13 操作日志
 *   14 表单校验（名称必填 / 金额 / 日期 / 超收）
 *   15 查重（同名 / 同主联系人手机）
 *   23 空状态
 *   29 产品价目表（1.24：分类树 + 产品表格 + 抽屉折后价，无 JS 报错）
 *   24 浏览器兼容（Chrome + Edge，导航 5 项）
 *   25 自定义行业与内联新增
 *   26 数据零外流（无外部请求）
 *
 * 用法：node tools/test-acceptance-browser.js
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(no, name, pass, detail) {
  results.push({ no: String(no), name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, json, data: json && json.data };
}

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; this.requests = []; }
  async connect() {
    this.ws = new globalThis.WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push((d.exception && d.exception.description) || d.text || '未知异常');
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      } else if (m.method === 'Network.requestWillBeSent') {
        this.requests.push(m.params.request.url);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 30000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

async function launchBrowser(exe, port, profile) {
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1100', 'about:blank'
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch (_) { /* 继续等 */ }
  }
  if (!version) { try { child.kill(); } catch (_) { /* 忽略 */ } return null; }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  return { child, cdp, version };
}

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

const created = { customers: [], projects: [], tags: [], dict: [] };

(async () => {
  console.log('=== 阶段七 最终验收测试（浏览器 · 1.23） ===\n');

  const health = await api('GET', '/api/health');
  if (health.status !== 200) {
    console.log('服务未运行，无法开始验收。');
    process.exit(1);
  }
  if (!CHROME) { console.log('未找到 Chrome，无法执行浏览器验收。'); process.exit(1); }

  const ts = Date.now().toString().slice(-6);
  const CUSTOMER_NAME = `最终验收客户${ts}`;

  /* ---------- 准备数据 ---------- */
  const tagsAll = await api('GET', '/api/tags');
  const fixedTag = (tagsAll.data || []).find((t) => t.name === '重点客户');
  const cust = await api('POST', '/api/customers', {
    name: CUSTOMER_NAME, short_name: `验收${ts}`,
    industry: '石油', source: '展会',
    contact_name: '验收联系人', contact_position: '采购经理', contact_phone: `139${ts}`,
    contact_birthday: '1985-05-20', follow_cycle_days: 30,
    province: '新疆维吾尔自治区', city: '克拉玛依市', district: '独山子区',
    address: '独山子区验收路 1 号', next_follow_at: dayOffset(-1) + ' 10:00:00',
    remark: '最终验收用客户',
    tag_ids: fixedTag ? [fixedTag.id] : []
  });
  if (!cust.data || !cust.data.id) { console.log('准备测试客户失败'); process.exit(1); }
  const customerId = cust.data.id;
  created.customers.push(customerId);

  const proj = await api('PUT', `/api/customers/${customerId}/project`, {
    name: `最终验收项目${ts}`, stage: '已中标/已签约', progress: 50,
    contract_amount: 660000, signed_at: dayOffset(-10),
    bid_date: dayOffset(-20), bid_result: '已中标', delivery_date: dayOffset(30)
  });
  const projectId = proj.data.id;
  created.projects.push(projectId);
  const plan = await api('POST', '/api/payments', {
    project_id: projectId, type: '计划', amount: 400000, plan_date: dayOffset(-5)
  });
  await api('POST', '/api/payments', {
    project_id: projectId, type: '实收', amount: 260000, actual_date: dayOffset(-2), plan_id: plan.data.id
  });
  await api('POST', '/api/costs', {
    customer_id: customerId, category: '采购成本', amount: 120000, spent_at: dayOffset(-3), supplier: '验收供应商'
  });

  /* 一个空客户，用于空状态验收 */
  const emptyCust = await api('POST', '/api/customers', { name: `最终验收-空客户${ts}`, industry: '其他' });
  const emptyId = emptyCust.data.id;
  created.customers.push(emptyId);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-br-'));
  const br = await launchBrowser(CHROME, 9240, profile);
  if (!br) { console.log('浏览器未就绪'); process.exit(1); }
  const cdp = br.cdp;
  console.log(`浏览器：${br.version.Browser}\n`);

  async function goto(hash, wait) {
    await cdp.js(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 3200);
  }

  /* ================================================================ */
  /* 8. 客户精简模型（列表 / 表单 / 详情）                              */
  /* ================================================================ */
  console.log('--- 验收 8：客户精简模型 ---');
  await goto('#/customers', 3600);
  const listUi = await cdp.js(`(() => {
    const headers = [...document.querySelectorAll('.data-table thead th')]
      .map(t => t.textContent.replace(/[↕↑↓]/g, '').trim());
    const nav = [...new Set([...document.querySelectorAll('.nav-item')].map(x => x.textContent.trim()))];
    const chips = [...document.querySelectorAll('.quick-chips .chip')].map(x => x.textContent.trim());
    return { headers, nav, chips, hasTable: !!document.querySelector('.data-table'), hasPager: !!document.querySelector('.pager') };
  })()`);
  check('8a', '客户列表列头为新口径（编号/公司名称/行业/联系人（职务）/来源/下次回访/标签）',
    listUi.hasTable && listUi.hasPager
      && ['编号', '公司名称', '行业', '联系人（职务）', '来源', '下次回访', '标签']
        .every((h) => listUi.headers.some((x) => x.includes(h))),
    `列头：${listUi.headers.join(' | ')}`);
  check('8b', '左侧导航 5 项（含产品价目表）且没有「项目管理」',
    listUi.nav.length === 5 && listUi.nav.includes('客户管理')
      && listUi.nav.includes('产品价目表')
      && !listUi.nav.some((n) => n.includes('项目管理')),
    `导航：${listUi.nav.join(' / ')}`);
  check('8c', '快捷筛选为 1.23 口径（今日待跟进/已逾期/从未跟进/本月新增）',
    ['今日待跟进', '已逾期', '从未跟进', '本月新增'].every((l) => listUi.chips.some((x) => x.includes(l))),
    `快捷：${listUi.chips.join(' / ')}`);

  const drawer = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
    if (!btn) return { err: '未找到新增客户按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = [...document.querySelectorAll('.drawer')].pop();
    if (!d) return { err: '抽屉未打开' };
    return {
      blocks: [...d.querySelectorAll('.form-block')].length,
      fields: [...d.querySelectorAll('.field-label')].map(x => x.textContent.trim()),
      required: d.querySelectorAll('.req').length,
      hasTagPicker: [...d.querySelectorAll('.field-label')].some(x => x.textContent.includes('标签')),
      hasInlineAdd: !!d.querySelector('button[title="新增选项"]')
    };
  })()`);
  check('8d', '新增客户表单精简为 4 区块 / 17 字段 / 仅 1 项必填',
    !drawer.err && drawer.blocks === 4 && drawer.fields.length >= 16
      && drawer.fields.length <= 20 && drawer.required === 1,
    drawer.err || `区块 ${drawer.blocks}，字段 ${drawer.fields.length}，必填 ${drawer.required}`);
  check('8e', '表单含标签选择器与字典内联新增入口',
    !drawer.err && drawer.hasTagPicker && drawer.hasInlineAdd,
    drawer.err || `标签=${drawer.hasTagPicker}，内联新增=${drawer.hasInlineAdd}`);

  /* 内联新增行业 */
  const inline = await cdp.js(`(async () => {
    const d = [...document.querySelectorAll('.drawer')].pop();
    const f = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim() === '行业';
    });
    if (!f) return { err: '未找到行业字段' };
    const add = f.querySelector('button[title="新增选项"]');
    if (!add) return { err: '无内联新增按钮' };
    add.click();
    await new Promise(r => setTimeout(r, 400));
    const inp = f.querySelector('input');
    inp.value = '验收内联行业${ts}';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const save = [...f.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 1400));
    const opts = [...(f.querySelector('select') || {}).options || []].map(o => o.value);
    return {
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      hasOption: opts.includes('验收内联行业${ts}')
    };
  })()`);
  created.dict.push(`验收内联行业${ts}`);
  check('8f', '表单内可直接新增行业选项并立即选中',
    !inline.err && inline.hasOption,
    inline.err || `提示：${(inline.toasts || []).join(' / ')}`);

  /* 关闭抽屉，用界面创建客户 */
  const uiCreate = await cdp.js(`(async () => {
    const d = [...document.querySelectorAll('.drawer')].pop();
    const x = [...d.querySelectorAll('.drawer-head button')].pop();
    x.click();
    await new Promise(r => setTimeout(r, 700));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const dd = [...document.querySelectorAll('.drawer')].pop();
    const field = (label) => [...dd.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith(label);
    });
    const setText = (label, v) => {
      const f = field(label);
      if (!f) return false;
      const i = f.querySelector('input, textarea');
      if (!i) return false;
      i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const setSelect = (label, v) => {
      const f = field(label);
      if (!f) return false;
      const s = f.querySelector('select');
      if (!s) return false;
      s.value = v; s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const filled = {
      name: setText('公司名称', ${JSON.stringify(`最终验收-界面新建${ts}`)}),
      industry: setSelect('行业', '石油'),
      contact: setText('姓名', '界面联系人'),
      phone: setText('手机', '13800008888'),
      cycle: setText('定期提醒天数', '15')
    };
    await new Promise(r => setTimeout(r, 250));
    const save = [...dd.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 1800));
    return {
      filled,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      closed: !document.querySelector('.drawer')
    };
  })()`);
  check('8g', '通过界面创建客户成功（含行业/主联系人/回访周期）',
    !uiCreate.err && Object.values(uiCreate.filled).every(Boolean)
      && uiCreate.toasts.some((t) => t.includes('客户已创建')) && uiCreate.closed,
    uiCreate.err || `填写=${JSON.stringify(uiCreate.filled)}，提示=${(uiCreate.toasts || []).join(' / ')}`);

  const uiCust = await api('GET', '/api/customers?q=' + encodeURIComponent(`最终验收-界面新建${ts}`));
  const uiRow = (uiCust.data.list || [])[0];
  if (uiRow) created.customers.push(uiRow.id);
  check('8h', '界面新建的客户已落库（客户编号自动生成、主联系人同步）',
    !!uiRow && /^KH-\d{4}-\d{4}$/.test(uiRow.customer_no || '')
      && uiRow.contact_name === '界面联系人' && uiRow.follow_cycle_days === 15,
    uiRow ? `id=${uiRow.id} 编号=${uiRow.customer_no}` : '未找到新建客户');

  /* 详情页 4 个标签页 + 财务栏 */
  await goto('#/customers/' + customerId, 3600);
  const detail = await cdp.js(`(() => {
    const tabs = [...document.querySelectorAll('.tabs .tab')].map(t => t.textContent.trim());
    const stats = [...document.querySelectorAll('.stat')].map(s => ({
      n: ((s.querySelector('.n') || {}).textContent || '').trim(),
      l: ((s.querySelector('.l') || {}).textContent || '').trim()
    }));
    const kv = {};
    document.querySelectorAll('.kv .k').forEach(k => {
      const v = k.nextElementSibling;
      if (v) kv[k.textContent.trim()] = v.textContent.trim().slice(0, 60);
    });
    return {
      tabs, stats, kv,
      hasExtra: document.body.innerText.includes('附加联系人'),
      tagCount: document.querySelectorAll('.detail-meta .tag').length
    };
  })()`);
  const statOf = (kw) => (detail.stats.find((s) => s.l.includes(kw)) || {}).n || '';
  check('8i', '客户详情为 4 个标签页（资料/回访与跟进/项目与财务/附件与日志）',
    detail.tabs.length === 4
      && detail.tabs.some((t) => t.includes('资料'))
      && detail.tabs.some((t) => t.includes('回访与跟进'))
      && detail.tabs.some((t) => t.includes('项目与财务'))
      && detail.tabs.some((t) => t.includes('附件与日志')),
    detail.tabs.join(' / '));
  check('8j', '资料页财务汇总栏显示合同额/已收/应收/采购成本/毛利/毛利率',
    String(statOf('合同额')).includes('660,000')
      && String(statOf('已收')).includes('260,000')
      && String(statOf('应收')).includes('140,000')
      && String(statOf('采购成本')).includes('120,000')
      && String(statOf('毛利')).includes('140,000'),
    detail.stats.map((s) => s.l + '=' + s.n).join(' / '));
  check('8k', '资料页显示编号/主联系人/附加联系人折叠区',
    detail.kv['客户编号'] && detail.kv['姓名'] === '验收联系人'
      && detail.kv['手机'] === '139' + ts && detail.hasExtra,
    `编号=${detail.kv['客户编号']}，联系人=${detail.kv['姓名']}，附加联系人区=${detail.hasExtra}`);

  /* ================================================================ */
  /* 9. 筛选与排序（API + 浏览器）                                      */
  /* ================================================================ */
  console.log('\n--- 验收 9：筛选与排序 ---');
  const q = encodeURIComponent(`最终验收客户${ts}`);
  const filterApi = await Promise.all([
    api('GET', `/api/customers?q=${q}`),
    api('GET', '/api/customers?industry=' + encodeURIComponent('石油')),
    api('GET', '/api/customers?source=' + encodeURIComponent('展会')),
    api('GET', `/api/customers?region_code=${(await api('GET', `/api/customers/${customerId}`)).data.region_code}`),
    api('GET', `/api/customers?tag_id=${fixedTag.id}`),
    api('GET', '/api/customers?quick=today'),
    api('GET', '/api/customers?quick=overdue'),
    api('GET', '/api/customers?sort=name&order=asc&pageSize=50')
  ]);
  const [fq, fInd, fSrc, fRegion, fTag, fToday, fOverdue, fSort] = filterApi;
  check('9a', '关键词 / 行业 / 来源 / 地州 / 标签筛选都能命中',
    fq.data.total >= 1 && fInd.data.total >= 1 && fSrc.data.total >= 1
      && fRegion.data.total >= 1 && fTag.data.total >= 1,
    `关键词 ${fq.data.total}，石油 ${fInd.data.total}，展会 ${fSrc.data.total}，地州 ${fRegion.data.total}，标签 ${fTag.data.total}`);
  check('9b', '快捷筛选（今日待跟进 / 已逾期）返回客户',
    fToday.data.list.some((x) => x.id === customerId) && fOverdue.data.list.some((x) => x.id === customerId),
    `今日 ${fToday.data.total}，逾期 ${fOverdue.data.total}`);
  const namesAsc = fSort.data.list.map((x) => x.name);
  const expectedAsc = [...namesAsc].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  check('9c', '按名称排序使用中文拼音序',
    namesAsc.length >= 1 && namesAsc.every((n, i) => n === expectedAsc[i]),
    `前 3：${namesAsc.slice(0, 3).map((n) => n.slice(0, 8)).join(' / ')}`);

  await goto('#/customers', 3400);
  const filterUi = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('高级筛选'));
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 500));
    const selects = [...document.querySelectorAll('.filter-bar select')].map(s => s.options[0].textContent.trim());
    return { selects };
  })()`);
  check('9d', '高级筛选只保留 行业 / 来源 / 归属地州 / 标签',
    filterUi.selects.some((x) => x.includes('行业（全部）'))
      && filterUi.selects.some((x) => x.includes('客户来源（全部）'))
      && filterUi.selects.some((x) => x.includes('归属地州（全部）'))
      && filterUi.selects.some((x) => x.includes('标签（全部）'))
      && !filterUi.selects.some((x) => x.includes('客户等级') || x.includes('主体类型')),
    filterUi.selects.join(' | '));

  /* ================================================================ */
  /* 11. 客户详情里的项目档案（1:1）                                    */
  /* ================================================================ */
  console.log('\n--- 验收 11：客户详情项目档案 + 财务 ---');
  await goto('#/customers/' + customerId, 3400);
  const projectPane = await cdp.js(`(async () => {
    const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('项目与财务'));
    t.click();
    await new Promise(r => setTimeout(r, 600));
    const kv = {};
    document.querySelectorAll('.kv .k').forEach(k => {
      const v = k.nextElementSibling;
      if (v) kv[k.textContent.trim()] = v.textContent.trim().slice(0, 80);
    });
    const titles = [...document.querySelectorAll('.card-title')].map(x => x.textContent.trim());
    return {
      kv, titles,
      planRows: [...document.querySelectorAll('.data-table tbody tr')].length,
      hasEdit: [...document.querySelectorAll('button')].some(b => b.textContent.includes('编辑档案')),
      hasArchive: [...document.querySelectorAll('button')].some(b => b.textContent.includes('转为历史'))
    };
  })()`);
  check('11a', '项目档案完整显示名称/阶段/合同额/投标结果/交货期',
    projectPane.kv['项目名称'] === `最终验收项目${ts}`
      && projectPane.kv['项目阶段'] === '已中标/已签约'
      && String(projectPane.kv['合同额']).includes('660,000')
      && projectPane.kv['投标结果'] === '已中标'
      && !!projectPane.kv['交货期'],
    JSON.stringify(projectPane.kv).slice(0, 200));
  check('11b', '回款计划 / 实收 / 成本台账都在项目与财务页',
    projectPane.titles.some((t) => t.includes('回款计划'))
      && projectPane.titles.some((t) => t.includes('实收流水'))
      && projectPane.titles.some((t) => t.includes('成本台账'))
      && projectPane.planRows >= 2,
    `卡片：${projectPane.titles.join(' / ')}；表格行 ${projectPane.planRows}`);

  /* 通过界面登记实收，验证页面与接口同步 */
  const receiptUi = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('登记实收'));
    if (!btn) return { err: '未找到登记实收按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { err: '回款抽屉未打开' };
    const amt = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('金额');
    });
    if (!amt) return { err: '未找到金额字段' };
    const i = amt.querySelector('input');
    i.value = '50000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 2200));
    return {
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      closed: !document.querySelector('.drawer')
    };
  })()`);
  const finAfter = await api('GET', `/api/customers/${customerId}/finance`);
  check('11c', '界面登记实收后财务汇总自动重算（已收 310,000 / 应收 90,000）',
    !receiptUi.err && finAfter.data.received_amount === 310000
      && finAfter.data.receivable_amount === 90000
      && finAfter.data.profit === 190000,
    receiptUi.err || `已收=${finAfter.data.received_amount}，应收=${finAfter.data.receivable_amount}，毛利=${finAfter.data.profit}`);

  /* 转为历史 → 新建当前项目 */
  const archUi = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('转为历史'));
    if (!btn) return { err: '未找到转为历史按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    const modal = document.querySelector('.modal');
    if (!modal) return { err: '确认框未出现' };
    const ok = [...modal.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('转为历史'));
    ok.click();
    await new Promise(r => setTimeout(r, 2200));
    return {
      isEmpty: document.body.innerText.includes('还没有项目档案'),
      hasHistory: document.body.innerText.includes('历史项目（1）'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  const hist = await api('GET', `/api/customers/${customerId}/history-projects`);
  check('11d', '当前项目可「转为历史」，历史项目 archived=1 只读',
    !archUi.err && archUi.isEmpty && archUi.hasHistory
      && hist.data.length === 1 && hist.data[0].archived === 1,
    archUi.err || `历史 ${hist.data.length} 条，空档案=${archUi.isEmpty}`);

  const rebuilt = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('建立项目档案'));
    if (!btn) return { err: '未找到建立项目档案按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector('.drawer');
    const nameF = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('项目名称');
    });
    const i = nameF.querySelector('input');
    i.value = '验收归档后的新项目${ts}';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 2000));
    return { toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) };
  })()`);
  const current = await api('GET', `/api/customers/${customerId}/project`);
  if (current.data.project) created.projects.push(current.data.project.id);
  check('11e', '归档后可再建新的当前项目（一客户一项目）',
    !rebuilt.err && current.data.project
      && current.data.project.name === `验收归档后的新项目${ts}`
      && current.data.history.length === 1,
    rebuilt.err || `新当前项目=${current.data.project && current.data.project.name}`);

  /* 回访周期：界面记录跟进后自动排下次 */
  const followUi = await cdp.js(`(async () => {
    const tab = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes('回访与跟进'));
    tab.click();
    await new Promise(r => setTimeout(r, 500));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('记录跟进'));
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector('.drawer');
    const content = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('跟进内容');
    });
    const ta = content.querySelector('textarea, input');
    ta.value = '验收：电话沟通，客户确认技术参数。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存跟进'));
    save.click();
    await new Promise(r => setTimeout(r, 2200));
    return { toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) };
  })()`);
  const afterFollow = await api('GET', `/api/customers/${customerId}`);
  const expectNext = new Date();
  expectNext.setDate(expectNext.getDate() + 30);
  const expectStr = `${expectNext.getFullYear()}-${String(expectNext.getMonth() + 1).padStart(2, '0')}-${String(expectNext.getDate()).padStart(2, '0')}`;
  check('11f', '记录跟进后按回访周期（30 天）自动排下次回访',
    !followUi.err && afterFollow.data.follow_count === 1
      && String(afterFollow.data.next_follow_at).startsWith(expectStr),
    followUi.err || `follow_count=${afterFollow.data.follow_count}，next=${afterFollow.data.next_follow_at}（预期 ${expectStr}）`);

  /* ================================================================ */
  /* 10. 首页 v2                                                       */
  /* ================================================================ */
  console.log('\n--- 验收 10：首页 v2 ---');
  await goto('#/home', 4600);
  const homeUi = await cdp.js(`(() => {
    const stats = [...document.querySelectorAll('.stat')].map((s) => ({
      n: ((s.querySelector('.n') || {}).textContent || '').trim(),
      l: ((s.querySelector('.l') || {}).textContent || '').trim()
    }));
    const text = document.querySelector('.content').innerText;
    return {
      stats,
      hasFollowCard: text.includes('回访提醒'),
      hasIncomeCard: text.includes('收入报表'),
      hasRegionRing: text.includes('客户分布 · 地区'),
      hasIndustryRing: text.includes('客户分布 · 行业'),
      canvases: document.querySelectorAll('canvas').length
    };
  })()`);
  check('10a', '首页 6 张指标卡齐全（客户总数 / 待回访 / 收入 / 利润 / 成本 / 应收）',
    homeUi.stats.length >= 6
      && homeUi.stats.some((s) => s.l.includes('客户总数'))
      && homeUi.stats.some((s) => s.l.includes('待回访'))
      && homeUi.stats.some((s) => s.l.includes('利润'))
      && homeUi.stats.some((s) => s.l.includes('应收未收')),
    homeUi.stats.map((s) => s.l).join(' / '));
  check('10b', '回访提醒 + 收入报表 + 两张分布环形图都在首页',
    homeUi.hasFollowCard && homeUi.hasIncomeCard && homeUi.hasRegionRing
      && homeUi.hasIndustryRing && homeUi.canvases >= 3,
    `提醒=${homeUi.hasFollowCard}，报表=${homeUi.hasIncomeCard}，环图 canvas=${homeUi.canvases}`);
  const dash = await api('GET', `/api/dashboard/v2?month=${new Date().toLocaleDateString('sv-SE').slice(0, 7)}`);
  const cardNum = (label) => (homeUi.stats.find((s) => s.l.includes(label)) || {}).n || '';
  check('10c', '指标卡数字与接口一致，利润口径 = 收入 − 全部成本',
    String(dash.data.cards.customer_total) === String(cardNum('客户总数'))
      && dash.data.cards.month_profit === Math.round((dash.data.cards.month_income - dash.data.cards.month_cost) * 100) / 100,
    `客户总数 页面「${cardNum('客户总数')}」/ 接口「${dash.data.cards.customer_total}」；利润 ${dash.data.cards.month_profit}`);
  const yearUi = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '按年');
    if (!btn) return { err: '没找到「按年」按钮' };
    btn.click();
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (/\\d{4} 年/.test(document.querySelector('.content').innerText)) return { ok: true };
    }
    return { ok: false };
  })()`);
  check('10d', '收入报表可在「按月 / 按年」之间切换',
    !yearUi.err && yearUi.ok === true, yearUi.err || '切到按年后出现年份行');

  /* ================================================================ */
  /* 12. 软删除与还原                                                   */
  /* ================================================================ */
  console.log('\n--- 验收 12：软删除与还原 ---');
  const rc = await api('POST', '/api/customers', {
    name: `最终验收-还原验证客户${ts}`, industry: '石油',
    contact_name: '还原联系人', contact_phone: '13700000001',
    city: '乌鲁木齐市', district: '天山区'
  });
  const rcId = rc.data.id;
  created.customers.push(rcId);
  await api('POST', '/api/followups', { customer_id: rcId, method: '电话', content: '还原验证用跟进记录' });
  await api('PUT', `/api/customers/${rcId}/project`, {
    name: `最终验收-还原验证项目${ts}`, stage: '信息收集', contract_amount: 10000
  });
  const rcProjects = await api('GET', `/api/projects?customer_id=${rcId}&pageSize=10`);
  if (rcProjects.data.list[0]) created.projects.push(rcProjects.data.list[0].id);
  const beforeDel = await api('GET', `/api/customers/${rcId}`);

  await goto('#/customers', 3400);
  const delUi = await cdp.js(`(async () => {
    const inp = document.querySelector('.search-box input');
    inp.value = '还原验证客户${ts}';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '搜索');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 1800));
    const rows = [...document.querySelectorAll('.data-table tbody tr')];
    if (!rows.length) return { err: '搜索结果为空' };
    const delBtn = [...rows[0].querySelectorAll('button')].find(b => b.textContent.includes('删除'));
    if (!delBtn) return { err: '未找到删除按钮' };
    delBtn.click();
    await new Promise(r => setTimeout(r, 800));
    const modal = document.querySelector('.modal');
    if (!modal) return { err: '未出现确认弹窗' };
    const modalText = modal.innerText;
    const confirmBtn = [...modal.querySelectorAll('button')].find(b => b.textContent.includes('删除'));
    confirmBtn.click();
    await new Promise(r => setTimeout(r, 1800));
    return {
      modalText,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      remaining: document.querySelectorAll('.data-table tbody tr').length
    };
  })()`);
  const afterDel = await api('GET', `/api/customers/${rcId}`);
  check('12a', '界面删除客户走确认弹窗（提示回收站），删除后详情 404',
    !delUi.err && delUi.modalText.includes('回收站') && afterDel.status === 404,
    delUi.err || `弹窗含回收站=${delUi.modalText.includes('回收站')}，HTTP ${afterDel.status}`);

  await goto('#/settings', 3200);
  const restoreUi = await cdp.js(`(async () => {
    const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('回收站'));
    if (!t) return { err: '未找到回收站标签页' };
    t.click();
    await new Promise(r => setTimeout(r, 1800));
    const rows = [...document.querySelectorAll('.content .data-table tbody tr')];
    const target = rows.find(r => r.innerText.includes('还原验证客户${ts}'));
    if (!target) return { err: '回收站里没有该记录', rowCount: rows.length };
    const btn = [...target.querySelectorAll('button')].find(b => b.textContent.includes('还原'));
    btn.click();
    await new Promise(r => setTimeout(r, 2000));
    return { toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) };
  })()`);
  const afterRestore = await api('GET', `/api/customers/${rcId}`);
  check('12b', '回收站可见已删除客户并可在界面还原',
    !restoreUi.err && afterRestore.status === 200,
    restoreUi.err || `还原后 HTTP ${afterRestore.status}，提示：${(restoreUi.toasts || []).join(' / ')}`);
  check('12c', '还原后关联数据完整恢复（联系人 / 跟进 / 项目）',
    beforeDel.data.contacts.length === 1 && afterRestore.data.contacts.length === 1
      && afterRestore.data.followups.length === 1 && afterRestore.data.follow_count === 1
      && afterRestore.data.project && afterRestore.data.project.name === `最终验收-还原验证项目${ts}`,
    `联系人 ${afterRestore.data.contacts.length}，跟进 ${afterRestore.data.followups.length}，项目=${afterRestore.data.project && afterRestore.data.project.name}`);

  /* ================================================================ */
  /* 13. 操作日志                                                       */
  /* ================================================================ */
  console.log('\n--- 验收 13：操作日志 ---');
  await goto('#/settings', 3200);
  const logUi = await cdp.js(`(async () => {
    const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('操作日志'));
    if (!t) return { err: '未找到操作日志标签页' };
    t.click();
    await new Promise(r => setTimeout(r, 2000));
    const rows = [...document.querySelectorAll('.content .data-table tbody tr')];
    return {
      rows: rows.length,
      text: rows.slice(0, 8).map(r => r.innerText.replace(/\\s+/g, ' ').slice(0, 80)),
      hasFilter: !!document.querySelector('.content select')
    };
  })()`);
  const logsApi = await api('GET', '/api/logs?pageSize=20');
  check('13a', '操作日志界面可查看，接口带中文标签',
    !logUi.err && logUi.rows >= 1 && logsApi.data.list.length > 0
      && !!logsApi.data.list[0].entity_label,
    logUi.err || `界面 ${logUi.rows} 行；接口 ${logsApi.data.total} 条`);
  check('13b', '客户新建/跟进都写入日志，项目修改也有日志',
    (await api('GET', `/api/logs?entity_type=customer&entity_id=${customerId}`)).data.list
      .some((l) => l.action === 'followup')
      && (await api('GET', `/api/logs?entity_type=customer&entity_id=${customerId}`)).data.list
        .some((l) => l.action === 'create')
      && (await api('GET', `/api/logs?entity_type=project&entity_id=${projectId}`)).data.list
        .some((l) => l.action === 'update'),
    '客户含 create/followup，项目含 update 日志');

  /* ================================================================ */
  /* 14. 表单校验（API 层 + 浏览器）                                    */
  /* ================================================================ */
  console.log('\n--- 验收 14：表单校验 ---');
  const badName = await api('POST', '/api/customers', { name: '' });
  const badAmount = await api('POST', '/api/payments', { project_id: projectId, type: '实收', amount: -100 });
  const badDate = await api('POST', '/api/payments', { project_id: projectId, type: '计划', amount: 100 });
  check('14a', '接口层校验：客户名称必填 / 金额 > 0 / 计划必须填日期',
    badName.status === 400 && badName.json.code === 'NAME_REQUIRED'
      && badAmount.status === 400 && badAmount.json.code === 'AMOUNT_REQUIRED'
      && badDate.status === 400 && badDate.json.code === 'PLAN_DATE_REQUIRED',
    `名称→${badName.json.code}，金额→${badAmount.json.code}，日期→${badDate.json.code}`);

  await goto('#/customers/' + customerId, 3200);
  const emptyNameUi = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑资料');
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector('.drawer');
    const f = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('公司名称');
    });
    const i = f.querySelector('input');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 1200));
    return {
      open: !!document.querySelector('.drawer'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  check('14b', '浏览器里清空公司名称后保存被拦住（抽屉不关闭）',
    emptyNameUi.open === true && emptyNameUi.toasts.some((t) => t.includes('公司名称')),
    `抽屉仍开=${emptyNameUi.open}，提示=${emptyNameUi.toasts.join(' / ')}`);
  await cdp.js(`(() => { const d = document.querySelector('.drawer'); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x.click(); } return 'ok'; })()`);
  await sleep(500);

  /* 超收提醒：先给当前项目一个合同额 */
  await api('PUT', `/api/customers/${customerId}/project`, { contract_amount: 100000 });
  const over = await api('POST', '/api/payments', {
    project_id: current.data.project.id, type: '实收', amount: 2000000, actual_date: dayOffset(0)
  });
  check('14c', '实收超过合同额时给出超收提醒（仍允许登记）',
    over.data && over.data.warning && over.data.warning.includes('超过合同金额'),
    over.data.warning || '未提示');
  if (over.data && over.data.id) await api('DELETE', `/api/payments/${over.data.id}`);

  /* ================================================================ */
  /* 15. 查重                                                           */
  /* ================================================================ */
  console.log('\n--- 验收 15：查重提示 ---');
  const dupName = await api('GET', `/api/customers/check-duplicate?name=${encodeURIComponent(CUSTOMER_NAME)}`);
  const dupPhone = await api('GET', '/api/customers/check-duplicate?phone=' + encodeURIComponent('139' + ts));
  check('15a', '同名 / 同主联系人手机查重都能命中',
    dupName.data.length >= 1 && dupPhone.data.length >= 1,
    `同名 ${dupName.data.length} 条，同手机 ${dupPhone.data.length} 条`);

  await goto('#/customers', 3400);
  const dupUi = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector('.drawer');
    const f = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('公司名称');
    });
    const i = f.querySelector('input');
    i.value = ${JSON.stringify(CUSTOMER_NAME)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 2000));
    const dd = document.querySelector('.drawer');
    return {
      open: !!dd,
      hasDup: !!(dd && dd.textContent.includes('发现可能重复的客户')),
      cards: dd ? dd.querySelectorAll('.mini-card').length : 0
    };
  })()`);
  check('15b', '浏览器里保存同名客户时弹出查重面板并展示已有记录',
    dupUi.open && dupUi.hasDup && dupUi.cards >= 1,
    `抽屉仍开=${dupUi.open}，查重面板=${dupUi.hasDup}，卡片 ${dupUi.cards} 张`);
  await cdp.js(`(() => { const d = document.querySelector('.drawer'); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x.click(); } return 'ok'; })()`);
  await sleep(500);

  /* ================================================================ */
  /* 25. 自定义行业（设置页 → 表单立即生效）                            */
  /* ================================================================ */
  console.log('\n--- 验收 25/27：字典与标签 ---');
  const newIndustry = `验收自定义行业${ts}`;
  created.dict.push(newIndustry);
  await goto('#/settings', 3200);
  const dictUi = await cdp.js(`(async () => {
    const tab = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('字典'));
    tab.click();
    await new Promise(r => setTimeout(r, 1200));
    const cat = [...document.querySelectorAll('.dict-cat')].find(c => c.textContent.trim().startsWith('行业'));
    if (!cat) return { err: '未找到行业分类' };
    cat.click();
    await new Promise(r => setTimeout(r, 700));
    const addBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增选项'));
    addBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const inp = document.querySelector('.content .card-body input.input');
    inp.value = ${JSON.stringify(newIndustry)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存');
    save.click();
    await new Promise(r => setTimeout(r, 1800));
    return {
      hasNew: document.body.innerText.includes(${JSON.stringify(newIndustry)}),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  check('25a', '设置页字典管理可新增自定义行业',
    !dictUi.err && dictUi.hasNew,
    dictUi.err || `提示：${(dictUi.toasts || []).join(' / ')}`);

  const formIndustry = await cdp.js(`(async () => {
    location.hash = '#/customers';
    await new Promise(r => setTimeout(r, 2800));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
    btn.click();
    await new Promise(r => setTimeout(r, 1000));
    const d = document.querySelector('.drawer');
    const f = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim() === '行业';
    });
    if (!f) return { err: '未找到行业字段' };
    const opts = [...f.querySelector('select').options].map(o => o.value);
    return { found: opts.includes(${JSON.stringify(newIndustry)}) };
  })()`);
  check('25b', '设置页新增的行业立即出现在客户表单下拉中',
    !formIndustry.err && formIndustry.found,
    formIndustry.err || '下拉已包含新选项');
  await cdp.js(`(() => { const d = document.querySelector('.drawer'); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x.click(); } return 'ok'; })()`);
  await sleep(500);

  /* 标签：5 个固定标签不可删除 */
  await goto('#/settings', 3200);
  const tagUi = await cdp.js(`(async () => {
    const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('标签管理'));
    t.click();
    await new Promise(r => setTimeout(r, 1500));
    const fixed = ['重点客户', '老客户', '待回访', '已成交', '暂停合作']
      .filter(n => document.body.innerText.includes(n));
    const dels = [...document.querySelectorAll('.dict-item .acts button')].filter(b => /删/.test(b.textContent));
    return { fixed, total: dels.length, disabled: dels.filter(b => b.disabled).length };
  })()`);
  check('27a', '5 个固定标签存在且删除按钮禁用（数据由代码常量维护）',
    tagUi.fixed.length === 5 && tagUi.disabled >= 5,
    `固定标签 ${tagUi.fixed.length}/5，删除按钮 ${tagUi.total} 个（禁用 ${tagUi.disabled}）`);

  /* ================================================================ */
  /* 待办中心                                                          */
  /* ================================================================ */
  console.log('\n--- 待办中心 ---');
  await goto('#/tasks', 3000);
  const tasksUi = await cdp.js(`(async () => {
    const tabs = [...document.querySelectorAll('.tabs .tab')].map(t => t.textContent.replace(/\\s+/g, ' ').trim());
    const inp = document.querySelector('.quick-add input.input');
    inp.value = '验收快速待办${ts}';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const btn = [...document.querySelectorAll('.quick-add button')].find(b => b.textContent.includes('添加'));
    btn.click();
    await new Promise(r => setTimeout(r, 1600));
    const all = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes('全部待办'));
    if (all) { all.click(); await new Promise(r => setTimeout(r, 800)); }
    return {
      tabs,
      hasItem: document.body.innerText.includes('验收快速待办${ts}'),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  check('28a', '待办中心多视图 + 快速添加可用',
    tasksUi.tabs.length >= 5 && tasksUi.hasItem,
    `视图：${tasksUi.tabs.join(' / ')}；新增可见=${tasksUi.hasItem}`);

  /* ================================================================ */
  /* 29. 产品价目表（1.24）                                             */
  /* ================================================================ */
  console.log('\n--- 验收 29：产品价目表 ---');

  /* 先在系统分类「蝶阀 / 对夹式」下建一个验收产品，页面才有数据可看 */
  const catTree = await api('GET', '/api/product-categories?tree=1');
  const dieCat = (catTree.data || []).find((c) => c.name === '蝶阀');
  const jiaCat = dieCat && (dieCat.children || []).find((c) => c.name === '对夹式');
  const testProduct = await api('POST', '/api/products', {
    category_id: jiaCat ? jiaCat.id : (dieCat ? dieCat.id : ''),
    name: `验收产品${ts} DN200 蝶阀`, code: `ACC-${ts}`,
    unit: '台', price: 1200, discount: 25, lead_time_days: 15,
    body_material: '碳钢 WCB', pressure_rating: 'PN16', remark: '最终验收用产品'
  });
  const productId = testProduct.data && testProduct.data.id;
  if (!productId) {
    check('29a', '产品价目表页可打开，左侧分类树与右侧产品表格都渲染', false,
      '准备验收产品失败：' + (testProduct.json && testProduct.json.message || ''));
  }
  const errBeforeProducts = cdp.errors.length;

  await goto('#/products', 3600);
  const prodUi = await cdp.js(`(() => {
    const text = document.body.innerText;
    const cats = [...document.querySelectorAll('.prod-cat-name')].map(x => x.textContent.trim());
    const headers = [...document.querySelectorAll('.data-table thead th')]
      .map(t => t.textContent.replace(/[↕↑↓]/g, '').trim());
    return {
      hasLayout: !!document.querySelector('.prod-layout'),
      hasTree: !!document.querySelector('.prod-tree'),
      hasTable: !!document.querySelector('.data-table'),
      hasPager: !!document.querySelector('.pager'),
      cats, headers,
      hasProduct: text.includes('验收产品${ts}'),
      navCount: document.querySelectorAll('.nav-item').length,
      fatal: !!document.querySelector('.fatal')
    };
  })()`);
  check('29a', '产品价目表页可打开，左侧分类树与右侧产品表格都渲染',
    prodUi.hasLayout && prodUi.hasTree && prodUi.hasTable && prodUi.hasPager && !prodUi.fatal
      && prodUi.cats.includes('蝶阀') && prodUi.cats.includes('对夹式')
      && prodUi.navCount === 5 && prodUi.hasProduct,
    `分类节点 ${prodUi.cats.length} 个（含蝶阀/对夹式=${prodUi.cats.includes('对夹式')}）；`
      + `验收产品可见=${prodUi.hasProduct}；导航 ${prodUi.navCount} 项`);

  check('29b', '产品表格列头为 1.24 口径（名称/编号/材质/压力/单价/货期/折扣/折后价/操作）',
    ['名称', '编号', '材质', '压力', '单价', '货期', '折扣', '折后价', '操作']
      .every((h) => prodUi.headers.some((x) => x.includes(h))),
    prodUi.headers.join(' | '));

  /* 抽屉：打开「新增产品」，填单价与折扣，检查实时折后价 */
  const prodDrawer = await cdp.js(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增产品'));
    if (!btn) return { err: '未找到新增产品按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = [...document.querySelectorAll('.drawer')].pop();
    if (!d) return { err: '抽屉未打开' };
    const labels = [...d.querySelectorAll('.field-label')]
      .map(x => x.textContent.trim().replace(/\\*$/, ''));
    const setVal = (label, v) => {
      const f = [...d.querySelectorAll('.field')].find(x => {
        const l = x.querySelector('.field-label');
        return l && l.textContent.trim().startsWith(label);
      });
      if (!f) return false;
      const i = f.querySelector('input');
      if (!i) return false;
      i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    setVal('单价', '1200');
    setVal('设定折扣', '30');
    await new Promise(r => setTimeout(r, 400));
    const net = (d.querySelector('.prod-net') || {}).textContent || '';
    const x = [...d.querySelectorAll('.drawer-head button')].pop();
    x.click();
    await new Promise(r => setTimeout(r, 600));
    return { labels, net: net.trim() };
  })()`);
  check('29c', '产品抽屉字段齐全（分类/名称/单价/货期/材质/压力/折扣/备注/启用），折后价实时计算',
    !prodDrawer.err
      && ['产品分类', '产品名称', '产品编号', '单位', '单价（元）', '货期（天）', '阀体材质',
        '压力等级', '设定折扣（%）', '备注', '启用'].every((l) => prodDrawer.labels.includes(l))
      && /840/.test(prodDrawer.net),
    prodDrawer.err || `折后价显示「${prodDrawer.net}」（1200 × 0.7 = 840）`);

  check('29d', '产品价目表页无 JS 报错',
    cdp.errors.length === errBeforeProducts,
    cdp.errors.length === errBeforeProducts
      ? '0 条错误'
      : cdp.errors.slice(errBeforeProducts, errBeforeProducts + 3).join(' | '));

  /* 清理验收产品（软删除即可，不影响其它套件） */
  if (productId) await api('DELETE', `/api/products/${productId}`);

  /* ================================================================ */
  /* 23. 空状态                                                         */
  /* ================================================================ */
  console.log('\n--- 验收 23：空状态 ---');
  await goto('#/customers/' + emptyId, 3200);
  const emptyUi = await cdp.js(`(async () => {
    const tabs = [...document.querySelectorAll('.tabs .tab')].map(t => t.textContent.trim());
    const out = { tabs, panes: {} };
    for (const name of ['资料', '回访与跟进', '项目与财务', '附件与日志']) {
      const tab = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes(name));
      if (!tab) continue;
      tab.click();
      await new Promise(r => setTimeout(r, 500));
      out.panes[name] = document.body.innerText.length > 100;
    }
    out.hasEmptyHint = document.body.innerText.includes('还没有') || document.body.innerText.includes('暂无');
    return out;
  })()`);
  check('23a', '资料为空的客户详情 4 个标签页都能正常渲染空状态',
    emptyUi.tabs.length === 4 && Object.values(emptyUi.panes).every(Boolean) && emptyUi.hasEmptyHint,
    `标签 ${emptyUi.tabs.join(' / ')}；空态提示=${emptyUi.hasEmptyHint}`);

  /* ================================================================ */
  /* 24. 双浏览器 + 无外部请求                                          */
  /* ================================================================ */
  console.log('\n--- 验收 24：浏览器兼容与数据零外流 ---');
  const navChrome = await cdp.js(`(() => ({
    navCount: document.querySelectorAll('.nav-item').length,
    navText: [...document.querySelectorAll('.nav-item')].map(x => x.textContent.trim())
  }))()`);
  check('24a', 'Chrome：导航 5 项、无外部请求',
    navChrome.navCount === 5
      && !cdp.requests.some((u) => /^https?:\/\//.test(u) && !/127\.0\.0\.1|localhost/.test(u)),
    `导航 ${navChrome.navCount} 项：${navChrome.navText.join(' / ')}；外部请求 ${cdp.requests.filter((u) => /^https?:\/\//.test(u) && !/127\.0\.0\.1|localhost/.test(u)).length} 个`);

  if (EDGE) {
    const edgeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-edge-'));
    const ed = await launchBrowser(EDGE, 9241, edgeProfile);
    if (ed) {
      let edgeOk = true;
      const pages = ['#/home', '#/customers', '#/products', '#/tasks', '#/settings'];
      for (const p of pages) {
        await ed.cdp.js(`location.href = ${JSON.stringify(BASE + '/' + p)}; 'ok'`);
        await sleep(2600);
        const st = await ed.cdp.js(`(() => ({
          hasLayout: !!document.querySelector('.layout'),
          navCount: document.querySelectorAll('.nav-item').length,
          err: !!document.querySelector('.fatal')
        }))()`);
        if (!st.hasLayout || st.navCount !== 5 || st.err) edgeOk = false;
      }
      check('24b', `Edge：5 个页面布局与导航正常（${ed.version.Browser}）`, edgeOk,
        edgeOk ? '导航 5 项，页面均正常渲染' : '存在渲染或导航异常');
      check('24c', 'Edge：无控制台报错', ed.cdp.errors.length === 0,
        ed.cdp.errors.length ? ed.cdp.errors.slice(0, 3).join(' | ') : '0 条错误');
      ed.cdp.close();
      try { ed.child.kill(); } catch (_) { /* 忽略 */ }
      await sleep(400);
      try { fs.rmSync(edgeProfile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    } else {
      check('24b', 'Edge：布局与导航正常', false, 'Edge 启动失败');
      check('24c', 'Edge：无控制台报错', false, 'Edge 启动失败');
    }
  } else {
    check('24b', 'Edge：布局与导航正常', false, '系统未安装 Edge');
    check('24c', 'Edge：无控制台报错', false, '系统未安装 Edge');
  }

  check('24d', 'Chrome 全程无未捕获 JS 错误',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

  /* ================================================================ */
  /* 清理                                                              */
  /* ================================================================ */
  cdp.close();
  try { br.child.kill(); } catch (_) { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  try {
    for (const cid of [...new Set(created.customers)]) {
      const pl = await api('GET', `/api/projects?customer_id=${cid}&pageSize=200&archived=all`);
      const pids = (pl.data.list || []).map((p) => p.id);
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
    const tl2 = await api('GET', '/api/tasks?view=all');
    const quickTids = (tl2.data.list || []).filter((t) => String(t.title).includes(`验收快速待办${ts}`)).map((t) => t.id);
    if (quickTids.length) await api('POST', '/api/tasks/batch-delete', { ids: quickTids });
    const d = await api('GET', '/api/dict');
    for (const val of created.dict) {
      const hits = (d.data.items.industry || []).filter((x) => x.value === val);
      for (const h of hits) await api('DELETE', '/api/dict/' + h.id);
    }
    console.log('\n（已清理验收测试数据）');
  } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  try {
    fs.writeFileSync(
      path.join(ROOT, '.fixtures', 'acceptance-browser-result.json'),
      JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
      'utf8'
    );
  } catch (_) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e && e.stack ? e.stack : e); process.exit(1); });
