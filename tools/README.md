# tools · 开发与测试脚本（不参与日常运行）

> 日常使用只需要根目录的 `启动.bat` / `停止.bat`；这里的脚本是开发和验收用的。

## 全量回归（最常用）

```bat
node tools\run-all-tests.js
```

- 默认**沙箱模式**：把 `server/` `web/` `tools/` 复制到 `.fixtures/sandbox/`，
  用空库 + 8955 端口跑，**不碰真实 `data/`**
- `--in-place`：就地跑（会清空本目录业务数据，仅限空库/测试库）
- `--no-clean`：跳过开头的清库
- 结果写入 `.fixtures/all-suites-summary.json`，每个套件的日志在 `.fixtures/suite-*.log`

## 测试套件（按阶段）

| 文件 | 覆盖 |
|---|---|
| `test-phase1.js` | 环境、目录结构、数据库结构、静态资源、零外链（会停服务，放最后） |
| `test-phase2-api.js` / `-ui-contract.js` / `-ui-interaction.js` | 客户 CRUD、字段契约、界面交互 |
| `test-phase3-api.js` / `-ui-interaction.js` | 项目档案、回款、待办 |
| `test-phase4-api.js` / `-ui-interaction.js` | 统计、看板、导入导出 |
| `test-phase5-api.js` / `-ui-interaction.js` | 附件、备份、恢复 |
| `test-phase*.js`（阶段六已随地图模块删除） | — |
| `test-migration.js` / `test-migration-full.js` | 结构迁移（v1 → 最新，含数据不丢/幂等） |
| `test-customer-123.js` | 客户精简、一客户一项目、回款周期、财务口径 |
| `test-products-124.js` | 产品三级分类、产品 CRUD、折后价、导出 |
| `test-stats-122.js` | 客户分布、收入报表、成本台账 |
| `test-auth-125.js` | 登录/会话/锁定/白名单/监听范围（自带隔离实例） |
| `test-region-*.js` | 行政区划归属与历史纠正 |
| `test-import-*.js` | 批量导入模板、接口、界面 |
| `test-remind-ui.js` / `test-notify-email.js` / `test-prefs-ui.js` | 提醒、邮件（本地模拟 SMTP）、偏好 |
| `test-acceptance-core.js` / `test-acceptance-browser.js` | 最终验收（接口/性能/浏览器） |
| `test-launcher-e2e.js` | 启动器端到端 |

## 辅助脚本

| 文件 | 用途 |
|---|---|
| `make-fixtures.js` | 生成测试用的导入表格 / 图片等夹具 |
| `screenshot.js` | 全站截图（`--tag xxx` → `.shots/xxx/`） |
| `cleanup-test-data.js` | 清理测试数据（`--all` 连客户/产品一起清，保留分类/标签/字典） |
| `reset-password.js` | 本机重置登录密码（清空密码并关闭登录） |
| `legacy-schema.js` | 构造 v1 老库，用于迁移测试 |
| `.fixtures/mock-smtp.js` | 本地模拟 SMTP（TLS + AUTH），邮件测试用 |

## 约定

- 每个套件**自己造数据、自己清理**，不依赖其它套件
- 断言失败返回非 0；`run-all-tests.js` 汇总后决定总退出码
- 禁止在测试里连外网；邮件测试只连本地模拟 SMTP
