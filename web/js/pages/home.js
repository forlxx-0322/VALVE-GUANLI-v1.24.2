/**
 * 首页总览（v2 · 1.22 重做）
 *
 * 布局（一屏看完）：
 *   6 张指标卡   客户总数（本月新增）/ 待回访（逾期）/ 本月收入 / 本月利润 / 本月成本 / 应收未收
 *   回访提醒      逾期与 3 天内要联系的客户，可直接登记回访
 *   收入报表      按月 / 按年；收入、采购成本、维护成本、差旅、其他、利润、毛利率；可下钻明细
 *   环形图 ×2     客户地区分布 / 客户行业分布（每张都可切换成来源、标签）
 *   今日待办 + 最近动态
 *
 * 口径（与后端 services/stats.js 一致，界面上有问号说明）：
 *   收入 = 实收回款；成本 = 成本台账；利润 = 收入 − 采购 − 维护 − 差旅 − 其他
 * 地图模块已在 1.22 删除，这里用环形图看分布。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  const axisStyle = (C) => ({
    axisLine: { lineStyle: { color: C.axisLine } },
    axisLabel: { color: C.axisLabel, fontSize: 11 },
    splitLine: { lineStyle: { color: C.splitLine } }
  });
  const tooltipStyle = (C) => ({
    backgroundColor: C.tooltipBg,
    borderWidth: 0,
    textStyle: { color: C.tooltipText, fontSize: 12 }
  });

  const DIM_LABEL = { region: '地区', industry: '行业', source: '客户来源', tag: '标签' };

  const HomePage = {
    name: 'HomePage',
    data() {
      return {
        loading: true,
        error: '',
        d: null,
        month: new Date().toLocaleDateString('sv-SE').slice(0, 7),

        /* 收入报表 */
        incomeBy: 'month',
        incomeYear: new Date().getFullYear(),
        income: null,
        incomeLoading: false,

        /* 两张环形图的维度（可切换） */
        ringDim: ['region', 'industry'],
        ringData: [null, null],

        /* 收入明细抽屉 */
        detailOpen: false,
        detailTitle: '',
        detail: null,
        detailLoading: false,

        /* 回访登记抽屉 */
        followOpen: false,
        followCustomer: null
      };
    },

    computed: {
      cards() { return (this.d && this.d.cards) || {}; },
      followList() { return (this.d && this.d.follow_customers) || []; },
      todayTasks() { return (this.d && this.d.today_tasks) || []; },
      recentLogs() { return (this.d && this.d.recent_logs) || []; },
      cardItems() {
        const c = this.cards;
        return [
          { key: 'customers', label: `客户总数 · 本月新增 ${c.customer_new_this_month || 0}`, value: c.customer_total || 0, tone: '' },
          { key: 'follow', label: `待回访 · 逾期 ${c.follow_overdue || 0}`, value: c.follow_due || 0, tone: (c.follow_overdue || 0) > 0 ? 'warn' : '' },
          { key: 'income', label: '本月收入', value: this.money(c.month_income), tone: '' },
          { key: 'profit', label: '本月利润', value: this.money(c.month_profit), tone: (c.month_profit || 0) < 0 ? 'danger' : 'success' },
          { key: 'cost', label: '本月成本', value: this.money(c.month_cost), tone: '' },
          { key: 'receivable', label: '应收未收', value: this.money(c.receivable), tone: (c.receivable || 0) > 0 ? 'warn' : '' }
        ];
      },

      incomeOption() {
        if (!this.income) return {};
        const C = CRM.theme.colors();
        const isMonth = this.income.by === 'month';
        const rows = isMonth ? this.income.months : this.income.years;
        const labels = rows.map((r) => (isMonth ? r.month.slice(5) + ' 月' : r.year + ' 年'));
        const pick = (k) => rows.map((r) => r[k] || 0);
        const shortNum = this.shortNum;
        return {
          color: C.palette,
          tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v) => this.money(v) }, tooltipStyle(C)),
          legend: { data: ['收入', '采购成本', '维护成本', '差旅', '其他成本', '利润'], top: 0, textStyle: { fontSize: 11, color: C.axisLabel } },
          grid: { left: 10, right: 16, top: 34, bottom: 6, containLabel: true },
          xAxis: Object.assign({ type: 'category', data: labels }, axisStyle(C)),
          yAxis: Object.assign({ type: 'value', axisLabel: { color: C.axisLabel, fontSize: 11, formatter: (v) => shortNum(v) } }, axisStyle(C)),
          series: [
            { name: '收入', type: 'bar', barMaxWidth: 16, data: pick('income'), itemStyle: { borderRadius: [3, 3, 0, 0] } },
            { name: '采购成本', type: 'bar', stack: 'cost', barMaxWidth: 16, data: pick('purchase') },
            { name: '维护成本', type: 'bar', stack: 'cost', barMaxWidth: 16, data: pick('maintain') },
            { name: '差旅', type: 'bar', stack: 'cost', barMaxWidth: 16, data: pick('travel') },
            { name: '其他成本', type: 'bar', stack: 'cost', barMaxWidth: 16, data: pick('other') },
            { name: '利润', type: 'line', smooth: true, symbolSize: 6, data: pick('profit'), lineStyle: { width: 2 } }
          ]
        };
      },

      regionOption() { return this.ringOption(0); },
      industryOption() { return this.ringOption(1); }
    },

    methods: {
      fmtMoney: CRM.util.fmtMoney,
      fmtDate: CRM.util.fmtDate,
      money(v) { return CRM.util.fmtMoney(v); },
      shortNum(v) {
        const n = Number(v) || 0;
        if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + ' 万';
        return String(Math.round(n));
      },
      dimLabel(by) { return DIM_LABEL[by] || by; },

      ringOption(i) {
        const data = this.ringData[i];
        if (!data) return {};
        const C = CRM.theme.colors();
        return {
          color: C.palette,
          tooltip: Object.assign({ trigger: 'item', formatter: (p) => `${p.name}<br/>${p.value} 家（${p.percent}%）` }, tooltipStyle(C)),
          legend: { type: 'scroll', orient: 'vertical', right: 4, top: 'center', textStyle: { fontSize: 11, color: C.axisLabel } },
          series: [{
            type: 'pie',
            radius: ['46%', '70%'],
            center: ['38%', '52%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: 'transparent', borderWidth: 2 },
            label: { show: false },
            emphasis: { label: { show: true, fontSize: 12, fontWeight: 600 } },
            data: (data.groups || []).map((g) => ({ name: g.label, value: g.count }))
          }]
        };
      },

      async load() {
        this.loading = true;
        this.error = '';
        try {
          this.d = await CRM.api.dashboardV2({ month: this.month });
          this.ringData = [this.d.dist_region, this.d.dist_industry];
          await this.loadIncome();
        } catch (e) {
          this.error = e.message || '加载失败';
        } finally {
          this.loading = false;
        }
      },

      async loadIncome() {
        this.incomeLoading = true;
        try {
          this.income = await CRM.api.incomeReport(
            this.incomeBy === 'year' ? { by: 'year', span: 5 } : { by: 'month', year: this.incomeYear }
          );
        } catch (e) {
          CRM.toast(e.message || '加载收入报表失败', 'error');
        } finally {
          this.incomeLoading = false;
        }
      },

      switchIncomeBy(by) {
        if (this.incomeBy === by) return;
        this.incomeBy = by;
        this.loadIncome();
      },

      changeIncomeYear() { this.loadIncome(); },

      async switchRing(i) {
        try {
          const next = this.ringData.slice();
          next[i] = await CRM.api.distribution({ by: this.ringDim[i], top: 8 });
          this.ringData = next;
        } catch (e) {
          CRM.toast(e.message || '加载分布失败', 'error');
        }
      },

      async openDetail(range, title) {
        this.detailOpen = true;
        this.detailTitle = title;
        this.detailLoading = true;
        this.detail = null;
        try {
          const params = String(range).length === 4 ? { year: range } : { month: range };
          this.detail = await CRM.api.incomeDetail(params);
        } catch (e) {
          CRM.toast(e.message || '加载明细失败', 'error');
        } finally {
          this.detailLoading = false;
        }
      },

      openMonthDetail(row) {
        const range = row.month || String(row.year);
        this.openDetail(range, (row.month || row.year + ' 年') + ' 收入与成本明细');
      },

      openFollow(customer) {
        this.followCustomer = customer;
        this.followOpen = true;
      },

      async onFollowSaved() {
        this.followOpen = false;
        await this.load();
      },

      go(hash) { location.hash = hash; },
      goCustomer(id) { location.hash = '#/customers/' + id; }
    },

    async created() { await this.load(); },

    template: `
      <div>
        <c-page-header title="首页总览"
          desc="客户、回访、收入与分布一屏看完；利润 = 收入 − 采购成本 − 维护成本 − 差旅 − 其他。" />

        <div v-if="loading" class="card"><div class="card-body muted">正在汇总数据…</div></div>

        <div v-else-if="error" class="note danger">
          <c-icon name="alert" :size="16" />
          <div>
            <strong>{{ error }}</strong>
            <div class="mt-3"><button class="btn btn-sm" @click="load">重试</button></div>
          </div>
        </div>

        <template v-else-if="d">
          <!-- ============ 指标卡 ============ -->
          <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
            <div class="stat clickable" v-for="c in cardItems" :key="c.key"
                 @click="c.key === 'customers' ? go('#/customers') : null">
              <div class="n" :class="c.tone">{{ c.value }}</div>
              <div class="l">{{ c.label }}</div>
            </div>
          </div>

          <div class="grid-2" style="margin-bottom:14px">
            <!-- ============ 回访提醒 ============ -->
            <c-card title="回访提醒" :sub="'逾期 ' + (cards.follow_overdue || 0) + ' 家 · 今日及 3 天内 ' + followList.length + ' 家'" icon="clock">
              <c-empty v-if="!followList.length" icon="check" title="近期没有要回访的客户"
                       desc="在客户资料里填「下次回访」后会自动出现在这里。" />
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr><th>客户</th><th style="width:120px">下次回访</th><th style="width:96px">状态</th><th style="width:110px">操作</th></tr>
                  </thead>
                  <tbody>
                    <tr v-for="c in followList" :key="c.id">
                      <td>
                        <a href="javascript:void 0" @click="goCustomer(c.id)">{{ c.short_name || c.name }}</a>
                        <div class="muted" style="font-size:var(--fs-xxs,11px)">
                          {{ c.industry || '未填行业' }} · {{ c.primary_contact || '无联系人' }}
                        </div>
                      </td>
                      <td>{{ fmtDate(c.next_follow_at) }}</td>
                      <td>
                        <span class="tag" :class="c.days_left < 0 ? 'danger' : (c.days_left === 0 ? 'warning' : '')">
                          {{ c.days_left < 0 ? ('逾期 ' + (-c.days_left) + ' 天') : (c.days_left === 0 ? '今天' : (c.days_left + ' 天后')) }}
                        </span>
                      </td>
                      <td><button class="btn btn-sm" @click="openFollow(c)">登记回访</button></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </c-card>

            <!-- ============ 收入报表 ============ -->
            <c-card title="收入报表" sub="收入按实收日期归月；成本按发生日期归月" icon="chart">
              <template #head>
                <div style="display:flex;gap:6px;align-items:center">
                  <button class="btn btn-sm" :class="{ 'btn-primary': incomeBy === 'month' }"
                          @click="switchIncomeBy('month')">按月</button>
                  <button class="btn btn-sm" :class="{ 'btn-primary': incomeBy === 'year' }"
                          @click="switchIncomeBy('year')">按年</button>
                  <select v-if="incomeBy === 'month'" class="input input-sm" style="width:92px"
                          v-model.number="incomeYear" @change="changeIncomeYear">
                    <option v-for="y in 6" :key="y" :value="(new Date().getFullYear() - 6 + y)">{{ (new Date().getFullYear() - 6 + y) }}</option>
                  </select>
                </div>
              </template>

              <div v-if="incomeLoading" class="muted" style="padding:12px">加载中…</div>
              <template v-else-if="income">
                <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:8px">
                  <div class="stat"><div class="n">{{ money(income.totals.income) }}</div><div class="l">收入</div></div>
                  <div class="stat"><div class="n">{{ money(income.totals.cost) }}</div><div class="l">成本合计</div></div>
                  <div class="stat"><div class="n" :class="income.totals.profit < 0 ? 'danger' : 'success'">{{ money(income.totals.profit) }}</div><div class="l">利润</div></div>
                  <div class="stat"><div class="n">{{ income.totals.margin == null ? '—' : income.totals.margin + '%' }}</div><div class="l">毛利率</div></div>
                </div>
                <c-chart :option="incomeOption" height="240px" />
                <div class="table-wrap" style="max-height:190px;overflow:auto">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th style="width:80px">期间</th><th>收入</th><th>采购成本</th><th>维护成本</th>
                        <th>其他成本</th><th>利润</th><th style="width:70px">毛利率</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="r in (income.by === 'month' ? income.months : income.years)" :key="r.month || r.year">
                        <td><a href="javascript:void 0" @click="openMonthDetail(r)">{{ r.month ? r.month.slice(5) + ' 月' : r.year + ' 年' }}</a></td>
                        <td class="num">{{ money(r.income) }}</td>
                        <td class="num">{{ money(r.purchase) }}</td>
                        <td class="num">{{ money(r.maintain) }}</td>
                        <td class="num">{{ money(r.travel + r.other) }}</td>
                        <td class="num" :style="{ color: r.profit < 0 ? 'var(--c-danger)' : '' }">{{ money(r.profit) }}</td>
                        <td class="num">{{ r.margin == null ? '—' : r.margin + '%' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </c-card>
          </div>

          <!-- ============ 两张环形图 ============ -->
          <div class="grid-2" style="margin-bottom:14px">
            <c-card title="客户分布 · 地区" :sub="'按地州统计，共 ' + ((ringData[0] && ringData[0].total) || 0) + ' 家'" icon="chart">
              <template #head>
                <select class="input input-sm" style="width:110px" v-model="ringDim[0]" @change="switchRing(0)">
                  <option value="region">按地区</option>
                  <option value="industry">按行业</option>
                  <option value="source">按来源</option>
                  <option value="tag">按标签</option>
                </select>
              </template>
              <c-empty v-if="!ringData[0] || !ringData[0].groups.length" icon="customers"
                       title="还没有客户数据" desc="录入客户后这里会显示分布。" />
              <c-chart v-else :option="regionOption" height="270px" />
            </c-card>

            <c-card title="客户分布 · 行业" :sub="'按行业统计，共 ' + ((ringData[1] && ringData[1].total) || 0) + ' 家'" icon="chart">
              <template #head>
                <select class="input input-sm" style="width:110px" v-model="ringDim[1]" @change="switchRing(1)">
                  <option value="region">按地区</option>
                  <option value="industry">按行业</option>
                  <option value="source">按来源</option>
                  <option value="tag">按标签</option>
                </select>
              </template>
              <c-empty v-if="!ringData[1] || !ringData[1].groups.length" icon="customers"
                       title="还没有客户数据" desc="录入客户后这里会显示分布。" />
              <c-chart v-else :option="industryOption" height="270px" />
            </c-card>
          </div>

          <div class="grid-2">
            <!-- ============ 今日待办 ============ -->
            <c-card title="今日待办" :sub="'共 ' + todayTasks.length + ' 项待处理'" icon="tasks">
              <c-empty v-if="!todayTasks.length" icon="check" title="今日待办已清空" desc="很好，没有待处理事项。" />
              <div v-else>
                <div v-for="t in todayTasks" :key="t.id"
                     style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--c-border)">
                  <span class="tag" :class="t.priority === '高' ? 'danger' : (t.priority === '中' ? 'warning' : '')">{{ t.priority }}</span>
                  <div style="flex:1">
                    <div>{{ t.title }}</div>
                    <div class="muted" style="font-size:var(--fs-xs)">{{ t.customer_short || t.project_name || '' }} · {{ fmtDate(t.due_at, true) }}</div>
                  </div>
                  <a href="javascript:void 0" @click="go('#/tasks')" class="muted">去处理</a>
                </div>
              </div>
            </c-card>

            <!-- ============ 最近动态 ============ -->
            <c-card title="最近动态" sub="最近 10 条操作记录" icon="list">
              <c-empty v-if="!recentLogs.length" icon="list" title="还没有操作记录" />
              <div v-else>
                <div v-for="l in recentLogs" :key="l.id" style="padding:6px 0;border-bottom:1px solid var(--c-border)">
                  <div style="font-size:var(--fs-sm)">{{ l.summary }}</div>
                  <div class="muted" style="font-size:var(--fs-xs)">{{ fmtDate(l.created_at, true) }}</div>
                </div>
              </div>
            </c-card>
          </div>
        </template>

        <!-- 回访登记 -->
        <c-followup-drawer v-model="followOpen"
                           :customer-id="followCustomer ? followCustomer.id : ''"
                           :customer-name="followCustomer ? (followCustomer.short_name || followCustomer.name) : ''"
                           @saved="onFollowSaved" />

        <!-- 收入 / 成本明细 -->
        <c-drawer v-model="detailOpen" :title="detailTitle" sub="点期间可查这笔钱来自哪个客户、哪个项目" width="760px">
          <div v-if="detailLoading" class="muted">加载中…</div>
          <template v-else-if="detail">
            <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
              <div class="stat"><div class="n">{{ money(detail.totals.income) }}</div><div class="l">收入</div></div>
              <div class="stat"><div class="n">{{ money(detail.totals.cost) }}</div><div class="l">成本</div></div>
              <div class="stat"><div class="n" :class="detail.totals.profit < 0 ? 'danger' : 'success'">{{ money(detail.totals.profit) }}</div><div class="l">利润</div></div>
              <div class="stat"><div class="n">{{ detail.totals.margin == null ? '—' : detail.totals.margin + '%' }}</div><div class="l">毛利率</div></div>
            </div>

            <div class="field-label">收入（实收 {{ detail.incomes.length }} 笔）</div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th style="width:104px">日期</th><th>客户</th><th>项目</th><th style="width:120px">金额</th><th style="width:80px">方式</th></tr></thead>
                <tbody>
                  <tr v-for="r in detail.incomes" :key="'i' + r.id">
                    <td>{{ r.date }}</td>
                    <td>{{ r.customer_name || '—' }}</td>
                    <td>{{ r.project_name || '—' }}</td>
                    <td class="num">{{ money(r.amount) }}</td>
                    <td>{{ r.method || '—' }}</td>
                  </tr>
                  <tr v-if="!detail.incomes.length"><td colspan="5" class="muted">该期间没有收入</td></tr>
                </tbody>
              </table>
            </div>

            <div class="field-label mt-3">成本（{{ detail.costs.length }} 笔）</div>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th style="width:104px">日期</th><th style="width:96px">分类</th><th>客户</th><th>供应商 / 备注</th><th style="width:120px">金额</th></tr></thead>
                <tbody>
                  <tr v-for="r in detail.costs" :key="'c' + r.id">
                    <td>{{ r.date }}</td>
                    <td><span class="tag">{{ r.category }}</span></td>
                    <td>{{ r.customer_name || '—' }}</td>
                    <td>{{ r.supplier || r.remark || '—' }}</td>
                    <td class="num">{{ money(r.amount) }}</td>
                  </tr>
                  <tr v-if="!detail.costs.length"><td colspan="5" class="muted">该期间没有成本记录</td></tr>
                </tbody>
              </table>
            </div>
          </template>
          <template #footer>
            <button class="btn" @click="detailOpen = false">关闭</button>
          </template>
        </c-drawer>
      </div>`
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.home = HomePage;

})(window.CRM);
