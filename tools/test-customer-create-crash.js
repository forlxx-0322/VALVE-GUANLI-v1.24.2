/**
 * 客户录入路径回归（1.23 精简表单）
 *
 * 复现并防止「录入客户信息时闪退到客户管理页面 / 保存后抽屉莫名关闭」：
 *   - 保存后抽屉消失，但**没有新增成功**（列表里查不到该客户）
 *   - 出现 JS 运行时异常
 *   - 抽屉消失后页面停留在客户列表，且无任何成功提示
 *
 * 覆盖：
 *   A. 只填公司名称（1.23 只有它必填）→ 保存
 *   B. 填常用字段（行业 / 来源 / 主联系人 / 地址 / 归属地州 / 回访周期）
 *   C. 与库中已有客户**同名**（触发查重面板）
 *   D. 与库中已有客户**同主联系人手机**（触发查重面板）
 *   D2. 同手机命中多家 → 逐条渲染成卡片
 *   E. 不填必填就保存（应被校验拦住，抽屉不关）
 *   F. 填一半关闭再打开（表单已重置）
 *
 * 用法：先启动服务，再 node tools/test-customer-create-crash.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    this.ws = new globalThis.WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push((d.exception && d.exception.description) || d.text || '未知异常');
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 40000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  }
  clearErrors() { this.errors.length = 0; }
}

const tag = Date.now().toString().slice(-6);

/* 浏览器内通用工具：打开抽屉 / 填字段 / 点保存 / 读状态 */
const HELPERS = `
window.__probe = {
  openDrawer: async () => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新增客户'));
    if (!b) return 'no-button';
    b.click();
    await new Promise(r => setTimeout(r, 1600));
    return 'ok';
  },
  drawer: () => [...document.querySelectorAll('.drawer')].pop() || null,
  field: (label) => {
    const d = window.__probe.drawer();
    if (!d) return null;
    return [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.trim().startsWith(label);
    }) || null;
  },
  setText: (label, value) => {
    const f = window.__probe.field(label);
    if (!f) return 'no-field:' + label;
    const inp = f.querySelector('input, textarea');
    if (!inp) return 'no-input:' + label;
    inp.value = value;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  },
  setSelect: (label, value) => {
    const f = window.__probe.field(label);
    if (!f) return 'no-field:' + label;
    const sel = f.querySelector('select');
    if (!sel) return 'no-select:' + label;
    if (value && ![...sel.options].some(o => o.value === value)) {
      return 'no-option:' + label + '=' + value + '（可选：' + [...sel.options].slice(0,4).map(o=>o.value).join('/') + '）';
    }
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  },
  clickFoot: (text) => {
    const d = window.__probe.drawer();
    if (!d) return 'no-drawer';
    const b = [...d.querySelectorAll('.drawer-foot button')].find(x => x.textContent.includes(text));
    if (!b) return 'no-btn:' + text;
    b.click();
    return 'ok';
  },
  state: () => {
    const d = window.__probe.drawer();
    return {
      hash: location.hash,
      drawerOpen: !!d,
      drawerTitle: d ? ((d.querySelector('.drawer-title') || {}).textContent || '') : '',
      hasDupPanel: !!(d && d.textContent.includes('发现可能重复的客户')),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      bodyHint: document.body.innerText.slice(0, 120)
    };
  }
};
'ok';
`;

