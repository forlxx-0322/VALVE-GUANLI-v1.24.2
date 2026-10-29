/**
 * 阶段三 浏览器交互测试（1.27 一个客户多个项目）
 *
 * 驱动真实浏览器走一遍客户详情里的「项目与财务」：
 *   - 打开项目档案抽屉并保存（项目名称 / 阶段 / 合同额 / 投标信息）
 *   - 新增回款计划 → 登记实收 → 项目卡与财务汇总当场更新
 *   - 登记成本 → 成本台账出现该笔
 *   - 进行中项目「归档」→ 项目列表变空、历史项目折叠区可查 → 再新增项目
 *   - 归档后再建新当前项目
 *   - 待办中心快速添加
 *   - 全程无未捕获 JS 错误
 *
 * 用法：node tools/test-phase3-ui-interaction.js
 * 前置：服务运行中；Chrome 已安装
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const PORT = 9224;
const TS = Date.now().toString().slice(-6);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
  }

  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.errors.push((d.exception && d.exception.description) || d.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 15000);
    });
  }

  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

(async () => {
  console.log('=== 阶段三 浏览器交互测试（多项目 / 回款 / 成本 / 待办）===\n');

  if (typeof globalThis.WebSocket !== 'function') {
    console.log('当前 Node 无内置 WebSocket，跳过交互测试。');
    process.exit(0);
  }

  /* 准备测试客户（1.23 字段模型） */
  const custRes = await fetch(BASE + '/api/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `阶段三交互测试客户${TS}`, short_name: `交互测试${TS}`,
      industry: '石油', source: '展会',
      contact_name: '交互联系人', contact_position: '采购经理', contact_phone: '13900007777'
    })
  });
  const customerId = (await custRes.json()).data.id;
  console.log(`准备测试客户 id=${customerId}\n`);

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmp3-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch (_) { /* 继续等 */ }
  }
  if (!version) {
    console.log('浏览器调试端口未就绪，测试中止。');
    try { child.kill(); } catch (_) { /* 忽略 */ }
    process.exit(1);
  }
  console.log(`浏览器：${version.Browser}\n`);

  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function goto(hash, wait) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 2800);
  }

  await goto('#/customers/' + customerId, 3000);

  /* ---------- 1. 切到「项目与财务」 ---------- */
  const pane = await cdp.evalJs(`(async () => {
    const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('项目与财务'));
    if (!t) return { ok: false, why: '未找到项目与财务标签' };
    t.click();
    await new Promise(r => setTimeout(r, 500));
    const titles = [...document.querySelectorAll('.card-title')].map(x => x.textContent.trim());
    return {
      ok: true, titles,
      hasEmpty: document.body.innerText.includes('还没有进行中的项目'),
      hasBuildBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('新增项目'))
    };
  })()`);
  check('客户详情「项目与财务」初始为空项目状态（一个客户可多个项目）',
    pane.ok && pane.hasEmpty && pane.hasBuildBtn
      && pane.titles.some((x) => x.includes('进行中项目'))
      && pane.titles.some((x) => x.includes('回款计划'))
      && pane.titles.some((x) => x.includes('成本台账')),
    `卡片：${(pane.titles || []).slice(0, 6).join(' / ')}`);

  /* ---------- 2. 新增项目 ---------- */
  const projectName = `阶段三交互项目${TS}`;
  const projectSaved = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增项目'));
    if (!btn) return { ok: false, why: '未找到新增项目按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    const field = (label) => [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith(label);
    });
    const setText = (label, value) => {
      const f = field(label);
      if (!f) return false;
      const i = f.querySelector('input, textarea');
      if (!i) return false;
      i.value = value;
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const setSelect = (label, value) => {
      const f = field(label);
      if (!f) return false;
      const s = f.querySelector('select');
      if (!s) return false;
      s.value = value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const filled = {
      name: setText('项目名称', ${JSON.stringify(projectName)}),
      amount: setText('合同额', '500000'),
      stage: setSelect('项目阶段', '投标/议价'),
      bid: setText('投标日期', '2026-09-20'),
      result: setSelect('投标结果', '已中标'),
      delivery: setText('交货期', '2026-12-31')
    };
    await new Promise(r => setTimeout(r, 250));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    if (!save) return { ok: false, why: '未找到保存按钮' };
    save.click();
    await new Promise(r => setTimeout(r, 1800));
    return {
      ok: true, filled,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      drawerClosed: !document.querySelector('.drawer')
    };
  })()`);
  check('项目抽屉填写并保存成功（新增第 1 个项目）',
    projectSaved.ok && Object.values(projectSaved.filled).every(Boolean)
      && projectSaved.toasts.some((t) => t.includes('项目已新增'))
      && projectSaved.drawerClosed,
    projectSaved.ok ? `提示：${(projectSaved.toasts || []).join(' / ')}` : `失败：${projectSaved.why}`);

  const projectCard = await cdp.evalJs(`(() => {
    const kv = {};
    document.querySelectorAll('.kv .k').forEach(k => {
      const v = k.nextElementSibling;
      if (v) kv[k.textContent.trim()] = v.textContent.trim().slice(0, 60);
    });
    const stats = [...document.querySelectorAll('.stat')].map(s => ({
      n: (s.querySelector('.n') || {}).textContent.trim(),
      l: (s.querySelector('.l') || {}).textContent.trim()
    }));
    return { kv, stats };
  })()`);
  check('项目档案保存后详情回显名称 / 阶段 / 合同额 / 投标结果',
    projectCard.kv['项目名称'] === projectName
      && projectCard.kv['项目阶段'] === '投标/议价'
      && String(projectCard.kv['合同额']).includes('500,000')
      && projectCard.kv['投标结果'] === '已中标',
    JSON.stringify(projectCard.kv));

  /* ---------- 3. 新增回款计划 ---------- */
  const planSaved = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增计划'));
    if (!btn) return { ok: false, why: '未找到新增计划按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '回款抽屉未打开' };
    const amt = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('金额');
    });
    if (!amt) return { ok: false, why: '未找到金额字段' };
    const i = amt.querySelector('input');
    i.value = '200000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    if (!save) return { ok: false, why: '未找到保存按钮' };
    save.click();
    await new Promise(r => setTimeout(r, 2000));
    return {
      ok: true,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      rows: [...document.querySelectorAll('.data-table tbody tr')].length
    };
  })()`);
  const afterPlanApi = await (await fetch(BASE + `/api/projects?customer_id=${customerId}&pageSize=10`)).json();
  const projectId = afterPlanApi.data.list[0] && afterPlanApi.data.list[0].id;
  const projectDetail = projectId ? await (await fetch(BASE + `/api/projects/${projectId}`)).json() : null;
  check('页面上新增回款计划（并自动生成待办）',
    planSaved.ok && planSaved.toasts.some((t) => t.includes('回款计划已保存'))
      && projectDetail && projectDetail.data.plans.length === 1
      && projectDetail.data.plans[0].amount === 200000,
    planSaved.ok
      ? `提示：${(planSaved.toasts || []).join(' / ')}；接口回款计划 ${projectDetail && projectDetail.data.plans.length} 条`
      : `失败：${planSaved.why}`);

  /* ---------- 4. 登记实收 ---------- */
  const receiptSaved = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('登记实收'));
    if (!btn) return { ok: false, why: '未找到登记实收按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '回款抽屉未打开' };
    const amt = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('金额');
    });
    if (!amt) return { ok: false, why: '未找到金额字段' };
    const i = amt.querySelector('input');
    i.value = '200000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    if (!save) return { ok: false, why: '未找到保存按钮' };
    save.click();
    await new Promise(r => setTimeout(r, 2200));
    const kv = {};
    document.querySelectorAll('.kv .k').forEach(k => {
      const v = k.nextElementSibling;
      if (v) kv[k.textContent.trim()] = v.textContent.trim().slice(0, 80);
    });
    return {
      ok: true,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      receivedText: kv['已收 / 欠款'] || ''
    };
  })()`);
  const afterReceipt = projectId ? await (await fetch(BASE + `/api/projects/${projectId}`)).json() : null;
  check('页面上登记实收后欠款当场重算',
    receiptSaved.ok && afterReceipt && afterReceipt.data.received_amount === 200000
      && afterReceipt.data.debt_amount === 300000
      && String(receiptSaved.receivedText).includes('200,000')
      && String(receiptSaved.receivedText).includes('300,000'),
    receiptSaved.ok
      ? `页面：${receiptSaved.receivedText}；接口：已收 ${afterReceipt.data.received_amount}，欠款 ${afterReceipt.data.debt_amount}`
      : `失败：${receiptSaved.why}`);

  /* ---------- 5. 登记成本 ---------- */
  const costSaved = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('登记成本'));
    if (!btn) return { ok: false, why: '未找到登记成本按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '成本抽屉未打开' };
    const fields = [...d.querySelectorAll('.field')];
    const amountField = fields.find(x => x.textContent.includes('金额'));
    const supplierField = fields.find(x => x.textContent.includes('供应商'));
    if (amountField) {
      const i = amountField.querySelector('input');
      i.value = '100000';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (supplierField) {
      const i = supplierField.querySelector('input');
      i.value = '交互测试供应商';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    if (!save) return { ok: false, why: '未找到保存按钮' };
    save.click();
    await new Promise(r => setTimeout(r, 2000));
    const rows = [...document.querySelectorAll('.data-table tbody tr')].map(tr => tr.innerText.replace(/\\s+/g, ' ').trim());
    return {
      ok: true,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      hasCostRow: rows.some(r => r.includes('采购成本') && r.includes('100,000'))
    };
  })()`);
  check('页面上登记采购成本并出现在成本台账',
    costSaved.ok && costSaved.hasCostRow && costSaved.toasts.some((t) => t.includes('成本已登记')),
    costSaved.ok ? `提示：${(costSaved.toasts || []).join(' / ')}，台账含该笔=${costSaved.hasCostRow}` : `失败：${costSaved.why}`);

  /* ---------- 6. 财务汇总栏随数据更新 ---------- */
  const financeBar = await cdp.evalJs(`(async () => {
    const tab = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes('资料'));
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 500));
    const stats = [...document.querySelectorAll('.stat')].map(s => ({
      n: (s.querySelector('.n') || {}).textContent.trim(),
      l: (s.querySelector('.l') || {}).textContent.trim()
    }));
    const get = (label) => (stats.find(s => s.l.includes(label)) || {}).n || '';
    return {
      contract: get('合同额'), received: get('已回款'), receivable: get('应收'),
      purchase: get('成本'), profit: get('毛利')
    };
  })()`);
  check('「资料」财务汇总栏显示进行中项目合计（合同额 / 已回款 / 应收 / 成本 / 毛利）',
    String(financeBar.contract).includes('500,000')
      && String(financeBar.received).includes('200,000')
      && String(financeBar.receivable).includes('0')
      && String(financeBar.purchase).includes('100,000')
      && String(financeBar.profit).includes('100,000'),
    JSON.stringify(financeBar));

  /* ---------- 7. 归档项目 ---------- */
  const archived = await cdp.evalJs(`(async () => {
    const tab = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes('项目与财务'));
    if (tab) tab.click();
    await new Promise(r => setTimeout(r, 500));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('归档'));
    if (!btn) return { ok: false, why: '未找到归档按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    const modal = document.querySelector('.modal');
    if (!modal) return { ok: false, why: '确认框未出现' };
    const ok = [...modal.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('转为历史'));
    if (!ok) return { ok: false, why: '确认框缺少确认按钮' };
    ok.click();
    await new Promise(r => setTimeout(r, 2200));
    return {
      ok: true,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      isEmpty: document.body.innerText.includes('还没有进行中的项目'),
      hasHistory: document.body.innerText.includes('历史项目（1）')
    };
  })()`);
  check('项目「归档」后列表为空、历史项目计数为 1',
    archived.ok && archived.isEmpty && archived.hasHistory
      && archived.toasts.some((t) => t.includes('已归档为历史项目')),
    archived.ok
      ? `提示：${(archived.toasts || []).join(' / ')}，空列表=${archived.isEmpty}，历史计数=${archived.hasHistory}`
      : `失败：${archived.why}`);

  const historyApi = projectId ? await (await fetch(BASE + `/api/customers/${customerId}/history-projects`)).json() : null;
  check('历史项目在接口里为 archived=1（只读）',
    historyApi && historyApi.data.length === 1 && historyApi.data[0].archived === 1,
    historyApi ? `历史 ${historyApi.data.length} 条` : '接口无响应');

  /* ---------- 8. 归档后再建新当前项目 ---------- */
  const newProjectName = `阶段三交互新项目${TS}`;
  const rebuilt = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增项目'));
    if (!btn) return { ok: false, why: '未找到新增项目按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    const nameField = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('项目名称');
    });
    if (!nameField) return { ok: false, why: '未找到项目名称字段' };
    const i = nameField.querySelector('input');
    i.value = ${JSON.stringify(newProjectName)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 2000));
    const kv = {};
    document.querySelectorAll('.kv .k').forEach(k => {
      const v = k.nextElementSibling;
      if (v) kv[k.textContent.trim()] = v.textContent.trim().slice(0, 60);
    });
    return { ok: true, projectName: kv['项目名称'] || '', toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) };
  })()`);
  const currentApi = await (await fetch(BASE + `/api/customers/${customerId}/project`)).json();
  check('归档后可再建新的进行中项目（一个客户多个项目）',
    rebuilt.ok && rebuilt.projectName === newProjectName
      && currentApi.data.project && currentApi.data.project.name === newProjectName
      && currentApi.data.history.length === 1,
    rebuilt.ok
      ? `新进行中项目=${rebuilt.projectName}，历史=${currentApi.data.history.length} 条`
      : `失败：${rebuilt.why}`);

  /* ---------- 9. 待办中心快速添加 ---------- */
  await goto('#/tasks', 3000);
  const taskInfo = await cdp.evalJs(`(async () => {
    const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.replace(/\\s+/g, ' ').trim());
    const inp = document.querySelector('.quick-add input.input');
    if (!inp) return { ok: false, why: '未找到快速添加输入框', tabs };
    inp.value = ${JSON.stringify('阶段三交互测试待办' + TS)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const btn = [...document.querySelectorAll('.quick-add button')].find(b => b.textContent.includes('添加'));
    if (!btn) return { ok: false, why: '未找到添加按钮', tabs };
    btn.click();
    await new Promise(r => setTimeout(r, 1600));
    /* 新待办没有截止日期，默认「今日」视图看不到，切到「全部待办」再确认 */
    const allTab = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes('全部待办'));
    if (allTab) { allTab.click(); await new Promise(r => setTimeout(r, 900)); }
    return {
      ok: true, tabs,
      hasItem: document.body.innerText.includes(${JSON.stringify('阶段三交互测试待办' + TS)}),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  check('待办中心渲染多个视图且可快速添加',
    taskInfo.ok && taskInfo.tabs.length >= 5 && taskInfo.hasItem,
    taskInfo.ok
      ? `视图：${taskInfo.tabs.join(' / ')}；新待办已出现=${taskInfo.hasItem}`
      : `失败：${taskInfo.why}`);

  /* ---------- 10. 无 JS 错误 ---------- */
  check('全程无未捕获的 JS 错误',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

  /* ---------- 清理 ---------- */
  try {
    const pl = await (await fetch(BASE + `/api/projects?customer_id=${customerId}&pageSize=200&archived=all`)).json();
    const pids = ((pl.data && pl.data.list) || []).map((p) => p.id);
    for (const pid of pids) {
      const d = await (await fetch(BASE + `/api/projects/${pid}`)).json();
      const rows = [].concat((d.data && d.data.plans) || [], (d.data && d.data.receipts) || []);
      for (const row of rows) await fetch(BASE + '/api/payments/' + row.id, { method: 'DELETE' });
    }
    const cl = await (await fetch(BASE + `/api/costs?customer_id=${customerId}&pageSize=200`)).json();
    for (const row of (cl.data && cl.data.list) || []) {
      await fetch(BASE + '/api/costs/' + row.id, { method: 'DELETE' });
    }
    if (pids.length) await fetch(BASE + '/api/projects/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: pids })
    });
    const tl = await (await fetch(BASE + '/api/tasks?view=all&customer_id=' + customerId)).json();
    const tids = ((tl.data && tl.data.list) || []).map((t) => t.id);
    if (tids.length) await fetch(BASE + '/api/tasks/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: tids })
    });
    await fetch(BASE + '/api/customers/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [customerId] })
    });
    console.log(`\n（已清理：${pids.length} 个项目、${tids.length} 条待办、1 个客户）`);
  } catch (_) { /* 忽略 */ }

  cdp.close();
  try { child.kill(); } catch (_) { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
