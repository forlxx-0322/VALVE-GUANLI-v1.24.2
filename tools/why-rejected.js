/**
 * 排查工具：这条公众号链接为什么没被收下？
 *
 * 用法：
 *   node tools/why-rejected.js <公众号文章链接>
 *   node tools/why-rejected.js <链接> --force     同时演示"人工仍收下"会得到什么
 *
 * 它会把抓取与判定过程摊开给你看：
 *   抓取是否成功（页面多大、耗时多久、是否命中风控/已删）
 *   正文抽到多少字、标题与公众号名
 *   地域判定（命中哪个地州 / 只提到"新疆" / 完全没命中）
 *   项目类词与阀门词各命中了哪些
 *   最终判定与原因；若被拒，还会告诉你"哪一条规则卡住了"
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const url = process.argv[2];
const SHOW_FORCE = process.argv.includes('--force');

if (!url) {
  console.error('用法：node tools/why-rejected.js <公众号文章链接> [--force]');
  process.exit(2);
}

const wechat = require(path.join(ROOT, 'server', 'collect', 'wechat.js'));
const extract = require(path.join(ROOT, 'server', 'collect', 'extract.js'));

(async () => {
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'), { readOnly: true });
  const extraHosts = wechat.readExtraHosts(db);
  const customers = db.prepare(
    'SELECT id, name, short_name, end_user, design_institute, region_code FROM customers WHERE deleted_at IS NULL'
  ).all();

  console.log('=== 排查：这条链接为什么没收下 ===\n');
  console.log('链接：', url);
  console.log('允许主机：', wechat.ARTICLE_HOSTS.concat(extraHosts).join('、'));

  const t0 = Date.now();
  const art = await wechat.fetchArticle(url, { extraHosts, timeout: 20000 });
  const ms = Date.now() - t0;

  if (!art.ok) {
    console.log(`\n✗ 抓取失败（耗时 ${ms} ms）：${art.error}`);
    if (art.blocked) console.log('  → 这是微信风控页：稍后再试，或减少一次抓取的篇数');
    if (art.gone) console.log('  → 文章已删除/不可访问，或正文没取到（可能是动态加载页）');
    if (/过大/.test(art.error || '')) {
      console.log(`  → 页面超过 ${Math.round(wechat.MAX_BYTES / 1024 / 1024)}MB 上限。`);
      console.log('     可以把 server/collect/wechat.js 里的 MAX_BYTES 再调大（本地软件，内存够）。');
    }
    db.close();
    process.exit(1);
  }

  const text = String(art.text || '');
  const title = String(art.title || '');
  const hay = title + '\n' + text;
  const sizeText = art.bytes >= 1024 * 1024
    ? `${(art.bytes / 1024 / 1024).toFixed(1)} MB`
    : (art.bytes >= 1024 ? `${Math.round(art.bytes / 1024)} KB` : `${art.bytes || 0} B`);
  console.log(`\n✓ 抓取成功：耗时 ${ms} ms，页面 ${sizeText}，正文 ${text.length} 字`);
  console.log(`  标题：${title || '(无)'}`);
  console.log(`  公众号：${art.account || '(未取到)'}    发布时间：${art.publish_time || '(未取到)'}`);

  /* 逐条规则摊开 */
  const region = extract.pickRegion(hay);
  const judge = extract.judgeXinjiangArticle(region, hay);
  const projectHits = extract.pickProjectHits(hay);
  const valveHits = extract.VALVE_KEYWORDS.filter((k) => hay.includes(k));

  console.log('\n--- 判定明细 ---');
  console.log(`地域：${region ? `${region.name}（${region.code}）` : '没命中新疆地州'}`
    + `  档位=${judge.level === 'region' ? '命中地州' : (judge.level === 'province' ? '仅提到"新疆"' : '无新疆痕迹')}`
    + (judge.others.length ? `  另提及：${judge.others.join('、')}` : ''));
  console.log(`项目类词（${projectHits.length}）：${projectHits.slice(0, 15).join('、') || '（一个都没命中）'}`);
  console.log(`阀门词（${valveHits.length}）：${valveHits.join('、') || '（一个都没命中）'}`);

  const r = extract.extractFromArticle(
    { url: art.url, title: art.title, account: art.account, publish_time: art.publish_time, text: art.text },
    { sourceName: '（排查工具）', customers, filterMode: 'region+project', requireXinjiang: true }
  );

  console.log('\n--- 结论 ---');
  if (r.ok) {
    console.log(`✓ 应当被收下：地区=${r.info.region_name}，类型=${r.info.notice_type}，得分=${r.info.score}`);
    console.log(`  得分构成：${r.info.score_note}`);
    console.log(`  抓到的字段：项目名=${r.info.project_name || '—'}，编号=${r.info.project_code || '—'}，`
      + `金额=${r.info.amount == null ? '—' : r.info.amount + ' 元'}，招标人=${r.info.tenderee || '—'}`);
  } else {
    console.log(`✗ 被拒：${r.reason}`);
    const hint = {
      '非新疆本地项目': '文章里没有任何新疆地名，也没提到"新疆"二字 —— 若确实是新疆项目，用界面上的「仍收下」',
      '未命中项目类词（更像行业资讯而非项目信息）': '文章没提到项目/工程/采购/招标这类词 —— 纯资讯可用来源的"只要新疆"档，或点「仍收下」',
      '未命中设定关键词': '来源口径设成了"只认关键词"，但文章里没有你设的那些词',
      '文章内容为空': '没抽到正文',
      '缺少原文链接，无法溯源': '链接没带上'
    }[r.reason];
    if (hint) console.log(`  → ${hint}`);
    if (SHOW_FORCE) {
      const forced = extract.buildForcedInfo(
        { url: art.url, title: art.title, account: art.account, publish_time: art.publish_time, text: art.text },
        { sourceName: '（排查工具）', customers, reason: r.reason }
      );
      console.log('\n（人工"仍收下"会这样入库）');
      console.log(`  标题=${forced.title}`);
      console.log(`  类型=${forced.notice_type}  地区=${forced.region_name || '—'}`);
      console.log(`  摘要首行=${String(forced.raw_excerpt).split('\n')[0]}`);
    }
  }

  console.log('\n--- 正文前 300 字（确认抽到的是不是真正文）---');
  console.log(text.slice(0, 300).replace(/\n{2,}/g, '\n'));
  db.close();
})().catch((e) => {
  console.error('排查失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
