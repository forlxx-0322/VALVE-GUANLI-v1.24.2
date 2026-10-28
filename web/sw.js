/**
 * Service Worker —— 只为"安装成桌面应用"服务
 *
 * 目的：
 *   1. 让浏览器认为站点可安装（Chromium 要求有 manifest + 带 fetch 的 SW）；
 *   2. 打开应用时静态资源走缓存，秒开；接口一律走网络（数据必须实时）。
 *
 * 策略（刻意保守，避免升级后看到旧页面）：
 *   · /api/*、/login.html、/index.html、manifest、sw.js 本身 → 永远走网络
 *   · css/js/vendor/图片 → 网络优先，成功就顺手更新缓存；断网时回退缓存
 *
 * 这个文件不参与任何业务逻辑，删掉也不影响系统运行（只是"安装为应用"入口会消失）。
 */
'use strict';

const CACHE = 'crm-shell-v1';
const STATIC_RE = /\.(css|js|png|jpg|jpeg|svg|ico|woff2?|ttf)$/i;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([
    '/index.html',
    '/login.html',
    '/css/app.css',
    '/css/login.css'
  ]).catch(() => undefined)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  /* 接口、页面入口、清单、SW 自身：不缓存 */
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/' || url.pathname.endsWith('.html')) return;
  if (url.pathname.endsWith('manifest.webmanifest') || url.pathname.endsWith('/sw.js')) return;
  if (!STATIC_RE.test(url.pathname)) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
      }
      return res;
    } catch (e) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw e;
    }
  })());
});
