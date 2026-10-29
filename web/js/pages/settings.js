/**
 * 功能设置页（外壳）
 * 标签页：字典管理 / 标签管理 / 提醒与偏好 / 备份与恢复 / 导入导出 / 回收站 / 操作日志 / 关于
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const SettingsPage = {
    name: 'SettingsPage',
    data() {
      return {
        tab: 'dict',
        tabs: [
          { key: 'dict', label: '字典管理' },
          { key: 'tags', label: '标签管理' },
          { key: 'prefs', label: '提醒与偏好' },
          { key: 'auth', label: '登录与异地访问' },
          { key: 'backup', label: '备份与恢复' },
          { key: 'data', label: '导入导出' },
          { key: 'storage', label: '附件与存储' },
          { key: 'trash', label: '回收站' },
          { key: 'logs', label: '操作日志' },
          { key: 'about', label: '关于' }
        ],
        info: null
      };
    },
    methods: {
      async loadInfo() {
        try { this.info = await CRM.api.status(); } catch (_) { /* 忽略 */ }
      },
      async stopService() {
        const ok = await CRM.confirm({
          title: '停止服务',
          message: '停止后网页将无法访问，需要重新双击「CRM管理系统」才能再用。确定停止吗？',
          okText: '停止', danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.shutdown();
        } catch (_) { /* 服务可能在返回前就关了，属正常 */ }
        document.body.innerHTML = '<div style="min-height:100vh;display:grid;place-items:center;font-family:system-ui;color:#555">'
          + '<div style="text-align:center"><div style="font-size:18px;margin-bottom:8px">服务已停止</div>'
          + '<div style="font-size:13px;color:#888">可以关闭这个窗口了；下次双击桌面「CRM管理系统」即可重新启动。</div></div></div>';
      },
      onImported() {
        CRM.toast('数据已更新，页面将刷新以显示最新内容', 'info');
        setTimeout(() => window.location.reload(), 900);
      }
    },
    async created() { this.loadInfo(); },
    template: `
      <div>
        <c-page-header title="功能设置"
          desc="字典、标签、备份、导入导出、回收站与操作日志集中管理。" />

        <div class="settings-tabs">
          <button v-for="t in tabs" :key="t.key" class="tab"
                  :class="{ active: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
        </div>

        <c-dict-manager v-if="tab === 'dict'" />
        <c-tag-panel v-else-if="tab === 'tags'" />
        <c-prefs-panel v-else-if="tab === 'prefs'" />
        <c-auth-panel v-else-if="tab === 'auth'" />
        <c-backup-panel v-else-if="tab === 'backup'" />
        <c-data-panel v-else-if="tab === 'data'" @imported="onImported" />
        <c-attachment-store v-else-if="tab === 'storage'" />
        <c-trash-panel v-else-if="tab === 'trash'" />
        <c-log-panel v-else-if="tab === 'logs'" />

        <div v-else-if="tab === 'about'">
          <c-card title="关于本软件" sub="一客户一项目 · 客户 / 回访 / 项目档案 / 财务台账 · 单机版" icon="settings">
            <div class="kv">
              <div class="k">软件版本</div>
              <div class="v">{{ info ? info.version : '—' }}</div>
              <div class="k">数据库结构版本</div>
              <div class="v">v{{ info ? info.schemaVersion : '—' }}</div>
              <div class="k">运行环境</div>
              <div class="v mono">{{ info ? (info.node + ' · ' + info.platform) : '—' }}</div>
              <div class="k">数据库文件</div>
              <div class="v mono">{{ info ? info.dbPath : '—' }}</div>
              <div class="k">数据目录</div>
              <div class="v mono">{{ info ? info.dataDir : '—' }}</div>
              <div class="k">数据表数量</div>
              <div class="v">{{ info ? info.tableCount : '—' }} 张</div>
              <div class="k">字典分类</div>
              <div class="v">{{ info ? info.dictCategories : '—' }} 类 / {{ info ? info.dictItems : '—' }} 项</div>
              <div class="k">本次启动于</div>
              <div class="v">{{ info ? fmtDate(info.startedAt, true) : '—' }}</div>
            </div>

            <div class="note mt-4">
              <c-icon name="database" :size="16" />
              <div style="font-size:var(--fs-sm)">
                <strong>数据都在本地。</strong>整个
                <span class="mono-text">{{ info ? info.dataDir : 'data' }}</span>
                文件夹拷走即为完整迁移；换电脑时复制到同目录即可继续使用。
              </div>
            </div>

            <div class="note mt-4">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                <strong>断网可用。</strong>软件不引用任何在线资源，断网后全部功能正常。
              </div>
            </div>

            <div class="mt-5">
              <button class="btn" @click="loadInfo">
                <c-icon name="refresh" :size="14" /> 刷新信息
              </button>
              <button class="btn ml-2" style="margin-left:10px" @click="stopService">
                <c-icon name="power" :size="14" /> 停止服务
              </button>
              <div class="field-hint" style="margin-top:8px">
                服务现在是后台运行（没有命令行窗口）。需要彻底退出时点这里；数据会先落盘再退出。
              </div>
            </div>
          </c-card>
        </div>
      </div>`,
    setup() { return { fmtDate: CRM.util.fmtDate }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.settings = SettingsPage;

})(window.CRM);
