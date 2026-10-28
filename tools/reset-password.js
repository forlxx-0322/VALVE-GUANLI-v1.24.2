/**
 * 忘记登录密码 · 本机重置工具（1.25）
 *
 * 用途：在**本机**清空登录密码并关闭登录，之后重新打开软件即可「免登录」进入，
 *       再在「设置 → 登录与异地访问」里设置新密码。
 *
 * 做法（不开任何网络后门）：
 *   1. auth_pass_hash = ''      清空 scrypt 哈希
 *   2. auth_enabled  = '0'      关闭登录（回到默认的打开即用）
 *   3. auth_session_secret = '' 作废所有已签发的会话 Cookie
 *   4. auth_fail_state = '{}'   清掉 IP 失败锁定
 *   并写一条审计（entity_type='auth'，action='password_change'）。
 *
 * 用法：
 *   1. 先关闭服务窗口（关掉黑色窗口即停服务），确保数据库没有被占用
 *   2. 在本项目目录执行：node tools/reset-password.js
 *   3. 重新双击 启动.bat
 *
 * 可选：CRM_ROOT 指向项目根目录（默认取本文件上一级）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = process.env.CRM_ROOT ? path.resolve(process.env.CRM_ROOT) : path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'crm.db');
const RUN_FILE = path.join(ROOT, 'data', '.run.json');

function die(message) {
  console.error('\n[重置失败] ' + message + '\n');
  process.exit(1);
}

function nowText() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

console.log('');
console.log('  客户管理系统 · 重置登录密码（本机操作）');
console.log('  ----------------------------------------');
console.log(`  项目目录 : ${ROOT}`);
console.log(`  数据库   : ${DB_FILE}`);

/* 服务还在跑时也允许执行（SQLite WAL 支持并发写），但要提醒重启 */
try {
  const info = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  if (info && info.pid) {
    console.log(`  [提示] 检测到服务可能仍在运行（PID ${info.pid}）。`);
    console.log('         重置后请关闭服务窗口并重新启动，登录状态才会彻底生效。');
  }
} catch (_) { /* 没有锁文件：服务未运行，正常情况 */ }

if (!fs.existsSync(DB_FILE)) {
  die(`找不到数据库文件。请先启动一次软件（会自动建库），或确认 CRM_ROOT 指向项目目录。`);
}

let db;
try {
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 5000');
} catch (e) {
  die('打开数据库失败：' + e.message);
}

try {
  const hasSettings = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'settings'"
  ).get().n;
  if (!hasSettings) die('数据库里没有 settings 表，可能不是本软件的数据库。');

  const ts = nowText();
  const upd = db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?');
  let changed = 0;

  db.exec('BEGIN');
  try {
    for (const [key, value] of [
      ['auth_pass_hash', ''],
      ['auth_enabled', '0'],
      ['auth_session_secret', ''],
      ['auth_fail_state', '{}']
    ]) {
      const r = upd.run(value, ts, key);
      changed += r.changes || 0;
    }

    /* 审计：只记"本机重置"这个事实，不写任何密码 / 哈希 / 密钥 */
    const hasLogs = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'activity_logs'"
    ).get().n;
    if (hasLogs) {
      db.prepare(
        `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
         VALUES ('auth', NULL, 'password_change', ?, ?, ?)`
      ).run(
        '本机运行 reset-password.js：已清空登录密码并关闭登录',
        JSON.stringify({ result: 'reset', source: 'tools/reset-password.js' }),
        ts
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }

  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* 忽略 */ }

  console.log(`  已处理   : ${changed} 项设置（密码哈希 / 登录开关 / 会话密钥 / 失败锁定）`);
  console.log('  ----------------------------------------');
  console.log('  完成：登录密码已清空，登录已关闭。');
  console.log('  下一步：重新双击「启动.bat」，打开首页即可直接使用；');
  console.log('          在「设置 → 登录与异地访问」里设置新密码后，可再次开启登录。');
  console.log('');
} catch (e) {
  die(e.message || String(e));
} finally {
  try { db.close(); } catch (_) { /* 忽略 */ }
}
