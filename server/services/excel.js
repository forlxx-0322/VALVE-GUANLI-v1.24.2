/**
 * 数据导入导出服务
 *
 * 架构说明（重要）：
 *   SheetJS 运行在**浏览器**里，因此：
 *     - 导出：后端返回数据 + 列定义，前端生成 xlsx 并触发下载
 *     - 导入：前端解析 xlsx 为 JSON 后提交后端；后端只做校验与落库
 *   好处：后端保持零第三方依赖；前端可即时预览、逐行报错，用户体验更好。
 *
 * 本文件负责：字段定义、模板与示例、行校验、查重、落库、错误报告。
 */

'use strict';

const { now } = require('../db');
const { syncCustomerRegion, nextCustomerNo } = require('./crm');

/* ------------------------------------------------------------------ */
/* 导入字段定义（也是导出与模板的列定义）                                */
/* ------------------------------------------------------------------ */

/** 客户导入字段（1.23 精简模型：只有公司资料 + 主联系人 + 回访 + 地址） */
const CUSTOMER_FIELDS = [
  { key: 'name', label: '客户全称', required: true, width: 34, sample: '中国石油天然气股份有限公司独山子石化分公司' },
  { key: 'short_name', label: '客户简称', width: 16, sample: '独山子石化' },
  { key: 'customer_no', label: '客户编号', width: 16, hint: '留空自动生成 KH-YYYY-0001' },
  { key: 'industry', label: '行业', dict: 'industry', width: 12, sample: '石油' },
  { key: 'source', label: '客户来源', dict: 'customer_source', width: 14, sample: '设计院推荐' },
  { key: 'contact_name', label: '联系人', width: 12, sample: '王建国' },
  { key: 'contact_position', label: '联系人职务', dict: 'contact_position', width: 14, sample: '采购经理' },
  { key: 'contact_phone', label: '联系人手机', width: 16, sample: '13909920001' },
  { key: 'contact_birthday', label: '联系人生日', width: 14, sample: '1980-05-20' },
  { key: 'email', label: '邮箱', width: 22, sample: 'procurement@example.com' },
  { key: 'province', label: '省/自治区', width: 16, sample: '新疆维吾尔自治区' },
  { key: 'city', label: '市/地区', width: 16, sample: '克拉玛依市' },
  { key: 'district', label: '区/县', width: 14, sample: '独山子区' },
  { key: 'address', label: '详细地址', width: 26, sample: '独山子区大庆路 1 号' },
  { key: 'follow_cycle_days', label: '回访周期(天)', type: 'number', width: 14, sample: 30 },
  { key: 'next_follow_at', label: '下次回访', width: 20, sample: '2026-03-01 10:00' },
  { key: 'remark', label: '备注', width: 30 }
];

/** 联系人导入字段 */
const CONTACT_FIELDS = [
  { key: 'customer_name', label: '客户全称', required: true, width: 34, sample: '中国石油天然气股份有限公司独山子石化分公司' },
  { key: 'name', label: '姓名', required: true, width: 12, sample: '王建国' },
  { key: 'position', label: '职位', dict: 'contact_position', width: 16, sample: '采购经理' },
  { key: 'department', label: '所属部门', width: 14, sample: '采购部' },
  { key: 'mobile', label: '手机号', width: 16, sample: '13909920001' },
  { key: 'phone', label: '座机', width: 16 },
  { key: 'wechat', label: '微信', width: 14 },
  { key: 'email', label: '邮箱', width: 22 },
  { key: 'is_primary', label: '主联系人', type: 'yesno', width: 12, sample: '是' },
  { key: 'is_decision', label: '决策人', type: 'yesno', width: 12, sample: '是' },
  { key: 'influence', label: '影响力', dict: 'contact_influence', width: 14, sample: '关键决策' },
  { key: 'birthday', label: '生日', width: 14 },
  { key: 'remark', label: '备注', width: 24 }
];

/** 项目导入字段 */
const PROJECT_FIELDS = [
  { key: 'customer_name', label: '客户全称', required: true, width: 34, sample: '中国石油天然气股份有限公司独山子石化分公司' },
  { key: 'name', label: '项目名称', required: true, width: 34, sample: '塔河炼化 2026 年大修阀门采购项目' },
  { key: 'stage', label: '项目阶段', dict: 'project_stage', width: 14, sample: '投标/议价' },
  { key: 'progress', label: '进度(%)', type: 'number', width: 12, sample: 30 },
  { key: 'end_user', label: '最终用户', width: 20 },
  { key: 'design_institute', label: '设计院', width: 22 },
  { key: 'valve_needs', label: '阀门需求', type: 'multiline', width: 24, sample: '闸阀,截止阀' },
  { key: 'quantity', label: '数量(台/套)', type: 'number', width: 14, sample: 260 },
  { key: 'contract_amount', label: '合同金额(元)', type: 'number', width: 16, sample: 1860000 },
  { key: 'bid_date', label: '投标日期', width: 14, sample: '2026-03-10' },
  { key: 'bid_result', label: '投标结果', width: 16, sample: '已投标待开标' },
  { key: 'win_rate_note', label: '中标/失标原因', width: 18 },
  { key: 'signed_at', label: '签约日期', width: 14 },
  { key: 'delivery_date', label: '合同交货期', width: 14 },
  { key: 'start_date', label: '开始日期', width: 14 },
  { key: 'end_date', label: '预计结束日期', width: 14 },
  { key: 'owner', label: '负责人', width: 12 },
  { key: 'remark', label: '备注', width: 24 }
];

/**
 * 产品导入字段（1.26 新增）。
 *
 * 口径：
 *   · 分类路径用 / 或 > 分隔，逐级按名称匹配现有分类；
 *   · 货期按「周」填写（可一位小数），落库仍换算成 lead_time_days（天）；
 *   · 折扣、启用、单价等与产品表单同口径。
 */
