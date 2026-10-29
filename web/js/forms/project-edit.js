/**
 * 项目抽屉（1.27 多项目版）
 *
 * 1.27 起一个客户可以同时有多个进行中项目：
 *   - 新增：从客户详情点「+ 新增项目」，带 customer_id 走 POST /api/projects
 *   - 编辑：传 project，走 PUT /api/projects/:id
 *   - 同一客户内、未归档项目的名称不能重复（后端 400 NAME_DUPLICATE，前端也先提示）
 *   - 历史项目（archived=1）只读，要改先「恢复归档」
 *
 * 用法：<c-project-edit v-model="open" :customer-id="id" :customer-name="name"
 *                       :project="project" :index="activeProjects.length + 1" @saved="onSaved" />
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
      customerName: String,
      /* 新增时是第几个进行中项目，只用于文案（1、2、3…） */
      index: { type: Number, default: 1 }
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
      title() { return this.isEdit ? '编辑项目' : '新增项目'; },
      sub() {
        const who = this.customerName ? '客户：' + this.customerName : '';
        if (this.isEdit) return who;
        return who ? `${who} · 第 ${Math.max(1, Number(this.index) || 1)} 个进行中项目` : '';
      }
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
        if (!String(this.form.name || '').trim()) e.name = '项目名称为必填项';
        const amt = Number(this.form.contract_amount);
        if (this.form.contract_amount !== '' && (!isFinite(amt) || amt < 0)) {
          e.contract_amount = '合同金额必须是不小于 0 的数字';
        }
        this.errors = e;
        if (Object.keys(e).length) {
          CRM.toast(e.name || '请检查合同金额', 'error');
          return false;
        }
        return true;
      },
      async save() {
        if (this.validate()) { /* 继续 */ } else return;
        if (!this.customerId) {
          CRM.toast('缺少客户，无法保存项目', 'error');
          return;
        }
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form);
          payload.name = String(payload.name || '').trim();
          payload.progress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
          if (payload.contract_amount === '') payload.contract_amount = 0;
          let r;
          if (this.isEdit) {
            payload.id = this.project.id;
            r = await CRM.api.saveProject(payload);
          } else {
            payload.customer_id = Number(this.customerId);
            r = await CRM.api.saveProject(payload);
          }
          CRM.toast(this.isEdit ? '项目已保存' : '项目已新增', 'success');
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
                @update:model-value="$emit('update:modelValue', false)">

        <div v-if="isArchived" class="note warn" style="margin-bottom:14px">
          <c-icon name="alert" :size="16" />
          <div style="font-size:var(--fs-sm)">这是历史项目，只读不能修改；如需修改请先在历史项目里「恢复归档」。</div>
        </div>

        <div class="form-block" style="margin-top:0;border:none">
          <div class="form-block-head open" style="cursor:default">
            <span>基本信息</span>
            <span class="count">同一客户内项目名不能重复</span>
          </div>
          <div class="form-block-body" style="border-top:none;padding-top:0">
            <div class="form-grid">
              <c-field v-model="form.name" label="项目名称" :span="2"
                       :hint="errors.name || '例如：塔河炼化 2026 年大修阀门采购项目'"
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
            一个客户可管理多个项目：各项目的回款、成本、待办互不影响；归档后仍可查看与恢复
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
