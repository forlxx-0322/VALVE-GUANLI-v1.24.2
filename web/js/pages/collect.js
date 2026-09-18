/**
 * 招标信息采集
 *
 * 模块定位：本软件**唯一会联网**的功能，默认关闭。
 * 走「邮件订阅解析」路线 —— 在各招标平台订阅关键词推送，本地读邮件解析，
 * 不抓取任何网站、不采集任何个人信息（见实施方案附录 A）。
 *
 * 三个标签页：
 *   待审核  采集到的公告暂存区，逐条审核后才写入正式项目库
 *   采集来源 邮箱与订阅配置（含授权码获取指引、测试连接）
 *   采集记录 审计日志（谁在什么时候采了什么、拒绝原因）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /** 授权码获取指引（与后端 PROVIDERS 的 hint 对应，减少用户配错） */
  const PROVIDER_TIP_FALLBACK = '请到邮箱网页版设置中开启 IMAP 服务并生成授权码（不是登录密码）';

  const CollectPage = {
    name: 'CollectPage',
    data() {
      return {
        tab: 'staging',
        summary: null,
        loading: false,

        /* 暂存区 */
        list: [],
        total: 0,
        page: 1,
        pageSize: 20,
        counts: {},
        filter: { status: 'pending', keyword: '', source_id: '', has_personal: '', min_score: '' },

        /* 来源 */
        sources: [],
        providers: [],
        sourceForm: null,
        sourceOpen: false,
        savingSource: false,

        /* 粘贴链接采集（公众号） */
        pasteOpen: false,
        pasteText: '',
        pasting: false,
        pasteResult: null,
        testing: false,

        /* 日志 */
        logs: [],
        logsTotal: 0,
        logPage: 1,

        /* 审核抽屉 */
        review: null,
        reviewForm: { customer_id: '', stage: '信息收集', owner: '', remark: '' },
        reviewSaving: false,

        running: false,
        selected: []
      };
    },
    computed: {
      customers() { return CRM.api.customerOptions(); },
      stages() {
        return CRM.api.options('project_stage').length
          ? CRM.api.options('project_stage')
          : ['信息收集', '初步接洽', '技术交流', '方案选型', '询价报价'];
      },
      personalTip() {
        return '本软件不采集任何个人联系方式；公告里的联系人信息请点「查看原公告」自行获取。';
      },
      sourceHint() {
        if (!this.sourceForm) return PROVIDER_TIP_FALLBACK;
        const p = this.providers.find((x) => x.key === this.sourceForm.provider);
        return p ? p.hint : PROVIDER_TIP_FALLBACK;
      }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fmtMoney: CRM.util.fmtMoney,

      async loadSummary() {
        try { this.summary = await CRM.api.collectSummary(); }
        catch (e) { CRM.toast(e.message || '加载采集总览失败', 'error'); }
      },

      async loadStaging() {
        this.loading = true;
        try {
          const d = await CRM.api.collectStaging({
            status: this.filter.status,
            keyword: this.filter.keyword,
            source_id: this.filter.source_id,
            has_personal: this.filter.has_personal,
            min_score: this.filter.min_score,
            page: this.page,
            pageSize: this.pageSize
          });
          this.list = d.list;
          this.total = d.total;
          this.counts = d.counts || {};
        } catch (e) {
          CRM.toast(e.message || '加载暂存区失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      async loadSources() {
        try {
          const [s, p] = await Promise.all([CRM.api.collectSources(), CRM.api.collectProviders()]);
          this.sources = s;
          this.providers = p;
        } catch (e) {
          CRM.toast(e.message || '加载来源失败', 'error');
        }
      },

      async loadLogs() {
        try {
          const d = await CRM.api.collectLogs({ page: this.logPage, pageSize: 50 });
          this.logs = d.list;
          this.logsTotal = d.total;
        } catch (e) {
          CRM.toast(e.message || '加载日志失败', 'error');
        }
      },

      async loadAll() {
        await this.loadSummary();
        if (this.tab === 'staging') await this.loadStaging();
        if (this.tab === 'source') await this.loadSources();
        if (this.tab === 'logs') await this.loadLogs();
      },

      switchTab(t) {
        this.tab = t;
        this.loadAll();
      },

      /* ---------------- 采集 ---------------- */
      async runNow(ignoreInterval) {
        if (this.running) return;
        if (ignoreInterval) {
          const ok = await CRM.confirm({
            title: '忽略 24 小时间隔',
            message: '正常情况下每 24 小时采集一次。强制采集会再次读取邮箱，'
              + '内容没有变化时不会产生重复记录。<br>确定继续吗？',
            okText: '强制采集'
          });
          if (!ok) return;
        }
        this.running = true;
        try {
          const r = await CRM.api.collectRun({ ignore_interval: !!ignoreInterval });
          const parts = (r.results || []).map((x) => `${x.sourceName}：${x.message}`);
          CRM.toast(parts.length ? parts.join('；') : '没有启用的采集来源', r.failed ? 'warn' : 'success');
          await this.loadAll();
        } catch (e) {
          CRM.toast(e.message || '采集失败', 'error');
        } finally {
          this.running = false;
        }
      },

      /* ---------------- 粘贴链接采集（公众号） ---------------- */
      openPaste() {
        this.pasteText = '';
        this.pasteResult = null;
        this.pasteOpen = true;
      },

      /**
       * 提交粘贴的链接。
       * 服务端会逐条抓取并抽取，命中风控页会立即停下（结果里会说明）。
       * force=true 时口径没命中的也收进暂存区（人工看过、确认要留）。
       */
      async doPaste(force) {
        const lines = String(this.pasteText || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
        if (!lines.length) { CRM.toast('请先粘贴公众号文章链接（一行一条）', 'error'); return; }
        if (force && !this.pasteResult) {
          CRM.toast('请先抓取一次；"仍收下"是把上一次没命中的收进来', 'error', 5000);
          return;
        }
        this.pasting = true;
        const prev = this.pasteResult;
        this.pasteResult = force ? prev : null;
        try {
          const r = await CRM.api.collectWechatPaste({ urls: lines, force: !!force });
          this.pasteResult = r;
          CRM.toast(r.message || '抓取完成', r.blocked ? 'warn' : 'success', 6000);
          await this.loadAll();
        } catch (e) {
          CRM.toast(e.message || '抓取失败', 'error');
        } finally {
          this.pasting = false;
        }
      },

      /** 单条"仍收下"：只重跑这一条 */
      async forceOne(row) {
        if (!row || !row.url) return;
        this.pasting = true;
        try {
          const r = await CRM.api.collectWechatPaste({ urls: [row.url], force: true });
          const one = (r.results || [])[0] || {};
          row.status = one.status || row.status;
          row.forced = !!one.forced;
          row.reason = one.staging_id
            ? `人工收下（原：${one.forced_reason || row.reason || '口径未命中'}）`
            : (one.reason || row.reason);
          CRM.toast(one.staging_id ? '已按人工判断收进待审核' : '仍然没抓到（可能是文章不可访问）',
            one.staging_id ? 'success' : 'error', 5000);
          await this.loadAll();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        } finally {
          this.pasting = false;
        }
      },

      pasteStatusText(st) {
        return {
          new: '已收进暂存区', updated: '已更新', skipped: '已收过（跳过）',
          duplicate: '本批重复', rejected: '不符合条件', gone: '文章不可访问',
          invalid: '链接无效', blocked: '触发风控，已停止'
        }[st] || st;
      },

      pasteStatusClass(st) {
        if (st === 'new') return 'tag success';
        if (st === 'updated') return 'tag';
        if (st === 'blocked') return 'tag danger';
        if (st === 'rejected' || st === 'gone' || st === 'invalid' || st === 'duplicate') return 'tag muted';
        return 'tag';
      },

      /* ---------------- 来源 ---------------- */
      openSource(s) {
        this.sourceForm = s ? Object.assign({ pass: '' }, s) : {
          id: null, name: '', type: 'subscription', provider: 'qq', host: '', port: 993, secure: true,
          user: '', pass: '', mailbox: 'INBOX',
          keywords: '阀门,球阀,闸阀,蝶阀', regionOnly: true, sinceDays: 30, enabled: false,
          /* 公众号 / RSS 用 */
          url: '', filterMode: 'region+project', maxPerRun: 30
        };
        if (!this.sourceForm.type) this.sourceForm.type = 'subscription';
        if (!this.sourceForm.filterMode) this.sourceForm.filterMode = 'region+project';
        this.sourceOpen = true;
      },

      /** 切换采集方式时补齐该方式需要的默认值 */
      onTypeChange() {
        if (this.sourceForm.type === 'rss') {
          this.sourceForm.maxPerRun = this.sourceForm.maxPerRun || 30;
          this.sourceForm.filterMode = this.sourceForm.filterMode || 'region+project';
        } else if (!this.sourceForm.host) {
          this.onProviderChange();
        }
      },

      onProviderChange() {
        const p = this.providers.find((x) => x.key === this.sourceForm.provider);
        if (!p) return;
        this.sourceForm.host = p.host || '';
        this.sourceForm.port = p.port || 993;
        this.sourceForm.secure = (p.port || 993) !== 143;
      },

      async saveSource() {
        if (!this.sourceForm.name.trim()) { CRM.toast('请填写来源名称', 'error'); return; }
        this.savingSource = true;
        try {
          await CRM.api.saveCollectSource(this.sourceForm);
          CRM.toast('已保存采集来源', 'success');
          this.sourceOpen = false;
          await this.loadSources();
          await this.loadSummary();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.savingSource = false;
        }
      },

      async testSource(s) {
        this.testing = true;
        try {
          const r = await CRM.api.testCollectSource(s.id);
          CRM.toast(`连接成功，窗口内可读 ${r.mails} 封邮件（文件夹：${r.mailbox}）`, 'success');
        } catch (e) {
          CRM.toast(e.message || '连接失败', 'error');
        } finally {
          this.testing = false;
        }
      },

      async toggleSource(s) {
        try {
          await CRM.api.saveCollectSource(Object.assign({}, s, { enabled: !s.enabled, pass: '' }));
          await this.loadSources();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      async removeSource(s) {
        const ok = await CRM.confirm({
          title: '删除采集来源',
          message: `确定删除「${s.name}」吗？已有的暂存记录与采集日志会保留。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteCollectSource(s.id);
          CRM.toast('已删除', 'success');
          await this.loadSources();
          await this.loadSummary();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------------- 审核 ---------------- */
      openReview(row) {
        this.review = row;
        this.reviewForm = {
          customer_id: '',
          stage: '信息收集',
          owner: '',
          remark: ''
        };
        /* 若能匹配到客户，默认选中（按简称/全称模糊命中） */
        const name = row.matched_customer || row.tenderee || '';
        const hit = this.customers.find((c) => name && (c.short_name === name || String(c.name).includes(name)));
        if (hit) this.reviewForm.customer_id = hit.id;
      },

      async approve() {
        if (!this.reviewForm.customer_id) { CRM.toast('请选择该项目归属的客户', 'error'); return; }
        this.reviewSaving = true;
        try {
          const r = await CRM.api.reviewStaging(this.review.id, Object.assign({ action: 'approve' }, this.reviewForm));
          CRM.toast(`已转入项目库（项目 id=${r.project_id}）`, 'success');
          this.review = null;
          this.selected = [];
          await this.loadAll();
        } catch (e) {
          CRM.toast(e.message || '入库失败', 'error');
        } finally {
          this.reviewSaving = false;
        }
      },

      async reject(row, reason) {
        const target = row || this.review;
        if (!target) return;
        const ok = await CRM.confirm({
          title: '忽略这条公告',
          message: '忽略后不会写入项目库，仍保留在采集记录中可追溯。',
          okText: '忽略'
        });
        if (!ok) return;
        try {
          await CRM.api.reviewStaging(target.id, { action: 'reject', reject_reason: reason || '人工判定不相关' });
          CRM.toast('已忽略', 'success');
          this.review = null;
          await this.loadAll();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      async rejectSelected() {
        if (!this.selected.length) return;
        const ok = await CRM.confirm({
          title: '批量忽略',
          message: `确定忽略选中的 ${this.selected.length} 条公告吗？`,
          okText: '忽略'
        });
        if (!ok) return;
        try {
          const r = await CRM.api.rejectStagingBatch(this.selected, '批量忽略');
          CRM.toast(`已忽略 ${r.rejected} 条`, 'success');
          this.selected = [];
          await this.loadAll();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      toggleAll(e) {
        this.selected = e.target.checked
          ? this.list.filter((x) => x.status === 'pending').map((x) => x.id)
          : [];
      },

      openSourceUrl(url) {
        /* 用系统默认浏览器打开原公告：本软件不抓取网页，只提供跳转 */
        try { window.open(url, '_blank', 'noopener'); }
        catch (_) { CRM.toast('打开链接失败，请手动复制：' + url, 'warn'); }
      },

      goProject(id) {
        this.review = null;
        CRM.router.navigate('/projects/' + id);
      },

      changePage(delta) {
        const max = Math.max(1, Math.ceil(this.total / this.pageSize));
        const next = this.page + delta;
        if (next < 1 || next > max) return;
        this.page = next;
        this.loadStaging();
      },

      statusText(s) {
        return { pending: '待审核', approved: '已入库', rejected: '已忽略' }[s] || s;
      },
      statusClass(s) {
        return { pending: 'warning', approved: 'success', rejected: 'muted' }[s] || 'muted';
      },
      logClass(level) {
        return { error: 'danger', warn: 'warning' }[level] || 'muted';
      }
    },
    async created() {
      /* 客户下拉与阶段字典由 api 缓存提供 */
      await Promise.all([CRM.api.loadDict(), CRM.api.loadCustomerOptions()]);
      await this.loadAll();
    },
    template: `
      <div>
        <c-page-header title="招标信息采集"
          desc="在招标平台订阅关键词推送，软件本地读邮件解析成项目线索；采集结果需人工审核后才入库。" />

        <!-- 顶部说明与操作 -->
        <div class="note" style="margin-bottom:14px">
          <c-icon name="alert" :size="16" />
          <div style="font-size:var(--fs-sm)">
            <strong>本模块是软件里唯一会联网的功能</strong>，默认关闭；未启用来源时不会有任何外部网络请求。
            采集只读取订阅邮件，<strong>不抓取任何网站</strong>，也<strong>不采集任何个人联系方式</strong>
            （公告里的联系人信息会提示你点原文自行查看）。审核通过的项目会带来源链接，可随时回查。
          </div>
        </div>

        <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
          <div class="stat">
            <div class="n">{{ summary ? summary.enabled : '—' }}<span class="muted" style="font-size:14px">/{{ summary ? summary.sources : '—' }}</span></div>
            <div class="l">已启用来源 / 全部</div>
          </div>
          <div class="stat clickable" @click="filter.status = 'pending'; switchTab('staging')">
            <div class="n" :style="summary && summary.pending ? 'color:var(--c-warning)' : ''">{{ summary ? summary.pending : '—' }}</div>
            <div class="l">待审核公告</div>
          </div>
          <div class="stat">
            <div class="n money" style="color:var(--c-success)">{{ summary ? summary.approved : '—' }}</div>
            <div class="l">已转入项目库</div>
          </div>
          <div class="stat">
            <div class="n">{{ summary ? summary.intervalHours : 24 }}<span class="muted" style="font-size:14px">h</span></div>
            <div class="l">采集间隔</div>
          </div>
          <div class="stat">
            <div class="n" style="font-size:15px;line-height:1.6">{{ summary && summary.nextRunAt ? fmtDate(summary.nextRunAt, true) : '随时可采集' }}</div>
            <div class="l">下次采集时间</div>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px">
          <div class="card-body" style="padding:12px 16px">
            <div class="filter-bar">
              <div class="tabs" style="border:none;margin:0">
                <button class="tab" :class="{ active: tab === 'staging' }" @click="switchTab('staging')">
                  待审核
                  <span v-if="summary && summary.pending" class="badge">{{ summary.pending }}</span>
                </button>
                <button class="tab" :class="{ active: tab === 'source' }" @click="switchTab('source')">采集来源</button>
                <button class="tab" :class="{ active: tab === 'logs' }" @click="switchTab('logs')">采集记录</button>
              </div>
              <div style="flex:1"></div>
              <span v-if="summary && summary.lastRun" class="muted" style="font-size:var(--fs-xs)">
                上次采集：{{ summary.lastRun.source_name }} · {{ fmtDate(summary.lastRun.last_run_at, true) }}
                <span :class="summary.lastRun.last_status === 'ok' ? 'tag success' : 'tag danger'" style="font-size:10px;margin-left:6px">
                  {{ summary.lastRun.last_status === 'ok' ? '成功' : '失败' }}
                </span>
              </span>
              <button class="btn btn-sm" :disabled="running" @click="runNow(false)">
                <c-icon name="refresh" :size="13" /> {{ running ? '采集中…' : '立即采集' }}
              </button>
              <button class="btn btn-sm" :disabled="running || !(summary && summary.enabled)"
                      title="忽略 24 小时间隔，强制再采集一次" @click="runNow(true)">强制采集</button>
              <button class="btn btn-sm btn-primary" title="把公众号文章链接粘进来，直接抓取并抽取"
                      @click="openPaste">粘贴链接采集</button>
            </div>
          </div>
        </div>

        <!-- ============ 待审核 ============ -->
        <div v-show="tab === 'staging'">
          <div class="card" style="margin-bottom:14px">
            <div class="card-body" style="padding:12px 16px">
              <div class="filter-bar">
                <select class="input" v-model="filter.status" @change="page = 1; loadStaging()">
                  <option value="pending">待审核</option>
                  <option value="approved">已入库</option>
                  <option value="rejected">已忽略</option>
                  <option value="">全部</option>
                </select>
                <select class="input" v-model="filter.source_id" @change="page = 1; loadStaging()">
                  <option value="">来源（全部）</option>
                  <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
                <select class="input" v-model="filter.has_personal" @change="page = 1; loadStaging()">
                  <option value="">是否含个人信息（全部）</option>
                  <option value="1">仅看含个人信息的</option>
                </select>
                <select class="input" v-model="filter.min_score" @change="page = 1; loadStaging()">
                  <option value="">匹配度（全部）</option>
                  <option value="70">仅看高匹配（≥70）</option>
                  <option value="100">仅看极高匹配（≥100）</option>
                </select>
                <input class="input" v-model="filter.keyword" placeholder="搜索项目名 / 编号 / 招标人"
                       style="min-width:180px" @keydown.enter="page = 1; loadStaging()" />
                <button class="btn btn-sm" @click="page = 1; loadStaging()">筛选</button>
                <button class="btn btn-sm" v-if="filter.keyword" @click="filter.keyword = ''; page = 1; loadStaging()">清空</button>
                <div style="flex:1"></div>
                <button v-if="selected.length" class="btn btn-sm" @click="rejectSelected">
                  批量忽略（{{ selected.length }}）
                </button>
              </div>
            </div>
          </div>

          <div v-if="loading" class="card"><div class="card-body muted">加载中…</div></div>

          <c-empty v-else-if="!list.length" icon="list" title="没有符合条件的采集公告"
                   desc="先在「采集来源」里配置邮箱并启用，然后点「立即采集」。" />

          <div v-else class="card">
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width:34px">
                      <input type="checkbox" :checked="selected.length > 0 && selected.length === list.filter(x => x.status === 'pending').length"
                             @change="toggleAll" :disabled="filter.status !== 'pending'" />
                    </th>
                    <th>项目名称</th>
                    <th style="width:120px">所属地州</th>
                    <th style="width:110px" class="right">公告金额</th>
                    <th style="width:96px">类型</th>
                    <th style="width:120px">匹配客户</th>
                    <th style="width:86px">状态</th>
                    <th style="width:150px" class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in list" :key="row.id" :class="row.has_personal_info ? 'row-warn' : ''">
                    <td>
                      <input v-if="row.status === 'pending'" type="checkbox" :value="row.id" v-model="selected" />
                    </td>
                    <td>
                      <div class="cell-main">{{ row.project_name || row.title }}</div>
                      <div class="muted" style="font-size:var(--fs-xs)">
                        <span v-if="row.project_code" class="mono-text">{{ row.project_code }}</span>
                        <span v-if="row.tenderee"> · {{ row.tenderee }}</span>
                        <span v-if="row.agency"> · 代理：{{ row.agency }}</span>
                      </div>
                      <div class="muted" style="font-size:var(--fs-xs);margin-top:2px">
                        <span class="tag muted" style="font-size:10px">{{ row.source_platform }}</span>
                        <span v-if="row.keyword_hits" class="tag" style="font-size:10px;margin-left:4px">{{ row.keyword_hits }}</span>
                        <span v-if="row.has_personal_info" class="tag warning" style="font-size:10px;margin-left:4px"
                              :title="'原公告含：' + row.personal_fields">含个人信息</span>
                      </div>
                    </td>
                    <td>
                      <span class="tag" style="font-size:11px">{{ row.region_name || '未识别' }}</span>
                    </td>
                    <td class="right money">{{ row.amount ? fmtMoney(row.amount) : '—' }}</td>
                    <td><span class="tag muted" style="font-size:10px">{{ row.notice_type }}</span></td>
                    <td>
                      <span v-if="row.matched_customer" class="tag success" style="font-size:10px"
                            :title="'匹配得分 ' + row.match_score">{{ row.matched_customer }}</span>
                      <span v-else class="muted">—</span>
                    </td>
                    <td><span class="tag" :class="statusClass(row.status)" style="font-size:10px">{{ statusText(row.status) }}</span></td>
                    <td class="right" style="white-space:nowrap">
                      <button v-if="row.status === 'pending'" class="btn btn-sm btn-primary" @click="openReview(row)">审核</button>
                      <button v-if="row.status === 'pending'" class="btn btn-sm" @click="reject(row)">忽略</button>
                      <button v-if="row.status !== 'pending'" class="btn btn-sm" @click="openReview(row)">查看</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-body" style="padding:10px 16px;display:flex;align-items:center;gap:10px">
              <span class="muted" style="font-size:var(--fs-xs)">共 {{ total }} 条 · 第 {{ page }} 页</span>
              <div style="flex:1"></div>
              <button class="btn btn-sm" :disabled="page <= 1" @click="changePage(-1)">上一页</button>
              <button class="btn btn-sm" :disabled="page >= Math.ceil(total / pageSize)" @click="changePage(1)">下一页</button>
            </div>
          </div>
        </div>

        <!-- ============ 采集来源 ============ -->
        <div v-show="tab === 'source'">
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">采集来源</div>
                <div class="card-sub">在各招标平台订阅关键词推送后，在这里填邮箱信息即可本地解析</div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="openSource(null)">
                <c-icon name="plus" :size="13" /> 新增来源
              </button>
            </div>
            <div class="card-body">
              <c-empty v-if="!sources.length" icon="list" title="还没有采集来源"
                       desc="点右上角「新增来源」，选择邮箱服务商并填入授权码。" />
              <div v-else class="dict-items">
                <div v-for="s in sources" :key="s.id" class="dict-item" :class="{ off: !s.enabled }" style="align-items:flex-start">
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <strong>{{ s.name }}</strong>
                      <span class="tag" :class="s.enabled ? 'success' : 'muted'" style="font-size:10px">
                        {{ s.enabled ? '已启用' : '已停用' }}
                      </span>
                      <span class="tag muted" style="font-size:10px">{{ s.providerLabel }}</span>
                      <span v-if="!s.hasCredential" class="tag danger" style="font-size:10px">未配置授权码</span>
                    </div>
                    <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">
                      {{ s.user || '未填账号' }} @ {{ s.host || '未填服务器' }}:{{ s.port }}
                      · 文件夹「{{ s.mailbox }}」
                      · 关键词「{{ s.keywords || '（默认阀门类）' }}」
                      · {{ s.regionOnly ? '仅新疆项目' : '不限地区' }}
                      · 回看 {{ s.sinceDays }} 天
                    </div>
                    <div v-if="s.last_run_at" class="muted" style="font-size:var(--fs-xs);margin-top:4px">
                      上次采集 {{ fmtDate(s.last_run_at, true) }}：
                      <span :style="s.last_status === 'ok' ? 'color:var(--c-success)' : 'color:var(--c-danger)'">{{ s.last_status === 'ok' ? '成功' : '失败' }}</span>
                      · {{ s.last_message }}
                      <span v-if="s.next_run_at && s.enabled"> · 下次 {{ fmtDate(s.next_run_at, true) }}</span>
                    </div>
                    <div v-if="s.fail_streak" class="muted" style="font-size:var(--fs-xs);color:var(--c-danger);margin-top:2px">
                      连续失败 {{ s.fail_streak }} 次（累计 3 次将自动暂停）
                    </div>
                  </div>
                  <span class="acts" style="flex:0 0 auto">
                    <button :disabled="testing" @click="testSource(s)">测试连接</button>
                    <button @click="toggleSource(s)">{{ s.enabled ? '停用' : '启用' }}</button>
                    <button @click="openSource(s)">编辑</button>
                    <button class="danger" @click="removeSource(s)">删除</button>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ 采集记录 ============ -->
        <div v-show="tab === 'logs'">
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">采集记录</div>
                <div class="card-sub">保留 {{ summary ? summary.logKeepDays : 200 }} 天，可追溯每次采集与每条公告的处置</div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm" @click="loadLogs">刷新</button>
            </div>
            <div class="card-body" style="padding:0">
              <c-empty v-if="!logs.length" title="还没有采集记录" desc="启用来源并采集后会在这里留痕。" />
              <div v-else class="table-wrap" style="border:none">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th style="width:150px">时间</th>
                      <th style="width:70px">级别</th>
                      <th style="width:200px">来源</th>
                      <th>内容</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="l in logs" :key="l.id">
                      <td class="muted">{{ fmtDate(l.created_at, true) }}</td>
                      <td><span class="tag" :class="logClass(l.level)" style="font-size:10px">{{ l.level }}</span></td>
                      <td class="muted">{{ l.source_name || '（系统）' }}</td>
                      <td>
                        {{ l.message }}
                        <div v-if="l.detail" class="muted" style="font-size:var(--fs-xs)">变更/明细：{{ l.detail }}</div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ 审核抽屉 ============ -->
        <div v-if="review" class="drawer-mask" @click.self="review = null">
          <div class="drawer" style="width:720px;max-width:96vw">
            <div class="drawer-head">
              <div>
                <div class="drawer-title">{{ review.status === 'pending' ? '审核招标公告' : '公告详情' }}</div>
                <div class="drawer-sub">
                  {{ review.source_platform }} · 采集于 {{ fmtDate(review.collected_at, true) }}
                  · 匹配度 {{ review.match_score }}
                </div>
              </div>
              <button class="icon-btn" @click="review = null">✕</button>
            </div>

            <div class="drawer-body">
              <div v-if="review.has_personal_info" class="note warn" style="margin-bottom:14px">
                <c-icon name="alert" :size="16" />
                <div>
                  原公告含 <strong>{{ review.personal_fields }}</strong>。
                  按合规要求本软件<strong>不采集个人联系方式</strong>，
                  <a href="javascript:;" @click="openSourceUrl(review.source_url)">点此查看原公告</a>自行获取。
                </div>
              </div>

              <div class="form-block" style="margin-bottom:14px">
                <div class="form-block-head open" style="cursor:default">
                  公告信息
                </div>
                <div class="kv-grid">
                  <div class="kv"><div class="k">项目名称</div><div class="v">{{ review.project_name || '—' }}</div></div>
                  <div class="kv"><div class="k">公告编号</div><div class="v mono-text">{{ review.project_code || '—' }}</div></div>
                  <div class="kv"><div class="k">所属地州</div><div class="v">{{ review.region_name || '未识别' }}</div></div>
                  <div class="kv"><div class="k">建设地点</div><div class="v">{{ review.location || '—' }}</div></div>
                  <div class="kv"><div class="k">公告金额</div><div class="v money">{{ review.amount ? fmtMoney(review.amount) + ' 元' : '—' }}</div></div>
                  <div class="kv"><div class="k">公告类型</div><div class="v">{{ review.notice_type }}</div></div>
                  <div class="kv"><div class="k">招标人</div><div class="v">{{ review.tenderee || '—' }}</div></div>
                  <div class="kv"><div class="k">代理机构</div><div class="v">{{ review.agency || '—' }}</div></div>
                  <div class="kv"><div class="k">设计单位</div><div class="v">{{ review.design_institute || '—' }}</div></div>
                  <div class="kv"><div class="k">开标时间</div><div class="v">{{ review.bid_date || '—' }}</div></div>
                  <div class="kv"><div class="k">涉及行业</div><div class="v">{{ review.industry || '—' }}</div></div>
                  <div class="kv"><div class="k">命中关键词</div><div class="v">{{ review.keyword_hits || '—' }}</div></div>
                </div>
                <div class="mt-3">
                  <button class="btn btn-sm" @click="openSourceUrl(review.source_url)">
                    <c-icon name="search" :size="13" /> 查看原公告
                  </button>
                  <span class="muted mono-text" style="font-size:var(--fs-xs);margin-left:8px">{{ review.source_url }}</span>
                </div>
              </div>

              <div class="form-block" style="margin-bottom:14px">
                <div class="form-block-head open" style="cursor:default">邮件溯源</div>
                <div class="kv-grid">
                  <div class="kv"><div class="k">邮件主题</div><div class="v">{{ review.mail_subject || '—' }}</div></div>
                  <div class="kv"><div class="k">发件人</div><div class="v">{{ review.mail_from || '—' }}</div></div>
                  <div class="kv"><div class="k">邮件时间</div><div class="v">{{ review.mail_date || '—' }}</div></div>
                  <div class="kv"><div class="k">邮件 UID</div><div class="v mono-text">{{ review.mail_uid || '—' }}</div></div>
                </div>
              </div>

              <div class="form-block">
                <div class="form-block-head open" style="cursor:default">正文摘要（已剔除含个人信息的行）</div>
                <pre style="white-space:pre-wrap;font-size:var(--fs-xs);color:var(--c-text-2);margin:0;font-family:inherit">{{ review.raw_excerpt || '（无）' }}</pre>
              </div>

              <div v-if="review.status === 'pending'" class="card mt-4">
                <div class="card-head"><div class="card-title">转为项目</div>
                  <div class="card-sub">确认后写入项目库，并带上来源链接以便回查</div>
                </div>
                <div class="card-body">
                  <div class="form-grid">
                    <c-ref-select v-model="reviewForm.customer_id" label="归属客户" required
                                  :options="customers.map(c => ({ value: c.id, label: c.label }))" />
                    <div class="field">
                      <label class="field-label">项目阶段</label>
                      <select class="input" v-model="reviewForm.stage">
                        <option v-for="s in stages" :key="s" :value="s">{{ s }}</option>
                      </select>
                    </div>
                    <c-field v-model="reviewForm.owner" label="负责人" />
                    <c-field v-model="reviewForm.remark" label="补充备注" />
                  </div>
                </div>
              </div>

              <div v-else-if="review.project_id" class="note" style="margin-top:16px">
                <c-icon name="check" :size="16" />
                <div>已转入项目库（项目 id={{ review.project_id }}）。
                  <a href="javascript:;" @click="goProject(review.project_id)">打开项目</a>
                </div>
              </div>
              <div v-else-if="review.reject_reason" class="note warn" style="margin-top:16px">
                <c-icon name="alert" :size="16" />
                <div>已忽略：{{ review.reject_reason }}</div>
              </div>
            </div>

            <div class="drawer-foot">
              <span class="muted" style="font-size:var(--fs-xs);margin-right:auto">
                {{ personalTip }}
              </span>
              <button class="btn" @click="review = null">关闭</button>
              <template v-if="review.status === 'pending'">
                <button class="btn" @click="reject(review)">忽略</button>
                <button class="btn btn-primary" :disabled="reviewSaving" @click="approve">
                  {{ reviewSaving ? '入库中…' : '确认转入项目库' }}
                </button>
              </template>
            </div>
          </div>
        </div>

        <!-- ============ 来源编辑抽屉 ============ -->
        <div v-if="sourceOpen" class="drawer-mask" @click.self="sourceOpen = false">
          <div class="drawer" style="width:640px;max-width:96vw">
            <div class="drawer-head">
              <div>
                <div class="drawer-title">{{ sourceForm.id ? '编辑采集来源' : '新增采集来源' }}</div>
                <div class="drawer-sub">
                  {{ sourceForm.type === 'rss'
                    ? '订阅一个 RSS/Atom 地址（可放公众号转 RSS 的地址）；默认停用，确认无误后再启用'
                    : '填邮箱与授权码即可；来源默认停用，确认无误后再启用' }}
                </div>
              </div>
              <button class="icon-btn" @click="sourceOpen = false">✕</button>
            </div>
            <div class="drawer-body">
              <div v-if="sourceForm.type !== 'rss'" class="note" style="margin-bottom:14px">
                <c-icon name="alert" :size="16" />
                <div style="font-size:var(--fs-sm)">
                  <strong>授权码不是邮箱登录密码。</strong>{{ sourceHint }}
                </div>
              </div>
              <div v-else class="note" style="margin-bottom:14px">
                <c-icon name="alert" :size="16" />
                <div style="font-size:var(--fs-sm)">
                  本软件<strong>只读你填的这个订阅地址</strong>：订阅源里若是公众号文章链接，
                  会按链接再抓一次正文（每篇间隔 3 秒）。<br>
                  公众号本身没有面向个人的列表接口，所以"公众号 → RSS"这一步需要你自己解决
                  （例如另跑一个 wewe-rss 之类的工具），本软件不代管你的账号。
                </div>
              </div>

              <div class="form-grid">
                <c-field v-model="sourceForm.name" label="来源名称" required
                         :placeholder="sourceForm.type === 'rss' ? '例如：某公众号 · RSS 订阅' : '例如：新疆公共资源交易网 · 邮件订阅'"
                         :span="2" />

                <div class="field" :span="2">
                  <label class="field-label">采集方式</label>
                  <select class="input" v-model="sourceForm.type" @change="onTypeChange">
                    <option value="subscription">订阅邮件（招标平台的关键词推送）</option>
                    <option value="rss">公众号 / RSS 订阅</option>
                  </select>
                  <div class="field-hint">两种方式都是"读你订阅的内容"，不做全站爬取</div>
                </div>

                <!-- ===== RSS / 公众号 ===== -->
                <template v-if="sourceForm.type === 'rss'">
                  <c-field v-model="sourceForm.url" label="订阅地址" required :span="2"
                           placeholder="以 http 开头的 RSS / Atom 地址" />
                  <div class="field">
                    <label class="field-label">收文口径</label>
                    <select class="input" v-model="sourceForm.filterMode">
                      <option value="region+project">新疆 + 项目类词（推荐）</option>
                      <option value="region">只要新疆（最宽，资讯也收）</option>
                      <option value="keyword">只认下面的关键词（最严）</option>
                    </select>
                    <div class="field-hint">项目类词指项目/工程/采购/招标/中标/EPC/装置/管线/改造/阀门…</div>
                  </div>
                  <c-field v-model.number="sourceForm.maxPerRun" label="每次最多取几篇" type="number"
                           hint="最多 30 篇；每篇公众号正文之间会停 3 秒" />
                  <c-field v-model="sourceForm.keywords" label="关键词（口径选"只认关键词"时生效）" :span="2"
                           placeholder="例如：阀门,球阀,闸阀,蝶阀" />
                  <div class="field" :span="2">
                    <label class="field-label">启用状态</label>
                    <div class="switch" @click="sourceForm.enabled = !sourceForm.enabled">
                      <input type="checkbox" :checked="sourceForm.enabled" readonly />
                      <span class="switch-text">{{ sourceForm.enabled ? '已启用（会联网采集）' : '已停用（零网络请求）' }}</span>
                    </div>
                  </div>
                </template>

                <template v-else>
                <div class="field">
                  <label class="field-label">邮箱服务商</label>
                  <select class="input" v-model="sourceForm.provider" @change="onProviderChange">
                    <option v-for="p in providers" :key="p.key" :value="p.key">{{ p.label }}</option>
                  </select>
                </div>
                <c-field v-model="sourceForm.host" label="IMAP 服务器" placeholder="imap.qq.com" />
                <c-field v-model.number="sourceForm.port" label="端口" type="number" placeholder="993" />
                <c-field v-model="sourceForm.user" label="邮箱地址" placeholder="you@qq.com" />
                <c-field v-model="sourceForm.pass" label="授权码"
                         :placeholder="sourceForm.hasCredential ? '已配置，留空表示不修改' : '粘贴邮箱授权码'" />
                <c-field v-model="sourceForm.mailbox" label="订阅所在文件夹"
                         placeholder="INBOX" hint="订阅邮件通常进收件箱；如建了独立文件夹请填其名称" />
                <c-field v-model="sourceForm.keywords" label="关键词过滤"
                         :span="2"
                         hint="中英文逗号分隔；只保留命中这些词的公告，留空则用默认阀门类关键词" />
                <c-field v-model.number="sourceForm.sinceDays" label="回看天数" type="number"
                         hint="只读取最近这些天的邮件，避免拉取整箱" />
                <div class="field">
                  <label class="field-label">地区范围</label>
                  <select class="input" v-model="sourceForm.regionOnly">
                    <option :value="true">仅新疆本地项目</option>
                    <option :value="false">不限地区</option>
                  </select>
                  <div class="field-hint">按你的客户分布，建议只收新疆项目</div>
                </div>
                <div class="field">
                  <label class="field-label">启用状态</label>
                  <div class="switch" @click="sourceForm.enabled = !sourceForm.enabled">
                    <input type="checkbox" :checked="sourceForm.enabled" readonly />
                    <span class="switch-text">{{ sourceForm.enabled ? '已启用（会联网采集）' : '已停用（零网络请求）' }}</span>
                  </div>
                </div>
                </template>
              </div>

              <div v-if="sourceForm.type !== 'rss'" class="note warn mt-4">
                <c-icon name="alert" :size="16" />
                <div style="font-size:var(--fs-xs)">
                  软件以<strong>只读方式</strong>读取邮件：使用 EXAMINE + BODY.PEEK，
                  不会把你的邮件标记为已读、不会移动或删除任何邮件，也不改动邮箱里的任何状态。
                </div>
              </div>
            </div>
            <div class="drawer-foot">
              <button class="btn" @click="sourceOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="savingSource" @click="saveSource">
                {{ savingSource ? '保存中…' : '保存' }}
              </button>
            </div>
          </div>
        </div>

        <!-- ============ 粘贴链接采集（公众号） ============ -->
        <div v-if="pasteOpen" class="drawer-mask" @click.self="pasteOpen = false">
          <aside class="drawer" style="width:760px">
            <header class="drawer-head">
              <div>
                <div class="drawer-title">粘贴链接采集（微信公众号）</div>
                <div class="drawer-sub">
                  在微信里打开文章 → 右上角「…」→ 复制链接 → 粘到这里（一行一条）
                </div>
              </div>
              <button class="icon-btn" title="关闭" @click="pasteOpen = false">✕</button>
            </header>
            <div class="drawer-body">
              <div class="field">
                <label class="field-label">公众号文章链接</label>
                <textarea class="input" rows="6" v-model="pasteText"
                          placeholder="一行一条，例如：mp.weixin.qq.com/s?__biz=…（从微信里复制来的完整链接）"></textarea>
                <div class="field-hint">
                  一次最多 30 篇；每篇之间会停 3 秒（克制原则，避免被微信风控），所以 5 篇大约要等 15 秒
                </div>
              </div>

              <div class="note mt-3">
                <c-icon name="alert" :size="15" />
                <div style="font-size:var(--fs-xs)">
                  只抓<strong>公开可访问</strong>的文章页，不带你的账号凭据、不绕验证；
                  命中微信「环境异常」提示时会<strong>立即停止</strong>，已抓到的照常入暂存区。<br>
                  收文口径：<strong>新疆地区 + 项目类词</strong>（项目/工程/采购/招标/中标/EPC/装置/管线/
                  改造/阀门/管件…）。<strong>只要文章里出现新疆的地州/县市就会收</strong>；
                  通篇只提到「新疆」二字、没有具体地州的也会收（标为"仅省级"，得分较低，排后面）。<br>
                  确实该留但没命中的，点那一行的<strong>「仍收下」</strong>
                  或底部「把未命中的也收下」—— 收进来同样先进<strong>待审核</strong>。
                </div>
              </div>

              <div v-if="pasteResult" class="mt-4">
                <div class="field-label">抓取结果</div>
                <div class="note" style="margin-bottom:8px">
                  <div style="font-size:var(--fs-xs)">
                    {{ pasteResult.message }}
                    <span v-if="pasteResult.dayUsed != null" class="muted">
                      （今日已抓 {{ pasteResult.dayUsed }} / {{ pasteResult.dayLimit }} 篇）
                    </span>
                  </div>
                </div>
                <div class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th style="width:110px">结果</th>
                        <th>文章 / 链接</th>
                        <th style="width:110px">地区</th>
                        <th style="width:200px">说明</th>
                        <th style="width:90px">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(r, i) in (pasteResult.results || [])" :key="i">
                        <td><span :class="pasteStatusClass(r.status)">{{ pasteStatusText(r.status) }}</span></td>
                        <td>
                          <div>{{ r.title || '—' }}</div>
                          <div class="muted" style="font-size:var(--fs-xxs,11px);word-break:break-all">{{ r.url }}</div>
                        </td>
                        <td>{{ r.region || '—' }}</td>
                        <td class="muted" style="font-size:var(--fs-xs)">{{ r.reason || (r.score ? '得分 ' + r.score : '') }}</td>
                        <td>
                          <button v-if="r.status === 'rejected' && !r.forced" class="btn btn-sm"
                                  :disabled="pasting" title="口径没命中，但我确认这篇要留 —— 收进待审核"
                                  @click="forceOne(r)">仍收下</button>
                          <span v-else-if="r.status === 'rejected'" class="muted" style="font-size:var(--fs-xxs,11px)">已人工收下</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="drawer-foot">
              <button class="btn" @click="pasteOpen = false">关闭</button>
              <button class="btn" :disabled="pasting || !(pasteResult && pasteResult.results)"
                      title="口径没命中的也收进待审核（我确认这些要留）"
                      @click="doPaste(true)">把未命中的也收下</button>
              <button class="btn btn-primary" :disabled="pasting" @click="doPaste(false)">
                {{ pasting ? '抓取中…（每篇间隔 3 秒）' : '开始抓取' }}
              </button>
            </div>
          </aside>
        </div>
      </div>`
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.collect = CollectPage;

})(window.CRM);