const PRODUCT_FIELDS = [
  { key: 'category_path', label: '分类路径', required: true, width: 34,
    sample: '蝶阀 / 三偏心蝶阀 / 对夹', hint: '用 / 或 > 分隔，如：蝶阀 / 三偏心蝶阀 / 对夹' },
  { key: 'name', label: '产品名称', required: true, width: 30, sample: 'DN200 三偏心对夹蝶阀' },
  { key: 'code', label: '产品编号', width: 16, hint: '可留空；非空时全库唯一' },
  { key: 'unit', label: '单位', width: 8, sample: '台', hint: '留空默认「台」' },
  { key: 'price', label: '单价', type: 'number', width: 12, sample: 1280 },
  { key: 'lead_time_weeks', label: '货期(周)', type: 'number', width: 10, sample: 3,
    hint: '按周填写，可一位小数；空按 0 处理' },
  { key: 'body_material', label: '阀体材质', dict: 'body_material', width: 14, sample: '碳钢 WCB' },
  { key: 'pressure_rating', label: '压力等级', dict: 'pressure_rating', width: 10, sample: 'PN16' },
  { key: 'discount', label: '折扣(%)', type: 'number', width: 10, sample: 10 },
  { key: 'remark', label: '备注', width: 26 },
  { key: 'enabled', label: '启用', type: 'yesno', width: 8, sample: '是' }
];

const SCHEMAS = {
  customer: { key: 'customer', label: '客户', fields: CUSTOMER_FIELDS, matchKey: 'name' },
  contact: { key: 'contact', label: '联系人', fields: CONTACT_FIELDS, matchKey: 'name' },
  project: { key: 'project', label: '项目', fields: PROJECT_FIELDS, matchKey: 'name' },
  product: { key: 'product', label: '产品', fields: PRODUCT_FIELDS, matchKey: 'name' }
};

/** 产品导入上限与其他业务约定 */
const PRODUCT_MAX_ROWS = 2000;
const PRODUCT_NOTES = [
  '1. 带 * 的列为必填项：分类路径、产品名称；其余列可留空。',
  '2. 分类路径用「/」或「>」分隔，逐级按名称匹配现有分类，例如：蝶阀 / 三偏心蝶阀 / 对夹，或 蝶阀>三偏心蝶阀>对夹；首尾空格会被忽略。',
  '3. 分类不存在时，若导入时勾选「分类不存在时自动创建」，缺失的层级会按路径顺序自动创建（is_system=0，排在同级末尾）；不勾选则该行报错。',
  '4. 产品名称在同一分类下不能重名（跨分类允许同名）；重名行按导入设置「跳过」或「更新已有记录」。',
  '5. 产品编号可留空；非空时全库唯一，重复则整行报错（不覆盖已有产品）。',
  '6. 单价 ≥ 0，保留两位小数；折扣(%) 0~100；货期(周) ≥ 0，最多一位小数（如 3、3.5、0.5），留空按 0 处理。',
  '7. 启用填 是 / 否 / 1 / 0，留空按「是」处理；单位留空默认「台」。',
  '8. 空行会被跳过；表头顺序可调整，多余列会被忽略；单次最多导入 2000 行。',
  '9. 导入前会先校验并预览，确认后才写入；更新重名记录时只覆盖表格里填了值的列，留空的列保留原值。',
  '10. 导入成功后会同时刷新左侧分类树与右侧产品列表。'
];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 把 Excel 单元格值转成字符串 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).trim();
}

/** 是/否 → 1/0 */
function yesNo(v) {
  const s = cellText(v).toLowerCase();
  if (!s) return 0;
  if (['是', 'y', 'yes', 'true', '1', '√', '有'].includes(s)) return 1;
  return 0;
}

/** 归一化日期：支持 2026/3/1、2026-03-01、20260301 */
function normDate(v) {
  const s = cellText(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/年.]?(\d{1,2})[-/月.]?(\d{1,2})/);
  if (m) {
    const p = (n) => String(n).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])}`;
  }
  // Excel 序列号
  const n = Number(s);
  if (isFinite(n) && n > 20000 && n < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  return s;
}

/** 归一化日期时间 */
function normDateTime(v) {
  const d = normDate(v);
  if (!d) return '';
  const s = cellText(v);
  const tm = s.match(/(\d{1,2}):(\d{2})/);
  return tm ? `${d} ${String(tm[1]).padStart(2, '0')}:${tm[2]}:00` : `${d} 09:00:00`;
}

/** 按字段类型归一值 */
function normValue(field, raw, dictCache) {
  const s = cellText(raw);
  if (field.type === 'yesno') return yesNo(raw);
  if (field.type === 'number') {
    if (!s) return 0;
    const n = Number(s.replace(/[,，\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  if (field.key === 'contact_birthday'
    || field.key === 'signed_at' || field.key === 'bid_date' || field.key === 'delivery_date'
    || field.key === 'start_date' || field.key === 'end_date' || field.key === 'birthday') {
    return normDateRaw(s);
  }
  if (field.key === 'next_follow_at') return normDateTime(raw);

  /* 字典字段：校验值是否在字典中，不在则保留原值（允许用户自定义） */
  if (field.dict && s && dictCache && dictCache[field.dict]) {
    const hit = dictCache[field.dict].find((x) => x === s);
    if (!hit) return s;   // 保留原值，由业务层决定是否新增选项
  }
  return s;
}

function normDateRaw(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})[-/年.]?(\d{1,2})[-/月.]?(\d{1,2})/);
  if (m) {
    const p = (n) => String(n).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3])}`;
  }
  return String(s);
}

/** 读取字典（用于校验与提示） */
function readDictMap(db) {
  const rows = db.prepare(
    'SELECT category, value FROM dict WHERE deleted_at IS NULL AND enabled = 1'
  ).all();
  const map = {};
  for (const r of rows) (map[r.category] = map[r.category] || []).push(r.value);
  return map;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** 产品分类路径：支持 / \ > ＞ ／ 分隔；首尾与每一级空格忽略 */
function splitCategoryPath(v) {
  const s = cellText(v);
  if (!s) return [];
  return s.split(/[\/\\>＞／]+/).map((x) => x.trim()).filter(Boolean);
}

/** 分类索引：parent_id + name → id（只看未删除分类） */
function productCategoryIndex(db) {
  const rows = db.prepare(`SELECT id, parent_id, name, sort FROM product_categories
    WHERE deleted_at IS NULL`).all();
  const byParent = new Map();
  const byId = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    const parentId = r.parent_id == null ? null : Number(r.parent_id);
    byParent.set(`${parentId == null ? 0 : parentId}\u0000${r.name}`, id);
    byId.set(id, { id, parent_id: parentId, name: r.name });
  }
  return { rows, byParent, byId };
}

function categoryChildId(index, parentId, name) {
  return index.byParent.get(`${parentId == null ? 0 : Number(parentId)}\u0000${name}`) || null;
}

