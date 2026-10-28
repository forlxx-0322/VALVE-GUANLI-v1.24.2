# web · 前端（全部本地静态资源，无构建、无 npm）

```
web/
├─ index.html              主界面（按顺序加载 js/ 下的脚本）
├─ login.html              登录页（独立的极简页面）
├─ manifest.webmanifest    「安装为桌面应用」清单
├─ sw.js                   Service Worker（只做可安装性 + 静态资源缓存）
├─ css/
│  ├─ app.css              全站样式（设计令牌在文件顶部，浅色/深色共用）
│  └─ login.css            登录页样式（含深色）
├─ assets/                 图标（logo.svg / crm-maid.svg / 生成的 PNG / crm.ico）
├─ vendor/                 Vue 3、ECharts、SheetJS（本地文件，断网可用）
└─ js/
   ├─ core/                基础设施
   │  ├─ util.js           日期/金额/字典等工具函数
   │  ├─ theme.js          浅色/深色主题（localStorage 记忆）
   │  ├─ api.js            所有后端接口封装 + 401 跳登录
   │  └─ router.js         前端路由与左侧导航
   ├─ ui/                  通用组件
   │  ├─ components.js     图标、卡片、页头、空状态等基础组件
   │  ├─ components2.js    表格、分页、抽屉、弹窗、表单控件、标签选择
   │  ├─ components-chart.js   ECharts 封装
   │  ├─ components-attachment.js  附件上传/预览
   │  └─ reminders.js      顶栏「跟进提醒」铃铛面板
   ├─ forms/               表单与抽屉（业务录入）
   │  ├─ customer-fields.js   客户字段定义（区块/筛选/排序）
   │  ├─ customer-edit.js     客户新增/编辑抽屉
   │  ├─ followup-drawer.js   跟进记录
   │  ├─ project-edit.js      客户项目档案（1:1 项目）
   │  ├─ payment-drawer.js    回款计划与实收
   │  └─ cost-drawer.js       成本台账
   ├─ settings/            功能设置各面板
   │  ├─ settings-dict.js      字典管理
   │  ├─ settings-backup.js    备份与恢复
   │  ├─ settings-data.js      导入/导出
   │  ├─ settings-attachment.js 附件与存储
   │  ├─ settings-misc.js      提醒与偏好、标签等
   │  └─ settings-auth.js      登录与异地访问
   ├─ pages/               页面（路由目标）
   │  ├─ home.js           首页总览
   │  ├─ customers.js      客户列表
   │  ├─ customer-detail.js 客户详情（资料/回访/项目与财务/附件日志）
   │  ├─ products.js       产品价目表（三级分类）
   │  ├─ tasks.js          待办中心
   │  └─ settings.js       功能设置外壳
   ├─ app.js               Vue 应用启动、全局组件注册、Service Worker 注册
   └─ login.js             登录页脚本
```

## 加载顺序有要求

`index.html` 里的 `<script>` 顺序不能随便调：
`core → ui → forms → settings → pages → app.js`。
后面的脚本会往 `window.CRM` 上挂东西，`app.js` 最后启动 Vue。

## 改样式的入口

- 颜色、圆角、阴影、字号：`css/app.css` 顶部 `:root` 与 `:root[data-theme="dark"]`
- 组件样式：同文件下半部分，按段落注释分区
- 不要在模板里写死颜色（深色模式会不生效）；用 `var(--c-*)` 令牌

## 本地验证

```bat
启动.bat
:: 然后浏览器打开 http://127.0.0.1:8899
:: 全量回归：node tools\run-all-tests.js
```
