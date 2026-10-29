/**
 * 产品批量导入专项（1.26 新增）
 *
 * 覆盖：
 *   · 模板：11 列 / 2 个必填项 / 货期为「周」/ 真实三级分类示例 / 分类路径清单 ≤200 / 填写说明
 *   · 真实 xlsx 往返：SheetJS 生成填好的表 → 读回 JSON → 预览 → 导入
 *   · 正常导入 3 行（跨 2 个分类，含折扣 / 货期(周) / 材质 / 启用）
 *   · 同分类重名：skip（跳过不动库）/ update（只覆盖表格填了的列）
 *   · 产品编号全库唯一：重复整行报错
 *   · 数值校验：单价 −1、折扣 120、货期 −1、货期两位小数
 *   · 启用=否 落库为 0；单位 / 启用留空按默认值
 *   · 空行跳过；单次超过 2000 行拒绝
 *   · 分类不存在：不勾选自动创建 → 该行报错；勾选 → 按路径顺序创建（新一级 + 新二级）
 *   · 导入后列表接口 / 导出接口能查到，货期按周展示
 *   · 审计：entity_type='product' / action='import'，摘要「批量导入产品 N 个」
 *   · 测试数据自清理（产品、自动创建的分类、日志）
 *
 * 前置：服务已启动（默认 127.0.0.1:8899，可用 CRM_TEST_BASE 覆盖）
 * 用法：node tools/test-products-import.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const DB_FILE = path.join(ROOT, 'data', 'crm.db');
const TAG = '【产品导入测试' + Math.random().toString(36).slice(2, 8) + '】';
const UID = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: !!j.ok, data: j.data, code: j.code, message: j.message };
}

function withDb(fn) {
  const db = new DatabaseSync(DB_FILE);
  try { return fn(db); } finally { db.close(); }
}

/** 物理清理本套件数据（含上次失败残留）；只动名字里带 TAG 的记录 */
function purgeTag() {
  withDb((db) => {
    db.prepare(`DELETE FROM products WHERE name LIKE ?`).run(`%${TAG}%`);
    db.prepare(`DELETE FROM products WHERE category_id IN
      (SELECT id FROM product_categories WHERE name LIKE ?)`).run(`%${TAG}%`);
    db.prepare(`DELETE FROM product_categories WHERE name LIKE ? AND is_system = 0`).run(`%${TAG}%`);
    db.prepare(`DELETE FROM activity_logs WHERE summary LIKE ? OR detail LIKE ?`)
      .run(`%${TAG}%`, `%${TAG}%`);
  });
}

/** 按模板表头生成 xlsx，再按前端同样的逻辑读回 JSON 行 */
function buildSheet(tpl, rows) {
  const header = tpl.fields.map((f) => (f.required ? f.label + ' *' : f.label));
  const aoa = [header];
  for (const r of rows) {
    aoa.push(tpl.fields.map((f) => (r[f.key] === undefined || r[f.key] === null ? '' : r[f.key])));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, tpl.sheetName || '导入模板');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

function sheetToRows(tpl, buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const headerRow = aoa[0].map((h) => String(h || '').replace(/[*＊\s]/g, ''));
  const colMap = [];
  tpl.fields.forEach((f, i) => { colMap[i] = f; });
  const idxOf = {};
  for (const f of tpl.fields) idxOf[f.key] = headerRow.findIndex((h) => h === f.label);
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i];
    if (!line || line.every((c) => String(c || '').trim() === '')) continue;
    const obj = {};
    for (const f of tpl.fields) {
      const idx = idxOf[f.key];
      if (idx >= 0) obj[f.key] = line[idx] === undefined ? '' : line[idx];
    }
    rows.push(obj);
  }
  return rows;
}

const OPTIONS = { duplicate_mode: 'skip', auto_create_categories: false };

