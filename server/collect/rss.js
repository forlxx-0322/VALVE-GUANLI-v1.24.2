/**
 * RSS / Atom 订阅解析（零依赖）
 *
 * 为什么自己写：本项目坚持"不装任何第三方包"，Node 内置也没有 XML 解析器。
 * RSS 2.0 与 Atom 的结构都很规整，用**受控的标签扫描 + 实体解码**足够可靠；
 * 关键是把边界情况处理干净，而不是追求通用 XML：
 *   - CDATA（`<![CDATA[ ... ]]>`）
 *   - 命名空间前缀（`content:encoded`、`dc:date`）
 *   - 自闭合标签、属性里的引号
 *   - 实体（含 `&#x...;` 十六进制）
 * 解析失败一律返回明确原因（不要静默丢数据）。
 *
 * 本模块只负责"发现"：把订阅源里的条目读出来（标题/链接/时间/摘要）。
 * 正文抓取交给 wechat.js（公众号链接）或直接用源里给的摘要/全文。
 */
'use strict';

const { httpGet } = require('./wechat.js');

const DEFAULT_MAX_ITEMS = 30;

/** 解实体（与 wechat.js 同一套，保持行为一致） */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** 去掉 CDATA 包装并解实体、去首尾空白 */
function textOf(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).trim();
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) s = cdata[1];
  return decodeEntities(s.trim());
}

/** 取第一个匹配标签的内容（支持命名空间前缀，如 content:encoded） */
function pickTag(xml, names) {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('<' + esc + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + esc + '\\s*>', 'i');
    const m = re.exec(xml);
    if (m) {
      const v = textOf(m[1]);
      if (v) return v;
    }
  }
  return '';
}

/** 取属性值（如 <link href="..."/>、<enclosure url="..."/>） */
function pickAttr(tagText, attr) {
  const re = new RegExp('\\b' + attr + '\\s*=\\s*["\']([^"\']*)["\']', 'i');
  const m = re.exec(String(tagText || ''));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** 把一段 XML 按标签切块（用于 item / entry） */
function splitBlocks(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** 解析日期：RSS 用 RFC822（Tue, 03 Jun 2025 09:00:00 +0800），Atom 用 ISO8601 */
function parseDate(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 解析 RSS 2.0 / Atom。
 * @returns {{ ok:boolean, format?:'rss'|'atom', title?:string, items?:Array, error?:string }}
 *   items: [{ title, link, date, summary, content }]
 */
function parseFeed(xml, opt) {
  const o = opt || {};
  const max = Math.min(Math.max(Number(o.maxItems) || DEFAULT_MAX_ITEMS, 1), 200);
  const src = String(xml || '').trim();
  if (!src) return { ok: false, error: '订阅内容为空' };
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(src)) {
    return { ok: false, error: '看起来不是 RSS/Atom 订阅源（没有 <rss> / <feed> 根标签）' };
  }

  const isAtom = /<feed[\s>]/i.test(src) && !/<rss[\s>]/i.test(src);
  const blocks = isAtom ? splitBlocks(src, 'entry') : splitBlocks(src, 'item');
  if (!blocks.length) {
    return { ok: false, error: isAtom ? 'Atom 里没有 <entry> 条目' : 'RSS 里没有 <item> 条目' };
  }

  const feedTitle = (() => {
    /* channel/title（RSS）或 feed/title（Atom）：取第一个 title 即可 */
    const m = src.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i);
    return m ? textOf(m[1]) : '';
  })();

  const items = [];
  for (const b of blocks) {
    const link = (() => {
      /* Atom：<link rel="alternate" href="..."/>；RSS：<link>...</link> */
      const tags = b.match(/<link\b[^>]*\/?>/gi) || [];
      for (const t of tags) {
        const rel = pickAttr(t, 'rel');
        const href = pickAttr(t, 'href');
        if (href && (!rel || rel === 'alternate')) return href;
      }
      const inner = pickTag(b, ['link']);
      if (inner) return inner;
      /* RSS 的 guid 常常就是文章链接 */
      return pickTag(b, ['guid']);
    })();

    const title = pickTag(b, ['title']);
    const date = parseDate(pickTag(b, ['pubDate', 'published', 'updated', 'dc:date', 'date']));
    const summary = pickTag(b, ['description', 'summary', 'content:encoded', 'content']);
    const content = pickTag(b, ['content:encoded', 'content']);

    if (!link && !title) continue;
    items.push({
      title,
      link,
      date,
      summary: summary.slice(0, 2000),
      content: content.slice(0, 20000)
    });
    if (items.length >= max) break;
  }

  if (!items.length) return { ok: false, error: '订阅源里没有可用条目（缺标题也缺链接）' };
  return { ok: true, format: isAtom ? 'atom' : 'rss', title: feedTitle, items };
}

/** 拉取并解析订阅源 */
async function fetchFeed(url, opt) {
  const o = opt || {};
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, error: '订阅地址必须以 http:// 或 https:// 开头' };

  let res;
  try {
    res = await httpGet(raw, { timeout: o.timeout || 15000 });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  if (res.status !== 200) return { ok: false, error: `订阅地址返回状态 ${res.status}` };

  const parsed = parseFeed(res.body, { maxItems: o.maxItems });
  if (!parsed.ok) return parsed;
  return Object.assign(parsed, { url: raw, feedUrl: raw });
}

module.exports = {
  parseFeed,
  fetchFeed,
  decodeEntities,
  textOf,
  parseDate,
  DEFAULT_MAX_ITEMS
};