/** 全部分类全路径（未删除），按中文路径排序 */
function listCategoryPaths(db) {
  const rows = db.prepare(`SELECT id, parent_id, name FROM product_categories
    WHERE deleted_at IS NULL ORDER BY sort, id`).all();
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const cache = new Map();
  const build = (id, seen) => {
    const key = Number(id);
    if (cache.has(key)) return cache.get(key);
    const row = byId.get(key);
    if (!row) return '';
    if (!seen) seen = new Set();
    if (seen.has(key)) return row.name;
    seen.add(key);
    const parentPath = row.parent_id == null ? '' : build(Number(row.parent_id), seen);
    const path = parentPath ? `${parentPath} / ${row.name}` : row.name;
    cache.set(key, path);
    return path;
  };
  const paths = [];
  for (const r of rows) {
    const p = build(Number(r.id));
    if (p) paths.push(p);
  }
  return paths.sort((a, b) => a.localeCompare(b, 'zh'));
}

/** 分类 id → 全路径（含已删除分类，历史产品也能显示路径） */
function categoryPathMap(db) {
  const rows = db.prepare('SELECT id, parent_id, name FROM product_categories').all();
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const cache = new Map();
  const build = (id, seen) => {
    const key = Number(id);
    if (cache.has(key)) return cache.get(key);
    const row = byId.get(key);
    if (!row) return '';
    if (!seen) seen = new Set();
    if (seen.has(key)) return row.name;
    seen.add(key);
    const parentPath = row.parent_id == null ? '' : build(Number(row.parent_id), seen);
    const path = parentPath ? `${parentPath} / ${row.name}` : row.name;
    cache.set(key, path);
    return path;
  };
  for (const r of rows) build(Number(r.id));
  return cache;
}

/** 模板示例行用真实存在的三级分类；优先「蝶阀 / 三偏心蝶阀 / 对夹」 */
function pickSampleCategoryPath(paths) {
  if (!paths.length) return '';
  const preferred = '蝶阀 / 三偏心蝶阀 / 对夹';
  if (paths.includes(preferred)) return preferred;
  const three = paths.find((p) => p.split(' / ').length >= 3);
  return three || paths[0];
}

/* ------------------------------------------------------------------ */
/* 模板与导出列定义                                                     */
/* ------------------------------------------------------------------ */

/**
 * 生成导入模板的列定义。
 * @param {object} db  用于读取字典当前可选值（供模板里生成「可选值参考」页）
 * @param {string} entity customer / contact / project / product
 */
function getTemplate(db, entity) {
  const schema = SCHEMAS[entity];
  if (!schema) throw Object.assign(new Error('不支持的导入类型：' + entity), { status: 400, code: 'BAD_ENTITY' });
  const dictMap = readDictMap(db);
  const fields = schema.fields.map((f) => ({
    key: f.key, label: f.label, required: !!f.required,
    type: f.type || 'text', width: f.width || 16,
    /* 带字典的列，把当前可选值一并返回，供模板生成「可选值参考」页 */
    dict: f.dict || '',
    options: f.dict ? (dictMap[f.dict] || []) : []
  }));

  /* 产品：额外返回分类路径清单、填写说明与可选值，供模板三页使用 */
  if (entity === 'product') {
    const paths = listCategoryPaths(db);
    const categoryPaths = paths.slice(0, 200);
    const sampleCategory = pickSampleCategoryPath(paths);
    const material = (dictMap.body_material || []);
    const pressure = (dictMap.pressure_rating || []);
    const sample = schema.fields.map((f) => {
      if (f.key === 'category_path') return sampleCategory;
      if (f.key === 'body_material') {
        return material.includes('碳钢 WCB') ? '碳钢 WCB' : (material[0] || '');
      }
      if (f.key === 'pressure_rating') {
        return pressure.includes('PN16') ? 'PN16' : (pressure[0] || '');
      }
      return f.sample === undefined ? '' : f.sample;
    });
    return {
      entity: schema.key,
      label: schema.label,
      sheetName: '导入模板',
      maxRows: PRODUCT_MAX_ROWS,
      fields,
      sample,
      notes: PRODUCT_NOTES.slice(),
      categoryPaths,
      categoryPathsTotal: paths.length,
      options: {
        category_paths: categoryPaths,
        body_material: material,
        pressure_rating: pressure,
        enabled: ['是', '否'],
        duplicate_mode: [
          { value: 'skip', label: '跳过（保留库中已有资料）' },
          { value: 'update', label: '更新已有记录（只覆盖表格里填了值的列）' }
        ]
      },
      defaults: {
        unit: '台',
        enabled: '是',
        auto_create_categories: true,
        max_rows: PRODUCT_MAX_ROWS
      }
    };
  }

  return {
    entity: schema.key,
    label: schema.label,
    fields,
    sample: schema.fields.map((f) => (f.sample === undefined ? '' : f.sample))
  };
}

/**
 * 导出数据：返回 { entity, fields, rows }
 * 前端用 SheetJS 生成 xlsx
 */
function exportData(db, entity, options) {
  const schema = SCHEMAS[entity] || SCHEMAS.customer;
  const opts = options || {};
  const fields = schema.fields;
  let rows = [];

  if (entity === 'contact') {
    rows = db.prepare(`
      SELECT c.name AS customer_name, ct.name, ct.position, ct.department, ct.mobile,
             ct.phone, ct.wechat, ct.email, ct.is_primary, ct.is_decision, ct.influence,
             ct.birthday, ct.remark
      FROM contacts ct JOIN customers c ON c.id = ct.customer_id
      WHERE ct.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY c.id, ct.is_primary DESC, ct.id
    `).all();
  } else if (entity === 'project') {
    rows = db.prepare(`
      SELECT c.name AS customer_name, p.name, p.stage, p.progress, p.end_user,
             p.design_institute, p.valve_needs, p.quantity, p.contract_amount,
             p.bid_date, p.bid_result, p.win_rate_note, p.signed_at, p.delivery_date,
             p.start_date, p.end_date, p.owner, p.remark
      FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.deleted_at IS NULL
      ORDER BY p.id DESC
    `).all();
  } else if (entity === 'product') {
    const paths = categoryPathMap(db);
    rows = db.prepare(`SELECT * FROM products WHERE deleted_at IS NULL ORDER BY sort, id`).all()
      .map((r) => ({
        category_path: paths.get(Number(r.category_id)) || '',
        name: r.name,
        code: r.code || '',
        unit: r.unit || '',
        price: round2(r.price),
        lead_time_weeks: round1((Number(r.lead_time_days) || 0) / 7),
        body_material: r.body_material || '',
        pressure_rating: r.pressure_rating || '',
        discount: round2(r.discount),
        remark: r.remark || '',
        enabled: Number(r.enabled) === 1 ? 1 : 0
      }));
  } else {
    /* 客户：支持按当前筛选条件导出 */
    const where = ['deleted_at IS NULL'];
    const params = [];
    if (opts.ids && opts.ids.length) {
      where.push(`id IN (${opts.ids.map(() => '?').join(', ')})`);
      params.push(...opts.ids.map(Number));
    } else {
      if (opts.industry) { where.push('industry = ?'); params.push(opts.industry); }
      if (opts.source) { where.push('source = ?'); params.push(opts.source); }
      if (opts.region_code) { where.push('region_code = ?'); params.push(opts.region_code); }
    }
    const cols = fields.map((f) => f.key).join(', ');
    rows = db.prepare(
      `SELECT ${cols} FROM customers WHERE ${where.join(' AND ')} ORDER BY id DESC`
    ).all(...params);
  }

  /* 把 1/0 转成 是/否，便于阅读 */
  const out = rows.map((r) => {
    const o = {};
    for (const f of fields) {
      let v = r[f.key];
      if (f.type === 'yesno') v = v ? '是' : '否';
      o[f.key] = v === null || v === undefined ? '' : v;
    }
    return o;
  });

  return {
    entity: schema.key,
    label: schema.label,
    fields: fields.map((f) => ({
      key: f.key, label: f.label, required: !!f.required,
      type: f.type || 'text', width: f.width || 16
    })),
    rows: out,
    count: out.length
  };
}

