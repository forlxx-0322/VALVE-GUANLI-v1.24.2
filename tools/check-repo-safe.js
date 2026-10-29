'use strict';
/**
 * 仓库安全检查：确保**数据库内容永远不会被提交 / 推送**
 *
 * 用法：
 *   node tools/check-repo-safe.js           检查已跟踪文件
 *   node tools/check-repo-safe.js --staged  检查暂存区（供 pre-commit 钩子用）
 *
 * 拦截对象：
 *   · data/ 目录下的任何文件（数据库、WAL、附件、备份、日志、端口记录）
 *   · 任何 *.db / *.db-wal / *.db-shm / *.sqlite* 文件
 *   · 导出的表格与备份压缩包（*.xlsx / *.zip / *.bak，仓库根或导出目录）
 *
 * 通过返回 0；发现风险打印清单并返回 1。
 */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const staged = process.argv.includes('--staged');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

let files = [];
try {
  files = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files'])
    .split(/\r?\n/).filter(Boolean);
} catch (e) {
  console.error('无法读取 git 文件列表（不在 git 仓库里？）：', e.message);
  process.exit(0); // 不在仓库里（如解压版安装包）时不阻塞
}

const DATA_RE = /^data\//i;
const DB_RE = /(^|\/)\.?[^/]*\.(db|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm)$/i;
const RISKY_RE = /(^|\/)(导出|backup|backups)\/|\.(xlsx|xls|zip|bak)$/i;

const bad = files.filter((f) => DATA_RE.test(f) || DB_RE.test(f) || RISKY_RE.test(f));

if (!bad.length) {
  console.log(`仓库安全检查通过：${files.length} 个文件，无数据库 / 备份 / 导出内容。`);
  process.exit(0);
}

console.error('');
console.error('✗ 仓库安全检查未通过：以下文件不应提交到 GitHub');
for (const f of bad.slice(0, 30)) console.error('    ' + f);
if (bad.length > 30) console.error(`    …还有 ${bad.length - 30} 个`);
console.error('');
console.error('处理办法：');
console.error('    git rm --cached <文件>        # 取消跟踪（本地文件保留）');
console.error('    并把规则补进 .gitignore（data/、*.db 已默认忽略）');
console.error('');
process.exit(1);
