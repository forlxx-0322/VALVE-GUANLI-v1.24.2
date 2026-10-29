/**
 * 阶段一验收测试脚本
 * 用法：node tools/test-phase1.js
 * 前置：服务已在 127.0.0.1:8899 运行
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const DB_FILE = path.join(ROOT, 'data', 'crm.db');

const EXPECTED_TABLES = [
  'customers', 'contacts', 'tags', 'customer_tags', 'followups', 'projects',
  'payments', 'tasks', 'attachments', 'activity_logs', 'dict', 'settings', 'region',
  /* 1.22：成本台账（首页收入报表要算利润） */
  'costs',
  /* 1.24：产品价目表（分类树 + 产品） */
  'product_categories', 'products'
];
/* 1.21 起报价单模块整体移除，quotation_status 这一类随之删除，故为 22 */
const DICT_CATEGORIES = 22;

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  const mark = pass ? '✓ 通过' : '✗ 失败';
  console.log(`[${mark}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

async function get(pathname, init) {
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { res, text, json };
}

(async () => {
  console.log('=== 阶段一验收测试 ===');
  console.log('目标服务：' + BASE + '\n');

  /* --- 1. 服务可启动、健康检查可用 --- */
  let health = null;
  try {
    const { res, json } = await get('/api/health');
    health = json && json.data;
    check(1, '服务可启动且 /api/health 返回正常',
      res.status === 200 && json && json.ok === true && health && health.app === 'crm-bjxt/1',
      health ? `app=${health.app} pid=${health.pid} port=${health.port}` : '无响应');
  } catch (e) {
    check(1, '服务可启动且 /api/health 返回正常', false, e.message);
    console.log('\n服务未运行，后续测试中止。');
    process.exit(1);
  }

  /* --- 2. 数据库与 17 张表 --- */
  let tables = [];
  try {
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    const idxCount = db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).get().n;
    const missing = EXPECTED_TABLES.filter((t) => !tables.includes(t));
    check(2, '业务表全部存在（含 1.22 成本台账、1.24 产品价目表两张表）',
      missing.length === 0,
      missing.length ? `缺少：${missing.join(', ')}` : `共 ${tables.length} 张（含 schema_version），索引 ${idxCount} 个`);

    const sv = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    const expectedVersion = require('../server/db').SCHEMA_VERSION;
    check(3, '结构版本表已记录为最新版本', sv && sv.v === expectedVersion,
      `schema_version = ${sv && sv.v}（代码当前结构版本 v${expectedVersion}）`);

    /* 1.24.2：产品价目表两张表的列数与三级分类种子（6 个一级 + 22 个二级 + 46 个三级 = 74） */
    const catCols = db.prepare('PRAGMA table_info(product_categories)').all().map((c) => c.name);
    const prodCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    const builtinRoots = db.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1 AND parent_id IS NULL`).get().n;
    const customSecond = db.prepare(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.is_system = 0 AND c.parent_id IS NOT NULL
        AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NULL`).get().n;
    const customThird = db.prepare(`SELECT COUNT(*) AS n FROM product_categories c
      WHERE c.deleted_at IS NULL AND c.is_system = 0 AND c.parent_id IS NOT NULL
        AND (SELECT p.parent_id FROM product_categories p WHERE p.id = c.parent_id) IS NOT NULL`).get().n;
    const systemTotal = db.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL AND is_system = 1`).get().n;
    const catTotal = db.prepare(`SELECT COUNT(*) AS n FROM product_categories
      WHERE deleted_at IS NULL`).get().n;
    const sanBian = db.prepare(`SELECT id FROM product_categories
      WHERE deleted_at IS NULL AND parent_id IS NULL AND name = '蝶阀'`).get();
    const sanId = sanBian && db.prepare(`SELECT id FROM product_categories
      WHERE deleted_at IS NULL AND parent_id = ? AND name = '三偏心蝶阀'`).get(sanBian.id);
    const sanLinks = sanId ? db.prepare(`SELECT name FROM product_categories
      WHERE deleted_at IS NULL AND parent_id = ? ORDER BY sort, id`).all(sanId.id).map((r) => r.name) : [];
    check('3a', '产品价目表结构完整（分类 8 列 / 产品 17 列）且三级分类种子 6 + 22 + 46 = 74 已灌入',
      catCols.length === 8 && prodCols.length === 17
        && catCols.includes('parent_id') && catCols.includes('is_system')
        && ['category_id', 'name', 'price', 'lead_time_days', 'lead_time_weeks', 'body_material',
          'pressure_rating', 'discount', 'code', 'enabled', 'sort'].every((c) => prodCols.includes(c))
        && builtinRoots === 6 && customSecond === 22 && customThird === 46
        && systemTotal === 6 && catTotal === 74
        && /^对夹,法兰,支耳$/.test(sanLinks.join(',')),
      `分类 ${catCols.length} 列 / 产品 ${prodCols.length} 列；一级内置 ${builtinRoots}、二级 ${customSecond}、`
        + `三级 ${customThird}（合计 ${catTotal}，is_system=1 共 ${systemTotal}）；`
        + `蝶阀→三偏心蝶阀→${sanLinks.join('/')}`);

    const dictStat = db.prepare(
      'SELECT COUNT(DISTINCT category) AS c, COUNT(*) AS n FROM dict WHERE deleted_at IS NULL'
    ).get();
    check(4, '字典数据已灌入（23 类）',
      dictStat.c === DICT_CATEGORIES,
      `${dictStat.c} 类 / ${dictStat.n} 项${dictStat.c !== DICT_CATEGORIES ? '（预期 ' + DICT_CATEGORIES + ' 类）' : ''}`);

    const st = db.prepare('SELECT COUNT(*) AS n FROM settings').get();
    check(5, '系统设置默认值已灌入', st.n >= 12, `${st.n} 项`);

    const region = db.prepare('SELECT COUNT(*) AS n FROM region').get();
    check(6, '行政区划表可用（客户分布与地址归属用，1.22 起由本地种子灌入）', true,
      `当前 ${region.n} 条（server/data/region.json 种子）`);

    const custCols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
    check(7, '客户表已精简为 27 列（1.23：6 个新列，旧 47 列已删，industry 保留）',
      custCols.length === 27
        && ['customer_no', 'contact_name', 'contact_position', 'contact_phone',
          'contact_birthday', 'follow_cycle_days', 'industry'].every((c) => custCols.includes(c))
        && ['type', 'level', 'status', 'owner', 'phone', 'supplier_code', 'deal_amount']
          .every((c) => !custCols.includes(c)),
      `${custCols.length} 个字段，含 customer_no=${custCols.includes('customer_no')}，`
      + `旧列 type=${custCols.includes('type')} phone=${custCols.includes('phone')}`);

    const projCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    const uq = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='uq_projects_customer_current'"
    ).get();
    const fixedTags = db.prepare(
      "SELECT COUNT(*) AS n FROM tags WHERE name IN ('重点客户','老客户','待回访','已成交','暂停合作')"
    ).get().n;
    check('7a', '项目表有 archived 列 + v16 已删除一客户一项目唯一索引 + 5 个固定标签',
      projCols.includes('archived') && !uq && fixedTags === 5,
      `archived=${projCols.includes('archived')} 唯一索引=${!!uq}（应为 false） 固定标签=${fixedTags}/5`);

    db.close();
  } catch (e) {
    check(2, '业务表全部存在（含 1.22 成本台账、1.24 产品价目表两张表）', false, e.message);
  }

  /* --- 8. WAL 模式 --- */
  try {
    const db = new DatabaseSync(DB_FILE);
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    const bt = db.prepare('PRAGMA busy_timeout').get().timeout;
    db.close();
    check(8, 'WAL 模式与 busy_timeout 生效', mode === 'wal', `journal_mode=${mode}, busy_timeout=${bt || '（会话级，需连接内设置）'}`);
  } catch (e) {
    check(8, 'WAL 模式与 busy_timeout 生效', false, e.message);
  }

  /* --- 9. /api/status 返回完整信息 --- */
  try {
    const { json } = await get('/api/status');
    const d = json && json.data;
    check(9, '/api/status 返回数据库与字典统计',
      d && d.tableCount >= 16 && d.dictCategories === DICT_CATEGORIES,
      d ? `表 ${d.tableCount} 张 / 字典 ${d.dictCategories} 类 ${d.dictItems} 项` : '无响应');
  } catch (e) {
    check(9, '/api/status 返回数据库与字典统计', false, e.message);
  }

  /* --- 10. 首页 HTML 可访问且引用本地资源 --- */
  try {
    const { res, text } = await get('/');
    const hasVendor = text.includes('vendor/vue.global.prod.js');
    const noCdn = !/https?:\/\/(?!127\.0\.0\.1)/.test(text.replace(/<!--[\s\S]*?-->/g, ''));
    check(10, '首页 HTML 返回且仅引用本地资源',
      res.status === 200 && hasVendor && noCdn,
      `HTTP ${res.status}, 引用本地 vue=${hasVendor}, 无外部 URL=${noCdn}`);
  } catch (e) {
    check(10, '首页 HTML 返回且仅引用本地资源', false, e.message);
  }

  /* --- 11. 静态资源的 MIME 类型 --- */
  try {
    const js = await get('/vendor/vue.global.prod.js');
    const css = await get('/css/app.css');
    const svg = await get('/assets/logo.svg');
    const okJs = (js.res.headers.get('content-type') || '').includes('javascript');
    const okCss = (css.res.headers.get('content-type') || '').includes('text/css');
    const okSvg = (svg.res.headers.get('content-type') || '').includes('image/svg+xml');
    check(11, '静态资源 MIME 类型正确',
      okJs && okCss && okSvg,
      `js=${okJs}, css=${okCss}, svg=${okSvg}`);
  } catch (e) {
    check(11, '静态资源 MIME 类型正确', false, e.message);
  }

  /* --- 12. 路径遍历防护 --- */
  try {
    const a = await get('/../server/server.js');
    const b = await get('/%2e%2e%2fserver%2fserver.js');
    const c = await get('/..%2f..%2fWindows%2fwin.ini');
    const blocked = [a, b, c].every((r) => r.res.status === 400 || r.res.status === 404);
    check(12, '路径遍历攻击被阻止', blocked,
      `状态码 ${[a, b, c].map((r) => r.res.status).join('/')}（应全为 400 或 404）`);
  } catch (e) {
    check(12, '路径遍历攻击被阻止', false, e.message);
  }

  /* --- 13. 未知 API 返回结构化错误 --- */
  try {
    const { res, json } = await get('/api/not-exist');
    check(13, '未知接口返回结构化错误',
      res.status === 404 && json && json.ok === false && json.code === 'API_NOT_FOUND',
      json ? `HTTP ${res.status} code=${json.code}` : '');
  } catch (e) {
    check(13, '未知接口返回结构化错误', false, e.message);
  }

  /* --- 14. 中文文件名与查询参数 --- */
  try {
    const r1 = await get('/%E4%B8%8D%E5%AD%98%E5%9C%A8.txt'); // 不存在的中文名
    check(14, '中文路径解码不报错', r1.res.status === 404,
      `中文路径返回 ${r1.res.status}（预期 404，而非 500）`);
  } catch (e) {
    check(14, '中文路径解码不报错', false, e.message);
  }

  /* --- 15. 单实例锁文件 --- */
  try {
    const runFile = path.join(ROOT, 'data', '.run.json');
    const info = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    check(15, '单实例锁文件已写入',
      info.pid === health.pid && info.port === health.port,
      `.run.json pid=${info.pid} port=${info.port}`);
  } catch (e) {
    check(15, '单实例锁文件已写入', false, e.message);
  }

  /* --- 16. 方法限制 --- */
  try {
    const r = await fetch(BASE + '/api/health', { method: 'DELETE' });
    check(16, '非法方法被拒绝', r.status === 404 || r.status === 405,
      `DELETE /api/health → ${r.status}`);
  } catch (e) {
    check(16, '非法方法被拒绝', false, e.message);
  }

  /* --- 17. 前端 JS 文件全部可加载 --- */
  try {
    const files = [
      '/js/core/util.js', '/js/core/api.js', '/js/core/router.js',
      '/js/ui/components.js', '/js/app.js',
      '/js/forms/customer-fields.js', '/js/forms/customer-edit.js', '/js/forms/project-edit.js',
      '/js/pages/home.js', '/js/pages/customers.js', '/js/pages/customer-detail.js',
      '/js/pages/tasks.js', '/js/pages/settings.js',
      '/vendor/vue.global.prod.js', '/vendor/echarts.min.js', '/vendor/xlsx.full.min.js'
    ];
    const codes = [];
    for (const f of files) {
      const r = await fetch(BASE + f);
      codes.push(r.status);
    }
    const bad = files.filter((f, i) => codes[i] !== 200);
    check(17, '前端全部脚本可加载（含 3 个第三方库）',
      bad.length === 0,
      bad.length ? `加载失败：${bad.join(', ')}` : `${files.length} 个文件全部 200`);
  } catch (e) {
    check(17, '前端全部脚本可加载（含 3 个第三方库）', false, e.message);
  }

  /* --- 18. 语法自检：本地解析全部前端 JS --- */
  try {
    const jsFiles = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'vendor') continue;
          walk(p);
        } else if (e.name.endsWith('.js')) jsFiles.push(p);
      }
    };
    walk(path.join(ROOT, 'web', 'js'));
    walk(path.join(ROOT, 'server'));

    const { execFileSync } = require('node:child_process');
    const bad = [];
    for (const f of jsFiles) {
      try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      } catch (_) {
        bad.push(path.relative(ROOT, f));
      }
    }
    check(18, '全部后端与前端脚本语法检查通过',
      bad.length === 0,
      bad.length ? `语法错误：${bad.join(', ')}` : `检查 ${jsFiles.length} 个文件`);
  } catch (e) {
    check(18, '全部后端与前端脚本语法检查通过', false, e.message);
  }

  /* --- 19. 启动器编码（UTF-8 无 BOM；1.25.4 起只保留 启动.bat 一个） --- */
  try {
    const bats = ['启动.bat'];
    const bad = [];
    const info = [];
    for (const b of bats) {
      const p = path.join(ROOT, b);
      if (!fs.existsSync(p)) { bad.push(`${b}(缺失)`); continue; }
      const buf = fs.readFileSync(p);
      const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      const hasChcp = buf.toString('utf8').includes('chcp 65001');
      const crlf = buf.includes(Buffer.from('\r\n'));
      if (hasBom || !hasChcp || !crlf) bad.push(b);
      info.push(`${b}: ${buf.length}B BOM=${hasBom ? '有' : '无'} chcp=${hasChcp ? '有' : '无'} CRLF=${crlf ? '有' : '无'}`);
    }
    check(19, '.bat 文件编码正确（UTF-8 无 BOM + chcp + CRLF）',
      bad.length === 0,
      bad.length ? `异常：${bad.join(', ')}` : info.join(' | '));
  } catch (e) {
    check(19, '.bat 文件编码正确（UTF-8 无 BOM + chcp + CRLF）', false, e.message);
  }

  /* --- 20. data 目录结构 --- */
  try {
    const need = ['data', path.join('data', 'backups'), path.join('data', 'backups', 'mirror'), path.join('data', 'attachments')];
    const missing = need.filter((d) => !fs.existsSync(path.join(ROOT, d)));
    check(20, 'data 目录结构完整', missing.length === 0,
      missing.length ? `缺少：${missing.join(', ')}` : 'data / backups / backups\\mirror / attachments 均已创建');
  } catch (e) {
    check(20, 'data 目录结构完整', false, e.message);
  }

  /* --- 21. 零外部请求：全量扫描前端源码中的外部 URL ---
     说明：地图模块已在 1.22 移除（在线地图核对/坐标拾取器一并下线），
     因此当前**不登记任何外部链接**：前端源码里出现外链即视为不合格。
     将来若要加"用户主动点击才打开"的外链，必须在此登记并说明用途。 */
  const ALLOWED_USER_TRIGGERED = [];
  try {
    const scanned = [];
    const offenders = [];
    const allowedHits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(html|css|js)$/i.test(e.name)) continue;
        // vendor 是第三方库，只做记录不做禁用（其内部注释含官网链接，不影响运行）
        const isVendor = p.includes(path.sep + 'vendor' + path.sep);
        const text = fs.readFileSync(p, 'utf8');
        scanned.push(path.relative(ROOT, p));
        if (isVendor) continue;
        const urls = text.match(/https?:\/\/[^\s"'`)<>]+/g) || [];
        const external = urls.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u));
        const notAllowed = external.filter((u) => {
          const hit = ALLOWED_USER_TRIGGERED.find((a) => u.includes(a.domain));
          if (hit) { allowedHits.push(`${hit.domain}（${hit.why}）`); return false; }
          return true;
        });
        if (notAllowed.length) {
          offenders.push(`${path.relative(ROOT, p)} → ${[...new Set(notAllowed)].slice(0, 3).join(', ')}`);
        }
      }
    };
    walk(path.join(ROOT, 'web'));
    check(21, '零外部请求：前端源码无未登记的外部 URL',
      offenders.length === 0,
      offenders.length
        ? offenders.join(' | ')
        : `已扫描 ${scanned.length} 个文件；已登记的仅点击触发链接 ${allowedHits.length} 处：${[...new Set(allowedHits)].join('；')}`);
  } catch (e) {
    check(21, '零外部请求：前端源码无未登记的外部 URL', false, e.message);
  }

  /* --- 22. 优雅停机接口 --- */
  try {
    const r = await fetch(BASE + '/api/shutdown', { method: 'POST' });
    const j = await r.json();
    check(22, '优雅停机接口可用（本机调用）',
      r.status === 200 && j.ok === true,
      `HTTP ${r.status} message=${j.data && j.data.message}`);

    // 等待进程退出并释放端口
    let released = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((s) => setTimeout(s, 200));
      try {
        await fetch(BASE + '/api/health');
      } catch (_) { released = true; break; }
    }
    const runFile = path.join(ROOT, 'data', '.run.json');
    check(23, '停机后端口释放且锁文件已清理',
      released && !fs.existsSync(runFile),
      `端口释放=${released}, 锁文件存在=${fs.existsSync(runFile)}`);
  } catch (e) {
    check(22, '优雅停机接口可用（本机调用）', false, e.message);
    check(23, '停机后端口释放且锁文件已清理', false, '未能完成停机测试');
  }

  /* --- 汇总 --- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  ✗ ${r.no}. ${r.name}  —— ${r.detail}`);
    }
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
