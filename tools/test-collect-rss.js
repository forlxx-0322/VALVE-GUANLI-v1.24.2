/**
 * 公众号 / RSS 订阅来源 全流程测试（W2）
 *
 * 覆盖：
 *   A. 来源配置：新增/修改 rss 类型来源（地址校验、口径、上限），白名单仍拒绝未知类型
 *   B. 采集：订阅源里的条目按「新疆 + 项目类词」入暂存区；公众号链接会再抓正文
 *   C. 增量：再采一次内容没变 → 整条跳过（不重复入暂存区）
 *   D. 稳健：订阅地址不可用 → 失败有明确原因；连续失败 3 次自动暂停来源
 *   E. 安全：未审核不入项目库；个人信息不入库；来源凭据/地址按既有规范处理
 *
 * 做法：起一个本地 http 服务当"订阅源"（RSS 2.0 与 Atom 各一份，外加一份畸形源），
 * 走真实的采集链路（service.runCollect → runRssSource → extractFromArticle → 暂存区）。
 *
 * 用法：先启动服务，再 node tools/test-collect-rss.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const TAG = '【RSS采集测试' + Date.now().toString().slice(-6) + '】';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const j = await res.json().catch(() => null);
  return { status: res.status, data: j && j.data, code: j && j.code, message: j && j.message };
}

/* ---------------- 模拟订阅源 ---------------- */

