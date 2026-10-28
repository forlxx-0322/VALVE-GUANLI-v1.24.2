/**
 * 登录路由 —— 1.25
 *
 *   GET  /api/auth/status    登录与异地访问状态（不需要会话）
 *   POST /api/auth/login     { username, password } → 成功下发 crm_session Cookie
 *   POST /api/auth/logout    清 Cookie + 审计
 *   POST /api/auth/password  { old_password, new_password } → 改密后旧会话全部失效
 *
 * 约定与其它路由一致：返回 { ok:true, data } 或 { ok:false, status, code, message }，
 * 由 server.js 统一套 HTTP 响应。
 */

'use strict';

const auth = require('../services/auth');

module.exports = async function authRoutes(ctx) {
  const { db, method, pathname, body, req, res } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api' || segments[1] !== 'auth') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const sub = segments[2] || '';
  const ip = auth.clientIp(req);
  const ua = auth.userAgent(req);

  /* ---------------- 状态 ---------------- */
  if (sub === 'status' && (method === 'GET' || method === 'HEAD')) {
    return ok(auth.authStatus(db, req, { bindAddress: ctx.bindAddress }));
  }

  /* ---------------- 登录 ---------------- */
  if (sub === 'login' && method === 'POST') {
    const s = auth.readSettings(db);
    if (s.auth_enabled !== '1') {
      return fail(400, 'AUTH_DISABLED', '当前未启用登录，直接打开首页即可');
    }
    /* 白名单已在中间件拦过，这里再挡一次（防止以后调整中间件顺序出错） */
    if (s.auth_ip_allow && !auth.isIpAllowed(ip, s.auth_ip_allow)) {
      return fail(403, 'IP_NOT_ALLOWED', '当前 IP 不在允许访问的范围内');
    }

    /* 锁定期间：正确密码也返回 423，且不消耗新的失败次数 */
    const locked = auth.lockRemainingSec(db, ip);
    if (locked > 0) {
      const minutes = Math.max(1, Math.ceil(locked / 60));
      auth.audit(db, 'login_failed', `登录被拒绝（锁定中）：IP ${ip}，剩余约 ${minutes} 分钟`, {
        ip, ua, result: 'locked', remaining_sec: locked
      });
      return fail(423, 'AUTH_LOCKED', `密码连续错误次数过多，账号已锁定，请 ${minutes} 分钟后再试（剩余 ${locked} 秒）`);
    }

    const username = String((body && body.username) || '').trim() || String(s.auth_user || 'admin');
    const password = String((body && body.password) || '');
    const expectedUser = String(s.auth_user || 'admin');

    /* 用户名与密码都校验；密码始终走一遍 scrypt，避免用响应时间判断用户名是否存在 */
    const userOk = username === expectedUser;
    const passOk = auth.verifyPassword(password, s.auth_pass_hash);

    if (!(userOk && passOk)) {
      const r = auth.recordFailure(db, ip);
      if (r.locked) {
        const minutes = Math.max(1, Math.ceil(r.remaining / 60));
        auth.audit(db, 'login_failed',
          `登录失败并锁定：${username} 来自 ${ip}（连续错误 ${r.count} 次，锁定 ${minutes} 分钟）`,
          { ip, ua, username, result: 'locked', count: r.count, remaining_sec: r.remaining });
        return fail(423, 'AUTH_LOCKED',
          `密码连续错误 ${r.count} 次，已锁定 ${minutes} 分钟，请稍后再试（剩余 ${r.remaining} 秒）`);
      }
      const left = Math.max(0, auth.LOCK_FAILS - r.count);
      auth.audit(db, 'login_failed',
        `登录失败：${username} 来自 ${ip}（第 ${r.count} 次，剩余 ${left} 次机会）`,
        { ip, ua, username, result: 'fail', count: r.count });
      return fail(401, 'AUTH_FAILED',
        `用户名或密码不正确（再错 ${left} 次将锁定 15 分钟）`);
    }

    auth.clearFailures(db, ip);
    const session = auth.issueSession(db, expectedUser);
    res.setHeader('Set-Cookie', session.cookie);
    auth.audit(db, 'login', `登录成功：${expectedUser} 来自 ${ip}`, {
      ip, ua, username: expectedUser, result: 'success'
    });
    return ok({
      username: expectedUser,
      logged_in: true,
      expires_at: session.exp,
      ttl_sec: session.maxAge
    });
  }

  /* ---------------- 退出 ---------------- */
  if (sub === 'logout' && method === 'POST') {
    const s = auth.readSettings(db);
    const session = s.auth_session_secret
      ? auth.verifySession(s.auth_session_secret, auth.readCookie(req, auth.SESSION_COOKIE), s.auth_user || 'admin')
      : null;
    res.setHeader('Set-Cookie', auth.clearSessionCookie());
    auth.audit(db, 'logout', `退出登录：${session ? session.u : (s.auth_user || 'admin')} 来自 ${ip}`, {
      ip, ua, username: session ? session.u : '', result: 'success'
    });
    return ok({ logged_out: true });
  }

  /* ---------------- 设置 / 修改密码 ---------------- */
  if (sub === 'password' && method === 'POST') {
    const s = auth.readSettings(db);
    const oldPassword = String((body && (body.old_password || body.oldPassword)) || '');
    const newPassword = String(
      (body && (body.new_password || body.newPassword || body.password)) || ''
    );

    if (newPassword.length < 6) {
      return fail(400, 'PASSWORD_TOO_SHORT', '新密码至少 6 位');
    }
    if (newPassword.length > 200) {
      return fail(400, 'PASSWORD_TOO_LONG', '新密码最多 200 位');
    }

    /* 首次设置密码：只允许本机操作（此时仍只监听 127.0.0.1） */
    if (!auth.hasPassword(s)) {
      if (!auth.isLocalIp(ip)) {
        return fail(403, 'LOCAL_ONLY', '首次设置登录密码只能在本机（127.0.0.1）操作');
      }
      auth.setSetting(db, 'auth_pass_hash', auth.hashPassword(newPassword));
      auth.ensureSessionSecret(db);
      auth.audit(db, 'password_change', `首次设置登录密码（本机 ${ip}）`, {
        ip, ua, result: 'success', first_time: true
      });
      return ok({ changed: true, first_time: true, relogin: false });
    }

    /* 已有密码：必须已登录 + 旧密码正确 */
    const state = auth.authStatus(db, req, { bindAddress: ctx.bindAddress });
    if (!state.logged_in) {
      return fail(401, 'AUTH_REQUIRED', '请先登录后再修改密码');
    }
    if (!oldPassword) {
      return fail(400, 'OLD_PASSWORD_REQUIRED', '请输入当前密码');
    }
    if (!auth.verifyPassword(oldPassword, s.auth_pass_hash)) {
      return fail(401, 'INVALID_OLD_PASSWORD', '当前密码不正确');
    }

    auth.setSetting(db, 'auth_pass_hash', auth.hashPassword(newPassword));
    /* 换密钥 = 所有旧会话立刻失效（含当前这一个），必须重新登录 */
    auth.rotateSessionSecret(db);
    auth.clearFailures(db, ip);
    auth.audit(db, 'password_change', `修改登录密码：${state.username || s.auth_user || 'admin'} 来自 ${ip}`, {
      ip, ua, username: state.username || s.auth_user || '', result: 'success', relogin: true
    });
    return ok({ changed: true, first_time: false, relogin: true });
  }

  return fail(404, 'API_NOT_FOUND', `接口不存在：${pathname}`);
};
