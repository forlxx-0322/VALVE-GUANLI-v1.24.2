/**
 * 客户详情页（1.23 一客户一项目版）
 *
 * 4 个标签页：
 *   资料            —— 客户字段 + 财务汇总栏 + 标签 + 附加联系人（折叠）
 *   回访与跟进      —— 跟进记录 + 下次回访 + 定期提醒
 *   项目与财务      —— 当前项目档案 + 回款计划/实收 + 成本台账 + 历史项目（折叠只读）
 *   附件与日志      —— 附件 + 变更记录
 *
 * 没有独立的「项目管理」入口：项目档案、回款、成本都在本页维护。
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
        /* 项目档案抽屉 */
        projectOpen: false,
        /* 回款 */
        paymentOpen: false,
        paymentType: '计划',
        paymentEditing: null,
        /* 成本台账 */
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
          { key: 'project', label: '项目与财务' },
          { key: 'files', label: '附件与日志' }
        ];
      },
      extraContacts() {
        return (this.customer && this.customer.contacts || []).filter((x) => !x.is_primary);
      },
      /* 财务汇总栏（8 个数字 + 预计毛利） */
      financeCards() {
        const f = this.finance || {};
        return [
          { key: 'contract_amount', label: '合同额', value: f.contract_amount, money: true },
          { key: 'received_amount', label: '已收', value: f.received_amount, money: true },
          { key: 'receivable_amount', label: '应收', value: f.receivable_amount, money: true, danger: f.receivable_amount > 0 },
          { key: 'purchase_cost', label: '采购成本', value: f.purchase_cost, money: true },
          { key: 'maintain_cost', label: '维护成本', value: f.maintain_cost, money: true },
          { key: 'other_cost', label: '其他成本', value: f.other_cost, money: true },
          { key: 'profit', label: '毛利（实收−成本）', value: f.profit, money: true, signed: true },
          { key: 'margin', label: '毛利率', value: f.margin, percent: true }
        ];
      },
      plans() { return (this.project && this.project.plans) || []; },
      receipts() { return (this.project && this.project.receipts) || []; }
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
          this.extraOpen = this.extraContacts.length > 0;
          await Promise.all([this.loadProject(), this.loadCosts()]);
        } catch (e) {
          this.error = e.message || '加载失败';
        } finally {
          this.loading = false;
        }
      },

      async loadProject() {
        try {
          const r = await CRM.api.customerProject(this.id);
          this.project = r.project || null;
          this.history = r.history || [];
          this.finance = r.finance || null;
        } catch (_) {
          this.project = null;
          this.history = [];
          this.finance = null;
        }
      },

      async loadCosts() {
        this.costsLoading = true;
        try {
          const r = await CRM.api.listCosts({ customer_id: this.id, pageSize: 100 });
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

      /* ---------------- 项目档案 ---------------- */
      openProject() { this.projectOpen = true; },
      async onProjectSaved() { await this.load(); },
      async archiveProject() {
        const ok = await CRM.confirm({
          title: '把当前项目转为历史',
          message: '转为历史后这条项目只读，之后可以再建立新的当前项目。回款与成本记录都会保留。',
          okText: '转为历史'
        });
        if (!ok) return;
        try {
          await CRM.api.archiveCustomerProject(this.id);
          CRM.toast('已转为历史项目', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },
      /** 第一次登记回款前先保证有项目档案（1:1） */
      async ensureProject() {
        if (this.project && this.project.id) return true;
        try {
          await CRM.api.saveCustomerProject(this.id, {});
          await this.loadProject();
          return true;
        } catch (e) {
          CRM.toast(e.message || '建立项目档案失败', 'error');
          return false;
        }
      },

      /* ---------------- 回款 ---------------- */
      async openPayment(type, row) {
        this.paymentType = type;
        this.paymentEditing = row || null;
        if (!row) {
          const ok = await this.ensureProject();
          if (!ok) return;
        }
        if (type === '实收' && !this.project) {
          CRM.toast('请先建立项目档案', 'error');
          return;
        }
        this.paymentOpen = true;
      },
      async onPaymentSaved() {
        this.paymentOpen = false;
        await this.load();
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
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------------- 成本台账 ---------------- */
      openCost(row) {
        this.costEditing = row || null;
        this.costOpen = true;
      },
      async onCostSaved() {
        this.costOpen = false;
        await this.loadCosts();
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
          await this.loadCosts();
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
                  <div class="card-sub">毛利 = 已收 − 采购成本 − 维护成本 − 其他成本；全部自动算，明细在「项目与财务」</div>
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
            <!-- 当前项目档案 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">当前项目档案</div>
                  <div class="card-sub">一客户一项目：历史项目会归档只读，回款与成本都挂在这条档案上</div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-sm btn-primary" @click="openProject">
                  {{ project ? '编辑档案' : '+ 建立项目档案' }}
                </button>
                <button v-if="project" class="btn btn-sm" @click="archiveProject">转为历史</button>
              </div>
              <div class="card-body">
                <c-empty v-if="!project" icon="projects" title="还没有项目档案"
                         desc="客户可以暂时没有项目；第一次登记回款或成本时会自动建立一条空档案。" />
                <div v-else class="kv">
                  <div class="k">项目名称</div><div class="v">{{ project.name || '（未命名）' }}</div>
                  <div class="k">项目阶段</div><div class="v"><span class="tag">{{ project.stage }}</span></div>
                  <div class="k">进度</div><div class="v">{{ project.progress }}%</div>
                  <div class="k">合同额</div><div class="v">{{ fmtMoney(project.contract_amount) }} 元</div>
                  <div class="k">签约日期</div><div class="v">{{ project.signed_at || '—' }}</div>
                  <div class="k">投标日期</div><div class="v">{{ project.bid_date || '—' }}</div>
                  <div class="k">投标结果</div><div class="v">{{ project.bid_result || '—' }}</div>
                  <div class="k">交货期</div><div class="v">{{ project.delivery_date || '—' }}</div>
                  <div class="k">已收 / 欠款</div>
                  <div class="v">
                    {{ fmtMoney(project.received_amount) }} 元
                    <span :style="project.debt_amount > 0 ? 'color:var(--c-danger)' : ''">
                      / 欠 {{ fmtMoney(project.debt_amount) }} 元
                    </span>
                    <span class="muted">（回款率 {{ project.payment_rate }}%）</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 回款计划 -->
            <div class="card" style="margin-bottom:12px">
              <div class="card-head">
                <div>
                  <div class="card-title">回款计划</div>
                  <div class="card-sub">保存计划会按设置里的提前天数自动生成待办</div>
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
                  <div class="card-sub">登记后自动重算欠款、回款率与毛利</div>
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
                  <div class="card-sub">采购成本 / 维护成本 / 差旅 / 其他；毛利 = 已收 − 这些成本</div>
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

            <!-- 历史项目（折叠只读） -->
            <div class="card">
              <div class="card-head" style="cursor:pointer" @click="historyOpen = !historyOpen">
                <div>
                  <div class="card-title">历史项目（{{ history.length }}）</div>
                  <div class="card-sub">已归档的旧项目只读保留，回款与成本记录仍在</div>
                </div>
                <div class="spacer"></div>
                <button class="icon-btn" @click.stop="historyOpen = !historyOpen">{{ historyOpen ? '▾' : '▸' }}</button>
              </div>
              <div v-show="historyOpen" class="card-body">
                <c-empty v-if="!history.length" icon="projects" title="没有历史项目" />
                <div v-else class="table-wrap">
                  <table class="data-table">
                    <thead>
                      <tr><th>项目名称</th><th style="width:110px">阶段</th><th style="width:90px">进度</th><th style="width:130px;text-align:right">合同额</th><th style="width:130px;text-align:right">已收</th><th style="width:90px">归档</th></tr>
                    </thead>
                    <tbody>
                      <tr v-for="h in history" :key="h.id">
                        <td>{{ h.name || '（未命名）' }}</td>
                        <td><span class="tag muted">{{ h.stage }}</span></td>
                        <td>{{ h.progress }}%</td>
                        <td class="num">{{ fmtMoney(h.contract_amount) }}</td>
                        <td class="num">{{ fmtMoney(h.received_amount) }}</td>
                        <td><span class="tag">只读</span></td>
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

        <!-- 项目档案 -->
        <c-project-edit v-model="projectOpen" :customer-id="id"
                        :customer-name="customer ? customer.name : ''"
                        :project="project" @saved="onProjectSaved" />

        <!-- 回款 -->
        <c-payment-drawer v-model="paymentOpen" :type="paymentType"
                          :project-id="project ? project.id : ''"
                          :project-name="project ? (project.name || '（未命名项目）') : ''"
                          :contract-amount="project ? project.contract_amount : 0"
                          :debt-amount="project ? project.debt_amount : 0"
                          :plans="plans"
                          :payment="paymentEditing" @saved="onPaymentSaved" />

        <!-- 成本登记 -->
        <c-cost-drawer v-model="costOpen" :customer-id="id"
                       :project-id="project ? project.id : ''"
                       :customer-name="customer ? customer.name : ''"
                       :cost="costEditing" @saved="onCostSaved" />

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
