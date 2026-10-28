/**
 * 项目档案抽屉（1.23 改造）
 *
 * 原来叫「项目新增/编辑」，现在项目是客户的 1:1 档案：
 *   - 从客户详情打开，客户固定（不再选客户）
 *   - 保存走 PUT /api/customers/:id/project（已存在则更新，没有则新建）
 *   - 历史项目（archived=1）只读，不允许在这里编辑
 *
 * 用法：<c-project-edit v-model="open" :customer-id="id" :customer-name="name"
 *                       :project="project" @saved="onSaved" />
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const STAGE_ORDER = [
    '信息收集', '初步接洽', '技术交流', '方案选型', '询价报价', '投标/议价',
    '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项',
    '质保期内', '已暂停', '已终止'
  ];

  const BID_RESULTS = ['未投标', '已投标待开标', '已中标', '未中标', '已废标'];

  function emptyForm() {
    return {
      name: '', stage: '信息收集', progress: 0,
      contract_amount: '', signed_at: '', bid_date: '', bid_result: '',
      delivery_date: '', remark: ''
    };
  }

  const ProjectEdit = {
    name: 'ProjectEdit',
    props: {
      modelValue: Boolean,
      project: { type: Object, default: null },
      customerId: [String, Number],
      customerName: String
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        form: emptyForm(),
        saving: false,
        errors: {}
      };
    },
    computed: {
      isEdit() { return !!(this.project && this.project.id); },
      isArchived() { return !!(this.project && this.project.archived); },
      title() { return '项目档案'; },
      sub() { return this.customerName ? '客户：' + this.customerName : ''; }
    },
    watch: {
      modelValue(v) { if (v) this.reset(); },
      project() { if (this.modelValue) this.reset(); }
    },
    methods: {
      reset() {
        this.errors = {};
        if (this.project) {
          const f = emptyForm();
          for (const k of Object.keys(f)) {
            if (this.project[k] !== undefined && this.project[k] !== null) f[k] = this.project[k];
          }
          this.form = f;
        } else {
          this.form = emptyForm();
        }
      },
      validate() {
        const e = {};
        const amt = Number(this.form.contract_amount);
        if (this.form.contract_amount !== '' && (!isFinite(amt) || amt < 0)) {
          e.contract_amount = '合同金额必须是不小于 0 的数字';
        }
        this.errors = e;
        if (Object.keys(e).length) {
          CRM.toast('请检查合同金额', 'error');
          return false;
        }
        return true;
      },
      async save() {
        if (this.validate()) { /* 继续 */ } else return;
        if (!this.customerId) {
          CRM.toast('缺少客户，无法保存项目档案', 'error');
          return;
        }
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form);
          if (this.isEdit) payload.id = this.project.id;
          payload.progress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
          if (payload.contract_amount === '') payload.contract_amount = 0;
          const r = await CRM.api.saveCustomerProject(Number(this.customerId), payload);
          CRM.toast(r.created ? '项目档案已建立' : '项目档案已保存', 'success');
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      }
    },
    template: `
      <c-drawer :model-value="modelValue" :title="title" :sub="sub" width="720px"
                @update:model-value="$emit('update:modelValue', $event)">

        <div v-if="isArchived" class="note warn" style="margin-bottom:14px">
          <c-icon name="alert" :size="16" />
          <div style="font-size:var(--fs-sm)">这是历史项目，只读不能修改。</div>
        </div>

        <div class="form-block" style="margin-top:0;border:none">
          <div class="form-block-head open" style="cursor:default">
            <span>基本信息</span>
            <span class="count">名称可以留空，以后补</span>
          </div>
          <div class="form-block-body" style="border-top:none;padding-top:0">
            <div class="form-grid">
              <c-field v-model="form.name" label="项目名称" :span="2"
                       placeholder="例如：塔河炼化 2026 年大修阀门采购项目" />
              <c-select v-model="form.stage" label="项目阶段" :options="STAGE_ORDER" :allow-empty="false" />
              <c-field v-model="form.progress" label="进度（%）" type="number" hint="0 ~ 100" />
            </div>
          </div>
        </div>

        <div class="form-block">
          <div class="form-block-head open" style="cursor:default">
            <span>合同与投标</span>
            <span class="count">合同额用于算预计毛利与欠款</span>
          </div>
          <div class="form-block-body">
            <div class="form-grid">
              <c-field v-model="form.contract_amount" label="合同额（元）" type="number"
                       :hint="errors.contract_amount || '未签约填 0；已收/欠款由回款流水自动算'"
                       placeholder="例如：1860000" />
              <c-field v-model="form.signed_at" label="签约日期" type="date" />
              <c-field v-model="form.bid_date" label="投标日期" type="date" />
              <c-select v-model="form.bid_result" label="投标结果" :options="BID_RESULTS" />
              <c-field v-model="form.delivery_date" label="交货期" type="date" />
              <c-field v-model="form.remark" label="备注" type="textarea" :span="2" :rows="2" />
            </div>
          </div>
        </div>

        <template #footer>
          <span class="muted" style="font-size:var(--fs-xs)">
            一客户一项目：同一客户只有一条当前档案；换项目请先把当前项目「转为历史」
          </span>
          <div style="flex:1"></div>
          <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
          <button class="btn btn-primary" :disabled="saving || isArchived" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </c-drawer>`,
    setup() {
      return { STAGE_ORDER, BID_RESULTS };
    }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.ProjectEdit = ProjectEdit;

})(window.CRM);