/* ------------------------------------------------------------------ */
/* 导入：逐行校验                                                       */
/* ------------------------------------------------------------------ */

/**
 * 逐行校验导入数据。
 *
 * 关键区分：**「与库中重名」是"重复"，不是"错误"**。
 * 早期实现把它塞进 errors，导致重复行被算作"校验未通过"、
 * 既不能跳过也不能更新，前端设的"遇到同名客户"选项形同虚设。
 * 现在：
 *   - duplicateMode='skip'   → 该行标记 action='skip'，计入 valid（会被跳过而非失败）
 *   - duplicateMode='update' → 该行标记 action='update'，导入时更新已有记录
 * 只有真正无法导入的问题（必填缺失、文件内重复、找不到所属客户）才算错误。
 *
 * @param {object} db
 * @param {string} entity
 * @param {Array} rawRows
 * @param {object} options { duplicateMode: 'skip' | 'update' }
 */
function validateRows(db, entity, rawRows, options) {
  const opts = options || {};
  const duplicateMode = opts.duplicateMode === 'update' ? 'update' : 'skip';
  const schema = SCHEMAS[entity];
  if (!schema) throw Object.assign(new Error('不支持的导入类型：' + entity), { status: 400, code: 'BAD_ENTITY' });
  if (!Array.isArray(rawRows)) throw Object.assign(new Error('导入数据格式错误'), { status: 400, code: 'BAD_DATA' });
  if (entity === 'product') return validateProductRows(db, rawRows, opts);
  if (rawRows.length > 5000) throw Object.assign(new Error('单次最多导入 5000 行'), { status: 400, code: 'TOO_MANY' });

  const dictMap = readDictMap(db);
  const results = [];
  const seenKeys = new Map();   // 文件内查重
  let valid = 0;
  let invalid = 0;
  let duplicateCount = 0;

  /* 预取已有客户名与 id，用于查重与更新 */
  const existingCustomers = new Map(
    db.prepare('SELECT id, name FROM customers WHERE deleted_at IS NULL').all().map((r) => [r.name, r.id])
  );
  const existingProjects = new Map(
    db.prepare('SELECT id, name FROM projects WHERE deleted_at IS NULL').all().map((r) => [r.name, r.id])
  );

  rawRows.forEach((raw, i) => {
    const errors = [];
    const data = {};

    for (const f of schema.fields) {
      const v = normValue(f, raw[f.key], dictMap);
      data[f.key] = v;
      if (f.required && (v === '' || v === null || v === undefined)) {
        errors.push(`「${f.label}」为必填项`);
      }
    }

    /* 字典值是否已存在（仅提示，不阻止导入） */
    const dictWarnings = [];
    for (const f of schema.fields) {
      if (!f.dict) continue;
      const v = data[f.key];
      if (!v) continue;
      const list = dictMap[f.dict] || [];
      if (!list.includes(v)) dictWarnings.push(`「${f.label}」的值「${v}」不在字典中，导入后会自动新增该选项`);
    }

    /* 文件内查重 */
    const key = data[schema.matchKey];
    let duplicateInFile = false;
    if (key) {
      if (seenKeys.has(key)) duplicateInFile = true;
      else seenKeys.set(key, i + 1);
    }

    /* 与库中已有数据查重 */
    let duplicateInDb = false;
    let existingId = null;
    if (entity === 'customer' && data.name && existingCustomers.has(data.name)) {
      duplicateInDb = true;
      existingId = existingCustomers.get(data.name);
    }
    if (entity === 'project' && data.name && existingProjects.has(data.name)) {
      duplicateInDb = true;
      existingId = existingProjects.get(data.name);
    }

    /* 联系人需要能匹配到客户 */
    let customerMissing = false;
    if (entity === 'contact' || entity === 'project') {
      if (data.customer_name && !existingCustomers.has(data.customer_name)) customerMissing = true;
    }

    /* 只有真正无法导入的问题才算错误 */
    if (duplicateInFile) errors.push(`文件内第 ${seenKeys.get(key)} 行已存在同名「${key}」`);
    if (customerMissing) errors.push(`找不到客户「${data.customer_name}」，请先导入该客户`);

    /* 重名作为"重复"处理，按所选模式决定跳过还是更新 */
    if (duplicateInDb) {
      duplicateCount++;
      dictWarnings.push(duplicateMode === 'update'
        ? `库中已有同名「${data.name}」，将更新该记录`
        : `库中已有同名「${data.name}」，将跳过该行`);
    }

    const ok = errors.length === 0;
    if (ok) valid++; else invalid++;

    results.push({
      index: i + 1,
      data,
      errors,
      warnings: dictWarnings,
      duplicateInDb,
      existingId,
      action: ok ? (duplicateInDb ? duplicateMode : 'create') : 'error'
    });
  });

  return {
    entity: schema.key,
    label: schema.label,
    total: rawRows.length,
    valid,
    invalid,
    duplicateCount,
    duplicateMode,
    rows: results
  };
}

/* ------------------------------------------------------------------ */
/* 导入：产品专用校验（1.26）                                           */
/* ------------------------------------------------------------------ */

