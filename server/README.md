# server · 后端（零依赖，只用 Node 内置模块）

```
server/
├─ server.js        入口：静态文件、路由分发、登录中间件、监听范围、启动日志
├─ db.js           建表 + 结构版本 + 逐级迁移 + 设置/字典/行政区划/产品分类种子
├─ data/           region.json（新疆行政区划，客户分布与地址归属用）
├─ services/       业务逻辑（无 HTTP 概念，纯函数 + db）
│  ├─ crm.js          客户 / 联系人 / 标签 / 跟进 / 查重 / 客户编号 / 财务汇总
│  ├─ pm.js           客户 1:1 项目档案、回款、待办、看板
│  ├─ costs.js        成本台账（采购 / 维护 / 差旅 / 其他）
│  ├─ products.js     产品分类树与产品、折后价、货期（周精确存储 + 天兼容）、导出
│  ├─ stats.js        客户分布、收入报表（月/年）、明细下钻、首页 v2
│  ├─ dashboard.js    旧版首页数据（兼容保留）
│  ├─ reminders.js    跟进提醒的只读查询（逾期/今天/临近）
│  ├─ backup.js       备份、校验、恢复、镜像
│  ├─ excel.js        导入导出（客户 / 联系人 / 项目 / 产品；SheetJS 的表格结构在此定义）
│  ├─ attachments.js  附件存储与清理
│  ├─ auth.js         登录：scrypt 密码、签名会话、防爆破、白名单、审计
│  └─ logs.js         操作日志
├─ routes/         路由（只做参数解析与调用 service）
│  ├─ crm.js          /api/customers、/api/contacts、/api/followups、/api/tags…
│  ├─ pm.js           /api/projects、/api/payments、/api/tasks…
│  ├─ products.js     /api/product-categories、/api/products
│  ├─ stats.js        /api/dashboard/v2、/api/stats、/api/costs、/api/regions
│  ├─ system.js       /api/settings、/api/dict、/api/status、/api/export…
│  ├─ reminders.js    /api/reminders
│  ├─ attachments.js  /api/attachments
│  └─ auth.js         /api/auth/*
└─ notify/         邮件提醒（唯一会联网的功能）
   ├─ index.js        调度与设置（进程内定时器，不经过 HTTP）
   ├─ smtp.js         手写 SMTP 客户端（TLS/AUTH/编码）
   └─ index.js        sendDailyReminder / tick
```

## 约定

- **零依赖**：只用 `node:http` / `node:sqlite` / `node:crypto` / `node:net` / `node:tls` 等内置模块
- SQL 一律参数化；写库前过白名单；删除统一软删除（`deleted_at`）
- 业务错误统一 `fail(res, status, code, message)`；成功 `ok(res, data)`
- 会改数据的地方都写 `activity_logs`（`entity_type` / `action` / `summary`）

## 数据库结构（当前 v15）

表：`customers / contacts / tags / customer_tags / followups / projects / payments /
costs / tasks / attachments / activity_logs / dict / settings / region /
product_categories / products`（17 张）

> `products` 自 v15 起同时存 `lead_time_weeks`（周，界面/导入按此精确读写）与
> `lead_time_days`（天，旧字段/导出兼容，`Math.round(周×7)`）。

升级方式：`db.js` 里 `MIGRATIONS` 追加一段（`version` = 目标版本），
启动时自动按版本逐级执行，**执行前自动整库备份**到 `data/backups/before-migrate-v*-*.db`。
