/**
 * 客户新增 / 编辑抽屉（1.23 精简版）
 * 4 个区块一屏放下：资料 / 地址 / 主联系人 / 回访与备注。
 * 项目档案与财务不在这里，改在客户详情「项目与财务」标签页维护。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { BLOCKS } = CRM.customerForm;

  function emptyForm() {
    const f = {};
    for (const b of BLOCKS) {
      for (const fd of b.fields) {
        if (fd.key === 'tag_ids') f.tag_ids = [];
        else if (fd.type === 'switch') f[fd.key] = 0;
        else if (fd.type === 'number') f[fd.key] = '';
        else f[fd.key] = '';
      }
    }
    return f;
  }

  const CustomerEdit = {
    name: 'CustomerEdit',
    props: {
      modelValue: Boolean,
      customer: { type: Object, default: null }   // 为空表示新增
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        blocks: BLOCKS,
        open: ['profile', 'address', 'contact', 'follow'],
        form: emptyForm(),
        saving: false,
        errors: {},
        duplicates: [],
        showDup: false,
        /* 行政区划清单（用于「归属地州」下拉） */
        regions: { cities: [], districts: [] }
      };
    },
    computed: {
      isEdit() { return !!(this.customer && this.customer.id); },
      title() { return this.isEdit ? '编辑客户' : '新增客户'; },
      dialogWidth() { return '820px'; },
      /* 「归属地州」下拉显示地州名，字段里存地州编码 */
      regionOptions() {
        return (this.regions.cities || []).map((c) => ({ value: c.code, label: c.name }));
      }
    },
    watch: {
      modelValue(v) { if (v) { this.reset(); this.loadRegions(); } },
      customer() { if (this.modelValue) this.reset(); }
    },
    methods: {
      reset() {
        this.errors = {};
        this.duplicates = [];
        this.showDup = false;
        this.open = ['profile', 'address', 'contact', 'follow'];
        if (this.customer) {
          const f = emptyForm();
          for (const k of Object.keys(f)) {
            if (this.customer[k] !== undefined && this.customer[k] !== null) f[k] = this.customer[k];
          }
          f.tag_ids = (this.customer.tags || []).map((t) => t.id);
          this.form = f;
        } else {
          this.form = emptyForm();
        }
      },
      toggle(key) {
        const i = this.open.indexOf(key);
        if (i >= 0) this.open.splice(i, 1); else this.open.push(key);
      },
      isOpen(key) { return this.open.includes(key); },
      blockFilledCount(b) {
        return b.fields.filter((fd) => {
          const v = this.form[fd.key];
          if (fd.key === 'tag_ids') return Array.isArray(v) && v.length > 0;
          return v !== '' && v !== null && v !== undefined && v !== 0;
        }).length;
      },
      validate() {
        const e = {};
        if (!String(this.form.name || '').trim()) e.name = '公司名称必填';
        this.errors = e;
        if (Object.keys(e).length) {
          CRM.toast('请先填写公司名称', 'error');
          return false;
        }
        return true;
      },
      onDictAdded(result, category) {
        CRM.api.applyDictAdded(result, category);
      },

      async loadRegions() {
        if (this.regions.cities.length) return;
        try {
          const r = await CRM.api.regions();
          this.regions = { cities: r.cities || [], districts: r.districts || [] };
        } catch (_) { /* 行政区划未就绪时忽略，不影响客户编辑 */ }
      },
      async save(ignoreDuplicate) {
        if (!this.validate()) return;
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form);
          if (this.isEdit) payload.id = this.customer.id;
          const r = await CRM.api.saveCustomer(payload);

          /* 查重提示：仅在未忽略时弹出 */
          if (!ignoreDuplicate && r.duplicates && r.duplicates.length) {
            this.duplicates = r.duplicates;
            this.showDup = true;
            this.saving = false;
            return;
          }

          CRM.toast(r.created ? '客户已创建' : '客户已保存', 'success');
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      },
      async confirmDuplicate() {
        this.showDup = false;
        await this.save(true);
      },
      closeDup() { this.showDup = false; },
      goDuplicate(id) {
        this.$emit('update:modelValue', false);
        CRM.router.navigate(`/customers/${id}`);
      }
    },
    template: `
      <c-drawer :model-value="modelValue" :title="title"
                :sub="isEdit ? '修改后立即生效，变更会记入操作日志' : '只有公司名称必填，其余可后续补全（项目与财务在客户详情里维护）'"
                :width="dialogWidth"
                @update:model-value="$emit('update:modelValue', $event)">

        <c-empty v-if="showDup" icon="alert" title="发现可能重复的客户"
                 desc="以下客户与本次录入的名称或主联系人手机相同，请确认是否继续创建。" />

        <template v-if="showDup">
          <div v-for="d in duplicates" :key="d.id" class="mini-card mt-3">
            <div class="nm">
              {{ d.name }}
              <span class="tag muted">{{ d.match === 'name' ? '同名' : '同手机' }}</span>
            </div>
            <div class="rows">
              <div>编号：{{ d.customer_no || '—' }}</div>
              <div>联系人：{{ d.contact_name || '—' }}{{ d.contact_phone ? ' · ' + d.contact_phone : '' }}</div>
            </div>
            <div class="mt-3">
              <button class="btn btn-sm" @click="goDuplicate(d.id)">查看这条记录</button>
            </div>
          </div>
        </template>

        <div v-if="!showDup">
          <div v-for="b in blocks" :key="b.key" class="form-block"
               :style="b.key === 'profile' ? 'margin-top:0;border:none' : ''">
            <div class="form-block-head open" style="cursor:default">
              <span>{{ b.title }}</span>
              <span class="count">{{ b.desc }}</span>
            </div>

            <div class="form-block-body" :style="b.key === 'profile' ? 'border-top:none;padding-top:0' : ''">
              <div class="form-grid">
                <template v-for="fd in b.fields" :key="fd.key">
                  <!-- 标签 -->
                  <c-tag-picker v-if="fd.type === 'tags'"
                                v-model="form[fd.key]" :label="fd.label" :span="fd.span" />

                  <!-- 归属地州（存地州编码，显示地州名） -->
                  <c-select v-else-if="fd.type === 'region'"
                            v-model="form[fd.key]" :label="fd.label"
                            :options="regionOptions"
                            :span="fd.span" :hint="fd.hint" empty-text="（按地址自动匹配）" />

                  <!-- 单选 -->
                  <c-select v-else-if="fd.type === 'select'"
                            v-model="form[fd.key]" :label="fd.label"
                            :options="fd.options || api.options(fd.category)"
                            :category="fd.category" :allow-add="fd.allowAdd"
                            :required="fd.required" :span="fd.span" :hint="fd.hint"
                            @added="onDictAdded($event, fd.category)" />

                  <!-- 开关 -->
                  <c-switch v-else-if="fd.type === 'switch'"
                            v-model="form[fd.key]" :label="fd.label"
                            :span="fd.span" :hint="fd.hint" />

                  <!-- 文本 / 数字 / 日期 -->
                  <c-field v-else
                           v-model="form[fd.key]" :label="fd.label"
                           :type="fd.type" :placeholder="fd.placeholder"
                           :required="fd.required" :hint="errors[fd.key] || fd.hint"
                           :span="fd.span" :rows="fd.rows" />

                </template>
              </div>
            </div>
          </div>
        </div>

        <template #footer>
          <template v-if="showDup">
            <button class="btn" @click="closeDup">返回修改</button>
            <div style="flex:1"></div>
            <button class="btn btn-primary" :disabled="saving" @click="confirmDuplicate">
              确认不是同一家，继续创建
            </button>
          </template>
          <template v-else>
            <span class="muted" style="font-size:var(--fs-xs)">
              {{ isEdit ? '客户 ID：' + customer.id : '保存后可在详情页继续登记回访、项目与财务' }}
            </span>
            <div style="flex:1"></div>
            <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save(false)">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </template>
        </template>

      </c-drawer>`,
    setup() {
      return { api: CRM.api };
    }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.CustomerEdit = CustomerEdit;

})(window.CRM);