(async () => {
  console.log('=== 客户录入路径回归（1.23 精简表单）===\n');

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));

  /* 先造一条"已有客户"用于触发查重 */
  const existing = {
    name: `【闪退复现${tag}】已有客户`,
    short_name: `已有${tag}`,
    phone: `0991-${tag}-0`
  };
  const mk = async (body) => {
    const r = await fetch(BASE + '/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    return (await r.json()).data;
  };
  const base = await mk({
    name: existing.name, short_name: existing.short_name, industry: '石油',
    contact_name: '已有联系人', contact_phone: existing.phone
  });
  console.log(`已造对照客户 #${base.id}（主联系人手机 ${existing.phone}）\n`);

  const createdIds = [base.id];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
  const PORT = 9300;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(4000);
    await cdp.js(HELPERS);

    /** 跑一个场景：返回状态快照 + 是否落库 */
    async function scenario(title, name, fillScript) {
      cdp.clearErrors();
      await cdp.js(`location.hash = '#/customers'; 'ok'`);
      await sleep(2200);
      await cdp.js(HELPERS);

      /* 关掉可能残留的抽屉（查重面板出现时抽屉不会自动关闭） */
      await cdp.js(`(() => {
        let guard = 0;
        while (guard++ < 5) {
          const ds = [...document.querySelectorAll('.drawer')];
          if (!ds.length) break;
          const d = ds[ds.length - 1];
          const x = [...d.querySelectorAll('.drawer-head button')].pop();
          if (x) x.click();
        }
        return document.querySelectorAll('.drawer').length;
      })()`);
      await sleep(900);

      const open = await cdp.js(`window.__probe.openDrawer()`);
      if (open !== 'ok') {
        check(title, false, '无法打开新增抽屉：' + open);
        return null;
      }
      const openedCount = await cdp.js(`document.querySelectorAll('.drawer').length`);
      if (openedCount < 1) {
        check(title, false, '抽屉未真正打开（可能有残留遮罩挡住按钮）');
        return null;
      }
      const fill = await cdp.js(`(async () => {
        ${fillScript}
        await new Promise(r => setTimeout(r, 400));
        const d2 = window.__probe.drawer();
        const val = (label) => {
          if (!d2) return '（无抽屉）';
          const f = [...d2.querySelectorAll('.field')].find(x =>
            ((x.querySelector('.field-label') || {}).textContent || '').trim().startsWith(label));
          if (!f) return '（无此字段）';
          const c = f.querySelector('input, select, textarea');
          return c ? c.value : '（无控件）';
        };
        return 'filled: 名称=' + val('公司名称') + ' 行业=' + val('行业') + ' 联系人=' + val('姓名') + ' 字段数=' + (d2 ? d2.querySelectorAll('.field').length : 0);
      })()`);
      const saveClick = await cdp.js(`window.__probe.clickFoot('保存')`);

      /* 轮询等待保存完成，避免固定等待造成"已落库但抽屉未关"的假失败 */
      let state = null;
      for (let i = 0; i < 24; i++) {
        await sleep(400);
        const st = await cdp.js(`JSON.stringify(window.__probe.state())`);
        state = JSON.parse(st);
        if (!state.drawerOpen) break;
        if (state.hasDupPanel) break;
      }
      await sleep(300);
      if (!state.drawerOpen) {
        state = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      }

      const row = db.prepare('SELECT id, name FROM customers WHERE name = ?').get(name);
      if (row) createdIds.push(row.id);

      return { title, fill, saveClick, state, saved: !!row, errors: cdp.errors.slice(0, 3) };
    }

    /* ---------- A. 只填公司名称 ---------- */
    const A = `【闪退复现${tag}】只填必填`;
    const ra = await scenario('A. 只填公司名称 → 保存', A, `
      window.__probe.setText('公司名称', ${JSON.stringify(A)});
    `);
    if (ra) {
      check('A. 只填公司名称：保存成功且抽屉关闭',
        ra.saved && !ra.state.drawerOpen && ra.errors.length === 0,
        `落库=${ra.saved}，抽屉仍开=${ra.state.drawerOpen}，提示=${ra.state.toasts.join('/')}，JS错误=${ra.errors.join(' | ') || '无'}`);
    }

    /* ---------- B. 填常用字段 ---------- */
    const B = `【闪退复现${tag}】全字段`;
    const BPhone = `0991-${tag}-b`;
    const rb = await scenario('B. 填常用字段（含地址与归属地州）→ 保存', B, `
      window.__probe.setText('公司名称', ${JSON.stringify(B)});
      window.__probe.setSelect('行业', '石油');
      window.__probe.setSelect('客户来源', '展会');
      window.__probe.setText('姓名', '全字段联系人');
      window.__probe.setText('手机', ${JSON.stringify(BPhone)});
      window.__probe.setText('省 / 自治区', '新疆维吾尔自治区');
      window.__probe.setText('市 / 地区', '乌鲁木齐市');
      window.__probe.setText('区 / 县', '天山区');
      window.__probe.setText('详细地址', '天山区测试路 1 号');
      window.__probe.setSelect('归属地州', '650100');
      window.__probe.setText('定期提醒天数', '30');
    `);
    if (rb) {
      check('B. 全字段：保存成功且抽屉关闭',
        rb.saved && !rb.state.drawerOpen && rb.errors.length === 0,
        `填报=${rb.fill}；落库=${rb.saved}，提示=${rb.state.toasts.join('/')}，JS错误=${rb.errors.join(' | ') || '无'}`);
      if (rb.saved) {
        const row = db.prepare('SELECT city, district, address, region_code, contact_name, follow_cycle_days FROM customers WHERE name = ?').get(B);
        check('B. 全字段：地址 / 归属 / 主联系人 / 回访周期正确落库',
          row && row.address === '天山区测试路 1 号' && row.region_code === '650100'
            && row.contact_name === '全字段联系人' && row.follow_cycle_days === 30,
          row ? `地址="${row.address}" 归属=${row.region_code} 联系人=${row.contact_name} 周期=${row.follow_cycle_days}` : '未找到');
      }
    }

    /* ---------- C. 同名（触发查重） ---------- */
    const rc = await scenario('C. 与已有客户同名 → 保存', existing.name, `
      window.__probe.setText('公司名称', ${JSON.stringify(existing.name)});
    `);
    if (rc) {
      check('C. 同名：出现查重面板，抽屉不关闭、不闪退',
        rc.state.drawerOpen && rc.state.hasDupPanel && rc.errors.length === 0,
        `抽屉仍开=${rc.state.drawerOpen}，查重面板=${rc.state.hasDupPanel}，JS错误=${rc.errors.join(' | ') || '无'}`);
    }

    /* ---------- D. 同主联系人手机（触发查重） ---------- */
    const rd = await scenario('D. 与已有客户同手机 → 保存', `【闪退复现${tag}】同电话`, `
      window.__probe.setText('公司名称', '【闪退复现${tag}】同电话');
      window.__probe.setSelect('行业', '石油');
      window.__probe.setText('姓名', '同电话联系人');
      window.__probe.setText('手机', ${JSON.stringify(existing.phone)});
    `);
    if (rd) {
      check('D. 同手机：出现查重面板，抽屉不关闭、不闪退',
        rd.state.drawerOpen && rd.state.hasDupPanel && rd.errors.length === 0,
        `抽屉仍开=${rd.state.drawerOpen}，查重面板=${rd.state.hasDupPanel}，JS错误=${rd.errors.join(' | ') || '无'}`);
      const dupActions = await cdp.js(`(async () => {
        const d = window.__probe.drawer();
        if (!d) return { err: '抽屉已关闭' };
        const btns = [...d.querySelectorAll('button')].map(b => b.textContent.trim());
        const view = [...d.querySelectorAll('button')].find(b => b.textContent.includes('查看这条记录'));
        return { btns, hasView: !!view };
      })()`);
      check('D. 查重面板按钮齐全（查看记录 / 继续创建）',
        !dupActions.err && dupActions.hasView
        && dupActions.btns.some((t) => t.includes('继续') || t.includes('创建')),
        dupActions.err || '按钮：' + dupActions.btns.join(' / '));
    }

    /* ---------- D2. 同手机命中多家：逐条渲染 ---------- */
    {
      const bulkPhone = `0991-${tag}-9`;
      for (let i = 1; i <= 3; i++) {
        const r = await mk({
          name: `【闪退复现${tag}】同电话${i}`,
          short_name: `同话${i}${tag}`,
          industry: '石油', contact_name: `同话联系人${i}`, contact_phone: bulkPhone
        });
        if (r && r.id) createdIds.push(r.id);
      }
      const multiName = `【同话核对${tag}】待录入`;
      const multi = await scenario('D2. 同手机命中多条 → 查重面板', multiName, `
        window.__probe.setText('公司名称', ${JSON.stringify(multiName)});
        window.__probe.setSelect('行业', '石油');
        window.__probe.setText('姓名', '同话核对联系人');
        window.__probe.setText('手机', ${JSON.stringify(bulkPhone)});
      `);
      const dupApi = await (await fetch(
        `${BASE}/api/customers/check-duplicate?name=${encodeURIComponent(multiName)}&phone=${encodeURIComponent(bulkPhone)}`
      )).json();
      const apiCount = (dupApi && dupApi.data && dupApi.data.length) || 0;
      const dbCount = db.prepare(
        'SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND contact_phone = ?'
      ).get(bulkPhone).n;
      check('D2. 前置条件：库中确有 3 家同手机客户',
        dbCount >= 3 && apiCount >= 3,
        `库中同手机 ${dbCount} 家，服务端查重返回 ${apiCount} 条`);

      if (multi) {
        const cards = await cdp.js(`(() => {
          const d = window.__probe.drawer();
          if (!d) return { err: '抽屉已关闭' };
          const cs = [...d.querySelectorAll('.mini-card')];
          return {
            count: cs.length,
            names: cs.map(c => ((c.querySelector('.nm') || {}).textContent || '').replace(/\\s+/g,' ').trim()),
            allHaveBtn: cs.every(c => [...c.querySelectorAll('button')].some(b => b.textContent.includes('查看这条记录'))),
            matches: cs.map(c => ((c.querySelector('.tag') || {}).textContent || '').trim())
          };
        })()`);
        const phoneCards = (cards.matches || []).filter((m) => m === '同手机').length;
        check('D2. 命中多条重复时逐条渲染（每家重复各成一张独立卡片）',
          !cards.err && cards.count === apiCount - 1 && phoneCards === cards.count && cards.count >= 3 && cards.allHaveBtn,
          cards.err || `服务端查重 ${apiCount} 条（含刚保存的这条自己）→ 界面 ${cards.count} 张卡片，全部为「同手机」命中且每张都带查看按钮`);
      }
    }

    /* ---------- E. 不填必填就保存（应被拦住） ---------- */
    cdp.clearErrors();
    await cdp.js(`location.hash = '#/customers'; 'ok'`);
    await sleep(2200);
    await cdp.js(HELPERS);
    const re = await (async () => {
      await cdp.js(`window.__probe.openDrawer()`);
      await cdp.js(`window.__probe.clickFoot('保存')`);
      await sleep(1500);
      return JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
    })();
    check('E. 缺必填：被校验拦住，抽屉保持打开',
      re.drawerOpen && cdp.errors.length === 0,
      `抽屉仍开=${re.drawerOpen}，提示=${re.toasts.join('/')}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- F. 填一半关闭再打开 ---------- */
    cdp.clearErrors();
    const rf = await (async () => {
      await cdp.js(`(() => { const d = window.__probe.drawer(); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x.click(); } return 'ok'; })()`);
      await sleep(1200);
      await cdp.js(`window.__probe.openDrawer()`);
      await cdp.js(`window.__probe.setText('公司名称', '【闪退复现${tag}】半途')`);
      await sleep(400);
      const mid = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      await cdp.js(`(() => { const d = window.__probe.drawer(); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x.click(); } return 'ok'; })()`);
      await sleep(1000);
      await cdp.js(`window.__probe.openDrawer()`);
      await sleep(600);
      const nm = await cdp.js(`(() => { const f = window.__probe.field('公司名称'); const i = f && f.querySelector('input'); return i ? i.value : '（未取到）'; })()`);
      return { mid, reopenedValue: nm };
    })();
    check('F. 填一半关闭再打开：表单已重置且无异常',
      rf.reopenedValue === '' && cdp.errors.length === 0,
      `重开后公司名称="${rf.reopenedValue}"，JS错误=${cdp.errors.join(' | ') || '无'}`);

    check('全程无 JS 运行时异常', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 3).join('\n    ') : '0 条');

    cdp.ws.close();
  } finally {
    for (const id of [...new Set(createdIds.filter(Boolean))]) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【闪退复现${tag}】%`);
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【同话核对${tag}】%`);
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ? OR name LIKE ?')
      .get(`【闪退复现${tag}】%`, `【同话核对${tag}】%`).n;
    check('测试数据已清理', left === 0, `残留 ${left} 条`);
    db.close();
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'customer-create-crash-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