(async () => {
  console.log('=== 产品批量导入专项（1.26）===\n');
  console.log(`测试标记：${TAG}\n`);

  /* ---------------- 0. 健康检查与预清理 ---------------- */
  const health = await api('GET', '/api/health');
  const ver = String((health.data && health.data.version) || '').split('.').map(Number);
  check('服务可访问且版本 ≥ 1.26（产品批量导入随 1.26 上线）',
    health.ok === true && ver[0] === 1 && (ver[1] || 0) >= 26,
    health.ok ? `v${health.data.version}` : (health.message || '无响应'));
  if (!health.ok) {
    console.error('服务未启动，请先运行 启动.bat 或 node server/server.js');
    process.exit(2);
  }
  try { purgeTag(); } catch (e) { console.log('（预清理失败，继续：' + e.message + '）'); }

  try {
    /* ---------------- 1. 模板 ---------------- */
    const tplRes = await api('GET', '/api/data/template?entity=product');
    const tpl = tplRes.data || {};
    const required = (tpl.fields || []).filter((f) => f.required);
    check('模板接口可用：11 列，必填列为「分类路径」「产品名称」',
      tplRes.ok && (tpl.fields || []).length === 11
        && required.length === 2
        && required.some((f) => f.key === 'category_path')
        && required.some((f) => f.key === 'name'),
      `${(tpl.fields || []).length} 列；必填：${required.map((f) => f.label).join('、')}`);

    const leadField = (tpl.fields || []).find((f) => f.key === 'lead_time_weeks');
    check('货期列改按「周」：表头为「货期(周)」且不再出现「货期(天)」',
      !!leadField && leadField.label === '货期(周)'
        && !(tpl.fields || []).some((f) => /货期\(天\)/.test(f.label)),
      leadField ? leadField.label : '未找到货期列');

    const sampleIdx = (tpl.fields || []).findIndex((f) => f.key === 'category_path');
    const samplePath = sampleIdx >= 0 ? tpl.sample[sampleIdx] : '';
    check('示例行使用真实存在的三级分类（分类路径清单里能查到）',
      (tpl.categoryPaths || []).includes(samplePath) && String(samplePath).split(' / ').length >= 3,
      `示例分类路径：${samplePath}`);

    const sampleMap = {};
    (tpl.fields || []).forEach((f, i) => { sampleMap[f.key] = tpl.sample[i]; });
    check('示例行数量与列数一致，且含单价 / 货期(周) / 材质 / 折扣',
      (tpl.sample || []).length === (tpl.fields || []).length
        && Number(sampleMap.price) > 0 && Number(sampleMap.lead_time_weeks) > 0
        && !!sampleMap.body_material && Number(sampleMap.discount) > 0,
      `单价=${sampleMap.price}，货期=${sampleMap.lead_time_weeks} 周，材质=${sampleMap.body_material}，折扣=${sampleMap.discount}%`);

    check('分类路径清单最多 200 条，另有总数与填写说明（含自动创建 / 2000 行提示）',
      Array.isArray(tpl.categoryPaths) && tpl.categoryPaths.length > 0
        && tpl.categoryPaths.length <= 200
        && Number(tpl.categoryPathsTotal) >= tpl.categoryPaths.length
        && (tpl.notes || []).join('').includes('分类路径')
        && (tpl.notes || []).join('').includes('自动创建')
        && (tpl.notes || []).join('').includes('2000'),
      `${tpl.categoryPaths.length} 条 / 共 ${tpl.categoryPathsTotal} 条，说明 ${(tpl.notes || []).length} 行`);

    check('模板页名与行数上限（导入模板 / 2000 行），材质与压力等级带可选值',
      tpl.sheetName === '导入模板' && Number(tpl.maxRows) === 2000
        && (tpl.options.body_material || []).length > 0
        && (tpl.options.pressure_rating || []).length > 0,
      `${tpl.sheetName}，maxRows=${tpl.maxRows}，材质 ${(tpl.options.body_material || []).length} 项`);

    /* ---------------- 2. 真实 xlsx 往返 + 正常导入 ---------------- */
    const rows = [
      {
        category_path: '蝶阀 / 三偏心蝶阀 / 对夹', name: TAG + '甲', code: `PI${UID}A`,
        unit: '台', price: 1200.555, lead_time_weeks: 3.5,
        body_material: '碳钢 WCB', pressure_rating: 'PN16', discount: 10,
        remark: '导入测试甲', enabled: '是'
      },
      {
        category_path: '蝶阀>三偏心蝶阀>对夹', name: TAG + '乙', code: '',
        unit: '', price: 0, lead_time_weeks: 0.5,
        body_material: '不锈钢 304', pressure_rating: 'PN10', discount: 0,
        remark: '', enabled: ''
      },
      {
        category_path: '球阀 / 浮动球阀', name: TAG + '丙', code: `PI${UID}C`,
        unit: '', price: 500, lead_time_weeks: '',
        body_material: '', pressure_rating: '', discount: 100,
        remark: '', enabled: '否'
      }
    ];
    const buf = buildSheet(tpl, rows);
    const readBack = sheetToRows(tpl, buf);
    check('真实 xlsx 往返：3 行按模板表头读回，货期(周)、分类路径等列正确',
      readBack.length === 3
        && readBack[0].category_path === '蝶阀 / 三偏心蝶阀 / 对夹'
        && readBack[0].lead_time_weeks === '3.5'
        && readBack[1].category_path === '蝶阀>三偏心蝶阀>对夹',
      `读回 ${readBack.length} 行，第 1 行货期=${readBack[0].lead_time_weeks}`);

    const prevNormal = await api('POST', '/api/data/preview', Object.assign({ entity: 'product', rows: readBack }, OPTIONS));
    check('预校验：3 行全部可导入，分类路径 / 名称都能解析',
      prevNormal.ok && prevNormal.data.total === 3 && prevNormal.data.valid === 3
        && prevNormal.data.invalid === 0,
      prevNormal.ok ? `可导入 ${prevNormal.data.valid}，有问题 ${prevNormal.data.invalid}` : prevNormal.message);
    check('预览按周展示：3.5 周 ↔ 25 天（0.5 周 ↔ 4 天）',
      prevNormal.ok
        && Number(prevNormal.data.rows[0].data.lead_time_weeks) === 3.5
        && Number(prevNormal.data.rows[0].data.lead_time_days) === 25
        && Number(prevNormal.data.rows[1].data.lead_time_days) === 4,
      prevNormal.ok ? `${prevNormal.data.rows[0].data.lead_time_weeks} 周 = ${prevNormal.data.rows[0].data.lead_time_days} 天` : prevNormal.message);

    const repNormal = await api('POST', '/api/data/import', Object.assign({ entity: 'product', rows: readBack }, OPTIONS));
    check('正常导入 3 行：新增 3、失败 0、未自动建分类',
      repNormal.ok && repNormal.data.imported === 3 && repNormal.data.failed === 0
        && repNormal.data.invalid === 0 && repNormal.data.categoriesCreated === 0,
      repNormal.ok ? `新增 ${repNormal.data.imported}，失败 ${repNormal.data.failed}，新建分类 ${repNormal.data.categoriesCreated}` : repNormal.message);

    const dbState = withDb((db) => {
      const find = (name) => db.prepare('SELECT * FROM products WHERE name = ? AND deleted_at IS NULL').get(name);
      const jia = db.prepare(`SELECT c.id, c.name FROM product_categories c
        JOIN product_categories p ON p.id = c.parent_id
        JOIN product_categories g ON g.id = p.parent_id
        WHERE g.name = '蝶阀' AND p.name = '三偏心蝶阀' AND c.name = '对夹'
          AND c.deleted_at IS NULL`).get();
      return { a: find(TAG + '甲'), b: find(TAG + '乙'), c: find(TAG + '丙'), jia };
    });
    check('落库口径：单价两位小数、货期换算为天、折扣 / 材质 / 启用正确',
      !!dbState.a && !!dbState.jia && Number(dbState.a.category_id) === Number(dbState.jia.id)
        && Number(dbState.a.price) === 1200.56 && Number(dbState.a.lead_time_days) === 25
        && Number(dbState.a.discount) === 10 && dbState.a.body_material === '碳钢 WCB'
        && Number(dbState.a.enabled) === 1,
      dbState.a ? `分类=${dbState.jia.name}，单价=${dbState.a.price}，货期=${dbState.a.lead_time_days} 天，折扣=${dbState.a.discount}%` : '未找到产品甲');
    check('单位留空默认「台」、启用留空默认是、货期 0.5 周落 4 天',
      !!dbState.b && dbState.b.unit === '台' && Number(dbState.b.enabled) === 1
        && Number(dbState.b.price) === 0 && Number(dbState.b.lead_time_days) === 4,
      dbState.b ? `单位=${dbState.b.unit}，启用=${dbState.b.enabled}，货期=${dbState.b.lead_time_days} 天` : '未找到产品乙');
    check('启用=否 落库为 0，折扣 100 正确，空货期为 0',
      !!dbState.c && Number(dbState.c.enabled) === 0 && Number(dbState.c.discount) === 100
        && Number(dbState.c.lead_time_days) === 0,
      dbState.c ? `启用=${dbState.c.enabled}，折扣=${dbState.c.discount}，货期=${dbState.c.lead_time_days}` : '未找到产品丙');

    /* ---------------- 3. 列表 / 导出 / 折后价 ---------------- */
    const list = await api('GET', `/api/products?keyword=${encodeURIComponent(TAG)}&pageSize=50`);
    const listA = list.ok ? (list.data.list || []).find((r) => r.name === TAG + '甲') : null;
    check('导入后列表能查到 3 个产品，接口返回货期周数（25 天 → 3.6 周）',
      list.ok && list.data.total === 3 && !!listA
        && Number(listA.lead_time_weeks) === 3.6 && Number(listA.lead_time_days) === 25,
      list.ok ? `total=${list.data.total}，甲货期=${listA && listA.lead_time_weeks} 周` : list.message);

    const exp = await api('GET', `/api/products/export-data?keyword=${encodeURIComponent(TAG)}`);
    const expA = exp.ok ? (exp.data || []).find((r) => r.name === TAG + '甲') : null;
    check('导出接口能查到，含 category_path 与货期周数，折后价 1080.5',
      exp.ok && (exp.data || []).length === 3 && !!expA
        && expA.category_path === '蝶阀 / 三偏心蝶阀 / 对夹'
        && Number(expA.lead_time_weeks) === 3.6 && Number(expA.lead_time_days) === 25
        && Number(expA.net_price) === 1080.5,
      expA ? `${expA.category_path}，${expA.lead_time_weeks} 周，折后价 ${expA.net_price}` : '未找到导出行');

    /* ---------------- 4. 同分类重名：skip / update ---------------- */
    const dupRows = [{ category_path: '蝶阀 / 三偏心蝶阀 / 对夹', name: TAG + '甲', price: 9999 }];
    const prevSkip = await api('POST', '/api/data/preview',
      Object.assign({ entity: 'product', rows: dupRows }, OPTIONS, { duplicate_mode: 'skip' }));
    check('重名 skip 模式：算"可导入（跳过）"，提示库中已有',
      prevSkip.ok && prevSkip.data.valid === 1 && prevSkip.data.invalid === 0
        && prevSkip.data.rows[0].action === 'skip'
        && (prevSkip.data.rows[0].warnings || []).some((w) => /跳过/.test(w)),
      prevSkip.ok ? `action=${prevSkip.data.rows[0].action}` : prevSkip.message);

    const repSkip = await api('POST', '/api/data/import',
      Object.assign({ entity: 'product', rows: dupRows }, OPTIONS, { duplicate_mode: 'skip' }));
    const afterSkip = withDb((db) => db.prepare('SELECT price FROM products WHERE name = ?').get(TAG + '甲'));
    check('skip 模式：产品被跳过，库中价格不被覆盖',
      repSkip.ok && repSkip.data.skipped === 1 && repSkip.data.imported === 0
        && Number(afterSkip.price) === 1200.56,
      `跳过 ${repSkip.data && repSkip.data.skipped}，价格仍为 ${afterSkip.price}`);

    const updRows = [{
      category_path: '蝶阀 / 三偏心蝶阀 / 对夹', name: TAG + '甲',
      price: 88.8, lead_time_weeks: 1, discount: 20, unit: '只', enabled: '否',
      code: '', body_material: '', remark: ''
    }];
    const prevUpd = await api('POST', '/api/data/preview',
      Object.assign({ entity: 'product', rows: updRows }, OPTIONS, { duplicate_mode: 'update' }));
    check('重名 update 模式：算"将更新"，提示会更新已有记录',
      prevUpd.ok && prevUpd.data.valid === 1
        && prevUpd.data.rows[0].action === 'update'
        && (prevUpd.data.rows[0].warnings || []).some((w) => /更新/.test(w)),
      prevUpd.ok ? `action=${prevUpd.data.rows[0].action}` : prevUpd.message);

    const repUpd = await api('POST', '/api/data/import',
      Object.assign({ entity: 'product', rows: updRows }, OPTIONS, { duplicate_mode: 'update' }));
    const afterUpd = withDb((db) => db.prepare('SELECT * FROM products WHERE name = ?').get(TAG + '甲'));
    check('update 模式：价格 / 货期 / 折扣 / 单位 / 启用被更新（1 周 = 7 天）',
      repUpd.ok && repUpd.data.updated === 1
        && Number(afterUpd.price) === 88.8 && Number(afterUpd.lead_time_days) === 7
        && Number(afterUpd.discount) === 20 && afterUpd.unit === '只'
        && Number(afterUpd.enabled) === 0,
      `更新 ${repUpd.data && repUpd.data.updated}，价格=${afterUpd.price}，货期=${afterUpd.lead_time_days} 天`);
    check('update 模式：表格留空的列保持原值（材质 / 备注 / 编号不被清空）',
      afterUpd.body_material === '碳钢 WCB' && afterUpd.remark === '导入测试甲'
        && afterUpd.code === `PI${UID}A`,
      `材质=${afterUpd.body_material}，备注=${afterUpd.remark}，编号=${afterUpd.code}`);

    /* ---------------- 5. 编号重复（整行报错） ---------------- */
    const codeRows = [{
      category_path: '球阀 / 浮动球阀', name: TAG + '编号重复', code: `PI${UID}A`, price: 1
    }];
    const prevCode = await api('POST', '/api/data/preview', Object.assign({ entity: 'product', rows: codeRows }, OPTIONS));
    check('产品编号全库重复：整行报错（提示被哪个产品占用）',
      prevCode.ok && prevCode.data.invalid === 1
        && prevCode.data.rows[0].errors.some((e) => /产品编号/.test(e) && /占用/.test(e)),
      prevCode.ok ? prevCode.data.rows[0].errors.join('；') : prevCode.message);
    const repCode = await api('POST', '/api/data/import', Object.assign({ entity: 'product', rows: codeRows }, OPTIONS));
    check('编号重复不会覆盖已有产品：导入 0 条、校验未通过 1 条',
      repCode.ok && repCode.data.imported === 0 && repCode.data.invalid === 1,
      repCode.ok ? `新增 ${repCode.data.imported}，校验未通过 ${repCode.data.invalid}` : repCode.message);

    /* ---------------- 6. 数值校验 ---------------- */
    const badRows = [
      { category_path: '球阀 / 浮动球阀', name: TAG + '负价', price: -1 },
      { category_path: '球阀 / 浮动球阀', name: TAG + '折扣超限', discount: 120 },
      { category_path: '球阀 / 浮动球阀', name: TAG + '负货期', lead_time_weeks: -1 },
      { category_path: '球阀 / 浮动球阀', name: TAG + '两位货期', lead_time_weeks: 1.55 }
    ];
    const prevBad = await api('POST', '/api/data/preview', Object.assign({ entity: 'product', rows: badRows }, OPTIONS));
    const badText = prevBad.ok ? prevBad.data.rows.map((r) => r.errors.join('；')).join(' | ') : '';
    check('数值越界报错：单价 −1 / 折扣 120 / 货期 −1 / 货期两位小数',
      prevBad.ok && prevBad.data.invalid === 4
        && /单价/.test(badText) && /折扣/.test(badText)
        && /货期/.test(badText) && /最多保留一位小数/.test(badText),
      prevBad.ok ? `有问题 ${prevBad.data.invalid} 行：${badText}` : prevBad.message);
    const repBad = await api('POST', '/api/data/import', Object.assign({ entity: 'product', rows: badRows }, OPTIONS));
    check('数值越界行全部被拒绝，不会写入 0 或越界值',
      repBad.ok && repBad.data.imported === 0 && repBad.data.invalid === 4
        && repBad.data.failed === 0,
      repBad.ok ? `新增 ${repBad.data.imported}，校验未通过 ${repBad.data.invalid}` : repBad.message);

    /* ---------------- 7. 空行跳过 / 超行数上限 ---------------- */
    const blankRows = [
      { category_path: '球阀 / 浮动球阀', name: TAG + '空行测试', price: 1 },
      {},
      { category_path: '', name: '', code: '', unit: '', price: '', lead_time_weeks: '', discount: '', enabled: '' }
    ];
    const repBlank = await api('POST', '/api/data/import', Object.assign({ entity: 'product', rows: blankRows }, OPTIONS));
    check('空行自动跳过：3 行输入只导入 1 行，空行 2 行',
      repBlank.ok && repBlank.data.total === 1 && repBlank.data.blankSkipped === 2
        && repBlank.data.imported === 1 && repBlank.data.invalid === 0,
      repBlank.ok ? `total=${repBlank.data.total}，空行=${repBlank.data.blankSkipped}，新增=${repBlank.data.imported}` : repBlank.message);

    const tooMany = Array.from({ length: 2001 }, (_, i) => ({
      category_path: '球阀 / 浮动球阀', name: `${TAG}超限${i}`
    }));
    const prevMany = await api('POST', '/api/data/preview', { entity: 'product', rows: tooMany });
    check('超过 2000 行被拒绝（400 TOO_MANY，提示 2000）',
      prevMany.status === 400 && prevMany.code === 'TOO_MANY' && /2000/.test(prevMany.message || ''),
      `HTTP ${prevMany.status} ${prevMany.code} ${prevMany.message || ''}`);

    /* ---------------- 8. 分类不存在：不勾选 / 勾选自动创建 ---------------- */
    const newRoot = TAG + '新一级';
    const newSecond = TAG + '新二级';
    const newPath = `${newRoot} / ${newSecond}`;
    const newRows = [{ category_path: newPath, name: TAG + '庚', price: 66, lead_time_weeks: 2 }];

    const prevNoCreate = await api('POST', '/api/data/preview', {
      entity: 'product', rows: newRows, duplicate_mode: 'skip', auto_create_categories: false
    });
    check('不勾选自动创建：分类不存在的那一行报错（提示可勾选自动创建）',
      prevNoCreate.ok && prevNoCreate.data.invalid === 1
        && prevNoCreate.data.rows[0].errors.some((e) => /不存在/.test(e) && /自动创建/.test(e)),
      prevNoCreate.ok ? prevNoCreate.data.rows[0].errors.join('；') : prevNoCreate.message);

    const repNoCreate = await api('POST', '/api/data/import', {
      entity: 'product', rows: newRows, duplicate_mode: 'skip', auto_create_categories: false
    });
    const catAfterNo = withDb((db) => db.prepare(
      'SELECT COUNT(*) AS n FROM product_categories WHERE name IN (?, ?) AND deleted_at IS NULL'
    ).get(newRoot, newSecond).n);
    check('不勾选自动创建：导入 0 条且不留下空分类',
      repNoCreate.ok && repNoCreate.data.imported === 0 && repNoCreate.data.invalid === 1
        && repNoCreate.data.categoriesCreated === 0 && catAfterNo === 0,
      `新增 ${repNoCreate.data && repNoCreate.data.imported}，新建分类 ${repNoCreate.data && repNoCreate.data.categoriesCreated}`);

    const prevCreate = await api('POST', '/api/data/preview', {
      entity: 'product', rows: newRows, duplicate_mode: 'skip', auto_create_categories: true
    });
    check('勾选自动创建：预览通过并提示将按路径创建分类（预览阶段不落库）',
      prevCreate.ok && prevCreate.data.valid === 1 && prevCreate.data.invalid === 0
        && (prevCreate.data.rows[0].warnings || []).some((w) => /自动创建/.test(w))
        && withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM product_categories WHERE name IN (?, ?)').get(newRoot, newSecond).n) === 0,
      prevCreate.ok ? prevCreate.data.rows[0].warnings.join('；') : prevCreate.message);

    const repCreate = await api('POST', '/api/data/import', {
      entity: 'product', rows: newRows, duplicate_mode: 'skip', auto_create_categories: true
    });
    check('勾选自动创建：导入 1 条，按路径顺序新建 2 个层级（新一级 + 新二级）',
      repCreate.ok && repCreate.data.imported === 1 && repCreate.data.categoriesCreated === 2
        && repCreate.data.failed === 0,
      repCreate.ok ? `新增 ${repCreate.data.imported}，新建分类 ${repCreate.data.categoriesCreated}` : repCreate.message);

    const newCats = withDb((db) => {
      const root = db.prepare(`SELECT * FROM product_categories
        WHERE name = ? AND parent_id IS NULL AND deleted_at IS NULL`).get(newRoot);
      const second = root ? db.prepare(`SELECT * FROM product_categories
        WHERE name = ? AND parent_id = ? AND deleted_at IS NULL`).get(newSecond, root.id) : null;
      const maxRootSort = db.prepare(`SELECT MAX(sort) AS s FROM product_categories
        WHERE parent_id IS NULL AND deleted_at IS NULL`).get().s;
      const maxSecondSort = root ? db.prepare(`SELECT MAX(sort) AS s FROM product_categories
        WHERE parent_id = ? AND deleted_at IS NULL`).get(root.id).s : null;
      const product = db.prepare('SELECT * FROM products WHERE name = ? AND deleted_at IS NULL').get(TAG + '庚');
      return { root, second, maxRootSort, maxSecondSort, product };
    });
    check('自动创建的分类：is_system=0、父子关系正确、sort 排到同级末尾',
      !!newCats.root && !!newCats.second
        && Number(newCats.root.is_system) === 0 && Number(newCats.second.is_system) === 0
        && Number(newCats.second.parent_id) === Number(newCats.root.id)
        && Number(newCats.root.sort) === Number(newCats.maxRootSort)
        && Number(newCats.second.sort) === Number(newCats.maxSecondSort),
      newCats.root ? `新一级 #${newCats.root.id} sort=${newCats.root.sort}，新二级 #${newCats.second.id} sort=${newCats.second.sort}` : '未找到新分类');
    check('产品落在自动创建的新二级分类下',
      !!newCats.product && !!newCats.second
        && Number(newCats.product.category_id) === Number(newCats.second.id)
        && Number(newCats.product.lead_time_days) === 14,
      newCats.product ? `产品分类=${newCats.product.category_id}，货期 2 周=${newCats.product.lead_time_days} 天` : '未找到产品庚');

    /* ---------------- 9. 审计日志 ---------------- */
    const logs = await api('GET', '/api/logs?entity_type=product&action=import&pageSize=100');
    const importLogs = logs.ok ? (logs.data.list || []).filter((l) => /^批量导入产品 \d+ 个$/.test(l.summary || '')) : [];
    const logDetail = withDb((db) => db.prepare(`SELECT * FROM activity_logs
      WHERE entity_type = 'product' AND action = 'import' ORDER BY id DESC LIMIT 1`).get());
    let detailObj = {};
    try { detailObj = JSON.parse((logDetail && logDetail.detail) || '{}'); } catch (_) { /* 忽略 */ }
    check('审计：product/import 摘要「批量导入产品 N 个」，明细含数量/新建分类/产品名',
      logs.ok && importLogs.length >= 1 && !!logDetail
        && Number(detailObj.categoriesCreated) === 2
        && Array.isArray(detailObj.names) && detailObj.names.some((n) => String(n).includes(TAG)),
      logs.ok ? `例如「${(importLogs[0] || {}).summary}」；detail=${String(logDetail && logDetail.detail).slice(0, 100)}…` : logs.message);
  } finally {
    /* ---------------- 10. 清理 ---------------- */
    let left = { products: -1, categories: -1, logs: -1 };
    try {
      purgeTag();
      left = withDb((db) => ({
        products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE name LIKE ?').get(`%${TAG}%`).n,
        categories: db.prepare('SELECT COUNT(*) AS n FROM product_categories WHERE name LIKE ?').get(`%${TAG}%`).n,
        logs: db.prepare('SELECT COUNT(*) AS n FROM activity_logs WHERE summary LIKE ? OR detail LIKE ?')
          .get(`%${TAG}%`, `%${TAG}%`).n
      }));
    } catch (e) {
      check('测试数据已清理（产品 / 自动创建的分类 / 日志）', false, e.message);
    }
    check('测试数据已清理（产品 / 自动创建的分类 / 日志）',
      left.products === 0 && left.categories === 0 && left.logs === 0,
      `残留产品 ${left.products} 个、分类 ${left.categories} 个、日志 ${left.logs} 条`);
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.mkdirSync(path.join(ROOT, '.fixtures'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'products-import-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e.stack || e);
  try { purgeTag(); } catch (_) { /* 忽略 */ }
  process.exit(1);
});
