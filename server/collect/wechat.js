/**
 * 微信公众号文章抓取（零依赖）
 *
 * 为什么能做：公众号文章页 `https://mp.weixin.qq.com/s?...` 是**公开页面**，
 * 拿到链接就能读到正文，不需要登录、不需要任何凭据。
 * 难的是"发现新文章"，所以本模块只负责**把给定的链接抓下来**，
 * 发现环节交给使用者粘贴链接或订阅 RSS（见 rss.js）。
 *
 * 合规边界（写死在实现里）：
 *   - 只抓公开可访问的文章页；不带 Cookie、不绕登录、不做验证码绕过
 *   - 命中"环境异常 / 需要验证"这类风控页 → 立即返回 blocked，由调用方停止本轮
 *   - 单次请求带超时与体积上限；请求间隔由调用方控制（service.js 里统一限速）
 *
 * 正文抽取：微信正文在 `<div id="js_content">` 容器里，用**标签配对扫描**取出整块
 * （不能用正则硬切，正文里有大量嵌套 div），再交给 mail.htmlToText 转纯文本。
 */
'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const mail = require('./mail.js');

/** 只接受公众号文章链接（贴错了要明确告诉使用者，而不是抓一堆乱码回来） */
const ARTICLE_HOSTS = ['mp.weixin.qq.com', 'mp.weixin.qq.com.cn'];

/**
 * 额外的允许主机：设置项 `wechat_extra_hosts`（逗号分隔，**默认留空**）。
 *
 * 什么情况下会用到：自己搭了公众号内容的镜像/中转站（内网域名或 IP），
 * 想让软件抓那上面的文章。默认空 = 只认微信官方域名。
 * 测试套件也用它：起一个本地 http 服务模拟"公众号文章页"，
 * 这样正文抽取、风控识别、限速、去重、入库跑的都是**真实代码路径**。
 */
const EXTRA_HOSTS_SETTING = 'wechat_extra_hosts';

function readExtraHosts(db) {
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(EXTRA_HOSTS_SETTING);
    return r && r.value ? String(r.value).split(',').map((s) => s.trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

/** 判断是不是公众号文章链接（extraHosts 由调用方从设置项读出后传入） */
function isWechatUrl(url, extraHosts) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const hosts = ARTICLE_HOSTS.concat(extraHosts || []);
    return hosts.includes(u.hostname) || hosts.includes(u.host);
  } catch (_) {
    return false;
  }
}

/* 单篇上限：公众号文章图文混排，正文 HTML 动辄几 MB（图片标签、内联样式），
   3MB 会把很多文章挡在门外 —— 这是本地软件，放宽到 20MB 更实际。 */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** 被判为"风控页"的特征（出现即停止本轮，不硬闯） */
const BLOCK_MARKS = [
  '环境异常', '去验证', '请输入验证码', '访问过于频繁', '操作频繁',
  '请稍后再试', '当前环境异常', 'weui-msg__title'
];
/** 被判为"内容不可用"的特征（这是单篇的问题，不停止整轮） */
const GONE_MARKS = [
  '该内容已被发布者删除', '此内容因违规无法查看', '内容已被删除',
  '参数错误', '该内容已过期', '此内容发送失败无法查看'
];

/** 归一化：去掉无意义的追踪参数，保留 __biz/mid/idx/sn 这些定位参数 */
function normalizeUrl(url) {
  const u = new URL(String(url).trim());
  u.hash = '';
  const keep = ['__biz', 'mid', 'idx', 'sn', 'chksm', 'scene', 'srcid', 'mpshare', 'sharer_sharetime', 'sharer_shareid'];
  const params = [...u.searchParams.entries()].filter(([k]) => keep.includes(k));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

/**
 * 极简 HTTP(S) 客户端：跟随重定向、限制体积、带浏览器 UA。
 * 不用任何第三方库，与 imap.js 手写 TLS 的思路一致。
 */
function httpGet(url, opt) {
  const o = opt || {};
  const timeout = o.timeout || 15000;
  const depth = o.depth || 0;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('链接格式不对')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        /* 用普通浏览器 UA：不是为了伪装，而是很多站点对空 UA 直接拒绝 */
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'close'
      },
      timeout
    }, (res) => {
      /* 重定向 */
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (depth >= MAX_REDIRECTS) return reject(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, u).toString();
        return httpGet(next, Object.assign({}, o, { depth: depth + 1 })).then(resolve, reject);
      }

      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          return reject(new Error(`页面过大（已超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB），已中止抓取`));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        size,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', (e) => reject(new Error('网络请求失败：' + (e.message || e))));
    req.end();
  });
}

/**
 * 从 HTML 里取某个 div（按 id）的整块内容。
 * 做法：找到带该 id 的开始标签，然后**按标签配对**往后扫，直到配平。
 * 这样嵌套 div 不会被截断（正则做不到这一点）。
 */
function sliceDivById(html, id) {
  const src = String(html);
  const re = new RegExp('<div[^>]*\\bid\\s*=\\s*["\']' + id + '["\'][^>]*>', 'i');
  const m = re.exec(src);
  if (!m) return '';
  const start = m.index;
  let i = start;
  let depth = 0;
  /* 顺序扫描 div 的开合标签 */
  const tagRe = /<(\/?)div\b[^>]*?(\/?)>/gi;
  tagRe.lastIndex = start;
  let t;
  while ((t = tagRe.exec(src)) !== null) {
    const closing = t[1] === '/';
    const selfClosed = t[2] === '/';
    if (selfClosed) continue;
    if (closing) {
      depth--;
      i = tagRe.lastIndex;
      if (depth === 0) return src.slice(start, i);
    } else {
      depth++;
    }
    if (tagRe.lastIndex > src.length) break;
  }
  /* 没配平（页面被截断）时退化为取到末尾 */
  return src.slice(start);
}