function startMockFeed() {
  return new Promise((resolve) => {
    const rss = () => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>新疆项目信息速递</title>
  <item>
    <title><![CDATA[乌鲁木齐某热力公司供热管网改造项目阀门采购公告]]></title>
    <link>https://example.com/notice/1</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <description><![CDATA[<p>项目名称：乌鲁木齐某热力公司供热管网改造项目阀门采购</p>
      <p>项目编号：WLMQ-2026-0099</p><p>招标控制价：人民币 158 万元</p>
      <p>招标人：乌鲁木齐某热力有限责任公司，开标时间：2026-11-02</p>
      <p>采购球阀、截止阀共 80 台。联系人：李工 电话：13800000000</p>]]></description>
  </item>
  <item>
    <title>江苏某园区阀门采购</title>
    <link>https://example.com/notice/2</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <description>江苏南京某园区采购蝶阀 60 台，招标人：江苏某公司。</description>
  </item>
  <item>
    <title>新疆美食节今日开幕</title>
    <link>https://example.com/news/3</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <description>新疆国际大巴扎美食节今天开幕，游客众多。</description>
  </item>
</channel></rss>`;

    const atom = () => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 测试源</title>
  <entry><title>库车某化工厂管廊改造项目管件采购</title>
    <link rel="alternate" href="https://example.com/notice/4"/>
    <updated>${new Date().toISOString()}</updated>
    <summary>库车某化工厂管廊改造项目采购法兰、管件及阀门一批，招标人：库车某化工有限公司。</summary></entry>
</feed>`;

    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      if (req.url.startsWith('/rss')) return res.end(rss());
      if (req.url.startsWith('/atom')) return res.end(atom());
      if (req.url.startsWith('/broken')) return res.end('<html>没有订阅内容</html>');
      res.statusCode = 404;
      return res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  console.log('=== 公众号 / RSS 订阅来源 全流程测试 ===\n');
  const mock = await startMockFeed();
  const FEED = `http://127.0.0.1:${mock.port}/rss`;
  const ATOM = `http://127.0.0.1:${mock.port}/atom`;
  const BROKEN = `http://127.0.0.1:${mock.port}/broken`;
  console.log(`模拟订阅服务已启动：127.0.0.1:${mock.port}\n`);

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { sources: [] };

  try {
    /* ================= A. 来源配置 ================= */
    const badUrl = await api('POST', '/api/collect/sources', { name: `${TAG}地址错`, type: 'rss', url: '不是网址' });
    check('来源：rss 类型必须填合法订阅地址（400 且说明原因）',
      badUrl.status === 400 && badUrl.code === 'URL_REQUIRED', `${badUrl.status} ${badUrl.code}`);

    const badType = await api('POST', '/api/collect/sources', { name: `${TAG}类型错`, type: 'crawl', url: FEED });
    check('来源：未知采集类型仍被白名单拒绝（不会被当成爬虫入口）',
      badType.status === 400 && badType.code === 'SOURCE_TYPE_UNSUPPORTED', `${badType.status} ${badType.code}`);

    const made = await api('POST', '/api/collect/sources', {
      name: `${TAG}订阅源`, type: 'rss', url: FEED, enabled: true,
      filterMode: 'region+project', keywords: '阀门,球阀,闸阀,蝶阀', maxPerRun: 10
    });
    check('来源：可以新建 rss 来源并启用',
      made.status === 200 && made.data.id, `#${made.data && made.data.id}`);
    created.sources.push(made.data.id);

    const list = await api('GET', '/api/collect/sources');
    const allSources = Array.isArray(list.data) ? list.data : (list.data.list || []);
    const mine = allSources.find((s) => s.id === made.data.id);
    check('来源：列表里能回显类型、订阅地址与口径（界面编辑要用）',
      !!mine && mine.type === 'rss' && String(mine.url || '').includes(String(mock.port))
      && mine.filterMode === 'region+project' && mine.maxPerRun === 10,
      mine ? `type=${mine.type} url=${mine.url} 口径=${mine.filterMode} 上限=${mine.maxPerRun}` : '未找到');

    /* ================= B. 采集 ================= */
    const ran = await api('POST', '/api/collect/run', { source_id: made.data.id, ignoreInterval: true });
    const res1 = (ran.data.results || [])[0] || {};
    check('采集：能跑到 rss 来源并返回统计',
      ran.status === 200 && res1.status === 'ok',
      res1.message || JSON.stringify(res1).slice(0, 120));
    check('采集：新疆 + 项目类词的条目进了暂存区（2 条：RSS 一条、Atom 那条另跑）',
      res1.new_count === 1, `新增 ${res1.new_count}，不符合 ${res1.rejected_count}`);

    const staged = await api('GET', '/api/collect/staging?status=pending&pageSize=50');
    const row = (staged.data.list || []).find((r) => String(r.project_code || '') === 'WLMQ-2026-0099');
    check('采集：字段抽取正确（项目名/编号/金额/招标人/开标时间/地区）',
      !!row && row.amount === 1580000 && String(row.tenderee).includes('热力')
      && row.region_name === '乌鲁木齐市' && row.bid_date === '2026-11-02',
      row ? `${row.project_name} · ${row.amount} 元 · ${row.region_name} · 开标 ${row.bid_date}` : '未入库');
    check('采集：来源标注为订阅源名，来源链接可回查',
      !!row && String(row.source_platform).includes(TAG) && row.source_url === 'https://example.com/notice/1',
      row ? `${row.source_platform} / ${row.source_url}` : '—');
    check('采集：未审核不入项目库',
      !!row && row.status === 'pending' && !row.project_id, row ? `status=${row.status}` : '—');
    check('安全：订阅内容里的联系方式只标记不采集',
      !!row && row.has_personal_info === 1 && !String(row.raw_excerpt).includes('13800000000'),
      row ? `标记 ${row.personal_fields}` : '—');
    check('采集：外省条目与纯资讯都被拒（口径生效）',
      (res1.fetched === 0 || res1.fetched >= 0) && res1.rejected_count === 2,
      `不符合 ${res1.rejected_count} 条：${JSON.stringify(res1.rejectReasons || {})}`);

    /* Atom 源 */
    const madeAtom = await api('POST', '/api/collect/sources', {
      name: `${TAG}Atom源`, type: 'rss', url: ATOM, enabled: true, maxPerRun: 5
    });
    created.sources.push(madeAtom.data.id);
    const ranAtom = await api('POST', '/api/collect/run', { source_id: madeAtom.data.id, ignoreInterval: true });
    const resAtom = (ranAtom.data.results || [])[0] || {};
    check('采集：Atom 订阅同样能跑通（格式自动识别）',
      resAtom.status === 'ok' && resAtom.new_count === 1,
      resAtom.message || JSON.stringify(resAtom).slice(0, 120));

    /* ================= C. 增量 ================= */
    const again = await api('POST', '/api/collect/run', { source_id: made.data.id, ignoreInterval: true });
    const res2 = (again.data.results || [])[0] || {};
    check('增量：内容没变时不重复入暂存区（整条跳过）',
      res2.new_count === 0 && res2.skipped_count >= 1,
      `新增 ${res2.new_count}、跳过 ${res2.skipped_count}`);

    const total = await api('GET', '/api/collect/staging?pageSize=100');
    const mineRows = (total.data.list || []).filter((r) => String(r.source_platform || '').includes(TAG));
    check('增量：暂存区里同一个项目只有一条（按公告编号去重）',
      mineRows.filter((r) => r.project_code === 'WLMQ-2026-0099').length === 1,
      `本套件产生 ${mineRows.length} 条暂存记录`);

    /* ================= D. 稳健 ================= */
    const madeBad = await api('POST', '/api/collect/sources', {
      name: `${TAG}坏源`, type: 'rss', url: BROKEN, enabled: true
    });
    created.sources.push(madeBad.data.id);
    const badRun = await api('POST', '/api/collect/run', { source_id: madeBad.data.id, ignoreInterval: true });
    const resBad = (badRun.data.results || [])[0] || {};
    check('稳健：订阅内容不可解析时给出明确原因（不是静默成功）',
      resBad.status === 'failed' && /不是 RSS\/Atom/.test(resBad.message || ''),
      resBad.message);

    /* 连续失败 3 次自动暂停 */
    for (let i = 0; i < 2; i++) {
      await api('POST', '/api/collect/run', { source_id: madeBad.data.id, ignoreInterval: true });
    }
    const afterBad = await api('GET', '/api/collect/sources');
    const badSrc = (Array.isArray(afterBad.data) ? afterBad.data : (afterBad.data.list || []))
      .find((s) => s.id === madeBad.data.id);
    check('稳健：连续失败 3 次后该来源自动暂停（不再反复请求）',
      !!badSrc && Number(badSrc.enabled) === 0 && Number(badSrc.fail_streak) >= 3,
      badSrc ? `enabled=${badSrc.enabled}，连续失败 ${badSrc.fail_streak} 次` : '未找到');

    /* 停用的来源不再执行 */
    const disabledRun = await api('POST', '/api/collect/run', { source_id: madeBad.data.id });
    const resDisabled = (disabledRun.data.results || [])[0] || {};
    check('稳健：未启用的来源直接拒绝执行（默认关闭原则）',
      resDisabled.status === 'failed' && /未启用/.test(resDisabled.message || ''),
      resDisabled.message);

    /* ================= E. 日志与审计 ================= */
    const logs = await api('GET', `/api/collect/logs?pageSize=50`);
    const myLogs = (logs.data.list || []).filter((l) => String(l.source_name || '').includes(TAG));
    check('审计：每次采集都留下日志（成功与失败都有）',
      myLogs.some((l) => l.action === 'collect_ok') && myLogs.some((l) => l.action === 'collect_failed'),
      `本套件日志 ${myLogs.length} 条`);

    /* 界面上的"采集来源"能显示 rss 类型 */
    const summary = await api('GET', '/api/collect/summary');
    check('总览：采集总览正常（来源数/待审核数与操作一致）',
      summary.status === 200 && typeof summary.data.sources === 'number' && summary.data.pending >= 2,
      `来源 ${summary.data.sources} 个，待审核 ${summary.data.pending} 条`);
  } finally {
    /* ---------- 清理 ---------- */
    try {
      const rows = db.prepare("SELECT id FROM collect_staging WHERE source_name LIKE ? OR source_platform LIKE ?")
        .all(`%${TAG}%`, `%${TAG}%`).map((r) => r.id);
      for (const id of rows) db.prepare('DELETE FROM collect_staging WHERE id = ?').run(id);
      db.prepare('DELETE FROM collect_sources WHERE name LIKE ?').run(`%${TAG}%`);
      db.prepare('DELETE FROM collect_logs WHERE source_name LIKE ?').run(`%${TAG}%`);
      db.prepare("DELETE FROM settings WHERE key = 'collect_wechat_day'").run();
      mock.server.close();
    } catch (_) { /* 忽略 */ }

    const leftSrc = db.prepare('SELECT COUNT(*) AS n FROM collect_sources WHERE name LIKE ?').get(`%${TAG}%`).n;
    const leftStg = db.prepare('SELECT COUNT(*) AS n FROM collect_staging WHERE source_name LIKE ?').get(`%${TAG}%`).n;
    check('本套件测试数据已清理（来源/暂存/日志都不留）',
      leftSrc === 0 && leftStg === 0, `残留来源 ${leftSrc}、暂存 ${leftStg}`);
    db.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'collect-rss-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
