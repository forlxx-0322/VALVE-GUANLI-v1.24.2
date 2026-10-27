/**
 * 统计 / 报表 / 成本台账路由（1.22 新增，替代地图模块）
 *
 * 路径：
 *   GET    /api/dashboard/v2            首页 v2（指标卡 + 回访提醒 + 待办 + 动态 + 两张分布）
 *   GET    /api/stats/distribution      客户分布（by=region|industry|source|tag）
 *   GET    /api/stats/income            收入报表（by=month&year= | by=year&span=）
 *   GET    /api/stats/income/detail     收入/成本明细（month=YYYY-MM 或 year=YYYY）
 *   GET    /api/costs                   成本台账列表（customer_id / project_id / category / from / to / page）
 *   POST   /api/costs                   登记成本
 *   PUT    /api/costs/:id               修改成本
 *   DELETE /api/costs/:id               删除成本（软删除）
 *
 * 口径统一写在 services/stats.js 顶部；前端界面上也会显示同样的说明。
 */
'use strict';

const stats = require('../services/stats');
const costs = require('../services/costs');

module.exports = async function statsRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });

  /* ---------------- 行政区划（地州下拉用；地图模块已移除） ---------------- */
  if (segments[1] === 'regions' && method === 'GET') {
    const cities = db.prepare(`SELECT code, name, longitude, latitude FROM region
      WHERE level = 'city' ORDER BY sort, code`).all();
    const districts = db.prepare(`SELECT code, name, parent_code FROM region
      WHERE level = 'district' ORDER BY sort, code`).all();
    return ok({ cities, districts });
  }

  /* ---------------- 首页 v2 ---------------- */
  if (segments[1] === 'dashboard' && segments[2] === 'v2' && method === 'GET') {
    try {
      return ok(stats.dashboardV2(db, { month: query.month }));
    } catch (e) {
      return fail(500, 'DASHBOARD_FAILED', '生成首页数据失败：' + e.message);
    }
  }

  /* ---------------- 统计 ---------------- */
  if (segments[1] === 'stats') {
    const sub = segments[2] || '';
    if (sub === 'distribution' && method === 'GET') {
      try {
        return ok(stats.distribution(db, { by: query.by, top: query.top }));
      } catch (e) {
        return fail(500, 'DIST_FAILED', '生成分布数据失败：' + e.message);
      }
    }
    if (sub === 'income' && segments[3] === 'detail' && method === 'GET') {
      try {
        return ok(stats.incomeDetail(db, { month: query.month, year: query.year }));
      } catch (e) {
        return fail(500, 'INCOME_DETAIL_FAILED', '生成明细失败：' + e.message);
      }
    }
    if (sub === 'income' && method === 'GET') {
      try {
        return ok(stats.income(db, { by: query.by, year: query.year, span: query.span }));
      } catch (e) {
        return fail(500, 'INCOME_FAILED', '生成收入报表失败：' + e.message);
      }
    }
    return null;
  }

  /* ---------------- 成本台账 ---------------- */
  if (segments[1] === 'costs') {
    const id = segments[2] ? Number(segments[2]) : null;
    if (id !== null && !Number.isFinite(id)) return fail(400, 'BAD_ID', '成本记录 ID 无效');

    if (method === 'GET' && id === null) {
      try {
        return ok(costs.list(db, query));
      } catch (e) {
        return fail(500, 'COST_LIST_FAILED', '读取成本台账失败：' + e.message);
      }
    }
    if (method === 'GET' && id !== null) {
      const row = costs.getOne(db, id);
      return row ? ok(row) : fail(404, 'NOT_FOUND', '成本记录不存在或已删除');
    }
    if (method === 'POST' && id === null) {
      try {
        return ok(costs.create(db, body || {}));
      } catch (e) {
        return fail(e.status || 400, e.code || 'COST_CREATE_FAILED', e.message);
      }
    }
    if (method === 'PUT' && id !== null) {
      try {
        return ok(costs.update(db, id, body || {}));
      } catch (e) {
        return fail(e.status || 400, e.code || 'COST_UPDATE_FAILED', e.message);
      }
    }
    if (method === 'DELETE' && id !== null) {
      try {
        return ok(costs.remove(db, id));
      } catch (e) {
        return fail(e.status || 400, e.code || 'COST_DELETE_FAILED', e.message);
      }
    }
    return null;
  }

  return null;
};