const PRODUCT_TRUE_WORDS = new Set(['是', 'y', 'yes', 'true', '1', '√', '有']);
const PRODUCT_FALSE_WORDS = new Set(['否', 'n', 'no', 'false', '0', '×', '无']);

/** 产品行是否全空（按产品导入字段判断，多余列忽略） */
function productRowIsBlank(raw) {
  if (!raw || typeof raw !== 'object') return true;
  for (const f of PRODUCT_FIELDS) {
    if (cellText(raw[f.key]) !== '') return false;
  }
  return true;
}

/**
 * 归一化一行产品导入值。
 * 数值列在这里严格校验（不沿用 normValue 的"非法即 0"），
 * 避免把 −1 单价、120 折扣、−1 货期悄悄写成 0。
 */
function normalizeProductValues(raw, errors, provided) {
  const r = raw || {};
  const data = { category_path: '', category_id: null, name: '', code: '', unit: '台',
    price: 0, lead_time_weeks: 0, lead_time_days: 0, body_material: '', pressure_rating: '',
    discount: 0, remark: '', enabled: 1 };

  const segments = splitCategoryPath(r.category_path);
  data.category_path = segments.join(' / ');
  if (!segments.length) errors.push('「分类路径」为必填项');

  data.name = cellText(r.name);
  if (!data.name) errors.push('「产品名称」为必填项');

  data.code = cellText(r.code);
  if (data.code) provided.add('code');

  const unit = cellText(r.unit);
  data.unit = unit || '台';
  if (unit) provided.add('unit');

  /* 单价：≥0，保留两位小数 */
  const priceRaw = cellText(r.price);
  if (priceRaw) {
    const s = priceRaw.replace(/[,，\s]/g, '');
    const n = Number(s);
    if (!s || !Number.isFinite(n)) errors.push('「单价」必须是数字');
    else if (n < 0) errors.push('「单价」不能小于 0');
    else {
      data.price = round2(n);
      provided.add('price');
    }
  }

  /* 货期：按周填写，≥0，最多一位小数；落库换算成天（四舍五入） */
  const leadRaw = cellText(r.lead_time_weeks);
  if (leadRaw) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(leadRaw)) {
      errors.push('「货期(周)」必须是不小于 0 的数字');
    } else {
      const dec = leadRaw.includes('.') ? (leadRaw.split('.')[1] || '').length : 0;
      if (dec > 1) {
        errors.push('「货期(周)」最多保留一位小数');
      } else {
        const weeks = Number(leadRaw);
        if (!Number.isFinite(weeks) || weeks < 0) errors.push('「货期(周)」必须是不小于 0 的数字');
        else {
          data.lead_time_weeks = round1(weeks);
          data.lead_time_days = Math.round(weeks * 7);
          provided.add('lead_time_weeks');
          provided.add('lead_time_days');
        }
      }
    }
  }

  /* 折扣：0~100 */
  const discountRaw = cellText(r.discount);
  if (discountRaw) {
    const s = discountRaw.replace(/[,，\s]/g, '');
    const n = Number(s);
    if (!s || !Number.isFinite(n)) errors.push('「折扣(%)」必须是数字');
    else if (n < 0 || n > 100) errors.push('「折扣(%)」必须在 0~100 之间');
    else {
      data.discount = round2(n);
      provided.add('discount');
    }
  }

  /* 启用：是/否/1/0，留空默认是 */
  const enabledRaw = cellText(r.enabled);
  if (enabledRaw) {
    const s = enabledRaw.toLowerCase();
    if (PRODUCT_TRUE_WORDS.has(s)) {
      data.enabled = 1;
      provided.add('enabled');
    } else if (PRODUCT_FALSE_WORDS.has(s)) {
      data.enabled = 0;
      provided.add('enabled');
    } else {
      errors.push('「启用」只能填 是 / 否 / 1 / 0（留空按「是」处理）');
    }
  }

  data.body_material = cellText(r.body_material);
  if (data.body_material) provided.add('body_material');
  data.pressure_rating = cellText(r.pressure_rating);
  if (data.pressure_rating) provided.add('pressure_rating');
  data.remark = cellText(r.remark);
  if (data.remark) provided.add('remark');

  return { data, segments };
}

/** 解析分类路径：逐级匹配现有分类；缺失时只记录，不写库（预览阶段） */
function resolveProductCategory(index, segments, autoCreate) {
  let parentId = null;
  let missingStart = -1;
  for (let i = 0; i < segments.length; i++) {
    const hit = categoryChildId(index, parentId, segments[i]);
    if (hit) parentId = hit;
    else { missingStart = i; break; }
  }

  const path = segments.join(' / ');
  if (missingStart < 0) {
    return { segments, path, id: parentId, missing: [], willCreate: false };
  }
  const missing = [];
  for (let i = missingStart; i < segments.length; i++) {
    missing.push({ depth: i + 1, name: segments[i] });
  }
  return { segments, path, id: null, missing, willCreate: !!autoCreate };
}

/**
 * 产品导入逐行校验。
 *
 * 与客户导入同口径：
 *   · 与库中同分类重名 = "重复"（skip / update），不是错误；
 *   · 文件内重名、编号冲突、必填缺失、数值越界 = 错误；
 *   · 分类不存在且勾选自动创建时，只提示"将自动创建"，预览阶段不落库。
 */
