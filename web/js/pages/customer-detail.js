/**
 * 客户详情页（1.27 多项目版）
 *
 * 4 个标签页：
 *   资料            —— 客户字段 + 财务汇总栏（进行中项目合计） + 标签 + 附加联系人（折叠）
 *   回访与跟进      —— 跟进记录 + 下次回访 + 定期提醒
 *   项目与财务      —— 进行中项目列表（可多个） + 选中项目的回款/实收/成本 + 历史项目（折叠只读）
 *   附件与日志      —— 附件 + 变更记录
 *
 * 一个客户可以同时管理多个进行中项目：上面列表逐个项目维护，
 * 财务汇总栏的数字 = 进行中项目逐行相加；归档项目只读、可恢复。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  function emptyContact(customerId) {
    return {
      id: null, customer_id: customerId, name: '', position: '', department: '',
      mobile: '', phone: '', wechat: '', email: '', is_decision: 0, is_primary: 0,
      influence: '', birthday: '', remark: ''
    };
  }

  const CustomerDetail = {
    name: 'CustomerDetail',
    props: { id: [String, Number] },
    data() {
      return {
        customer: null,
        /* 进行中项目列表（summary.active）与历史项目（summary.archived） */
        projects: [],
        archivedProjects: [],
        projectSummary: null,
        selectedProjectId: null,
        /* 选中项目的完整详情（含回款计划 / 实收 / 待办 / 汇总） */
        projectDetail: null,
        /* 兼容旧字段：最近创建的一个进行中项目（部分旧逻辑/模板仍会读它） */
        project: null,
        history: [],
        finance: null,
        loading: true,
        error: '',
        tab: 'basic',
        editOpen: false,
        followOpen: false,
        contactOpen: false,
        contact: null,
        savingContact: false,
        /* 项目抽屉：projectEditing=null 表示新增 */
        projectOpen: false,
        projectEditing: null,
        /* 历史项目只读查看 */
        historyProjectOpen: false,
        historyProject: null,
        /* 回款 */
        paymentOpen: false,
        paymentType: '计划',
        paymentEditing: null,
        /* 成本台账（只针对选中项目） */
        costs: [],
        costByCategory: [],
        costTotal: 0,
        costsLoading: false,
        costOpen: false,
        costEditing: null,
        /* 折叠区 */
        extraOpen: false,
        historyOpen: false
      };
    },
    computed: {
      tabs() {
        const c = this.customer;
        return [
          { key: 'basic', label: '资料' },
          { key: 'followups', label: '回访与跟进', badge: c ? c.followups.length : 0 },
          { key: 'project', label: '项目与财务', badge: this.projects.length || 0 },
          { key: 'files', label: '附件与日志' }
        ];
      },
      extraContacts() {
        return (this.customer && this.customer.contacts || []).filter((x) => !x.is_primary);
      },
      /* 财务汇总栏：进行中项目合计（合同额 / 已回款 / 应收 / 成本 / 毛利 / 毛利率） */
      financeCards() {
        const f = this.finance || {};
        return [
          { key: 'contract_amount', label: '合同额', value: f.contract_amount, money: true },
          { key: 'received_amount', label: '已回款', value: f.received_amount, money: true },
          { key: 'receivable_amount', label: '应收', value: f.receivable_amount, money: true, danger: f.receivable_amount > 0 },
          { key: 'cost_amount', label: '成本', value: f.cost_amount !== undefined ? f.cost_amount : f.total_cost, money: true },
          { key: 'profit', label: '毛利（已回款−成本）', value: f.profit, money: true, signed: true },
          { key: 'margin', label: '毛利率', value: f.margin, percent: true }
        ];
      },
      plans() { return (this.projectDetail && this.projectDetail.plans) || []; },
      receipts() { return (this.projectDetail && this.projectDetail.receipts) || []; },
      selectedProject() {
        return this.projects.find((p) => p.id === this.selectedProjectId) || null;
      }
    },
    watch: {
      id() { this.load(); }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fromNow: CRM.util.fromNow,
      fmtMoney: CRM.util.fmtMoney,

      async load() {
        this.loading = true;
        this.error = '';
        try {
          await CRM.api.loadDict();
          this.customer = await CRM.api.getCustomer(this.id);
          this.finance = this.customer.finance || null;
          this.extraOpen = this.extraContacts.length > 0;
          /* 路由参数：#/customers/12?tab=project&project=34（待办里点项目名跳过来） */
          const q = (CRM.router.state.route.query) || {};
          if (q.tab === 'project' || q.tab === 'followups' || q.tab === 'files') this.tab = q.tab;
          if (q.project) this.selectedProjectId = Number(q.project);
          await this.loadProject();
        } catch (e) {
          this.error = e.message || '加载失败';
        } finally {
          this.loading = false;
        }
      },

      /** 拉客户的项目汇总（进行中 + 归档 + 合计），并选中一个项目 */
      async loadProject() {
        try {
          const [r, fin] = await Promise.all([
            CRM.api.customerProjects(this.id),
            CRM.api.customerFinance(this.id).catch(() => null)
          ]);
          this.projects = r.active || [];
          this.archivedProjects = r.archived || [];
          this.history = r.archived || [];
          this.projectSummary = r.totals || null;
          if (fin) this.finance = fin;
          /* 旧字段兼容：最近创建的一个进行中项目 */
          this.project = this.projects[0] || null;

          const keep = this.projects.find((p) => p.id === this.selectedProjectId);
          if (!keep) this.selectedProjectId = this.projects.length ? this.projects[0].id : null;
          await this.loadProjectDetail();
          await this.loadCosts();
        } catch (_) {
          this.projects = [];
          this.archivedProjects = [];
          this.history = [];
          this.projectSummary = null;
          this.project = null;
          this.projectDetail = null;
          this.costs = [];
          this.costByCategory = [];
          this.costTotal = 0;
        }
      },

      /** 选中项目的完整详情（回款计划 / 实收 / 待办 / 汇总） */
      async loadProjectDetail() {
        if (!this.selectedProjectId) {
          this.projectDetail = null;
          return;
        }
        try {
          this.projectDetail = await CRM.api.getProject(this.selectedProjectId);
        } catch (_) {
          this.projectDetail = null;
          this.selectedProjectId = null;
        }
      },

      /** 切换选中项目：只刷新该项目下的回款与成本 */
      async selectProject(p) {
        if (!p || !p.id || p.id === this.selectedProjectId) return;
        this.selectedProjectId = p.id;
        await this.loadProjectDetail();
        await this.loadCosts();
      },

      /** 成本台账按「选中项目」查，互不影响 */
      async loadCosts() {
        this.costsLoading = true;
        try {
          const params = { pageSize: 100 };
          if (this.selectedProjectId) params.project_id = this.selectedProjectId;
          else params.customer_id = this.id;
          const r = await CRM.api.listCosts(params);
          this.costs = r.list || [];
          this.costByCategory = r.by_category || [];
          this.costTotal = r.amount || 0;
        } catch (_) {
          this.costs = [];
          this.costByCategory = [];
          this.costTotal = 0;
        } finally {
          this.costsLoading = false;
        }
      },

      isOverdue(v) {
        if (!v) return false;
        return new Date(String(v).replace(' ', 'T')).getTime() < Date.now();
      },

      markClass(action) {
        if (action === 'create') return 'success';
        if (action === 'delete') return 'danger';
        return 'muted';
      },
      actionText(action) {
        const MAP = {
          create: '新建', update: '修改', delete: '删除', restore: '还原',
          followup: '跟进', followup_delete: '删跟进', bulk: '批量'
        };
        return MAP[action] || action;
      },

      /* ---------------- 跟进 ---------------- */
      openFollow() { this.followOpen = true; },
      async onFollowSaved() { await this.load(); },

      /* ---------------- 附加联系人 ---------------- */
      openContact(ct) {
        this.contact = ct ? JSON.parse(JSON.stringify(ct)) : emptyContact(this.customer.id);
        this.contact.is_primary = 0;
        this.contactOpen = true;
      },
      async saveContact() {
        if (!String(this.contact.name || '').trim()) {
          CRM.toast('请填写联系人姓名', 'error');
          return;
        }
        this.savingContact = true;
        try {
          await CRM.api.saveContact(this.contact);
          CRM.toast('联系人已保存', 'success');
          this.contactOpen = false;
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.savingContact = false;
        }
      },
      async removeContact(ct) {
        const ok = await CRM.confirm({
          title: '删除联系人',
          message: `确定要删除联系人 <strong>${ct.name}</strong> 吗？`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteContact(ct.id);
          CRM.toast('联系人已删除', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async removeFollowup(f) {
        const ok = await CRM.confirm({
          title: '删除跟进记录',
          message: '确定要删除这条跟进记录吗？客户的跟进次数会同步回退。',
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteFollowup(f.id);
          CRM.toast('跟进记录已删除', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------------- 项目（一个客户可多个） ---------------- */
      /** 打开项目抽屉：不传 = 新增；传项目 = 编辑（先取完整详情，避免只带列表行丢字段） */
      async openProject(p) {
        if (p && p.id) {
          try {
            this.projectEditing = await CRM.api.getProject(p.id);
          } catch (e) {
            CRM.toast(e.message || '项目详情加载失败', 'error');
            return;
          }
        } else {
          this.projectEditing = null;
        }
        this.projectOpen = true;
      },
      async onProjectSaved(r) {
        this.projectOpen = false;
        if (r && r.id) this.selectedProjectId = Number(r.id);
        await this.load();
      },
      async archiveProject(p) {
        const row = p || this.selectedProject || this.projects[0];
        if (!row || !row.id) return;
        const ok = await CRM.confirm({
          title: '把项目归档为历史',
          message: `「${row.name || '（未命名项目）'}」归档后只读，不计入客户财务合计；回款与成本记录都会保留，可随时恢复归档。`,
          okText: '转为历史'
        });
        if (!ok) return;
        try {
          await CRM.api.archiveCustomerProject(this.id, row.id);
          CRM.toast('已归档为历史项目', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },
      async unarchiveProject(p) {
        if (!p || !p.id) return;
        const ok = await CRM.confirm({
          title: '恢复归档',
          message: `把「${p.name || '（未命名项目）'}」恢复为进行中项目？恢复后会重新计入客户财务合计。`,
          okText: '恢复归档'
        });
        if (!ok) return;
        try {
          await CRM.api.unarchiveProject(p.id);
          CRM.toast('已恢复为进行中项目', 'success');
          this.historyProjectOpen = false;
          this.selectedProjectId = p.id;
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },
      async removeProject(p) {
        if (!p || !p.id) return;
        const ok = await CRM.confirm({
          title: '删除项目',
          message: `删除「${p.name || '（未命名项目）'}」？该项目的回款与成本会一起移入回收站，其它项目不受影响。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteProjects([p.id]);
          CRM.toast('项目已删除', 'success');
          if (this.selectedProjectId === p.id) this.selectedProjectId = null;
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },
      /** 历史项目只读查看（含回款计划与实收流水） */
      async viewHistoryProject(p) {
        try {
          this.historyProject = await CRM.api.getProject(p.id);
          this.historyProjectOpen = true;
        } catch (e) {
          CRM.toast(e.message || '历史项目加载失败', 'error');
        }
      },
      /** 登记回款/成本前必须有选中的进行中项目 */
      requireProject() {
        if (this.projectDetail && this.projectDetail.id) return true;
        CRM.toast('请先在上方新增或选择一个进行中项目', 'warn');
        return false;
      },

      /* ---------------- 回款 ---------------- */
      async openPayment(type, row) {
        if (!this.requireProject()) return;
        this.paymentType = type;
        this.paymentEditing = row || null;
        this.paymentOpen = true;
      },
      async onPaymentSaved() {
        this.paymentOpen = false;
        await this.loadProject();
      },
      async removePayment(row) {
        const ok = await CRM.confirm({
          title: row.type === '计划' ? '删除回款计划' : '删除实收记录',
          message: `确定删除 ${row.amount} 元（${row.plan_date || row.actual_date || ''}）吗？`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deletePayment(row.id);
          CRM.toast('已删除', 'success');
          await this.loadProject();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------------- 成本台账（只针对选中项目） ---------------- */
      openCost(row) {
        if (!row && !this.requireProject()) return;
        this.costEditing = row || null;
        this.costOpen = true;
      },
      async onCostSaved() {
        this.costOpen = false;
        await this.loadProject();
      },
      async removeCost(row) {
        const ok = await CRM.confirm({
          title: '删除成本记录',
          message: `确定删除「${row.category} ${CRM.util.fmtMoney(row.amount)} 元（${row.spent_at}）」吗？`,
          okText: '删除', danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteCost(row.id);
          CRM.toast('已删除', 'success');
          await this.loadProject();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      back() { CRM.router.navigate('/customers'); }
    },
    async created() { this.load(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">正在加载客户资料…</div></div>

        <div v-else-if="error" class="note danger">
          <c-icon name="alert" :size="16" />
          <div>
            <strong>{{ error }}</strong>
            <div class="mt-3" style="display:flex;gap:8px">
              <button class="btn btn-sm" @click="back">返回客户列表</button>
              <button class="btn btn-sm" @click="load">重试</button>
            </div>
          </div>
        </div>

        <template v-else-if="customer">
          <!-- 头部 -->
          <div class="detail-head">
            <div style="flex:1;min-width:0">
              <div class="detail-title">{{ customer.name }}</div>
              <div class="detail-meta">
                <span class="tag muted">{{ customer.customer_no || '无编号' }}</span>
                <span v-if="customer.industry" class="tag muted">{{ customer.industry }}</span>
                <span v-for="t in customer.tags" :key="t.id" class="tag"
                      :style="t.color ? 'border-color:' + t.color + ';color:' + t.color : ''">{{ t.name }}</span>
                <span v-if="customer.region_name || customer.city">
                  {{ customer.region_name || customer.city }}
                </span>
              </div>
              <div class="detail-meta">
                <span v-if="customer.contact_name">
                  主联系人：{{ customer.contact_name }}{{ customer.contact_position ? '（' + customer.contact_position + '）' : '' }}
                  <template v-if="customer.contact_phone"> · {{ customer.contact_phone }}</template>
                </span>
                <span v-else>未填主联系人</span>
                <span>跟进 {{ customer.follow_count }} 次</span>
                <span>最近跟进 {{ customer.last_follow_at ? fromNow(customer.last_follow_at) : '暂无' }}</span>
                <span v-if="customer.next_follow_at"
                      :style="isOverdue(customer.next_follow_at) ? 'color:var(--c-danger);font-weight:600' : ''">
                  下次回访 {{ fmtDate(customer.next_follow_at) }}{{ isOverdue(customer.next_follow_at) ? '（已逾期）' : '' }}
                </span>
                <span v-if="customer.follow_cycle_days > 0">定期提醒 {{ customer.follow_cycle_days }} 天</span>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" @click="back">返回列表</button>
              <button class="btn btn-primary" @click="openFollow">
                <c-icon name="plus" :size="14" /> 记录跟进
              </button>
              <button class="btn" @click="editOpen = true">编辑资料</button>
            </div>
          </div>

          <!-- 标签页 -->
          <div class="tabs">
            <button v-for="t in tabs" :key="t.key" class="tab" :class="{ active: tab === t.key }"
                    @click="tab = t.key">
              {{ t.label }}<span v-if="t.badge" class="badge">{{ t.badge }}</span>
            </button>
          </div>

          <!-- ==================== 资料 ==================== -->
          <div v-show="tab === 'basic'">
            <!-- 财务汇总栏 -->
            <div class="card">
              <div class="card-head">
                <div>
                  <div class="card-title">财务汇总</div>
                  <div class="card-sub">进行中项目合计（{{ projects.length }} 个项目）：毛利 = 已回款 − 成本；全部自动算，明细在「项目与财务」</div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm" @click="tab = 'project'">查看明细</button>
              </div>
              <div class="card-body">
                <div class="stat-grid fin-grid">
                  <div class="stat" v-for="c in financeCards" :key="c.key">
                    <div class="n" :style="c.danger ? 'color:var(--c-danger)' :
                         (c.signed ? (c.value < 0 ? 'color:var(--c-danger)' : 'color:var(--c-success)') : '')">
                      <template v-if="c.percent">{{ c.value === null ? '—' : c.value + '%' }}</template>
                      <template v-else>{{ fmtMoney(c.value) }}</template>
                    </div>
                    <div class="l">{{ c.label }}</div>
                  </div>
                  <div class="stat">
                    <div class="n">{{ fmtMoney(finance ? finance.expected_profit : 0) }}</div>
                    <div class="l" title="合同额 − 采购成本">预计毛利</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 客户资料 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head"><div class="card-title">客户资料</div></div>
              <div class="card-body">
                <div class="kv">
                  <div class="k">客户编号</div><div class="v">{{ customer.customer_no || '—' }}</div>
                  <div class="k">行业</div><div class="v">{{ customer.industry || '—' }}</div>
                  <div class="k">客户来源</div><div class="v">{{ customer.source || '—' }}</div>
                  <div class="k">邮箱</div><div class="v">{{ customer.email || '—' }}</div>
                  <div class="k">地址</div>
                  <div class="v">
                    {{ (customer.province || '') + (customer.city || '') + (customer.district || '') || '—' }}
                    <span v-if="customer.address"> · {{ customer.address }}</span>
                  </div>
                  <div class="k">归属地州</div><div class="v">{{ customer.region_name || '未归属' }}</div>
                  <div class="k">备注</div><div class="v">{{ customer.remark || '—' }}</div>
                </div>
              </div>
            </div>

            <!-- 主联系人 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">主联系人</div>
                  <div class="card-sub">一客户一个主联系人，其余在下方「附加联系人」里维护</div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm" @click="editOpen = true">编辑</button>
              </div>
              <div class="card-body">
                <div v-if="!customer.contact_name" class="muted">暂无主联系人，点「编辑」补充姓名与手机。</div>
                <div v-else class="kv">
                  <div class="k">姓名</div><div class="v">{{ customer.contact_name }}</div>
                  <div class="k">职务</div><div class="v">{{ customer.contact_position || '—' }}</div>
                  <div class="k">手机</div><div class="v">{{ customer.contact_phone || '—' }}</div>
                  <div class="k">生日</div><div class="v">{{ customer.contact_birthday || '—' }}</div>
                </div>
              </div>
            </div>

            <!-- 回访设置 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">回访设置</div>
                  <div class="card-sub">填了定期提醒天数后，每次记录跟进会自动排下次回访</div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm" @click="tab = 'followups'">看跟进记录</button>
              </div>
              <div class="card-body">
                <div class="kv">
                  <div class="k">回访日期</div>
                  <div class="v" :style="isOverdue(customer.next_follow_at) ? 'color:var(--c-danger);font-weight:600' : ''">
                    {{ customer.next_follow_at ? fmtDate(customer.next_follow_at, true) : '—' }}
                    <span v-if="isOverdue(customer.next_follow_at)">（已逾期）</span>
                  </div>
                  <div class="k">定期提醒天数</div>
                  <div class="v">{{ customer.follow_cycle_days > 0 ? customer.follow_cycle_days + ' 天' : '未设置' }}</div>
                  <div class="k">跟进次数</div><div class="v">{{ customer.follow_count }} 次</div>
                  <div class="k">最近跟进</div>
                  <div class="v">{{ customer.last_follow_at ? fmtDate(customer.last_follow_at, true) : '—' }}</div>
                </div>
              </div>
            </div>

            <!-- 附加联系人（折叠） -->
            <div class="card">
              <div class="card-head" style="cursor:pointer" @click="extraOpen = !extraOpen">
                <div>
                  <div class="card-title">附加联系人（{{ extraContacts.length }}）</div>
                  <div class="card-sub">第二个人、决策人、技术把关人放这里；没有就不用展开</div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm" @click.stop="openContact(null)">+ 新增</button>
                <button class="icon-btn" @click.stop="extraOpen = !extraOpen">{{ extraOpen ? '▾' : '▸' }}</button>
              </div>
              <div v-show="extraOpen" class="card-body">
                <c-empty v-if="!extraContacts.length" icon="customers"
                         title="还没有附加联系人" desc="点右上角「+ 新增」录入第二个人。" />
                <div v-else class="card-list">
                  <div class="mini-card" v-for="ct in extraContacts" :key="ct.id">
                    <div class="acts">
                      <button class="btn btn-sm" @click="openContact(ct)">编辑</button>
                      <button class="btn btn-sm btn-danger" @click="removeContact(ct)">删</button>
                    </div>
                    <div class="nm">
                      {{ ct.name }}
                      <span v-if="ct.is_decision" class="tag">决策人</span>
                    </div>
                    <div class="pos">
                      {{ ct.department || '' }}{{ ct.department && ct.position ? ' · ' : '' }}{{ ct.position || '职位未填' }}
                      <span v-if="ct.influence"> · {{ ct.influence }}</span>
                    </div>
                    <div class="rows">
                      <div v-if="ct.mobile">手机：{{ ct.mobile }}</div>
                      <div v-if="ct.phone">座机：{{ ct.phone }}</div>
                      <div v-if="ct.wechat">微信：{{ ct.wechat }}</div>
                      <div v-if="ct.email">邮箱：{{ ct.email }}</div>
                      <div v-if="ct.birthday">生日：{{ fmtDate(ct.birthday) }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ==================== 回访与跟进 ==================== -->
          <div v-show="tab === 'followups'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">回访与跟进</div>
                <div class="card-sub">
                  共 {{ customer.followups.length }} 条；最近跟进 {{ customer.last_follow_at ? fromNow(customer.last_follow_at) : '暂无' }}
                  <span v-if="customer.next_follow_at"
                        :style="isOverdue(customer.next_follow_at) ? 'color:var(--c-danger)' : ''">
                    · 下次回访 {{ fmtDate(customer.next_follow_at, true) }}
                    {{ isOverdue(customer.next_follow_at) ? '（已逾期）' : '' }}
                  </span>
                  <span v-if="customer.follow_cycle_days > 0">· 每 {{ customer.follow_cycle_days }} 天自动提醒</span>
                </div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="openFollow">+ 记录跟进</button>
            </div>
            <div class="card-body">
              <c-empty v-if="!customer.followups.length" icon="clock"
                       title="还没有跟进记录" desc="每次沟通后记一条；设置了定期提醒天数会自动排下次回访。" />
              <div v-else class="timeline">
                <div class="tl-item" v-for="f in customer.followups" :key="f.id">
                  <div class="tl-head">
                    <span class="tag">{{ f.method }}</span>
                    <span v-if="f.result" class="tag success">{{ f.result }}</span>
                    <span class="tl-time">{{ fmtDate(f.followed_at, true) }}</span>
                    <div style="flex:1"></div>
                    <button class="btn btn-sm" @click="removeFollowup(f)">删除</button>
                  </div>
                  <div class="tl-body">{{ f.content }}</div>
                  <div class="tl-extra" v-if="f.next_plan">下次计划：{{ f.next_plan }}</div>
                  <div class="tl-extra" v-if="f.next_at">下次回访：{{ fmtDate(f.next_at, true) }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- ==================== 项目与财务 ==================== -->
          <div v-show="tab === 'project'">
            <!-- 客户级财务汇总（进行中项目合计） -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">进行中项目合计</div>
                  <div class="card-sub">
                    进行中 {{ projects.length }} 个 · 历史归档 {{ archivedProjects.length }} 个；
                    下面的数字是进行中项目逐行相加，与列表一致
                  </div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-primary" @click="openProject(null)">
                  <c-icon name="plus" :size="14" /> 新增项目
                </button>
              </div>
              <div class="card-body">
                <div class="stat-grid fin-grid">
                  <div class="stat" v-for="c in financeCards" :key="'p-' + c.key">
                    <div class="n" :style="c.danger ? 'color:var(--c-danger)' :
                         (c.signed ? (c.value < 0 ? 'color:var(--c-danger)' : 'color:var(--c-success)') : '')">
                      <template v-if="c.percent">{{ c.value === null ? '—' : c.value + '%' }}</template>
                      <template v-else>{{ fmtMoney(c.value) }}</template>
                    </div>
                    <div class="l">{{ c.label }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 进行中项目列表（一个客户可多个） -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">进行中项目（{{ projects.length }}）</div>
                  <div class="card-sub">点某一行选中项目，下方回款 / 实收 / 成本只作用于选中项目</div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-primary" @click="openProject(null)">+ 新增项目</button>
              </div>
              <div class="card-body">
                <c-empty v-if="!projects.length" icon="projects" title="还没有进行中的项目"
                         desc="一个客户可以同时管理多个项目，点右上角「+ 新增项目」开始。" />
                <div v-else class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>项目名称</th>
                        <th style="width:110px">阶段</th>
                        <th style="width:80px">进度</th>
                        <th style="width:120px;text-align:right">合同额</th>
                        <th style="width:120px;text-align:right">已回款</th>
                        <th style="width:110px;text-align:right">成本</th>
                        <th style="width:110px;text-align:right">毛利</th>
                        <th style="width:180px">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="p in projects" :key="p.id" style="cursor:pointer"
                          :style="p.id === selectedProjectId ? 'background:var(--c-primary-soft)' : ''"
                          @click="selectProject(p)">
                        <td>
                          {{ p.name || '（未命名）' }}
                          <span v-if="p.id === selectedProjectId" class="tag" style="margin-left:6px">选中</span>
                        </td>
                        <td><span class="tag muted">{{ p.stage }}</span></td>
                        <td>{{ p.progress }}%</td>
                        <td class="num">{{ fmtMoney(p.contract_amount) }}</td>
                        <td class="num">{{ fmtMoney(p.received_amount) }}</td>
                        <td class="num">{{ fmtMoney(p.cost_amount) }}</td>
                        <td class="num" :style="p.profit < 0 ? 'color:var(--c-danger)' : ''">{{ fmtMoney(p.profit) }}</td>
                        <td @click.stop>
                          <button class="btn btn-sm" @click="openProject(p)">编辑</button>
                          <button class="btn btn-sm" @click="archiveProject(p)">归档</button>
                          <button class="btn btn-sm btn-danger" @click="removeProject(p)">删</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- 选中项目档案 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">{{ projectDetail ? (projectDetail.name || '（未命名项目）') : '项目档案' }}</div>
                  <div class="card-sub">
                    {{ projectDetail ? '选中项目的档案；回款与成本只挂在这一个项目上' : '先在列表里选择一个项目' }}
                  </div>
                </div>
                <div class="spacer"></div>
                <button v-if="projectDetail" class="btn btn-sm" @click="openProject(projectDetail)">编辑项目</button>
              </div>
              <div class="card-body">
                <c-empty v-if="!projectDetail" icon="projects" title="还没有进行中的项目"
                         desc="新增项目后，就能在这里维护它的回款计划、实收与成本。" />
                <div v-else class="kv">
                  <div class="k">项目名称</div><div class="v">{{ projectDetail.name || '（未命名）' }}</div>
                  <div class="k">项目阶段</div><div class="v"><span class="tag">{{ projectDetail.stage }}</span></div>
                  <div class="k">进度</div><div class="v">{{ projectDetail.progress }}%</div>
                  <div class="k">合同额</div><div class="v">{{ fmtMoney(projectDetail.contract_amount) }} 元</div>
                  <div class="k">签约日期</div><div class="v">{{ projectDetail.signed_at || '—' }}</div>
                  <div class="k">投标日期</div><div class="v">{{ projectDetail.bid_date || '—' }}</div>
                  <div class="k">投标结果</div><div class="v">{{ projectDetail.bid_result || '—' }}</div>
                  <div class="k">交货期</div><div class="v">{{ projectDetail.delivery_date || '—' }}</div>
                  <div class="k">已收 / 欠款</div>
                  <div class="v">
                    {{ fmtMoney(projectDetail.received_amount) }} 元
                    <span :style="projectDetail.debt_amount > 0 ? 'color:var(--c-danger)' : ''">
                      / 欠 {{ fmtMoney(projectDetail.debt_amount) }} 元
                    </span>
                    <span class="muted">（回款率 {{ projectDetail.payment_rate }}%）</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 回款计划 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">回款计划</div>
                  <div class="card-sub">
                    {{ projectDetail ? '项目：' + (projectDetail.name || '（未命名项目）') + ' · ' : '' }}
                    保存计划会按设置里的提前天数自动生成待办
                  </div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-primary" @click="openPayment('计划', null)">+ 新增计划</button>
              </div>
              <div class="card-body">
                <c-empty v-if="!plans.length" icon="money" title="还没有回款计划" />
                <div v-else class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th style="width:120px">计划日期</th>
                        <th style="width:130px">计划金额</th>
                        <th style="width:130px">已核销</th>
                        <th style="width:120px">剩余</th>
                        <th>状态</th>
                        <th style="width:120px">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="p in plans" :key="p.id">
                        <td>{{ p.plan_date || '—' }}</td>
                        <td class="num">{{ fmtMoney(p.amount) }}</td>
                        <td class="num">{{ fmtMoney(p.settled_amount) }}</td>
                        <td class="num" :style="p.remain > 0 ? 'color:var(--c-danger)' : ''">{{ fmtMoney(p.remain) }}</td>
                        <td>
                          <span class="tag" :class="p.is_settled ? 'success' : (p.is_overdue ? 'danger' : 'muted')">
                            {{ p.is_settled ? '已核销' : (p.is_overdue ? '已逾期' : '待收') }}
                          </span>
                        </td>
                        <td>
                          <button class="btn btn-sm" @click="openPayment('计划', p)">编辑</button>
                          <button class="btn btn-sm btn-danger" @click="removePayment(p)">删</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- 实收 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">实收流水</div>
                  <div class="card-sub">
                    {{ projectDetail ? '项目：' + (projectDetail.name || '（未命名项目）') + ' · ' : '' }}
                    登记后自动重算欠款、回款率与毛利
                  </div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-primary" @click="openPayment('实收', null)">+ 登记实收</button>
              </div>
              <div class="card-body">
                <c-empty v-if="!receipts.length" icon="money" title="还没有实收记录" />
                <div v-else class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th style="width:120px">收款日期</th>
                        <th style="width:130px">金额</th>
                        <th style="width:120px">方式</th>
                        <th>核销计划 / 备注</th>
                        <th style="width:110px">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="r in receipts" :key="r.id">
                        <td>{{ r.actual_date || '—' }}</td>
                        <td class="num">{{ fmtMoney(r.amount) }}</td>
                        <td>{{ r.method || '—' }}</td>
                        <td class="muted">{{ r.linked_plan_date ? '核销 ' + r.linked_plan_date + ' 计划' : '' }}{{ r.remark ? ' · ' + r.remark : '' }}</td>
                        <td>
                          <button class="btn btn-sm" @click="openPayment('实收', r)">编辑</button>
                          <button class="btn btn-sm btn-danger" @click="removePayment(r)">删</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- 成本台账 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">成本台账</div>
                  <div class="card-sub">
                    {{ projectDetail ? '项目：' + (projectDetail.name || '（未命名项目）') + ' · ' : '' }}
                    采购成本 / 维护成本 / 差旅 / 其他；毛利 = 已回款 − 这些成本
                  </div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-primary" @click="openCost(null)">+ 登记成本</button>
              </div>
              <div class="card-body">
                <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:10px">
                  <div class="stat" v-for="c in costByCategory" :key="c.category">
                    <div class="n">{{ fmtMoney(c.amount) }}</div>
                    <div class="l">{{ c.category }} · {{ c.count }} 笔</div>
                  </div>
                  <div class="stat">
                    <div class="n">{{ fmtMoney(costTotal) }}</div>
                    <div class="l">成本合计</div>
                  </div>
                </div>
                <c-empty v-if="!costs.length" icon="money" title="还没有成本记录"
                         desc="登记采购成本与维护成本后，毛利才是真实的。" />
                <div v-else class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr><th style="width:110px">日期</th><th style="width:110px">分类</th><th style="width:130px">金额</th><th>供应商 / 备注</th><th style="width:120px">操作</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="r in costs" :key="r.id">
                        <td>{{ r.spent_at }}</td>
                        <td><span class="tag">{{ r.category }}</span></td>
                        <td class="num">{{ fmtMoney(r.amount) }}</td>
                        <td class="muted">{{ r.supplier || r.remark || '—' }}</td>
                        <td>
                          <button class="btn btn-sm" @click="openCost(r)">编辑</button>
                          <button class="btn btn-sm btn-danger" @click="removeCost(r)">删除</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- 历史项目（折叠：只读查看 / 恢复归档） -->
            <div class="card">
              <div class="card-head" style="cursor:pointer" @click="historyOpen = !historyOpen">
                <div>
                  <div class="card-title">历史项目（{{ archivedProjects.length }}）</div>
                  <div class="card-sub">已归档的项目只读保留，可随时「恢复归档」重新计入进行中</div>
                </div>
                <div class="spacer"></div>
                <button class="icon-btn" @click.stop="historyOpen = !historyOpen">{{ historyOpen ? '▾' : '▸' }}</button>
              </div>
              <div v-show="historyOpen" class="card-body">
                <c-empty v-if="!archivedProjects.length" icon="projects" title="没有历史项目"
                         desc="把进行中的项目「归档」后会出现在这里，随时可以恢复。" />
                <div v-else class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>项目名称</th>
                        <th style="width:110px">阶段</th>
                        <th style="width:80px">进度</th>
                        <th style="width:120px;text-align:right">合同额</th>
                        <th style="width:120px;text-align:right">已回款</th>
                        <th style="width:110px;text-align:right">成本</th>
                        <th style="width:110px;text-align:right">毛利</th>
                        <th style="width:150px">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="h in archivedProjects" :key="h.id">
                        <td>{{ h.name || '（未命名）' }} <span class="tag muted">只读</span></td>
                        <td><span class="tag muted">{{ h.stage }}</span></td>
                        <td>{{ h.progress }}%</td>
                        <td class="num">{{ fmtMoney(h.contract_amount) }}</td>
                        <td class="num">{{ fmtMoney(h.received_amount) }}</td>
                        <td class="num">{{ fmtMoney(h.cost_amount) }}</td>
                        <td class="num" :style="h.profit < 0 ? 'color:var(--c-danger)' : ''">{{ fmtMoney(h.profit) }}</td>
                        <td>
                          <button class="btn btn-sm" @click="viewHistoryProject(h)">查看</button>
                          <button class="btn btn-sm" @click="unarchiveProject(h)">恢复归档</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <!-- ==================== 附件与日志 ==================== -->
          <div v-show="tab === 'files'">
            <div class="card" style="margin-bottom:12px">
              <c-attachments owner-type="customer" :owner-id="id" title="客户附件" />
            </div>
            <div class="card">
              <div class="card-head">
                <div>
                  <div class="card-title">操作日志</div>
                  <div class="card-sub">谁在什么时候改了什么，全部留痕</div>
                </div>
              </div>
              <div class="card-body">
                <c-empty v-if="!customer.logs.length" title="暂无操作记录" />
                <div v-else class="timeline">
                  <div class="tl-item" v-for="l in customer.logs" :key="l.id">
                    <div class="tl-head">
                      <span class="tag" :class="markClass(l.action)">{{ actionText(l.action) }}</span>
                      <span class="tl-time">{{ fmtDate(l.created_at, true) }}</span>
                    </div>
                    <div class="tl-body">{{ l.summary }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 编辑客户 -->
        <c-customer-edit v-model="editOpen" :customer="customer" @saved="load" />

        <!-- 记录跟进 -->
        <c-followup-drawer v-model="followOpen" :customer-id="id"
                           :customer-name="customer ? customer.name : ''"
                           @saved="onFollowSaved" />

        <!-- 项目抽屉：projectEditing=null 为新增，否则编辑指定项目 -->
        <c-project-edit v-model="projectOpen" :customer-id="id"
                        :customer-name="customer ? customer.name : ''"
                        :project="projectEditing"
                        :index="projects.length + 1" @saved="onProjectSaved" />

        <!-- 回款（作用于选中项目） -->
        <c-payment-drawer v-model="paymentOpen" :type="paymentType"
                          :project-id="projectDetail ? projectDetail.id : ''"
                          :project-name="projectDetail ? (projectDetail.name || '（未命名项目）') : ''"
                          :contract-amount="projectDetail ? projectDetail.contract_amount : 0"
                          :debt-amount="projectDetail ? projectDetail.debt_amount : 0"
                          :plans="plans"
                          :payment="paymentEditing" @saved="onPaymentSaved" />

        <!-- 成本登记（作用于选中项目） -->
        <c-cost-drawer v-model="costOpen" :customer-id="id"
                       :project-id="projectDetail ? projectDetail.id : ''"
                       :customer-name="customer ? customer.name : ''"
                       :cost="costEditing" @saved="onCostSaved" />

        <!-- 历史项目只读查看 -->
        <c-drawer v-model="historyProjectOpen"
                  :title="historyProject ? (historyProject.name || '历史项目') : '历史项目'"
                  sub="历史项目只读；回款与成本记录仍保留" width="720px">
          <template v-if="historyProject">
            <div class="note warn" style="margin-bottom:14px">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                该项目已归档（历史项目），不能修改与登记新回款；如需继续维护请点「恢复归档」。
              </div>
            </div>
            <div class="kv">
              <div class="k">项目名称</div><div class="v">{{ historyProject.name || '（未命名）' }}</div>
              <div class="k">项目阶段</div><div class="v"><span class="tag muted">{{ historyProject.stage }}</span></div>
              <div class="k">进度</div><div class="v">{{ historyProject.progress }}%</div>
              <div class="k">合同额</div><div class="v">{{ fmtMoney(historyProject.contract_amount) }} 元</div>
              <div class="k">已回款</div><div class="v">{{ fmtMoney(historyProject.received_amount) }} 元</div>
              <div class="k">成本</div>
              <div class="v">{{ fmtMoney(historyProject.cost_amount) }} 元</div>
              <div class="k">签约日期</div><div class="v">{{ historyProject.signed_at || '—' }}</div>
              <div class="k">回款计划</div>
              <div class="v">{{ (historyProject.plans || []).length }} 条 · 实收 {{ (historyProject.receipts || []).length }} 条</div>
            </div>
            <div class="table-wrap mt-4" v-if="(historyProject.plans || []).length">
              <table class="data-table">
                <thead><tr><th>计划日期</th><th>计划金额</th><th>已核销</th><th>状态</th></tr></thead>
                <tbody>
                  <tr v-for="p in historyProject.plans" :key="p.id">
                    <td>{{ p.plan_date || '—' }}</td>
                    <td class="num">{{ fmtMoney(p.amount) }}</td>
                    <td class="num">{{ fmtMoney(p.settled_amount) }}</td>
                    <td><span class="tag" :class="p.is_settled ? 'success' : 'muted'">{{ p.is_settled ? '已核销' : '待收' }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <template #footer>
            <div style="flex:1"></div>
            <button class="btn" @click="historyProjectOpen = false">关闭</button>
            <button v-if="historyProject" class="btn btn-primary" @click="unarchiveProject(historyProject)">
              恢复归档
            </button>
          </template>
        </c-drawer>

        <!-- 附加联系人编辑 -->
        <c-drawer v-model="contactOpen"
                  :title="contact && contact.id ? '编辑附加联系人' : '新增附加联系人'"
                  :sub="customer ? customer.name : ''" width="560px">
          <div v-if="contact" class="form-grid">
            <c-field v-model="contact.name" label="姓名" required />
            <c-select v-model="contact.position" label="职位"
                      :options="api.options('contact_position')" />
            <c-field v-model="contact.department" label="所属部门"
                     placeholder="采购部 / 技术部 / 设备部 / 工程部" />
            <c-select v-model="contact.influence" label="影响力"
                      :options="api.options('contact_influence')"
                      hint="工业客户里技术工程师常有一票否决权" />
            <c-field v-model="contact.mobile" label="手机号" />
            <c-field v-model="contact.phone" label="座机" />
            <c-field v-model="contact.wechat" label="微信" />
            <c-field v-model="contact.email" label="邮箱" />
            <c-field v-model="contact.birthday" label="生日" type="date" />
            <div class="field">
              <label class="field-label">标记</label>
              <div style="display:flex;gap:16px;padding-top:4px">
                <label class="switch">
                  <input type="checkbox" :checked="contact.is_decision === 1"
                         @change="contact.is_decision = $event.target.checked ? 1 : 0" />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                  <span class="switch-text">决策人</span>
                </label>
              </div>
              <div class="field-hint">主联系人在客户资料里维护，这里只登记附加联系人</div>
            </div>
            <c-field v-model="contact.remark" label="备注" type="textarea" :span="2" :rows="2" />
          </div>
          <template #footer>
            <div style="flex:1"></div>
            <button class="btn" @click="contactOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="savingContact" @click="saveContact">
              {{ savingContact ? '保存中…' : '保存' }}
            </button>
          </template>
        </c-drawer>
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.CustomerDetail = CustomerDetail;

})(window.CRM);
