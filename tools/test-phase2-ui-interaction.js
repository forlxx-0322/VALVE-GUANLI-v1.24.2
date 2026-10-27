/**
 * 阶段二 浏览器交互测试（1.23 一客户一项目）
 *
 * 通过 Chrome DevTools Protocol 驱动真实浏览器：
 *   - 客户列表：4 项导航（无项目管理）、新列头、筛选与快捷
 *   - 新增客户抽屉：4 个区块、只有公司名称必填、标签选择器、字典内联新增
 *   - 通过界面真实创建客户（含行业 / 主联系人）
 *   - 客户详情 4 个标签页：资料（财务栏）/ 回访与跟进 / 项目与财务 / 附件与日志
 *   - 项目档案抽屉（8 个字段）保存后回显
 *   - 记录跟进抽屉
 *   - 全程无未捕获 JS 错误
 *
 * 用法：node tools/test-phase2-ui-interaction.js
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
const PORT = 9223;
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

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
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
        this.consoleErrors.push((d.exception && d.exception.description) || d.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
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
  console.log('=== 阶段二 浏览器交互测试（1.23）===\n');

  if (typeof globalThis.WebSocket !== 'function') {
    console.log('当前 Node 无内置 WebSocket，跳过交互测试。');
    process.exit(0);
  }

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmcdp-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,960', 'about:blank'
  ], { stdio: 'ignore', detached: false });

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

  const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const tab = await tabRes.json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function goto(hash) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(2600);
  }

  const CUSTOMER_NAME = `交互测试客户${TS}`;

  /* ---------- 1. 客户列表页渲染 ---------- */
  await goto('#/customers');
  const listInfo = await cdp.evalJs(`(() => {
    const headers = [...document.querySelectorAll('.data-table thead th')].map(t => t.textContent.replace(/[↕↑↓]/g,'').trim());
    const nav = [...document.querySelectorAll('.sidebar a, .sidebar button, .nav-item, .nav-link')]
      .map(x => x.textContent.trim()).filter(Boolean);
    return {
      rowCount: document.querySelectorAll('.data-table tbody tr').length,
      hasTable: !!document.querySelector('.data-table'),
      hasPager: !!document.querySelector('.pager'),
      hasFilters: !!document.querySelector('.filter-bar'),
      headers,
      nav: [...new Set(nav)],
      title: (document.querySelector('.topbar-title') || {}).textContent || ''
    };
  })()`);
  check('客户列表页渲染出表格 / 分页 / 筛选',
    listInfo.hasTable && listInfo.hasPager && listInfo.hasFilters,
    `数据行=${listInfo.rowCount} 标题=${listInfo.title}`);
  check('列表列头为 1.23 新口径（编号/公司名称/行业/联系人（职务）/来源/下次回访/标签）',
    ['编号', '公司名称', '行业', '联系人（职务）', '来源', '下次回访', '标签']
      .every((h) => listInfo.headers.some((x) => x.includes(h))),
    `列头：${listInfo.headers.join(' | ')}`);
  check('左侧导航只剩 4 项（首页总览/客户管理/待办中心/功能设置），没有项目管理',
    listInfo.nav.length === 4
      && listInfo.nav.includes('首页总览') && listInfo.nav.includes('客户管理')
      && listInfo.nav.includes('待办中心') && listInfo.nav.includes('功能设置')
      && !listInfo.nav.some((x) => x.includes('项目管理')),
    `导航：${listInfo.nav.join(' / ')}`);

  /* ---------- 2. 新增客户抽屉 ---------- */
  await cdp.evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
    if (btn) btn.click();
    return 'ok';
  })()`);
  await sleep(900);

  const drawerInfo = await cdp.evalJs(`(() => {
    const d = document.querySelector('.drawer');
    if (!d) return { open: false };
    const blocks = [...d.querySelectorAll('.form-block-head')].map(h => h.textContent.trim().replace(/\\s+/g,' '));
    const labels = [...d.querySelectorAll('.field-label')].map(el => el.textContent.trim());
    return {
      open: true,
      title: (d.querySelector('.drawer-title') || {}).textContent || '',
      blockCount: d.querySelectorAll('.form-block').length,
      fieldCount: labels.length,
      blocks: blocks.slice(0, 6),
      hasInlineAdd: !!d.querySelector('button[title="新增选项"]'),
      hasTagPicker: labels.some((l) => l.includes('标签')),
      requiredCount: d.querySelectorAll('.req').length,
      labels
    };
  })()`);

  check('点击「新增客户」成功打开编辑抽屉',
    drawerInfo.open && drawerInfo.title.includes('新增客户'),
    drawerInfo.open ? `标题=${drawerInfo.title}` : '抽屉未打开');
  check('编辑抽屉精简为 4 个区块（资料/地址/联系人/回访与备注）',
    drawerInfo.blockCount === 4,
    `区块数=${drawerInfo.blockCount}：${(drawerInfo.blocks || []).join(' / ')}`);
  check('抽屉字段精简为一屏 2 列（16~20 个），只有公司名称必填',
    drawerInfo.fieldCount >= 16 && drawerInfo.fieldCount <= 20 && drawerInfo.requiredCount === 1,
    `字段 ${drawerInfo.fieldCount} 个，必填标记 ${drawerInfo.requiredCount} 个`);
  check('字典字段带「+ 新增选项」内联按钮，标签选择器已渲染',
    drawerInfo.hasInlineAdd && drawerInfo.hasTagPicker,
    `内联新增=${drawerInfo.hasInlineAdd}，标签=${drawerInfo.hasTagPicker}`);

  /* ---------- 3. 在表单内内联新增行业 ---------- */
  const inlineAdd = await cdp.evalJs(`(async () => {
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '无抽屉' };
    const fields = [...d.querySelectorAll('.field')];
    const f = fields.find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim() === '行业';
    });
    if (!f) return { ok: false, why: '未找到行业字段' };
    const addBtn = f.querySelector('button[title="新增选项"]');
    if (!addBtn) return { ok: false, why: '该字段无内联新增按钮' };
    addBtn.click();
    await new Promise(r => setTimeout(r, 350));
    const input = f.querySelector('input');
    if (!input) return { ok: false, why: '点击后未出现输入框' };
    input.value = '交互测试行业';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const saveBtn = [...f.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
    if (!saveBtn) return { ok: false, why: '未找到保存按钮' };
    saveBtn.click();
    await new Promise(r => setTimeout(r, 1400));
    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    const sel = f.querySelector('select');
    const opts = sel ? [...sel.options].map(o => o.value) : [];
    return { ok: true, toasts, hasOption: opts.includes('交互测试行业'), optCount: opts.length };
  })()`);
  check('在表单内直接新增行业选项（无需跳转设置页）',
    inlineAdd.ok && inlineAdd.hasOption,
    inlineAdd.ok
      ? `提示：${(inlineAdd.toasts || []).join(' / ') || '无'}；下拉选项数=${inlineAdd.optCount}`
      : `失败原因：${inlineAdd.why}`);
  check('内联新增全新选项时提示为「已新增选项」',
    inlineAdd.ok && (inlineAdd.toasts || []).some((t) => t.includes('已新增选项') && t.includes('交互测试行业')),
    `提示：${(inlineAdd.toasts || []).join(' / ') || '无'}`);

  /* ---------- 3.2 再次输入同名：提示「已选用已有选项」 ---------- */
  const inlineAgain = await cdp.evalJs(`(async () => {
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '无抽屉' };
    const fields = [...d.querySelectorAll('.field')];
    const f = fields.find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim() === '行业';
    });
    if (!f) return { ok: false, why: '未找到行业字段' };
    const addBtn = f.querySelector('button[title="新增选项"]');
    if (!addBtn) return { ok: false, why: '无内联新增按钮' };
    addBtn.click();
    await new Promise(r => setTimeout(r, 350));
    const input = f.querySelector('input');
    if (!input) return { ok: false, why: '点击后未出现输入框' };
    input.value = '交互测试行业';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const saveBtn = [...f.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
    if (!saveBtn) return { ok: false, why: '未找到保存按钮' };
    saveBtn.click();
    await new Promise(r => setTimeout(r, 1400));
    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    const sel = f.querySelector('select');
    return { ok: true, toasts, selected: sel ? sel.value : '' };
  })()`);
  check('内联输入已存在的同名选项时提示为「已选用已有选项」（不误报为已新增）',
    inlineAgain.ok
      && (inlineAgain.toasts || []).some((t) => t.includes('已选用已有选项') && t.includes('交互测试行业'))
      && !(inlineAgain.toasts || []).some((t) => t.includes('已新增选项')),
    inlineAgain.ok ? `提示：${(inlineAgain.toasts || []).join(' / ') || '无'}；已选中=「${inlineAgain.selected}」` : `失败原因：${inlineAgain.why}`);

  /* ---------- 4. 通过界面创建客户 ---------- */
  const createRes = await cdp.evalJs(`(async () => {
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '无抽屉' };
    const field = (label) => [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith(label);
    });
    const setText = (label, value) => {
      const f = field(label);
      if (!f) return false;
      const input = f.querySelector('input, textarea');
      if (!input) return false;
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    const setSelect = (label, value) => {
      const f = field(label);
      if (!f) return false;
      const sel = f.querySelector('select');
      if (!sel) return false;
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const filled = {
      name: setText('公司名称', ${JSON.stringify(CUSTOMER_NAME)}),
      industry: setSelect('行业', '石油'),
      source: setSelect('客户来源', '展会'),
      contact: setText('姓名', '交互联系人'),
      phone: setText('手机', '13900003333'),
      cycle: setText('定期提醒天数', '30')
    };
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    if (!save) return { ok: false, why: '未找到保存按钮' };
    save.click();
    await new Promise(r => setTimeout(r, 1800));
    return {
      ok: true, filled,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      drawerOpen: !!document.querySelector('.drawer')
    };
  })()`);
  check('通过界面填写并保存新客户',
    createRes.ok && createRes.filled.name && createRes.filled.industry
      && createRes.toasts.some((t) => t.includes('客户已创建'))
      && createRes.drawerOpen === false,
    createRes.ok
      ? `填写=${JSON.stringify(createRes.filled)}；提示=${(createRes.toasts || []).join(' / ')}；抽屉已关闭=${!createRes.drawerOpen}`
      : `失败原因：${createRes.why}`);

  /* 找到刚创建的客户 id */
  let customerId = null;
  try {
    const r = await (await fetch(BASE + '/api/customers?q=' + encodeURIComponent(CUSTOMER_NAME))).json();
    customerId = r.data.list[0] && r.data.list[0].id;
  } catch (_) { /* 忽略 */ }
  check('新建客户已落库（编号自动生成、主联系人同步）',
    !!customerId,
    customerId ? `id=${customerId}` : '接口查不到刚创建的客户');

  /* ---------- 5. 详情页 4 个标签页 ---------- */
  await goto('#/customers/' + customerId);
  const detailBase = await cdp.evalJs(`(() => {
    const tabs = [...document.querySelectorAll('.tabs .tab')].map(t => t.textContent.trim());
    const title = (document.querySelector('.detail-title') || {}).textContent || '';
    const hasFinance = !!document.querySelector('.stat-grid');
    return { tabs, title, hasFinance };
  })()`);
  check('详情页渲染 4 个标签页（资料/回访与跟进/项目与财务/附件与日志）',
    detailBase.tabs.length === 4
      && detailBase.tabs.some((t) => t.includes('资料'))
      && detailBase.tabs.some((t) => t.includes('回访与跟进'))
      && detailBase.tabs.some((t) => t.includes('项目与财务'))
      && detailBase.tabs.some((t) => t.includes('附件与日志')),
    `标签页（${detailBase.tabs.length} 个）：${detailBase.tabs.join(' / ')}；客户：${detailBase.title}`);

  const basicInfo = await cdp.evalJs(`(() => {
    const statLabels = [...document.querySelectorAll('.stat .l')].map(x => x.textContent.trim());
    const kvKeys = [...document.querySelectorAll('.kv .k')].map(x => x.textContent.trim());
    const cards = [...document.querySelectorAll('.card-title')].map(x => x.textContent.trim());
    return {
      statCount: document.querySelectorAll('.stat').length,
      statLabels, kvKeys, cards,
      hasMainContact: kvKeys.includes('姓名') && kvKeys.includes('手机'),
      hasExtraFold: cards.some(c => c.includes('附加联系人'))
    };
  })()`);
  check('「资料」标签页：财务汇总栏 9 个数字（8 项 + 预计毛利）',
    basicInfo.statCount >= 9
      && ['合同额', '已收', '应收', '采购成本', '维护成本', '其他成本', '毛利率']
        .every((l) => basicInfo.statLabels.some((x) => x.includes(l))),
    `统计卡 ${basicInfo.statCount} 个：${basicInfo.statLabels.join(' / ')}`);
  check('「资料」标签页：客户资料 + 主联系人 + 附加联系人折叠区',
    basicInfo.hasMainContact && basicInfo.hasExtraFold,
    `卡片：${basicInfo.cards.slice(0, 8).join(' / ')}`);

  const tabTests = [];
  for (const name of ['回访与跟进', '项目与财务', '附件与日志']) {
    const r = await cdp.evalJs(`(async () => {
      const tab = [...document.querySelectorAll('.tabs .tab')].find(t => t.textContent.includes(${JSON.stringify(name)}));
      if (!tab) return { ok: false };
      tab.click();
      await new Promise(r => setTimeout(r, 500));
      const page = document.querySelector('.content');
      const visible = [...page.querySelectorAll('.card')].filter(c => c.offsetParent !== null);
      const titles = visible.map(c => (c.querySelector('.card-title') || {}).textContent || '').filter(Boolean);
      return { ok: true, titles, textLen: visible.map(c => c.innerText).join(' ').length };
    })()`);
    tabTests.push({ name, ...r });
  }
  const tabsOk = tabTests.every((t) => t.ok && t.textLen > 20);
  check('另外 3 个标签页均可切换并渲染内容',
    tabsOk,
    tabTests.map((t) => `${t.name}${t.ok ? '✓' : '✗'}（${(t.titles || []).slice(0, 3).join('/')}）`).join(' '));

  const projectPane = tabTests.find((t) => t.name === '项目与财务') || {};
  check('「项目与财务」包含当前项目档案 / 回款计划 / 实收 / 成本台账 / 历史项目',
    ['当前项目档案', '回款计划', '实收流水', '成本台账', '历史项目']
      .every((k) => (projectPane.titles || []).some((x) => x.includes(k))),
    `卡片：${(projectPane.titles || []).join(' / ')}`);

  /* ---------- 6. 项目档案抽屉 ---------- */
  const projectDrawer = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('建立项目档案'));
    if (!btn) return { ok: false, why: '未找到「建立项目档案」按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    return {
      ok: true,
      title: (d.querySelector('.drawer-title') || {}).textContent || '',
      labels: [...d.querySelectorAll('.field-label')].map(x => x.textContent.trim())
    };
  })()`);
  check('客户详情可打开项目档案抽屉（8 个业务字段）',
    projectDrawer.ok
      && ['项目名称', '项目阶段', '进度（%）', '合同额（元）', '签约日期', '投标日期', '投标结果', '交货期']
        .every((l) => projectDrawer.labels.includes(l)),
    projectDrawer.ok ? projectDrawer.labels.join('、') : `失败原因：${projectDrawer.why}`);

  const projectSave = await cdp.evalJs(`(async () => {
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '无抽屉' };
    const field = (label) => [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith(label);
    });
    const nameF = field('项目名称');
    const amountF = field('合同额');
    if (nameF) {
      const i = nameF.querySelector('input');
      i.value = '交互测试项目'; i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (amountF) {
      const i = amountF.querySelector('input');
      i.value = '123456'; i.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(r => setTimeout(r, 200));
    const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    save.click();
    await new Promise(r => setTimeout(r, 1500));
    return {
      ok: true,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      kv: [...document.querySelectorAll('.kv .k')].map(k => k.textContent.trim() + '=' + (k.nextElementSibling
        ? k.nextElementSibling.textContent.trim().slice(0, 30) : ''))
    };
  })()`);
  check('保存项目档案后详情回显项目名称与合同额',
    projectSave.ok
      && projectSave.toasts.some((t) => t.includes('项目档案'))
      && projectSave.kv.some((x) => x.startsWith('项目名称=交互测试项目'))
      && projectSave.kv.some((x) => x.startsWith('合同额=123,456')),
    projectSave.ok ? `提示=${(projectSave.toasts || []).join(' / ')}` : `失败原因：${projectSave.why}`);

  /* ---------- 7. 记录跟进抽屉 ---------- */
  const followOpen = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('记录跟进'));
    if (!btn) return { ok: false, why: '未找到按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    return {
      ok: true,
      title: (d.querySelector('.drawer-title') || {}).textContent || '',
      labels: [...d.querySelectorAll('.field-label')].map(el => el.textContent.trim()),
      selects: d.querySelectorAll('select').length
    };
  })()`);
  check('点击「记录跟进」打开跟进抽屉并渲染表单',
    followOpen.ok && followOpen.labels.length >= 5 && followOpen.selects >= 2,
    followOpen.ok ? `标题=${followOpen.title}；字段：${followOpen.labels.join('、')}` : `失败原因：${followOpen.why}`);
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('.drawer-head button')].find(x => x.textContent.includes('✕'));
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(400);

  /* ---------- 8. 编辑资料抽屉回填值 ---------- */
  const editDrawer = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑资料');
    if (!btn) return { ok: false, why: '未找到编辑资料按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    const nameF = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith('公司名称');
    });
    const input = nameF ? nameF.querySelector('input') : null;
    return {
      ok: true,
      blockCount: d.querySelectorAll('.form-block').length,
      nameValue: input ? input.value : '',
      requiredCount: d.querySelectorAll('.req').length
    };
  })()`);
  check('「编辑资料」抽屉打开且回填客户名称（只有 1 个必填）',
    editDrawer.ok && editDrawer.blockCount === 4
      && editDrawer.nameValue === CUSTOMER_NAME && editDrawer.requiredCount === 1,
    editDrawer.ok
      ? `区块=${editDrawer.blockCount}，名称回填=${editDrawer.nameValue}，必填=${editDrawer.requiredCount}`
      : `失败原因：${editDrawer.why}`);

  /* ---------- 9. 固定标签在标签管理里不可删除 ---------- */
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('.drawer-head button')].find(x => x.textContent.includes('✕'));
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(400);
  await goto('#/settings');
  await cdp.evalJs(`(() => {
    const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('标签管理'));
    if (t) t.click();
    return 'ok';
  })()`);
  await sleep(1200);
  const tagPanel = await cdp.evalJs(`(() => {
    const text = document.body.innerText;
    const fixedHit = ['重点客户', '老客户', '待回访', '已成交', '暂停合作'].filter(n => text.includes(n));
    const delButtons = [...document.querySelectorAll('.dict-item .acts button')]
      .filter(b => /删/.test(b.textContent));
    const disabledDel = delButtons.filter(b => b.disabled).length;
    return { fixedHit, delButtons: delButtons.length, disabledDel };
  })()`);
  check('设置页标签管理里 5 个固定标签存在且删除按钮被禁用',
    tagPanel.fixedHit.length === 5 && tagPanel.delButtons > 0 && tagPanel.disabledDel >= 5,
    `固定标签 ${tagPanel.fixedHit.length}/5，删除按钮 ${tagPanel.delButtons} 个（禁用 ${tagPanel.disabledDel} 个）`);

  /* ---------- 10. 运行时 JS 错误 ---------- */
  check('全程无未捕获的 JS 错误',
    cdp.consoleErrors.length === 0,
    cdp.consoleErrors.length ? cdp.consoleErrors.slice(0, 3).join(' | ') : '0 条错误');

  /* ---------- 清理 ---------- */
  try {
    if (customerId) {
      const pl = await (await fetch(BASE + `/api/projects?customer_id=${customerId}&pageSize=200&archived=all`)).json();
      const pids = ((pl.data && pl.data.list) || []).map((p) => p.id);
      if (pids.length) await fetch(BASE + '/api/projects/batch-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pids })
      });
      await fetch(BASE + '/api/customers/batch-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [customerId] })
      });
    }
    const d = await (await fetch(BASE + '/api/dict')).json();
    const hits = (d.data.items.industry || []).filter((x) => x.value === '交互测试行业');
    for (const h of hits) await fetch(BASE + '/api/dict/' + h.id, { method: 'DELETE' });
    console.log('\n（已清理测试客户与测试行业选项）');
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