function validateProductRows(db, rawRows, opts) {
  const autoCreateCategories = opts.autoCreateCategories !== false;
  const duplicateMode = opts.duplicateMode === 'update' ? 'update' : 'skip';

  if (rawRows.length > PRODUCT_MAX_ROWS) {
    throw Object.assign(new Error(`单次最多导入 ${PRODUCT_MAX_ROWS} 行`),
      { status: 400, code: 'TOO_MANY' });
  }

  const items = [];
  rawRows.forEach((raw, i) => {
    if (!productRowIsBlank(raw)) items.push({ raw: raw || {}, index: i + 1 });
  });
  const blankSkipped = rawRows.length - items.length;

  const dictMap = readDictMap(db);
  const catIndex = productCategoryIndex(db);
  const existingProducts = new Map();
  for (const r of db.prepare(
    'SELECT id, category_id, name FROM products WHERE deleted_at IS NULL'
  ).all()) {
    existingProducts.set(`${Number(r.category_id)}\u0000${r.name}`, Number(r.id));
  }
  const existingCodes = new Map();
  for (const r of db.prepare(
    "SELECT id, name, code FROM products WHERE deleted_at IS NULL AND code <> ''"
  ).all()) {
    existingCodes.set(r.code, { id: Number(r.id), name: r.name });
  }

  const seenNames = new Map();
  const seenCodes = new Map();
  const pathCache = new Map();
  const results = [];
  let valid = 0;
  let invalid = 0;
  let duplicateCount = 0;

  for (const item of items) {
    const errors = [];
    const warnings = [];
    const provided = new Set();
    const { data, segments } = normalizeProductValues(item.raw, errors, provided);

    /* 分类路径解析（不写库） */
    let category = { segments: [], path: '', id: null, missing: [], willCreate: false };
    if (segments.length) {
      const cacheKey = segments.join('\u0000');
      if (!pathCache.has(cacheKey)) {
        pathCache.set(cacheKey, resolveProductCategory(catIndex, segments, autoCreateCategories));
      }
      category = pathCache.get(cacheKey);
      data.category_path = category.path;
      if (category.id) data.category_id = category.id;
      if (category.missing.length) {
        if (autoCreateCategories) {
          warnings.push(`分类「${category.path}」不存在，导入时将自动创建 ${category.missing.length} 个层级`);
        } else {
          const miss = category.missing[0];
          errors.push(`分类路径「${category.path}」的第 ${miss.depth} 级分类「${miss.name}」不存在（可勾选「分类不存在时自动创建」）`);
        }
      }
    }

    /* 文件内重名：按「分类 + 名称」判断，跨分类允许同名 */
    let duplicateInFile = false;
    const nameKey = data.name ? `${category.id ? '#' + category.id : '~' + category.path}\u0000${data.name}` : '';
    if (nameKey) {
      if (seenNames.has(nameKey)) duplicateInFile = true;
      else seenNames.set(nameKey, item.index);
    }

    /* 与库中同分类重名 */
    let duplicateInDb = false;
    let existingId = null;
    if (data.name && category.id) {
      const hit = existingProducts.get(`${Number(category.id)}\u0000${data.name}`);
      if (hit) {
        duplicateInDb = true;
        existingId = hit;
      }
    }

    /* 产品编号全库唯一；更新同一记录时允许保留自己的编号 */
    if (data.code) {
      const codeHit = existingCodes.get(data.code);
      if (codeHit && Number(codeHit.id) !== Number(existingId)) {
        errors.push(`产品编号「${data.code}」已被「${codeHit.name}」占用`);
      }
      const prev = seenCodes.get(data.code);
      const sameRecord = existingId != null && prev && prev.id != null
        && Number(prev.id) === Number(existingId);
      if (prev && !sameRecord) {
        errors.push(`文件内第 ${prev.index} 行已使用相同产品编号「${data.code}」`);
      } else if (!prev) {
        seenCodes.set(data.code, { index: item.index, id: existingId });
      }
    }

    if (duplicateInFile) errors.push(`文件内第 ${seenNames.get(nameKey)} 行已存在同分类同名「${data.name}」`);

    /* 字典值提示（不阻止） */
    for (const f of SCHEMAS.product.fields) {
      if (!f.dict) continue;
      const v = data[f.key];
      if (!v) continue;
      const list = dictMap[f.dict] || [];
      if (!list.includes(v)) warnings.push(`「${f.label}」的值「${v}」不在字典中，导入后会自动新增该选项`);
    }

    if (duplicateInDb) {
      duplicateCount++;
      warnings.push(duplicateMode === 'update'
        ? `库中已有同分类同名「${data.name}」，将更新该记录`
        : `库中已有同分类同名「${data.name}」，将跳过该行`);
    }

    const ok = errors.length === 0;
    if (ok) valid++; else invalid++;

    results.push({
      index: item.index,
      data,
      errors,
      warnings,
      duplicateInDb,
      existingId,
      action: ok ? (duplicateInDb ? duplicateMode : 'create') : 'error',
      category,
      provided: Array.from(provided)
    });
  }

  return {
    entity: 'product',
    label: '产品',
    total: items.length,
    blankSkipped,
    valid,
    invalid,
    duplicateCount,
    duplicateMode,
    autoCreateCategories,
    rows: results
  };
}

/* ------------------------------------------------------------------ */
/* 导入：落库                                                          */
/* ------------------------------------------------------------------ */

/**
 * 执行导入
 * @param {object} db
 * @param {string} entity
 * @param {Array} rawRows  前端传来的行（这里会再校验一次）
 * @param {object} options { duplicateMode: 'skip' | 'update' }
 *   skip   → 与库中重名的行跳过，保留库中已有资料
 *   update → 与库中重名的行更新已有记录（只覆盖表格里填了值的列）
 */
