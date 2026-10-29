/**
 * API 客户端 + 字典缓存
 * 约定：服务端统一返回 { ok:true, data } 或 { ok:false, code, message }
 *       本模块把成功响应解包为 data，失败抛出带 code 的 Error。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { reactive } = Vue;

  /** 当前是否在登录页（登录页自身不再跳转，避免重定向循环） */
  function onLoginPage() {
    return /\/login\.html$/i.test(String(window.location.pathname || ''));
  }

  let redirecting = false;
  /** 会话失效时统一跳登录页；只跳一次 */
  function redirectToLogin() {
    if (redirecting || onLoginPage()) return;
    redirecting = true;
    window.location.replace('/login.html');
  }

  function toQuery(params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      sp.append(k, v);
    }
    return sp.toString();
  }

  async function request(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (netErr) {
      const e = new Error('无法连接本地服务，请确认服务窗口仍在运行');
      e.code = 'NETWORK';
      throw e;
    }

    let payload = null;
    const text = await res.text();
    if (text) { try { payload = JSON.parse(text); } catch (_) { /* 非 JSON */ } }

    if (!res.ok || !payload || payload.ok !== true) {
      const message = (payload && payload.message) || `请求失败（HTTP ${res.status}）`;
      const e = new Error(message);
      e.code = (payload && payload.code) || `HTTP_${res.status}`;
      e.status = res.status;
      /* 登录已启用但会话失效：统一回登录页。
         登录 / 改密 / 退出这三个接口的 401 属于表单校验，不跳转，交给调用方提示。 */
      if (res.status === 401 && !/^\/api\/auth\//.test(String(url))) redirectToLogin();
      throw e;
    }
    return payload.data;
  }

  /* ------------------------------------------------------------------ */
  /* 字典与标签缓存：多页面共用，避免重复请求                              */
  /* ------------------------------------------------------------------ */

  const cache = reactive({
    dict: { options: {}, items: {}, categories: [] },
    tags: [],
    customers: [],
    loaded: false,
    tagsLoaded: false,
    customersLoaded: false
  });

  async function loadDict(force) {
    if (cache.loaded && !force) return cache.dict;
    const d = await request('GET', '/api/dict');
    cache.dict = d;
    cache.loaded = true;
    return d;
  }

  async function loadTags(force) {
    if (cache.tagsLoaded && !force) return cache.tags;
    cache.tags = await request('GET', '/api/tags');
    cache.tagsLoaded = true;
    return cache.tags;
  }

  function options(category) {
    return (cache.dict.options && cache.dict.options[category]) || [];
  }

  function items(category) {
    return (cache.dict.items && cache.dict.items[category]) || [];
  }

  /** 客户选项：形如 [{id, name, short_name, label}] */
  function customerOptions() {
    return cache.customers || [];
  }

  /** 新增字典选项后就地同步缓存，使所有表单下拉立刻可见（无需刷新页面） */
  function applyDictAdded(result, category) {
    if (!result || !cache.dict || !cache.dict.items) return loadDict(true);
    if (!cache.dict.items[category]) cache.dict.items[category] = [];
    const list = cache.dict.items[category];
    if (!list.some((x) => x.id === result.id)) {
      list.push({ id: result.id, category, value: result.value, color: '', sort: 99999, is_system: 0 });
      cache.dict.options[category] = list.map((x) => x.value);
    }
    return Promise.resolve(cache.dict);
  }

  /** 客户下拉选项（项目表单选客户用） */
  async function loadCustomerOptions(force) {
    if (cache.customersLoaded && !force) return cache.customers;
    const d = await request('GET', '/api/customers?pageSize=500&sort=name&order=asc');
    cache.customers = (d.list || []).map((c) => ({
      id: c.id,
      name: c.name,
      short_name: c.short_name,
      label: c.short_name ? `${c.short_name}（${c.name}）` : c.name
    }));
    cache.customersLoaded = true;
    return cache.customers;
  }

  /* ------------------------------------------------------------------ */
  /* 登录与异地访问（1.25）                                               */
  /* ------------------------------------------------------------------ */

  const authState = reactive({
    enabled: false,
    loggedIn: false,
    username: '',
    hasPassword: false,
    listenMode: 'local',
    bindAddress: '127.0.0.1',
    canRemote: false,
    restartRequired: false,
    lastLogin: null,
    lock: null,
    ip: '',
    loaded: false
  });

  /** 把 /api/auth/status 的结果写进全局状态（顶栏、设置页共用） */
  function applyAuthStatus(st) {
    if (!st) return authState;
    authState.enabled = !!st.auth_enabled;
    authState.loggedIn = !!st.logged_in;
    authState.username = st.username || '';
    authState.hasPassword = !!st.has_password;
    authState.listenMode = st.listen_mode || 'local';
    authState.bindAddress = st.bind_address || '127.0.0.1';
    authState.canRemote = !!st.can_remote;
    authState.restartRequired = !!st.restart_required;
    authState.lastLogin = st.last_login || null;
    authState.lock = st.lock || null;
    authState.ip = st.ip || '';
    authState.loaded = true;
    return authState;
  }

  async function fetchAuthStatus() {
    const d = await request('GET', '/api/auth/status');
    applyAuthStatus(d);
    return d;
  }

  async function login(username, password) {
    const d = await request('POST', '/api/auth/login', { username, password });
    authState.enabled = true;
    authState.loggedIn = true;
    authState.username = d.username || username;
    return d;
  }

  async function logout() {
    try {
      await request('POST', '/api/auth/logout');
    } finally {
      authState.loggedIn = false;
      authState.username = '';
    }
  }

  const changePassword = (payload) => request('POST', '/api/auth/password', payload);

  CRM.api = {
    get:   (url) => request('GET', url),
    post:  (url, body) => request('POST', url, body),
    put:   (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    del:   (url, body) => request('DELETE', url, body),

    health: () => request('GET', '/api/health'),
    status: () => request('GET', '/api/status'),
    openDataDir: () => request('POST', '/api/open-data-dir'),
    /* 停止服务（仅本机有效；用于"隐藏命令行"后的退出方式） */
    shutdown: () => request('POST', '/api/shutdown'),

    /* 提醒 */
    remindersDue: () => request('GET', '/api/reminders/due'),
    remindSettings: () => request('GET', '/api/reminders/settings'),
    saveRemindSettings: (data) => request('PUT', '/api/reminders/settings', data),
    emailStatus: () => request('GET', '/api/reminders/email-status'),
    testEmail: () => request('POST', '/api/reminders/test-email'),
    sendReminderNow: () => request('POST', '/api/reminders/send-now'),

    /* 行政区划（地州下拉用；地图模块已移除，数据来自本地种子） */
    regions: () => request('GET', '/api/regions'),

    /* 统计 / 报表 / 成本台账（1.22 新增） */
    dashboardV2: (params) => request('GET', '/api/dashboard/v2?' + toQuery(params || {})),
    distribution: (params) => request('GET', '/api/stats/distribution?' + toQuery(params || {})),
    incomeReport: (params) => request('GET', '/api/stats/income?' + toQuery(params || {})),
    incomeDetail: (params) => request('GET', '/api/stats/income/detail?' + toQuery(params || {})),
    listCosts: (params) => request('GET', '/api/costs?' + toQuery(params || {})),
    saveCost: (data) => data.id
      ? request('PUT', `/api/costs/${data.id}`, data)
      : request('POST', '/api/costs', data),
    deleteCost: (id) => request('DELETE', `/api/costs/${id}`),

    /* 客户 */
    listCustomers: (params) => request('GET', '/api/customers?' + toQuery(params)),
    getCustomer: (id) => request('GET', `/api/customers/${id}`),
    saveCustomer: (data) => data.id
      ? request('PUT', `/api/customers/${data.id}`, data)
      : request('POST', '/api/customers', data),
    deleteCustomers: (ids) => request('POST', '/api/customers/batch-delete', { ids }),
    bulk: (payload) => request('POST', '/api/customers/bulk', payload),
    checkDuplicate: (name, phone, excludeId) =>
      request('GET', '/api/customers/check-duplicate?' + toQuery({ name, phone, excludeId })),

    /* 客户的项目档案（1:1，1.23）与财务汇总 */
    customerProject: (id) => request('GET', `/api/customers/${id}/project`),
    saveCustomerProject: (id, data) => request('PUT', `/api/customers/${id}/project`, data),
    archiveCustomerProject: (id) => request('POST', `/api/customers/${id}/project/archive`),
    customerHistoryProjects: (id) => request('GET', `/api/customers/${id}/history-projects`),
    customerFinance: (id) => request('GET', `/api/customers/${id}/finance`),

    /* 联系人 */
    saveContact: (data) => request('POST', '/api/contacts', data),
    deleteContact: (id) => request('DELETE', `/api/contacts/${id}`),

    /* 跟进 */
    saveFollowup: (data) => request('POST', '/api/followups', data),
    deleteFollowup: (id) => request('DELETE', `/api/followups/${id}`),

    /* 标签 */
    listTags: () => request('GET', '/api/tags'),
    saveTag: (data) => request('POST', '/api/tags', data),
    deleteTag: (id) => request('DELETE', `/api/tags/${id}`),

    /* 字典 */
    listDict: () => request('GET', '/api/dict'),
    addDict: (category, value) => request('POST', '/api/dict', { category, value }),
    quickAddDict: (category, value) => request('POST', '/api/dict/quick-add', { category, value }),
    updateDict: (id, data) => request('PUT', `/api/dict/${id}`, data),
    deleteDict: (id) => request('DELETE', `/api/dict/${id}`),
    dictUsage: (category, value) => request('GET', '/api/dict/usage?' + toQuery({ category, value })),

    /* 回收站 */
    listTrash: (type) => request('GET', '/api/trash?' + toQuery({ type })),
    restore: (ids, type) => request('POST', '/api/trash/restore', { ids, type }),

    /* 项目 */
    listProjects: (params) => request('GET', '/api/projects?' + toQuery(params)),
    boardProjects: (params) => request('GET', '/api/projects/board?' + toQuery(params)),
    projectStages: () => request('GET', '/api/projects/stages'),
    getProject: (id) => request('GET', `/api/projects/${id}`),
    saveProject: (data) => data.id
      ? request('PUT', `/api/projects/${data.id}`, data)
      : request('POST', '/api/projects', data),
    deleteProjects: (ids) => request('POST', '/api/projects/batch-delete', { ids }),
    moveStage: (id, stage) => request('POST', `/api/projects/${id}/move-stage`, { stage }),

    /* 回款 */
    savePayment: (data) => request('POST', '/api/payments', data),
    deletePayment: (id) => request('DELETE', `/api/payments/${id}`),
    paymentOverview: (days) => request('GET', '/api/payment-overview?' + toQuery({ days })),

    /* 待办 */
    listTasks: (params) => request('GET', '/api/tasks?' + toQuery(params)),
    saveTask: (data) => data.id
      ? request('PUT', `/api/tasks/${data.id}`, data)
      : request('POST', '/api/tasks', data),
    toggleTask: (id, done) => request('POST', `/api/tasks/${id}/toggle`, { done }),
    deleteTasks: (ids) => request('POST', '/api/tasks/batch-delete', { ids }),
    purgeDoneTasks: (keepDays) => request('POST', '/api/tasks/purge-done', { keepDays }),

    /* 阶段四：首页总览 / 设置 / 备份 / 导入导出 / 日志 */
    dashboard: () => request('GET', '/api/dashboard'),

    getSettings: () => request('GET', '/api/settings'),
    saveSettings: (patch) => request('PUT', '/api/settings', patch),

    listBackups: () => request('GET', '/api/backup/list'),
    createBackup: (reason) => request('POST', '/api/backup/create', { reason }),
    verifyBackup: (name) => request('POST', '/api/backup/verify', { name }),
    restoreBackup: (name, confirm) => request('POST', '/api/backup/restore', { name, confirm }),
    deleteBackup: (name) => request('POST', '/api/backup/delete', { name }),

    getTemplate: (entity) => request('GET', '/api/data/template?' + toQuery({ entity })),
    exportData: (entity, filters) => request('POST', '/api/data/export', Object.assign({ entity }, filters || {})),
    previewImport: (entity, rows) => request('POST', '/api/data/preview', { entity, rows }),
    runImport: (entity, rows, opts) =>
      request('POST', '/api/data/import', Object.assign({ entity, rows }, opts || {})),

    listLogs: (params) => request('GET', '/api/logs?' + toQuery(params)),
    clearLogs: (keepDays) => request('POST', '/api/logs/clear', { keepDays }),

    /* 阶段五：附件 */
    listAttachments: (ownerType, ownerId) =>
      request('GET', '/api/attachments?' + toQuery({ owner_type: ownerType, owner_id: ownerId })),
    uploadAttachment: (payload) => request('POST', '/api/attachments', payload),
    updateAttachment: (id, data) => request('PUT', `/api/attachments/${id}/meta`, data),
    deleteAttachment: (id) => request('DELETE', `/api/attachments/${id}`),
    attachmentUsage: () => request('GET', '/api/attachments/usage'),
    cleanOrphanAttachments: () => request('POST', '/api/attachments/clean-orphans'),

    /* 产品价目表（1.24 新增） */
    productCategories: (params) => request('GET', '/api/product-categories?' + toQuery(params || {})),
    saveProductCategory: (data) => data.id
      ? request('PUT', `/api/product-categories/${data.id}`, data)
      : request('POST', '/api/product-categories', data),
    moveProductCategory: (id, dir) => request('POST', `/api/product-categories/${id}/move`, { dir }),
    deleteProductCategory: (id) => request('DELETE', `/api/product-categories/${id}`),

    listProducts: (params) => request('GET', '/api/products?' + toQuery(params || {})),
    getProduct: (id) => request('GET', `/api/products/${id}`),
    saveProduct: (data) => data.id
      ? request('PUT', `/api/products/${data.id}`, data)
      : request('POST', '/api/products', data),
    copyProduct: (id) => request('POST', `/api/products/${id}/copy`),
    deleteProduct: (id) => request('DELETE', `/api/products/${id}`),
    productsExport: (params) => request('GET', '/api/products/export-data?' + toQuery(params || {})),

    /* 登录与异地访问（1.25） */
    authStatus: fetchAuthStatus,
    authLogin: login,
    authLogout: logout,
    authChangePassword: changePassword,

    /* 缓存工具 */
    loadDict, loadTags, options, items, applyDictAdded, loadCustomerOptions, customerOptions, cache
  };

  /* 顶栏「退出登录」、启动鉴权、设置页面板共用同一个响应式状态 */
  CRM.auth = {
    state: authState,
    applyStatus: applyAuthStatus,
    status: fetchAuthStatus,
    login,
    logout,
    changePassword,
    onLoginPage
  };

})(window.CRM);
