'use strict';
/**
 * 安装仓库自带的 git 钩子（pre-commit：拦截数据库 / 备份 / 导出文件）
 *
 * 用法：node tools/install-git-hooks.js
 * 说明：钩子文件放在 tools/git-hooks/ 里随仓库走，但 git 不会自动启用，
 *       每个克隆到本机后执行一次本脚本即可（只影响本机，不改仓库）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tools', 'git-hooks', 'pre-commit');
const DST_DIR = path.join(ROOT, '.git', 'hooks');
const DST = path.join(DST_DIR, 'pre-commit');

if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.error('当前目录不是 git 仓库，跳过。');
  process.exit(0);
}
if (!fs.existsSync(SRC)) {
  console.error('找不到钩子源文件：', SRC);
  process.exit(1);
}

fs.mkdirSync(DST_DIR, { recursive: true });
if (fs.existsSync(DST)) {
  fs.copyFileSync(DST, DST + '.bak');
  console.log('已备份原钩子到 pre-commit.bak');
}
fs.copyFileSync(SRC, DST);
try { fs.chmodSync(DST, 0o755); } catch (_) { /* Windows 上忽略 */ }
console.log('✓ 已安装 pre-commit 钩子：提交前会检查 data/ 与 *.db 等文件');
console.log('  测试：git add 一个 .db 文件后提交，应被拦截');