function runImport(db, entity, rawRows, options) {
  const opts = options || {};
  const duplicateMode = opts.duplicateMode === 'update' ? 'update' : 'skip';
  const check = validateRows(db, entity, rawRows, {
    duplicateMode,
    autoCreateCategories: opts.autoCreateCategories
  });

  const report = {
    entity: check.entity,
    label: check.label,
    total: check.total,
    valid: check.valid,
    invalid: check.invalid,
    blankSkipped: check.blankSkipped || 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    dictAdded: 0,
    regionSynced: 0,
    categoriesCreated: 0,
    duplicateMode,
    errors: [],
    warnings: []
  };

  const insertable = check.rows.filter((r) => r.action !== 'error');
  const ts = now();

  db.exec('BEGIN');
  try {
    /* 1. 先把字典里缺失的选项补上，避免导入后下拉框对不上 */
    for (const r of insertable) {
      for (const f of SCHEMAS[entity].fields) {
        if (!f.dict) continue;
        const v = r.data[f.key];
        if (!v) continue;
        const exists = db.prepare(
          'SELECT id, enabled, deleted_at FROM dict WHERE category = ? AND value = ?'
        ).get(f.dict, v);
        if (exists && !exists.deleted_at) {
          if (!exists.enabled) {
            db.prepare('UPDATE dict SET enabled = 1, updated_at = ? WHERE id = ?').run(ts, exists.id);
          }
          continue;
        }
        if (exists && exists.deleted_at) {
          db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
            .run(ts, exists.id);
          continue;
        }
        const maxSort = db.prepare(
          'SELECT COALESCE(MAX(sort), 0) AS s FROM dict WHERE category = ?'
        ).get(f.dict).s;
        db.prepare(
          `INSERT INTO dict (category, value, color, sort, enabled, is_system, created_at, updated_at)
           VALUES (?, ?, '', ?, 1, 0, ?, ?)`
        ).run(f.dict, v, Number(maxSort) + 10, ts, ts);
        report.dictAdded++;
      }
    }

    /* 2. 逐行落库。三种动作：
          create → 新增；update → 覆盖已有记录里"本次填了值"的列；skip → 跳过
          （客户导入额外记录本次新增/更新的 id，供补归属使用） */
    const insertedCustomerIds = [];
    const touchedCustomerIds = [];
    for (const r of insertable) {
      try {
        if (r.action === 'skip') {
          report.skipped++;
          continue;
        }
        if (r.action === 'update' && r.existingId) {
          if (entity === 'product') {
            updateImportedProduct(db, r.existingId, r.data, new Set(r.provided || []), ts);
          } else {
            updateExisting(db, entity, r.existingId, r.data, ts);
          }
          report.updated++;
          if (entity === 'customer') touchedCustomerIds.push(r.existingId);
          continue;
        }

        if (entity === 'product') {
          /* 分类缺失时按路径顺序创建（已创建过的层级直接复用） */
          if (!r.data.category_id && r.category && r.category.missing.length) {
            const made = ensureProductCategoryPath(db, r.category, ts);
            r.data.category_id = made.id;
            report.categoriesCreated += made.created;
          }
          if (!r.data.category_id) throw new Error('产品分类无法确定，请检查分类路径');
          insertProduct(db, r.data, ts);
        } else if (entity === 'customer') {
          const id = insertCustomer(db, r.data, ts);
          insertedCustomerIds.push(id);
          touchedCustomerIds.push(id);
        } else if (entity === 'contact') {
          insertContact(db, r.data, ts);
        } else if (entity === 'project') {
          insertProject(db, r.data, ts);
        }
        report.imported++;
      } catch (e) {
        report.failed++;
        report.errors.push({ index: r.index, message: e.message });
      }
    }

    /* 3. 导入的客户按「市/地区」自动归属地州
         说明：导入走的是直接 INSERT（不是 saveCustomer），不会经过归属逻辑，
         所以这里必须显式补一次，否则批量导入的客户
         在地图分布、按区域筛选中都会缺失。 */
    if (entity === 'customer' && touchedCustomerIds.length) {
      for (const id of touchedCustomerIds) {
        try { syncCustomerRegion(db, id); } catch (_) { /* 单条失败不影响整体导入 */ }
      }
      const marks = touchedCustomerIds.map(() => '?').join(', ');
      report.regionSynced = db.prepare(
        `SELECT COUNT(*) AS n FROM customers WHERE id IN (${marks}) AND region_code <> ''`
      ).get(...touchedCustomerIds).n;
      void insertedCustomerIds;
    }

    /* 4. 记录操作日志。
          产品导入按 1.26 要求记为 entity_type='product' / action='import'，摘要形如「批量导入产品 12 个」。 */
    if (entity === 'product') {
      const names = insertable.filter((r) => r.action !== 'error')
        .slice(0, 50).map((r) => r.data.name);
      db.prepare(
        `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
         VALUES ('product', NULL, 'import', ?, ?, ?)`
      ).run(
        `批量导入产品 ${report.imported} 个`,
        JSON.stringify({
          entity: 'product', imported: report.imported, updated: report.updated,
          skipped: report.skipped, failed: report.failed, invalid: report.invalid,
          categoriesCreated: report.categoriesCreated, names
        }),
        ts
      );
    } else {
      db.prepare(
        `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
         VALUES ('import', NULL, 'import', ?, ?, ?)`
      ).run(
        `Excel 导入${report.label}：新增 ${report.imported} 条，更新 ${report.updated} 条，跳过 ${report.skipped} 条，失败 ${report.failed} 条，校验未通过 ${report.invalid} 条`,
        JSON.stringify({ entity: report.entity, imported: report.imported, invalid: report.invalid }),
        ts
      );
    }

    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    throw e;
  }

  /* 把校验期的错误与提示一并带上，方便前端展示 */
  report.errors = report.errors.concat(
    check.rows.filter((r) => r.action === 'error')
      .map((r) => ({ index: r.index, message: r.errors.join('；') }))
  );
  report.warnings = check.rows.reduce((out, r) => {
    for (const message of (r.warnings || [])) out.push({ index: r.index, message });
    return out;
  }, []);

  return report;
}

/**
 * 按路径顺序补建缺失的产品分类。
 * 新建分类 is_system=0，sort 排到同级末尾；已存在的层级直接复用（不会重复创建）。
 * 返回 { id, created }，created 是本次真正新建的层级数。
 */