/** 从 meta 或指定 id 的元素里取文本 */
function pickMeta(html, prop) {
  const re = new RegExp('<meta[^>]*\\b(?:property|name)\\s*=\\s*["\']' + prop + '["\'][^>]*\\bcontent\\s*=\\s*["\']([^"\']*)["\']', 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

function pickMetaReverse(html, prop) {
  /* content 写在 property 前面的写法 */
  const re = new RegExp('<meta[^>]*\\bcontent\\s*=\\s*["\']([^"\']*)["\'][^>]*\\b(?:property|name)\\s*=\\s*["\']' + prop + '["\']', 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

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

/** 取元素的纯文本（先按 id 取块，再剥标签） */
function textById(html, id) {
  const block = sliceDivById(html, id) || '';
  return mail.htmlToText(block);
}

/** 发布时间：微信页里有 `var ct = "1730000000"`（秒级时间戳） */
function pickPublishTime(html) {
  const m = String(html).match(/var\s+ct\s*=\s*["'](\d{9,13})["']/);
  if (m) {
    const n = Number(m[1]);
    const d = new Date(n > 1e12 ? n : n * 1000);
    if (!Number.isNaN(d.getTime())) return fmtDate(d);
  }
  const t = textById(html, 'publish_time');
  const m2 = String(t).match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (m2) {
    const p = (x) => String(x).padStart(2, '0');
    return `${m2[1]}-${p(m2[2])}-${p(m2[3])}`;
  }
  return '';
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 解析文章 HTML（抽标题/公众号/发布时间/正文）。
 * 单独导出，便于测试直接喂真实形态的 HTML 验证解析，不必联网。
 * @returns {{ ok:boolean, blocked?:boolean, gone?:boolean, title?, account?, publish_time?, text?, html?, error? }}
 */
function parseArticleHtml(html, url) {
  const src = String(html || '');
  const head = src.slice(0, 6000);

  /* 风控页：整体停下来 */
  if (BLOCK_MARKS.some((k) => head.includes(k) || src.slice(0, 20000).includes(k))) {
    return { ok: false, blocked: true, url, error: '微信提示访问异常（需要验证），已停止本次抓取' };
  }
  /* 文章不可用：这一篇的问题 */
  if (GONE_MARKS.some((k) => src.includes(k))) {
    return { ok: false, gone: true, url, error: '文章已删除或不可访问' };
  }

  const contentHtml = sliceDivById(src, 'js_content');
  const text = mail.htmlToText(contentHtml);

  const title = pickMeta(src, 'og:title') || pickMetaReverse(src, 'og:title')
    || textById(src, 'activity-name') || '';
  const account = pickMeta(src, 'og:article:author') || pickMetaReverse(src, 'og:article:author')
    || (src.match(/var\s+nickname\s*=\s*["']([^"']+)["']/) || [])[1]
    || textById(src, 'js_name') || '';
  const publishTime = pickPublishTime(src);

  if (!text || text.length < 30) {
    return {
      ok: false, gone: true, url,
      title, account, publish_time: publishTime,
      error: '没取到正文（可能是动态加载页、已删除，或该文章不含文字内容）'
    };
  }

  return {
    ok: true,
    url,
    title: String(title).trim(),
    account: String(account).trim(),
    publish_time: publishTime,
    text,
    html: contentHtml
  };
}

/**
 * 抓取并解析一篇文章。
 *
 * @returns {{
 *   ok: boolean, blocked?: boolean, gone?: boolean,
 *   url: string, title?: string, account?: string, publish_time?: string,
 *   text?: string, html?: string, error?: string
 * }}
 *   - blocked=true 表示命中风控页 —— 调用方应当**立即停止本轮**（不要继续请求）
 *   - gone=true 表示文章已删除/不可见 —— 只是这一篇不行，可继续处理别的
 */
async function fetchArticle(url, opt) {
  const o = opt || {};
  const raw = String(url || '').trim();
  if (!isWechatUrl(raw, o.extraHosts)) {
    return { ok: false, url: raw, error: '不是微信公众号文章链接（应以 https://mp.weixin.qq.com/s 开头）' };
  }
  const target = normalizeUrl(raw);

  let res;
  try {
    res = await httpGet(target, { timeout: o.timeout || 15000 });
  } catch (e) {
    return { ok: false, url: target, error: e.message || String(e) };
  }

  const parsed = parseArticleHtml(res.body || '', target);
  if (!parsed.ok) return parsed;
  if (res.status !== 200) {
    return { ok: false, url: target, error: `页面返回状态 ${res.status}` };
  }
  /* 带上页面字节数：排查工具要显示"这篇多大"，也便于判断要不要再放宽上限 */
  parsed.bytes = res.size || 0;
  return parsed;
}

module.exports = {
  isWechatUrl,
  normalizeUrl,
  fetchArticle,
  parseArticleHtml,
  httpGet,
  sliceDivById,
  decodeEntities,
  pickPublishTime,
  readExtraHosts,
  ARTICLE_HOSTS,
  EXTRA_HOSTS_SETTING,
  MAX_BYTES,
  BLOCK_MARKS,
  GONE_MARKS
};
