/**
 * 登录页脚本 —— 1.25
 *
 * 纯原生 JS + fetch，不依赖 Vue（登录页要在最小依赖下也能打开）。
 * 流程：
 *   1. 先查 /api/auth/status：未启用登录 / 已登录 → 直接进首页（不会循环跳转）
 *   2. 提交 /api/auth/login：成功 → location.replace('/index.html')
 *      401 → 提示还剩几次机会；423 → 显示锁定剩余时间并倒计时；403 → IP 白名单拦截
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  /* 跟随主应用里选的主题（默认浅色），登录页也要跟着变，不然进系统会闪一下 */
  try {
    const saved = localStorage.getItem('crm_theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (_) { /* 隐私模式下读不到 localStorage，用默认浅色 */ }

  const form = $('login-form');
  const userEl = $('username');
  const passEl = $('password');
  const errEl = $('error');
  const btn = $('submit');

  let lockTimer = null;

  function showMsg(text, kind) {
    errEl.textContent = text;
    errEl.className = 'msg' + (kind ? ' ' + kind : '');
    errEl.hidden = false;
  }

  function clearMsg() {
    errEl.hidden = true;
    errEl.textContent = '';
    errEl.className = 'msg';
  }

  function setBusy(busy, text) {
    btn.disabled = !!busy;
    btn.textContent = busy ? (text || '登录中…') : '登录';
  }

  function goHome() {
    window.location.replace('/index.html');
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  async function fetchStatus() {
    const res = await fetch('/api/auth/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin'
    });
    const j = await readJson(res);
    return { res, j };
  }

  /** 锁定倒计时：期间按钮不可点，提示剩余分钟/秒 */
  function startLock(remainingSec) {
    let left = Math.max(1, Number(remainingSec) || 900);
    if (lockTimer) clearInterval(lockTimer);

    const render = () => {
      if (left <= 0) {
        clearInterval(lockTimer);
        lockTimer = null;
        setBusy(false);
        showMsg('锁定已解除，可以重新输入密码登录。', 'info');
        passEl.focus();
        return;
      }
      const minutes = Math.ceil(left / 60);
      showMsg(`密码连续错误次数过多，账号已锁定。剩余约 ${minutes} 分钟（${left} 秒）后可重试。`, 'warn');
      btn.disabled = true;
      btn.textContent = `已锁定 · ${minutes} 分钟后可重试`;
      left -= 1;
    };
    render();
    lockTimer = setInterval(render, 1000);
  }

  /** 进入页面的第一件事：判断要不要显示登录框 */
  async function boot() {
    let res;
    let j;
    try {
      ({ res, j } = await fetchStatus());
    } catch (_) {
      showMsg('无法连接本地服务，请确认「启动.bat」的黑色窗口仍在运行。');
      setBusy(false);
      return;
    }

    if (res.status === 403) {
      showMsg((j && j.message) || '当前 IP 不在允许访问的范围内，请在本机调整 IP 白名单。');
      setBusy(false);
      return;
    }
    if (!res.ok || !j || j.ok !== true) {
      showMsg((j && j.message) || '读取登录状态失败，请刷新页面重试。');
      setBusy(false);
      return;
    }

    const st = j.data || {};
    if (!st.auth_enabled) {
      /* 未启用登录：登录页没有意义，直接回首页 */
      goHome();
      return;
    }
    if (st.logged_in) {
      goHome();
      return;
    }
    if (st.lock && st.lock.remaining_sec > 0) startLock(st.lock.remaining_sec);
    else { setBusy(false); passEl.focus(); }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (lockTimer) return;                 // 锁定期间不接受提交
    clearMsg();

    const username = String(userEl.value || '').trim() || 'admin';
    const password = String(passEl.value || '');
    if (!password) {
      showMsg('请输入密码。');
      passEl.focus();
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify({ username, password })
      });
      const j = await readJson(res);

      if (res.ok && j && j.ok === true) {
        btn.textContent = '登录成功，正在进入…';
        goHome();
        return;
      }

      const code = (j && j.code) || '';
      const message = (j && j.message) || `登录失败（HTTP ${res.status}）`;

      if (res.status === 423 || code === 'AUTH_LOCKED') {
        /* 从 status 拿准确的剩余秒数；拿不到就按 15 分钟起步 */
        let sec = 900;
        try {
          const { j: sj } = await fetchStatus();
          if (sj && sj.ok && sj.data && sj.data.lock) sec = sj.data.lock.remaining_sec || sec;
        } catch (_) { /* 忽略 */ }
        startLock(sec);
        passEl.value = '';
        return;
      }

      if (res.status === 403) {
        showMsg(message, 'warn');
      } else if (res.status === 400 && code === 'AUTH_DISABLED') {
        goHome();
        return;
      } else {
        showMsg(message);
      }
      passEl.value = '';
      passEl.focus();
    } catch (_) {
      showMsg('无法连接本地服务，请确认服务窗口仍在运行后重试。');
    } finally {
      if (!lockTimer) setBusy(false);
    }
  });

  /* 从「退出登录」回来时避免浏览器缓存表单状态 */
  passEl.value = '';

  /* 登录页也注册 Service Worker：这样即使还没登录，也能把站点「安装为桌面应用」 */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  boot();
})();