function ensureProductCategoryPath(db, category, ts) {
  const segments = (category && category.segments) || [];
  const index = productCategoryIndex(db);
  let parentId = null;
  let created = 0;

  for (let i = 0; i < segments.length; i++) {
    const hit = categoryChildId(index, parentId, segments[i]);
    if (hit) {
      parentId = hit;
      continue;
    }

    const logicalParentId = parentId;
    const maxSort = db.prepare(`SELECT COALESCE(MAX(sort), 0) AS s FROM product_categories
      WHERE deleted_at IS NULL AND parent_id IS ?`).get(logicalParentId).s;
    const info = db.prepare(`INSERT INTO product_categories
        (parent_id, name, sort, is_system, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run(logicalParentId, segments[i], Number(maxSort) + 10, ts, ts);
    const newId = Number(info.lastInsertRowid);

    index.byParent.set(`${logicalParentId == null ? 0 : logicalParentId}\u0000${segments[i]}`, newId);
    index.byId.set(newId, { id: newId, parent_id: logicalParentId, name: segments[i] });
    parentId = newId;
    created++;

    db.prepare(
      `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
       VALUES ('product_category', ?, 'create', ?, ?, ?)`
    ).run(
      newId,
      `Excel 导入新建产品分类：${segments.slice(0, i + 1).join(' / ')}`,
      JSON.stringify({ parent_id: logicalParentId, name: segments[i], source: 'product_import' }),
      ts
    );
  }

  return { id: parentId, created };
}

/** 导入新增产品（同分类 sort 排末尾） */
function insertProduct(db, d, ts) {
  const categoryId = Number(d.category_id);
  const maxSort = db.prepare(`SELECT COALESCE(MAX(sort), 0) AS s FROM products
    WHERE deleted_at IS NULL AND category_id = ?`).get(categoryId).s;
  db.prepare(`INSERT INTO products
    (category_id, name, code, unit, price, lead_time_days, body_material,
     pressure_rating, discount, remark, enabled, sort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    categoryId, d.name, d.code || '', d.unit || '台',
    round2(d.price || 0), Number(d.lead_time_days) || 0,
    d.body_material || '', d.pressure_rating || '', round2(d.discount || 0),
    d.remark || '', Number(d.enabled) === 0 ? 0 : 1,
    Number(maxSort) + 10, ts, ts
  );
}

/** 导入更新产品：只覆盖表格里实际填了值的列（匹配键 name / 分类不覆盖） */
function updateImportedProduct(db, id, d, provided, ts) {
  const keys = ['code', 'unit', 'price', 'lead_time_days', 'body_material',
    'pressure_rating', 'discount', 'remark', 'enabled'];
  const sets = [];
  const params = [];
  for (const key of keys) {
    if (!provided.has(key)) continue;
    sets.push(`${key} = ?`);
    params.push(d[key]);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  params.push(ts, Number(id));
  db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

/**
 * 更新一条已存在的记录（导入时选择「更新同名记录」的情况）。
 *
 * 只覆盖表格里**实际填了值**的列：表格中留空的列保持库里原值，
 * 避免"只想补一个字段，结果把其它资料清空"。
 * 注意 name 是匹配键，不参与覆盖。
 */
function updateExisting(db, entity, id, d, ts) {
  const schema = SCHEMAS[entity];
  const table = entity === 'customer' ? 'customers' : (entity === 'contact' ? 'contacts' : 'projects');
  const sets = [];
  const params = [];
  for (const f of schema.fields) {
    if (f.key === schema.matchKey) continue;        // 匹配键不覆盖
    const v = d[f.key];
    if (v === '' || v === null || v === undefined) continue;   // 留空则保持原值
    sets.push(`${f.key} = ?`);
    params.push(v);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  params.push(ts, id);
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return true;
}

function insertCustomer(db, d, ts) {
  const COLS = [
    'name', 'short_name', 'customer_no', 'industry', 'source', 'email',
    'contact_name', 'contact_position', 'contact_phone', 'contact_birthday',
    'follow_cycle_days', 'province', 'city', 'district', 'address',
    'next_follow_at', 'remark', 'created_at', 'updated_at'
  ];

  const customerNo = String(d.customer_no || '').trim() || nextCustomerNo(db);

  const VALUES = [
    d.name, d.short_name || '', customerNo, d.industry || '', d.source || '', d.email || '',
    d.contact_name || '', d.contact_position || '', d.contact_phone || '',
    d.contact_birthday || '', Number(d.follow_cycle_days) || 0,
    d.province || '', d.city || '', d.district || '', d.address || '',
    d.next_follow_at || null, d.remark || '', ts, ts
  ];

  if (COLS.length !== VALUES.length) {
    throw new Error(`客户导入列数与值数不一致（列 ${COLS.length} / 值 ${VALUES.length}），请反馈此问题`);
  }

  const info = db.prepare(
    `INSERT INTO customers (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`
  ).run(...VALUES);

  const id = Number(info.lastInsertRowid);

  /* 主联系人：导入也同步到 contacts（is_primary=1） */
  if (String(d.contact_name || '').trim()) {
    db.prepare(
      `INSERT INTO contacts (customer_id, name, position, mobile, birthday, is_primary, is_decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
    ).run(id, d.contact_name, d.contact_position || '', d.contact_phone || '',
      d.contact_birthday || null, ts, ts);
  }

  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES ('customer', ?, 'create', ?, '', ?)`
  ).run(id, `Excel 导入新建客户：${d.name}（${customerNo}）`, ts);
  return id;
}

function insertContact(db, d, ts) {
  const cust = db.prepare('SELECT id FROM customers WHERE name = ? AND deleted_at IS NULL').get(d.customer_name);
  if (!cust) throw new Error(`找不到客户「${d.customer_name}」`);
  const info = db.prepare(`
    INSERT INTO contacts (customer_id, name, position, department, mobile, phone, wechat, email,
      is_decision, is_primary, influence, birthday, remark, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cust.id, d.name, d.position || '', d.department || '', d.mobile || '', d.phone || '',
    d.wechat || '', d.email || '', Number(d.is_decision) || 0, Number(d.is_primary) || 0,
    d.influence || '', d.birthday || null, d.remark || '', ts, ts
  );
  if (Number(d.is_primary) === 1) {
    db.prepare('UPDATE contacts SET is_primary = 0 WHERE customer_id = ? AND id <> ?')
      .run(cust.id, Number(info.lastInsertRowid));
    /* 主联系人反向同步到客户表内嵌字段（列表里的「联系人（职务）」要能看到） */
    db.prepare(
      `UPDATE customers SET contact_name = ?, contact_position = ?, contact_phone = ?,
              contact_birthday = ?, updated_at = ? WHERE id = ?`
    ).run(d.name || '', d.position || '', d.mobile || '', d.birthday || '', ts, cust.id);
  }
  return Number(info.lastInsertRowid);
}

/**
 * 导入项目：1.23 起一客户一项目。
 * 已有当前项目时，导入的这条直接落成「历史项目」（archived=1），不阻断导入。
 */
function insertProject(db, d, ts) {
  const cust = db.prepare('SELECT id FROM customers WHERE name = ? AND deleted_at IS NULL').get(d.customer_name);
  if (!cust) throw new Error(`找不到客户「${d.customer_name}」`);
  const current = db.prepare(
    'SELECT id FROM projects WHERE customer_id = ? AND deleted_at IS NULL AND archived = 0'
  ).get(cust.id);
  const info = db.prepare(`
    INSERT INTO projects (name, customer_id, stage, progress, end_user, design_institute,
      valve_needs, quantity, contract_amount, signed_at, bid_date, bid_result, win_rate_note,
      start_date, end_date, delivery_date, owner, remark, archived, data_origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Excel 导入', ?, ?)
  `).run(
    d.name, cust.id, d.stage || '信息收集', Number(d.progress) || 0,
    d.end_user || '', d.design_institute || '', d.valve_needs || '', Number(d.quantity) || 0,
    Number(d.contract_amount) || 0, d.signed_at || null, d.bid_date || null,
    d.bid_result || '', d.win_rate_note || '', d.start_date || null, d.end_date || null,
    d.delivery_date || null, d.owner || '', d.remark || '', current ? 1 : 0, ts, ts
  );
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES ('project', ?, 'create', ?, '', ?)`
  ).run(id, `Excel 导入新建项目：${d.name}${current ? '（该客户已有当前项目，本条转为历史）' : ''}`, ts);
  return id;
}

module.exports = {
  SCHEMAS,
  getTemplate,
  exportData,
  validateRows,
  runImport
};
