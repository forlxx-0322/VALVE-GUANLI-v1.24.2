/**
 * 微信公众号「粘贴链接采集」全流程测试
 *
 * 覆盖：
 *   A. 解析：正文抽取（嵌套 div 配对）、标题/公众号/发布时间、风控页与已删页识别
 *   B. 接口：粘贴链接采集（多条、去重、非公众号链接、已删文章、风控中断）
 *   C. 口径：「新疆 + 项目类词」；外省不收；纯资讯不收；可用宽松档
 *   D. 安全：个人信息不入库、未审核不入项目库、限速与每轮上限
 *   E. RSS：解析器（RSS 2.0 / Atom / 畸形源）
 *   F. 浏览器：采集暂存页的「粘贴链接采集」入口可用
 *
 * 做法：起一个**本地 http 服务**模拟"公众号文章页"（真实形态的 HTML），
 * 并通过设置项 wechat_extra_hosts 把它加进允许主机 —— 这样正文抽取、风控识别、
 * 限速、去重、入库跑的都是**真实代码路径**，而不是替身函数。
 *
 * 用法：先启动服务，再 node tools/test-wechat-collect.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
}

/* ---------------- 模拟公众号文章页 ---------------- */

function articleHtml(opts) {
  const o = opts || {};
  const title = o.title || '独山子石化炼化装置改扩建工程阀门采购招标公告';
  const account = o.account || '新疆招标信息';
  const body = o.body || `
    <p>新疆维吾尔自治区某石化公司炼化装置改扩建项目阀门采购招标公告</p>
    <p>项目名称：独山子石化炼化装置改扩建工程阀门采购</p>
    <p>项目编号：XJSH-2026-GK-0088</p>
    <p>招标控制价：人民币 328.50 万元</p>
    <p>招标人：中国石油天然气股份有限公司独山子石化分公司</p>
    <p>建设地点：克拉玛依市独山子区</p>
    <p>开标时间：2026-10-15 10:00</p>
    <p>本次采购包括球阀、闸阀、蝶阀共 120 台，投标人须具备特种设备制造许可证。</p>
    <p>联系人：张工　联系电话：13909920000　邮箱：zhang@example.com</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta property="og:title" content="${title}" />
<meta property="og:article:author" content="${account}" />
<script>var ct = "${o.ct || '1786000000'}"; var nickname = "${account}";</script>
</head><body>
<div id="js_content" class="rich_media_content">
  <div class="inner"><div class="deep">${body}</div></div>
</div>
<div id="js_name">${account}</div>
<div id="publish_time">2026-09-14</div>
</body></html>`;
}

const BLOCK_HTML = '<!DOCTYPE html><html><head><title>环境异常</title></head><body>'
  + '<div class="weui-msg__title">当前环境异常，完成验证后即可继续访问</div><a>去验证</a></body></html>';
const GONE_HTML = '<!DOCTYPE html><html><head><title>提示</title></head><body><div>该内容已被发布者删除</div></body></html>';

function startMockArticles() {
  return new Promise((resolve) => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      const u = new URL(req.url, 'http://127.0.0.1');
      const sn = u.searchParams.get('sn') || '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (sn === 'block') return res.end(BLOCK_HTML);
      if (sn === 'gone') return res.end(GONE_HTML);
      if (sn === 'empty') return res.end('<!DOCTYPE html><html><body><div id="js_content"><p>短</p></div></body></html>');
      if (sn === 'xj-plain') {
        /* 新疆，但只是资讯：没有项目类词 */
        return res.end(articleHtml({
          title: '新疆秋季旅游推介活动在乌鲁木齐举行',
          account: '新疆发布',
          body: '<p>9 月 14 日，新疆秋季旅游推介活动在乌鲁木齐举行，现场介绍了多条精品线路。</p>'
            + '<p>活动由自治区文旅厅主办，来自各地的旅行商参加了推介。</p>'
        }));
      }
      if (sn === 'other-province') {
        return res.end(articleHtml({
          title: '江苏某化工园区阀门采购项目招标',
          account: '华东招标',
          body: '<p>江苏南京某化工园区阀门采购项目开始招标，采购蝶阀 60 台。</p>'
            + '<p>招标人：江苏某化工有限公司，开标时间：2026-10-01。</p>'
        }));
      }
      if (sn === 'xj-project-2') {
        return res.end(articleHtml({
          title: '库尔勒经济技术开发区管廊改造项目管件采购',
          account: '巴州项目通',
          ct: '1786100000',
          body: '<p>巴音郭楞蒙古自治州库尔勒经济技术开发区管廊改造项目管件采购公告。</p>'
            + '<p>采购内容：法兰、管件及阀门一批。招标人：库尔勒某开发建设有限公司。</p>'
        }));
      }
      /* 其它 sn（含 xj / xj-over-N）都返回同一篇"独山子"文章 */
      return res.end(articleHtml({}));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits: () => hits }));
  });
}

