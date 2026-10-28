/**
 * 成本登记抽屉（1.22 新增）
 *
 * 用途：登记采购成本 / 维护成本 / 差旅 / 其他，供首页"收入报表"算利润。
 * 用法：<c-cost-drawer v-model="open" :customer-id="id" :customer-name="name" :cost="editing" @saved="onSaved" />
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  const today = () => new Date().toLocaleDateString('sv-SE');

  const CostDrawer = {
    name: 'CostDrawer',
    props: {
      modelValue: Boolean,
      customerId: [Number, String],
      customerName: String,
      projectId: [Number, String],
      cost: { type: Object, default: null }
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        saving: false,
        form: {
          id: null,
          customer_id: '',
          project_id: '',
          category: '采购成本',
          amount: '',
          spent_at: today(),
          supplier: '',
          remark: ''
        },
        categories: ['采购成本', '维护成本', '差旅', '其他']
      };
    },
    computed: {
      isEdit() { return !!this.form.id; },
      title() { return this.isEdit ? '编辑成本' : '登记成本'; }
    },
    watch: {
      modelValue(v) { if (v) this.reset(); },
      cost() { if (this.modelValue) this.reset(); }
    },
    methods: {
      reset() {
        const c = this.cost || {};
        this.form = {
          id: c.id || null,
          customer_id: c.customer_id || this.customerId || '',
          project_id: c.project_id || this.projectId || '',
          category: c.category || '采购成本',
          amount: c.amount === undefined || c.amount === null ? '' : c.amount,
          spent_at: (c.spent_at || today()).slice(0, 10),
          supplier: c.supplier || '',
          remark: c.remark || ''
        };
      },
      async save() {
        if (this.form.amount === '' || Number(this.form.amount) < 0) {
          CRM.toast('请填写不小于 0 的金额', 'error');
          return;
        }
        if (!this.form.customer_id && !this.form.project_id) {
          CRM.toast('请至少关联一个客户或项目', 'error');
          return;
        }
        this.saving = true;
        try {
          const r = await CRM.api.saveCost(Object.assign({}, this.form));
          CRM.toast(this.isEdit ? '成本已保存' : '成本已登记', 'success');
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
      <c-drawer :model-value="modelValue" :title="title"
                :sub="customerName ? ('客户：' + customerName) : '成本会用于首页利润报表'"
                width="560px"
                @update:model-value="$emit('update:modelValue', $event)">
        <div class="form-grid">
          <div class="field">
            <label class="field-label">成本分类</label>
            <select class="input" v-model="form.category">
              <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
            </select>
            <div class="field-hint">利润 = 收入 − 采购成本 − 维护成本 − 差旅 − 其他</div>
          </div>
          <div class="field">
            <label class="field-label">金额（元）</label>
            <input class="input" type="number" min="0" step="any" v-model="form.amount" placeholder="0.00" />
          </div>
          <div class="field">
            <label class="field-label">发生日期</label>
            <input class="input" type="date" v-model="form.spent_at" />
          </div>
          <div class="field">
            <label class="field-label">供应商（采购成本时填）</label>
            <input class="input" v-model="form.supplier" placeholder="可留空" />
          </div>
          <div class="field" style="grid-column:span 2">
            <label class="field-label">备注</label>
            <input class="input" v-model="form.remark" placeholder="例如：DN200 蝶阀 10 台采购款" />
          </div>
        </div>
        <template #footer>
          <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
          <div style="flex:1"></div>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </c-drawer>`
  };

  CRM.costDrawer = { CostDrawer };
  CRM.registerCostComponent = function (app) {
    app.component('c-cost-drawer', CostDrawer);
  };

})(window.CRM);