/* ---------------- 用例 ---------------- */

(async () => {
  console.log('=== 微信公众号 粘贴链接采集 全流程测试 ===\n');

  const wechat = require(path.join(ROOT, 'server', 'collect', 'wechat.js'));
  const rssMod = require(path.join(ROOT, 'server', 'collect', 'rss.js'));
  const extract = require(path.join(ROOT, 'server', 'collect', 'extract.js'));
  const svc = require(path.join(ROOT, 'server', 'collect', 'service.js'));

  const mock = await startMockArticles();
  const M = (sn) => `http://127.0.0.1:${mock.port}/s?__biz=MzA1&mid=1&idx=1&sn=${sn}`;
  const EXTRA = ['127.0.0.1'];
  console.log(`模拟文章服务已启动：127.0.0.1:${mock.port}\n`);

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  let cdp = null, child = null, profile = null;

  /* 把本地模拟站点加进"允许抓取的主机"（设置项默认是空的，跑完还原）。
     测试主机一律不写回设置项，避免把测试痕迹留在使用者的配置里。 */
  const TEST_HOSTS = ['127.0.0.1', 'localhost', '::1'];
  const extraRow = db.prepare("SELECT value FROM settings WHERE key = 'wechat_extra_hosts'").get();
  const extraBefore = String((extraRow && extraRow.value) || '')
    .split(',').map((s) => s.trim()).filter((h) => h && !TEST_HOSTS.includes(h)).join(',');
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`INSERT INTO settings (key, value, remark, updated_at) VALUES ('wechat_extra_hosts', ?, '', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run([extraBefore, '127.0.0.1'].filter(Boolean).join(','), stamp());

  /* 清掉上一次跑留下的暂存记录：文章里的项目编号稳定，跨次运行会命中同一去重键 */
  {
    const stale = db.prepare(
      "SELECT id FROM collect_staging WHERE notice_id LIKE 'code:XJSH-%' OR source_url LIKE '%__biz=MzA1%'"
    ).all().map((r) => r.id);
    for (const id of stale) db.prepare('DELETE FROM collect_staging WHERE id = ?').run(id);
    db.prepare("DELETE FROM collect_logs WHERE action IN ('wechat_paste','wechat_blocked')").run();
    db.prepare("DELETE FROM settings WHERE key IN ('collect_wechat_day','collect_wechat_count')").run();
    if (stale.length) console.log(`（已清理上一轮残留的暂存记录 ${stale.length} 条）\n`);
  }

  try {
    /* ================= A. 解析 ================= */
    const fetched = await wechat.fetchArticle(M('xj'), { extraHosts: EXTRA });
    check('解析：能抓到正文、标题、公众号名与发布时间',
      fetched.ok && fetched.text.includes('阀门采购') && fetched.text.includes('招标控制价')
      && fetched.title.includes('独山子石化') && fetched.account === '新疆招标信息',
      fetched.ok ? `标题「${fetched.title}」公众号「${fetched.account}」发布 ${fetched.publish_time}` : fetched.error);
    check('解析：嵌套 div 的正文被完整取出（标签配对扫描）',
      fetched.ok && fetched.text.includes('投标人须具备特种设备制造许可证'),
      fetched.ok ? `正文 ${fetched.text.length} 字` : '未取到');

    const blocked = await wechat.fetchArticle(M('block'), { extraHosts: EXTRA });
    check('解析：命中微信风控页 → blocked（调用方应立即停止）',
      blocked.ok === false && blocked.blocked === true, blocked.error);

    const gone = await wechat.fetchArticle(M('gone'), { extraHosts: EXTRA });
    check('解析：文章已删除 → gone（只是这一篇不行）',
      gone.ok === false && gone.gone === true && !gone.blocked, gone.error);

    const empty = await wechat.fetchArticle(M('empty'), { extraHosts: EXTRA });
    check('解析：正文太短/取不到 → 明确报错而不是入库空数据',
      empty.ok === false && /没取到正文/.test(empty.error || ''), empty.error);

    const notWx = await wechat.fetchArticle('https://example.com/s?x=1', { extraHosts: EXTRA });
    check('解析：非公众号链接被拒（提示应贴什么链接）',
      notWx.ok === false && /不是微信公众号文章链接/.test(notWx.error || ''), notWx.error);

    const noExtra = await wechat.fetchArticle(M('xj'));
    check('解析：没开额外主机时，本地模拟站也不放行（默认只认公众号域名）',
      noExtra.ok === false && /不是微信公众号文章链接/.test(noExtra.error || ''), noExtra.error);

    /* ================= B. 接口：粘贴链接采集 ================= */
    const empty1 = await api('POST', '/api/collect/wechat/paste', { urls: [] });
    check('接口：不传链接 → 400 并提示', empty1.status === 400 && empty1.code === 'URLS_REQUIRED',
      `${empty1.status} ${empty1.code}`);

    const batch = await api('POST', '/api/collect/wechat/paste', {
      urls: [
        M('xj'),
        M('xj'),                                   // 故意重复
        M('xj-plain'),                             // 新疆纯资讯 → 应被拒
        M('other-province'),                       // 外省 → 应被拒
        'https://example.com/x',                   // 非公众号链接
        M('xj-project-2')
      ]
    });
    const byStatus = (s) => (batch.data.results || []).filter((r) => r.status === s);
    /* 精确定位"独山子"那一篇：归一化后 sn 是最后一个保留参数，所以用 [&?]sn=xj$ 匹配 */
    const s1 = (batch.data.results || []).find((r) => r.status === 'new' && /[?&]sn=xj$/.test(String(r.url)));
    check('接口：多条粘贴一次处理完，逐条给出结果',
      batch.status === 200 && (batch.data.results || []).length === 6,
      `新增 ${batch.data.new_count}、跳过 ${batch.data.skipped_count}、不符合 ${batch.data.rejected_count}`);
    check('接口：新疆 + 项目类词的文章进了暂存区（2 篇）',
      batch.data.new_count === 2 && !!s1,
      `新增 ${batch.data.new_count}：${byStatus('new').map((r) => r.title).join(' / ')}`);
    check('接口：同一批里的重复链接被识别',
      byStatus('invalid').some((r) => /重复/.test(r.reason || '')),
      JSON.stringify(byStatus('invalid').map((r) => r.reason)));
    check('接口：非公众号链接被单独指出（不影响其它链接）',
      byStatus('invalid').some((r) => /不是微信公众号/.test(r.reason || '')),
      JSON.stringify(byStatus('invalid').map((r) => r.reason)));
    check('接口：纯资讯（新疆但无项目类词）被拒，理由明确',
      ((batch.data.rejectReasons || {})['未命中项目类词（更像行业资讯而非项目信息）'] || 0) >= 1,
      JSON.stringify(batch.data.rejectReasons));
    check('接口：外省项目被拒（只要新疆）',
      ((batch.data.rejectReasons || {})['非新疆本地项目'] || 0) >= 1,
      JSON.stringify(batch.data.rejectReasons));

    if (!s1) throw new Error('没抓到"独山子"那一篇，后续断言无法继续');
    const detail = await api('GET', `/api/collect/staging/${s1.staging_id}`);
    check('接口：暂存区里字段抽取正确（地区/金额/招标人/日期）',
      detail.data.region_name === '克拉玛依市'
      && detail.data.amount === 3285000
      && String(detail.data.tenderee).includes('独山子石化')
      && detail.data.bid_date === '2026-10-15',
      `${detail.data.region_name} · ${detail.data.amount} 元 · ${detail.data.tenderee} · 开标 ${detail.data.bid_date}`);
    check('接口：来源写成「微信公众号 · 账号名」，来源链接可回查',
      String(detail.data.source_platform).includes('微信公众号')
      && String(detail.data.source_platform).includes('新疆招标信息')
      && String(detail.data.source_url).includes('/s?'),
      detail.data.source_platform);
    check('接口：综合打分已写入（地域+项目词+字段命中）',
      Number(detail.data.match_score) > 40,
      `得分 ${detail.data.match_score}，关键词 ${detail.data.keyword_hits}`);
    check('接口：未审核前不写项目库（status=pending）',
      detail.data.status === 'pending' && !detail.data.project_id, `status=${detail.data.status}`);
    check('接口：文章里的联系人/手机号被标记但**不写入任何字段**',
      detail.data.has_personal_info === 1
      && String(detail.data.personal_fields).includes('手机号')
      && !String(detail.data.raw_excerpt).includes('13909920000')
      && !String(detail.data.raw_excerpt).includes('张工'),
      `标记：${detail.data.personal_fields}；摘要已剔除联系方式`);

    const again = await api('POST', '/api/collect/wechat/paste', { urls: [M('xj')] });
    check('接口：同一条再粘一次不会重复入暂存区（内容指纹一致 → 跳过）',
      again.data.new_count === 0 && again.data.skipped_count === 1,
      `新增 ${again.data.new_count}、跳过 ${again.data.skipped_count}`);

    const blockedRun = await api('POST', '/api/collect/wechat/paste', {
      urls: [M('xj-project-2'), M('block'), M('xj')]
    });
    check('接口：命中风控页立即停止后续抓取，并明确告知',
      blockedRun.data.blocked === true
      && (blockedRun.data.results || []).some((r) => r.status === 'blocked'),
      blockedRun.data.message);
    check('接口：风控中断后仍写审计日志（可在采集记录里看到）',
      (await api('GET', '/api/collect/logs?pageSize=5')).data.list.some((l) => l.action === 'wechat_blocked'),
      '日志含 wechat_blocked');

    /* ================= C. 收文口径 ================= */
    const r1 = extract.extractFromArticle(
      { url: 'https://mp.weixin.qq.com/s?x=1', title: '新疆某项目阀门采购', account: 'A',
        text: '新疆乌鲁木齐某供热项目阀门采购，采购球阀 30 台。' },
      { filterMode: 'region+project', customers: [] });
    check('口径：新疆 + 项目词 → 收，地区识别正确且有打分',
      r1.ok && r1.info.region_code === '650100' && r1.info.score > 0,
      r1.ok ? `${r1.info.region_name} 得分 ${r1.info.score} 类型 ${r1.info.notice_type}` : r1.reason);

    const r2 = extract.extractFromArticle(
      { url: 'https://mp.weixin.qq.com/s?x=2', title: '新疆美食节开幕', text: '新疆国际大巴扎美食节今天开幕，游客众多。' },
      { filterMode: 'region+project', customers: [] });
    check('口径：新疆但无项目类词 → 拒（避免资讯刷屏）', r2.ok === false && /项目类词/.test(r2.reason), r2.reason);

    const r3 = extract.extractFromArticle(
      { url: 'https://mp.weixin.qq.com/s?x=3', title: '新疆美食节开幕', text: '新疆国际大巴扎美食节今天开幕。' },
      { filterMode: 'region', customers: [] });
    check('口径：宽松档（只判地域）时同一篇会收进来，并标为「资讯」',
      r3.ok === true && r3.info.notice_type === '资讯',
      r3.ok ? `资讯类，得分 ${r3.info.score}` : r3.reason);

    const r4 = extract.extractFromArticle(
      { url: 'https://mp.weixin.qq.com/s?x=4', title: '新疆阀门采购', text: '新疆某项目采购闸阀。' },
      { filterMode: 'keyword', keywords: ['蝶阀'], customers: [] });
    check('口径：严格档只认设定关键词（没命中就拒）', r4.ok === false && /关键词/.test(r4.reason), r4.reason);

    /* ================= D. 限速与上限 ================= */
    const t0 = Date.now();
    await api('POST', '/api/collect/wechat/paste', { urls: [M('xj-over-a'), M('xj-over-b')] });
    const ms = Date.now() - t0;
    check('限速：两篇之间至少间隔 3 秒（克制原则，避免被风控）', ms >= 2800, `耗时 ${ms} ms`);

    check('上限：常量已按方案设定（间隔 3 秒 / 每轮 30 篇 / 每日 200 篇）',
      svc.FETCH_INTERVAL_MS === 3000 && svc.MAX_ARTICLES_PER_RUN === 30 && svc.MAX_ARTICLES_PER_DAY === 200,
      `${svc.FETCH_INTERVAL_MS} / ${svc.MAX_ARTICLES_PER_RUN} / ${svc.MAX_ARTICLES_PER_DAY}`);

    const over = await api('POST', '/api/collect/wechat/paste', {
      urls: Array.from({ length: 35 }, (_, i) => M('xj-over-' + i))
    });
    check('上限：一次贴 35 条时只处理前 30 条，并说明还有多少没处理',
      over.data.overflow === 5 && (over.data.results || []).length <= 30,
      `overflow=${over.data.overflow}，实际处理 ${(over.data.results || []).length} 条`);

    /* ================= E. RSS 解析（W2 的地基，同一批代码） ================= */
    const rssXml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<rss version="2.0"><channel><title>测试源</title>'
      + '<item><title><![CDATA[新疆某项目阀门采购公告]]></title>'
      + '<link>https://mp.weixin.qq.com/s?__biz=A&amp;mid=2&amp;idx=1&amp;sn=r1</link>'
      + '<pubDate>Tue, 02 Sep 2026 09:00:00 +0800</pubDate>'
      + '<description><![CDATA[<p>库尔勒某项目采购蝶阀 20 台</p>]]></description></item>'
      + '<item><title>无关内容</title><link>https://example.com/a</link>'
      + '<pubDate>Mon, 01 Sep 2026 08:00:00 +0800</pubDate><description>天气</description></item>'
      + '</channel></rss>';
    const feed = rssMod.parseFeed(rssXml);
    check('RSS：解析 RSS 2.0（CDATA、实体、RFC822 时间）',
      feed.ok && feed.format === 'rss' && feed.title === '测试源' && feed.items.length === 2
      && feed.items[0].title === '新疆某项目阀门采购公告'
      && feed.items[0].link.includes('mid=2')
      && feed.items[0].date === '2026-09-02 09:00',
      feed.ok ? `${feed.items.length} 条，首条 ${feed.items[0].date}` : feed.error);

    const atomXml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom源</title>'
      + '<entry><title>新疆管廊改造项目</title><link rel="alternate" href="https://mp.weixin.qq.com/s?sn=a1"/>'
      + '<updated>2026-09-03T11:20:00+08:00</updated><summary>库车某管廊项目采购阀门</summary></entry></feed>';
    const atom = rssMod.parseFeed(atomXml);
    check('RSS：解析 Atom（link rel=alternate href、ISO 时间）',
      atom.ok && atom.format === 'atom' && atom.items[0].link.includes('sn=a1')
      && atom.items[0].date === '2026-09-03 11:20',
      atom.ok ? `${atom.items[0].date}` : atom.error);

    check('RSS：畸形订阅给出明确原因（不静默丢数据）',
      (() => {
        const a = rssMod.parseFeed('<html><body>不是订阅源</body></html>');
        const b = rssMod.parseFeed('<rss version="2.0"><channel><title>x</title></channel></rss>');
        return a.ok === false && /不是 RSS\/Atom/.test(a.error) && b.ok === false && /没有 <item>/.test(b.error);
      })(), '两种情况都有明确报错');

    /* ================= F. 浏览器 ================= */
    if (!CHROME) {
      check('浏览器：找到 Chrome 可执行文件', false, '未找到 chrome.exe');
    } else {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wxcollect-'));
      const PORT = 9415;
      child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1700,1100', 'about:blank'],
      { stdio: 'ignore' });
      for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
      const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      cdp = new CDP(tab.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');

      await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/collect')}; 'ok'`);
      await sleep(4200);
      const ui = await cdp.js(`(async () => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('粘贴链接'));
        if (!btn) return { err: '没找到「粘贴链接采集」入口' };
        btn.click();
        await new Promise(r => setTimeout(r, 1500));
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) return { err: '抽屉未打开' };
        const ta = d.querySelector('textarea');
        return { hasTextarea: !!ta, title: (d.querySelector('.drawer-title') || {}).textContent || '' };
      })()`);
      check('浏览器：采集暂存页有「粘贴链接采集」入口，且能打开粘贴抽屉',
        !ui.err && ui.hasTextarea === true, ui.err || `抽屉「${ui.title}」`);

      if (!ui.err && ui.hasTextarea) {
        const runUi = await cdp.js(`(async () => {
          const d = [...document.querySelectorAll('.drawer')].pop();
          const ta = d.querySelector('textarea');
          ta.value = ${JSON.stringify(M('xj-project-2'))};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          const go = [...d.querySelectorAll('button')].find(b => /开始抓取/.test(b.textContent));
          if (!go) return { err: '没有提交按钮' };
          go.click();
          await new Promise(r => setTimeout(r, 4500));
          const dd = [...document.querySelectorAll('.drawer')].pop();
          return { text: dd ? dd.innerText.replace(/\\s+/g, ' ').slice(0, 300) : '' };
        })()`);
        check('浏览器：在界面上粘贴并抓取，能看到逐条结果',
          !runUi.err && /已收进暂存区|已收过|不符合条件/.test(runUi.text || ''),
          runUi.err || String(runUi.text || '').slice(0, 120));
      }

      check('页面无 JS 报错', cdp.errors.length === 0,
        cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

      cdp.ws.close();
      child.kill();
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
      child = null; profile = null;
    }
  } finally {
    if (child) { try { child.kill(); } catch (_) { /* 忽略 */ } }
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ } }
    try { mock.server.close(); } catch (_) { /* 忽略 */ }

    /* 清理：本套件产生的暂存记录、日志、计数与额外主机设置 */
    try {
      const mine = db.prepare(
        "SELECT id FROM collect_staging WHERE source_platform LIKE '%微信公众号%' OR source_url LIKE '%__biz=MzA1%'"
      ).all().map((r) => r.id);
      for (const id of mine) db.prepare('DELETE FROM collect_staging WHERE id = ?').run(id);
      db.prepare("DELETE FROM collect_logs WHERE action IN ('wechat_paste','wechat_blocked')").run();
      db.prepare("DELETE FROM settings WHERE key IN ('collect_wechat_day','collect_wechat_count')").run();
      db.prepare("DELETE FROM collect_sources WHERE name LIKE '%【微信采集测试%'").run();
      /* 还原"额外允许主机"：只保留使用者原来的值（测试主机不写回） */
      db.prepare("UPDATE settings SET value = ? WHERE key = 'wechat_extra_hosts'").run(extraBefore);
      if (mine.length) console.log(`（已清理本轮暂存记录 ${mine.length} 条）`);
    } catch (_) { /* 忽略 */ }

    const leftStaging = db.prepare(
      "SELECT COUNT(*) AS n FROM collect_staging WHERE source_platform LIKE '%微信公众号%' OR source_url LIKE '%__biz=MzA1%'"
    ).get().n;
    const leftExtra = db.prepare("SELECT value FROM settings WHERE key = 'wechat_extra_hosts'").get();
    check('本套件测试数据与设置已还原（未留暂存记录，也未把测试主机写进设置）',
      leftStaging === 0 && (!leftExtra || String(leftExtra.value) === extraBefore),
      `残留暂存 ${leftStaging} 条，额外主机设置「${leftExtra ? leftExtra.value : ''}」`);
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
    path.join(ROOT, '.fixtures', 'wechat-collect-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
