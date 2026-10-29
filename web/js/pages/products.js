/**
 * 产品价目表（1.24 新增；1.24.2 起分类三级）
 *
 * 左侧：分类树（展开/收起、产品数含子分类、选中过滤；新增子分类 / 改名 / 上移下移 / 删除）
 *       一级＝阀门大类（is_system=1）的删除按钮禁用并给出说明；
 *       二级（按结构）、三级（按连接/法兰安装方式）及以下都是自定义分类，可删可改，
 *       树按 depth 递归渲染，三级节点同样带全套操作按钮。
 * 右侧：搜索 + 材质/压力/状态筛选 + 新增产品 + 导出 Excel + 产品表格 + 分页。
 * 产品新增/编辑走 c-drawer，折后价实时计算。
 * 导出用前端 SheetJS（web/vendor/xlsx.full.min.js），文件名 产品价目表-YYYYMMDD.xlsx。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const CAT_INDENT = 14;

  /** 周数保留一位小数；数据库 lead_time_weeks 为准，界面不再从天数反算 */
  const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const fmtWeeks = (weeks) => {
    const w = Number(weeks) || 0;
    return Number.isInteger(w) ? String(w) : w.toFixed(1);
  };

  const columns = [
    { key: 'name', label: '名称', width: '230px' },
    { key: 'code', label: '编号', width: '112px' },
    { key: 'body_material', label: '材质', width: '120px' },
    { key: 'pressure_rating', label: '压力', width: '90px' },
    { key: 'price', label: '单价', width: '96px', align: 'right' },
    { key: 'lead_time_weeks', label: '货期(周)', width: '84px', align: 'right' },
    { key: 'discount', label: '折扣', width: '72px', align: 'right' },
    { key: 'net_price', label: '折后价', width: '102px', align: 'right' },
    { key: 'ops', label: '操作', width: '168px', align: 'right' }
  ];

  function emptyForm() {
    return {
      id: null,
      category_id: '',
      name: '',
      code: '',
      unit: '台',
      price: '',
      lead_time_weeks: '',
      body_material: '',
      pressure_rating: '',
      discount: '',
      remark: '',
      enabled: 1
    };
  }

  /** 把嵌套树摊平成带 depth 的数组（select 选项与树渲染共用） */
  function flatten(nodes, depth, out, collapsed) {
    for (const n of nodes || []) {
      out.push(Object.assign({}, n, { depth }));
      const closed = collapsed && collapsed[n.id];
      if (!closed) flatten(n.children || [], depth + 1, out, collapsed);
    }
    return out;
  }

  const ProductsPage = {
    name: 'ProductsPage',
    data() {
      return {
        columns,
        tree: [],
        collapsed: {},
        selectedCatId: null,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 20,
        pages: 1,
        loading: false,
        query: { keyword: '', body_material: '', pressure_rating: '', enabled: '' },
        drawerOpen: false,
        form: emptyForm(),
        saving: false,
        catBusy: false,

        /* 批量导入（1.26） */
        importOpen: false,
        impStep: 1,                 // 1 选文件 → 2 预览 → 3 完成
        impFileName: '',
        impParsing: false,
        impDragOver: false,
        impRows: [],
        impPreview: null,
        impReport: null,
        impImporting: false,
        impMode: 'skip',
        impAutoCreate: true,
        tplBusy: false
      };
    },
    computed: {
      /** 全部节点（不受折叠影响）：用于分类下拉与查找 */
      allCats() {
        return flatten(this.tree, 0, [], null);
      },
      /** 树里当前可见的节点（折叠的分支不展开） */
      visibleCats() {
        return flatten(this.tree, 0, [], this.collapsed);
      },
      selectedCat() {
        return this.allCats.find((c) => Number(c.id) === Number(this.selectedCatId)) || null;
      },
      /** 「全部产品」计数 = 各一级分类的合计（已含子孙分类） */
      allCount() {
        return this.tree.reduce((s, n) => s + (Number(n.product_count) || 0), 0);
      },
      catOptions() {
        return this.allCats.map((c) => ({
          value: c.id,
          label: '　'.repeat(c.depth) + (c.depth ? '└ ' : '') + c.name
        }));
      },
      /** 产品表单里的折后价（与服务端 round2 口径一致） */
      formNetPrice() {
        const p = Number(this.form.price) || 0;
        const d = Number(this.form.discount) || 0;
        return Math.round(p * (1 - d / 100) * 100) / 100;
      },
      title() {
        return this.selectedCat ? this.selectedCat.name : '全部产品';
      },
      subTitle() {
        if (!this.selectedCat) return `共 ${this.allCount} 个产品，按分类看更清楚`;
        return `${this.selectedCat.product_count} 个产品（含子分类）`;
      },
      /** 导入预览里有问题的行 */
      impErrors() {
        const rows = (this.impPreview && this.impPreview.rows) || [];
        return rows.filter((r) => r.errors && r.errors.length);
      },
      /** 预览行里的提示（重名跳过/更新、分类将自动创建等） */
      impWarnings() {
        const rows = (this.impPreview && this.impPreview.rows) || [];
        return rows.filter((r) => !(r.errors && r.errors.length) && (r.warnings || []).length);
      }
    },
    methods: {
      fmtMoney: CRM.util.fmtMoney,
      orDash: CRM.util.orDash,
      fmtWeeks,

      /* ---------------- 数据加载 ---------------- */
      async loadTree() {
        try {
          this.tree = await CRM.api.productCategories({ tree: 1 });
          if (this.selectedCatId && !this.allCats.some((c) => Number(c.id) === Number(this.selectedCatId))) {
            this.selectedCatId = null;
          }
        } catch (e) {
          CRM.toast(e.message || '加载分类树失败', 'error');
        }
      },

      queryParams() {
        const p = {
          keyword: this.query.keyword,
          body_material: this.query.body_material,
          pressure_rating: this.query.pressure_rating,
          enabled: this.query.enabled
        };
        if (this.selectedCatId) p.category_id = this.selectedCatId;
        return p;
      },

      async load() {
        this.loading = true;
        try {
          const d = await CRM.api.listProducts(Object.assign(this.queryParams(), {
            page: this.page, pageSize: this.pageSize
          }));
          this.rows = d.list;
          this.total = d.total;
          this.pages = d.pages;
        } catch (e) {
          CRM.toast(e.message || '加载产品失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      reload() { this.page = 1; this.load(); },
      onPage(p) { this.page = p; this.load(); },
      onPageSize(n) { this.pageSize = n; this.page = 1; this.load(); },

      selectCat(node) {
        this.selectedCatId = node ? node.id : null;
        this.reload();
      },

      toggleNode(node) {
        if (this.collapsed[node.id]) delete this.collapsed[node.id];
        else this.collapsed[node.id] = true;
      },

      isCollapsed(node) { return !!this.collapsed[node.id]; },

      catPad(node) {
        return 6 + node.depth * CAT_INDENT;
      },

      deleteTitle(node) {
        if (node.is_system) return '一级分类不可删除（可改名、可调整排序）；二级及以下分类可自由删除';
        if ((node.children || []).length) return '该分类下还有子分类，删除会被拒绝';
        if (node.product_count) return '该分类下还有产品，删除会被拒绝（先移走或删除产品）';
        return '删除分类';
      },

      /* ---------------- 分类操作 ---------------- */
      async addRoot() {
        const name = await CRM.prompt({
          title: '新增一级分类', label: '分类名称', placeholder: '例如：闸阀 / 截止阀 / 疏水阀'
        });
        if (!name) return;
        await this.saveCategory({ name });
      },

      async addChild(node) {
        const name = await CRM.prompt({
          title: '新增子分类', label: `在「${node.name}」下新增`, placeholder: '例如：对夹 / 法兰 / 支耳'
        });
        if (!name) return;
        await this.saveCategory({ name, parent_id: node.id });
      },

      async renameNode(node) {
        const name = await CRM.prompt({
          title: '分类改名', label: '新的分类名称', value: node.name
        });
        if (!name || name === node.name) return;
        await this.saveCategory({ id: node.id, name });
      },

      async saveCategory(payload) {
        this.catBusy = true;
        try {
          await CRM.api.saveProductCategory(payload);
          CRM.toast(payload.id ? '分类已改名' : '分类已新增', 'success');
          await this.loadTree();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        } finally {
          this.catBusy = false;
        }
      },

      async moveNode(node, dir) {
        this.catBusy = true;
        try {
          const r = await CRM.api.moveProductCategory(node.id, dir);
          if (!r.moved) CRM.toast(r.message || '已到边界', 'warn');
          else CRM.toast(dir === 'up' ? '已上移' : '已下移', 'success');
          await this.loadTree();
        } catch (e) {
          CRM.toast(e.message || '移动失败', 'error');
        } finally {
          this.catBusy = false;
        }
      },

      async removeNode(node) {
        if (node.is_system) {
          CRM.toast('一级分类不可删除（可改名、可调整排序）；二级及以下分类可自由删除', 'warn');
          return;
        }
        const ok = await CRM.confirm({
          title: '删除分类',
          message: `确定删除分类 <strong>${node.name}</strong> 吗？<br>分类下还有产品或子分类时会被拒绝。`,
          danger: true
        });
        if (!ok) return;
        this.catBusy = true;
        try {
          await CRM.api.deleteProductCategory(node.id);
          CRM.toast('分类已删除', 'success');
          if (Number(this.selectedCatId) === Number(node.id)) this.selectedCatId = null;
          await this.loadTree();
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        } finally {
          this.catBusy = false;
        }
      },

      /* ---------------- 产品操作 ---------------- */
      openCreate() {
        this.form = emptyForm();
        if (this.selectedCatId) this.form.category_id = this.selectedCatId;
        this.drawerOpen = true;
      },

      async openEdit(row) {
        try {
          const full = await CRM.api.getProduct(row.id);
          this.fillForm(full);
        } catch (e) {
          CRM.toast(e.message || '读取产品失败', 'error');
          this.fillForm(row);
        }
        this.drawerOpen = true;
      },

      fillForm(src) {
        const f = emptyForm();
        f.id = src.id || null;
        f.category_id = src.category_id || '';
        f.name = src.name || '';
        f.code = src.code || '';
        f.unit = src.unit || '台';
        f.price = src.price === null || src.price === undefined ? '' : src.price;
        /* 1.26.1 起以 lead_time_weeks 为准；旧接口只有天数时兜底换算 */
        const weeks = src.lead_time_weeks !== undefined && src.lead_time_weeks !== null
          ? round1(src.lead_time_weeks)
          : round1((Number(src.lead_time_days) || 0) / 7);
        f.lead_time_weeks = weeks === 0 ? '' : weeks;
        f.body_material = src.body_material || '';
        f.pressure_rating = src.pressure_rating || '';
        f.discount = src.discount === null || src.discount === undefined ? '' : src.discount;
        f.remark = src.remark || '';
        f.enabled = Number(src.enabled) === 1 ? 1 : 0;
        this.form = f;
      },

      onDictAdded(result, category) {
        CRM.api.applyDictAdded(result, category);
      },

      async save() {
        const name = String(this.form.name || '').trim();
        if (!name) { CRM.toast('请填写产品名称', 'error'); return; }
        if (!this.form.category_id) { CRM.toast('请选择产品分类', 'error'); return; }

        /* 货期按周录入并原样提交（后端同时换算天数）；最多一位小数 */
        let leadWeeks = 0;
        if (this.form.lead_time_weeks !== '' && this.form.lead_time_weeks !== null) {
          leadWeeks = Number(this.form.lead_time_weeks);
          if (!Number.isFinite(leadWeeks) || leadWeeks < 0) {
            CRM.toast('货期(周)必须是不小于 0 的数字', 'error');
            return;
          }
          if (leadWeeks > 520) {
            CRM.toast('货期(周)不能超过 520 周', 'error');
            return;
          }
          if (Math.abs(Math.round(leadWeeks * 10) - leadWeeks * 10) > 1e-9) {
            CRM.toast('货期(周)最多保留一位小数', 'error');
            return;
          }
        }

        this.saving = true;
        try {
          const payload = {
            category_id: Number(this.form.category_id),
            name,
            code: this.form.code,
            unit: this.form.unit || '台',
            price: this.form.price === '' ? 0 : Number(this.form.price),
            lead_time_weeks: leadWeeks,
            body_material: this.form.body_material,
            pressure_rating: this.form.pressure_rating,
            discount: this.form.discount === '' ? 0 : Number(this.form.discount),
            remark: this.form.remark,
            enabled: this.form.enabled ? 1 : 0
          };
          if (this.form.id) payload.id = this.form.id;
          await CRM.api.saveProduct(payload);
          CRM.toast(this.form.id ? '产品已保存' : '产品已新增', 'success');
          this.drawerOpen = false;
          await this.loadTree();
          this.load();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      },

      async copy(row) {
        try {
          const r = await CRM.api.copyProduct(row.id);
          CRM.toast(`已复制为「${r.name}」`, 'success');
          await this.loadTree();
          this.load();
        } catch (e) {
          CRM.toast(e.message || '复制失败', 'error');
        }
      },

      async remove(row) {
        const ok = await CRM.confirm({
          title: '删除产品',
          message: `确定删除 <strong>${row.name}</strong> 吗？<br>删除后不再出现在价目表中（数据仍在库里）。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteProduct(row.id);
          CRM.toast('产品已删除', 'success');
          await this.loadTree();
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------------- 批量导入（1.26） ---------------- */
      openImport() {
        this.importOpen = true;
        this.resetImport();
        this.impMode = 'skip';
        this.impAutoCreate = true;
      },

      closeImport() {
        /* 实际导入时 doImport 已刷新过分类树与列表，这里只负责关闭 */
        this.importOpen = false;
      },

      resetImport() {
        this.impStep = 1;
        this.impFileName = '';
        this.impRows = [];
        this.impPreview = null;
        this.impReport = null;
      },

      async refreshAfterImport() {
        await this.loadTree();
        await this.load();
      },

      async downloadImportTemplate() {
        this.tplBusy = true;
        try {
          await CRM.importXlsx.downloadTemplate('product');
          CRM.toast('产品导入模板已下载（含填写说明与分类路径参考）', 'success', 4000);
        } catch (e) {
          CRM.toast(e.message || '下载模板失败', 'error');
        } finally {
          this.tplBusy = false;
        }
      },

      onImportFile(e) {
        const f = e.target.files && e.target.files[0];
        if (f) this.handleImportFile(f);
        e.target.value = '';
      },

      onImportDrop(e) {
        this.impDragOver = false;
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleImportFile(f);
      },

      async handleImportFile(file) {
        this.impParsing = true;
        this.impFileName = (file && file.name) || '';
        this.impReport = null;
        try {
          const r = await CRM.importXlsx.parseFile('product', file, {
            duplicateMode: this.impMode,
            autoCreateCategories: this.impAutoCreate
          });
          if (!r.ok) { CRM.toast(r.message, 'error', 6000); return; }
          this.impRows = r.rows;
          this.impPreview = r.preview;
          this.impStep = 2;
          CRM.toast(`已解析 ${r.preview.total} 行：可导入 ${r.preview.valid} 行，有问题 ${r.preview.invalid} 行`,
            'success', 4000);
        } catch (e) {
          CRM.toast('解析文件失败：' + (e.message || ''), 'error');
        } finally {
          this.impParsing = false;
        }
      },

      /** 切换「自动创建分类」或重复处理方式后重新预校验（不写库） */
      async refreshPreview() {
        if (!this.impRows.length) return;
        try {
          this.impPreview = await CRM.api.previewImport('product', this.impRows, {
            duplicateMode: this.impMode,
            autoCreateCategories: this.impAutoCreate
          });
        } catch (e) {
          CRM.toast(e.message || '重新校验失败', 'error');
        }
      },

      async doImport() {
        if (!this.impPreview || !this.impRows.length) return;
        this.impImporting = true;
        try {
          const rep = await CRM.importXlsx.run('product', this.impPreview, {
            duplicate_mode: this.impMode,
            auto_create_categories: this.impAutoCreate
          }, this.impRows);
          this.impReport = rep;
          this.impStep = 3;
          CRM.toast(`导入完成：新增 ${rep.imported} 个，更新 ${rep.updated} 个`
            + (rep.categoriesCreated ? `，新建分类 ${rep.categoriesCreated} 个` : ''), 'success', 5000);
          await this.refreshAfterImport();
        } catch (e) {
          CRM.toast(e.message || '导入失败', 'error');
        } finally {
          this.impImporting = false;
        }
      },

      /* ---------------- 导出 Excel ---------------- */
      async exportExcel() {
        try {
          const XLSX = window.XLSX;
          if (!XLSX) { CRM.toast('Excel 组件未加载', 'error'); return; }
          const rows = await CRM.api.productsExport(this.queryParams());
          if (!rows.length) { CRM.toast('当前筛选没有可导出的产品', 'warn'); return; }

          const header = ['分类', '名称', '编号', '单位', '单价(元)', '货期(周)', '材质', '压力等级',
            '折扣(%)', '折后价(元)', '备注', '启用'];
          const aoa = [header];
          for (const r of rows) {
            aoa.push([
              r.category_path, r.name, r.code, r.unit, r.price, fmtWeeks(r.lead_time_weeks),
              r.body_material, r.pressure_rating, r.discount, r.net_price, r.remark,
              r.enabled ? '是' : '否'
            ]);
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          ws['!cols'] = [
            { wch: 22 }, { wch: 26 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 9 },
            { wch: 14 }, { wch: 10 }, { wch: 9 }, { wch: 10 }, { wch: 26 }, { wch: 7 }
          ];
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, '产品价目表');

          const d = new Date();
          const p = (n) => String(n).padStart(2, '0');
          const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
          XLSX.writeFile(wb, `产品价目表-${stamp}.xlsx`);
          CRM.toast(`已导出 ${rows.length} 个产品`, 'success');
        } catch (e) {
          CRM.toast(e.message || '导出失败', 'error');
        }
      }
    },
    async created() {
      await CRM.api.loadDict();
      await this.loadTree();
      this.load();
    },
    template: `
      <div>
        <c-page-header title="产品价目表"
          desc="分类树 + 产品价：单价 / 货期(周) / 材质 / 压力等级 / 设定折扣，折后价自动算；支持 Excel 批量导入与导出。" />

        <div class="prod-layout">
          <!-- ================= 左侧：分类树 ================= -->
          <section class="card prod-tree">
            <div class="card-head">
              <c-icon name="folder" :size="17" style="color:var(--c-text-3)" />
              <div>
                <div class="card-title">产品分类</div>
                <div class="card-sub">一级分类固定（可改名）；二级按结构、三级按连接方式，均可自定义、可删除</div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm" title="新增一级分类" :disabled="catBusy" @click="addRoot">
                <c-icon name="plus" :size="13" />
              </button>
            </div>

            <div class="card-body prod-tree-body">
              <div class="prod-cat" :class="{ active: !selectedCatId }" @click="selectCat(null)">
                <span class="prod-cat-toggle">◈</span>
                <span class="prod-cat-name">全部产品</span>
                <span class="prod-cat-count">{{ allCount }}</span>
              </div>

              <div v-for="node in visibleCats" :key="node.id"
                   class="prod-cat" :class="{ active: Number(selectedCatId) === Number(node.id) }"
                   :style="{ paddingLeft: catPad(node) + 'px' }"
                   @click="selectCat(node)">
                <button v-if="node.children && node.children.length" type="button"
                        class="prod-cat-toggle" :title="isCollapsed(node) ? '展开' : '收起'"
                        @click.stop="toggleNode(node)">{{ isCollapsed(node) ? '▸' : '▾' }}</button>
                <span v-else class="prod-cat-toggle">·</span>

                <span class="prod-cat-name" :title="node.name">{{ node.name }}</span>
                <span class="prod-cat-count">{{ node.product_count }}</span>

                <span v-if="Number(selectedCatId) === Number(node.id)" class="prod-cat-ops" @click.stop>
                  <button type="button" class="icon-btn" title="新增子分类"
                          :disabled="catBusy" @click="addChild(node)">＋</button>
                  <button type="button" class="icon-btn" title="改名"
                          :disabled="catBusy" @click="renameNode(node)">改</button>
                  <button type="button" class="icon-btn" title="上移"
                          :disabled="catBusy" @click="moveNode(node, 'up')">↑</button>
                  <button type="button" class="icon-btn" title="下移"
                          :disabled="catBusy" @click="moveNode(node, 'down')">↓</button>
                  <button type="button" class="icon-btn prod-cat-del"
                          :title="deleteTitle(node)" :disabled="node.is_system === 1 || catBusy"
                          @click="removeNode(node)">✕</button>
                </span>
              </div>

              <c-empty v-if="!tree.length" icon="folder" title="还没有产品分类"
                       desc="点右上角「＋」新增一级分类；选中任一分类后可再加下级分类（一级 / 二级 / 三级…）。" />
            </div>
          </section>

          <!-- ================= 右侧：产品 ================= -->
          <div class="prod-main">
            <div class="card" style="margin-bottom:16px">
              <div class="card-body" style="padding:14px 16px">
                <div class="filter-bar">
                  <div class="search-box">
                    <c-icon name="search" :size="15" style="color:var(--c-text-3)" />
                    <input class="input" v-model="query.keyword"
                           placeholder="搜索名称 / 编号 / 备注" @keydown.enter="reload" />
                    <button v-if="query.keyword" class="icon-btn" title="清空"
                            @click="query.keyword = ''; reload()">✕</button>
                  </div>
                  <button class="btn btn-primary" @click="reload">搜索</button>

                  <select class="input" v-model="query.body_material" @change="reload()">
                    <option value="">材质（全部）</option>
                    <option v-for="o in api.options('body_material')" :key="o" :value="o">{{ o }}</option>
                  </select>
                  <select class="input" v-model="query.pressure_rating" @change="reload()">
                    <option value="">压力（全部）</option>
                    <option v-for="o in api.options('pressure_rating')" :key="o" :value="o">{{ o }}</option>
                  </select>
                  <select class="input" v-model="query.enabled" @change="reload()">
                    <option value="">状态（全部）</option>
                    <option value="1">启用</option>
                    <option value="0">停用</option>
                  </select>

                  <div style="flex:1"></div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                    <button class="btn" title="下载模板，填好后批量导入产品" @click="openImport">
                      <c-icon name="file" :size="14" /> 批量导入
                    </button>
                    <button class="btn" title="按当前筛选导出 xlsx" @click="exportExcel">
                      <c-icon name="file" :size="14" /> 导出 Excel
                    </button>
                    <button class="btn btn-primary" @click="openCreate">
                      <c-icon name="plus" :size="14" /> 新增产品
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-head">
                <div>
                  <div class="card-title">{{ title }}</div>
                  <div class="card-sub">{{ subTitle }}</div>
                </div>
                <div class="spacer"></div>
                <button v-if="selectedCat" class="btn btn-sm" @click="openCreate">在此分类下新增</button>
              </div>

              <c-table :columns="columns" :rows="rows" :loading="loading"
                       empty-text="还没有产品"
                       empty-desc="点右上角「新增产品」录入第一个产品；也可按分类逐个补充。">
                <template #cell-name="{ row }">
                  <div style="font-weight:500">{{ row.name }}</div>
                  <div class="muted" style="font-size:var(--fs-xs)">
                    {{ row.category_path || row.category_name || '未分类' }}
                    <span v-if="!row.enabled" class="tag muted" style="margin-left:4px">停用</span>
                  </div>
                </template>

                <template #cell-code="{ row }">
                  <span class="muted" style="font-size:var(--fs-xs)">{{ orDash(row.code) }}</span>
                </template>

                <template #cell-body_material="{ row }">
                  <span v-if="row.body_material" class="tag muted">{{ row.body_material }}</span>
                  <span v-else class="muted">—</span>
                </template>

                <template #cell-pressure_rating="{ row }">
                  <span v-if="row.pressure_rating">{{ row.pressure_rating }}</span>
                  <span v-else class="muted">—</span>
                </template>

                <template #cell-price="{ row }">
                  <span>{{ fmtMoney(row.price) }}</span>
                </template>

                <template #cell-lead_time_weeks="{ row }">
                  <span v-if="row.lead_time_weeks">{{ fmtWeeks(row.lead_time_weeks) }} 周</span>
                  <span v-else class="muted">按合同</span>
                </template>

                <template #cell-discount="{ row }">
                  <span v-if="row.discount" class="tag warning">{{ row.discount }}%</span>
                  <span v-else class="muted">—</span>
                </template>

                <template #cell-net_price="{ row }">
                  <strong style="color:var(--c-primary)">{{ fmtMoney(row.net_price) }}</strong>
                </template>

                <template #cell-ops="{ row }">
                  <div style="display:flex;gap:4px;justify-content:flex-end">
                    <button class="btn btn-sm" @click="openEdit(row)">编辑</button>
                    <button class="btn btn-sm" @click="copy(row)">复制</button>
                    <button class="btn btn-sm btn-danger" @click="remove(row)">删除</button>
                  </div>
                </template>
              </c-table>

              <c-pager :page="page" :pages="pages" :total="total" :page-size="pageSize"
                       @update:page="onPage" @update:page-size="onPageSize" />
            </div>
          </div>
        </div>

        <!-- ================= 产品新增 / 编辑抽屉 ================= -->
        <c-drawer v-model="drawerOpen"
                  :title="form.id ? '编辑产品' : '新增产品'"
                  sub="同一分类下产品不能重名；编号留空即可，填了必须全库唯一"
                  width="720px">
          <div class="form-grid">
            <c-select v-model="form.category_id" label="产品分类" :options="catOptions"
                      required :span="2" empty-text="请选择分类" />
            <c-field v-model="form.name" label="产品名称" required :span="2"
                     placeholder="例如：DN200 蝶阀 三偏心 对夹 碳钢" />
            <c-field v-model="form.code" label="产品编号" placeholder="可留空；非空时全库唯一" />
            <c-field v-model="form.unit" label="单位" placeholder="台" />

            <c-field v-model="form.price" label="单价（元）" type="number" placeholder="0.00" />
            <c-field v-model="form.lead_time_weeks" label="货期（周）" type="number"
                     placeholder="3.5" hint="按周填写，可一位小数；3.5 周保存后仍回显 3.5 周（同时换算天数供导出）" />

            <c-select v-model="form.body_material" label="阀体材质"
                      :options="api.options('body_material')" category="body_material" allow-add
                      @added="onDictAdded($event, 'body_material')" />
            <c-select v-model="form.pressure_rating" label="压力等级"
                      :options="api.options('pressure_rating')" category="pressure_rating" allow-add
                      @added="onDictAdded($event, 'pressure_rating')" />

            <c-field v-model="form.discount" label="设定折扣（%）" type="number"
                     placeholder="0" hint="0~100，折后价 = 单价 × (1 − 折扣/100)" />
            <div class="field">
              <label class="field-label">折后价（自动）</label>
              <div class="input prod-net">{{ fmtMoney(formNetPrice) }} 元</div>
              <div class="field-hint">按上方单价与折扣实时计算</div>
            </div>

            <c-field v-model="form.remark" label="备注" type="textarea" :span="2" :rows="3"
                     placeholder="如：含税、含法兰、执行标准等" />
            <c-switch v-model="form.enabled" label="启用" :span="1"
                      hint="停用后仍在价目表里，只是标记为不对外报价" />
          </div>

          <template #footer>
            <span class="muted" style="font-size:var(--fs-xs)">
              {{ form.id ? '产品 ID：' + form.id : '保存后可在右侧表格里继续编辑或复制' }}
            </span>
            <div style="flex:1"></div>
            <button class="btn" @click="drawerOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </template>
        </c-drawer>

        <!-- ================= 产品批量导入抽屉（1.26） ================= -->
        <c-drawer v-model="importOpen" title="批量导入产品"
                  sub="下载模板 → 在 Excel 里填好 → 拖进来 → 校验预览 → 确认导入；导入前不会写入数据库"
                  width="820px">
          <div class="import-steps">
            <div class="import-step" :class="{ on: impStep >= 1 }"><span class="idx">1</span>下载模板 / 选择文件</div>
            <div class="import-step" :class="{ on: impStep >= 2 }"><span class="idx">2</span>校验预览</div>
            <div class="import-step" :class="{ on: impStep >= 3 }"><span class="idx">3</span>确认导入</div>
          </div>

          <!-- 步骤 1：模板 + 文件 -->
          <template v-if="impStep === 1">
            <div class="note" style="margin-bottom:14px">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                模板包含 <strong>导入模板 / 填写说明 / 可选值参考</strong> 三页：
                分类路径支持 <code>蝶阀 / 三偏心蝶阀 / 对夹</code> 或 <code>蝶阀&gt;三偏心蝶阀&gt;对夹</code>，
                可选值参考页列出现有分类路径与材质 / 压力等级。
              </div>
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
              <button class="btn btn-primary" :disabled="tplBusy" @click="downloadImportTemplate">
                <c-icon name="file" :size="14" /> {{ tplBusy ? '生成中…' : '下载产品导入模板（.xlsx）' }}
              </button>
              <button class="btn" @click="exportExcel">导出现有产品当作样例</button>
            </div>

            <div class="drop-zone" :class="{ over: impDragOver }"
                 @dragover.prevent="impDragOver = true"
                 @dragleave.prevent="impDragOver = false"
                 @drop.prevent="onImportDrop">
              <c-icon name="file" :size="30" />
              <div class="mt-3">
                {{ impParsing ? '正在解析…' : '把填好的 Excel 拖到这里，或' }}
                <label v-if="!impParsing" class="link-btn">
                  点击选择文件
                  <input type="file" accept=".xlsx,.xls,.csv" style="display:none"
                         @change="onImportFile" />
                </label>
              </div>
              <div class="muted mt-3" style="font-size:var(--fs-xs)">
                支持 .xlsx / .xls / .csv；单次最多 2000 行；空行会自动跳过
              </div>
            </div>
            <div v-if="impFileName" class="muted mt-3" style="font-size:var(--fs-xs)">
              已选择：{{ impFileName }}
            </div>
          </template>

          <!-- 步骤 2：预览与设置 -->
          <template v-else-if="impStep === 2 && impPreview">
            <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
              <div class="stat"><div class="n">{{ impPreview.total }}</div><div class="l">总行数</div></div>
              <div class="stat"><div class="n" style="color:var(--c-success)">{{ impPreview.valid }}</div><div class="l">可导入</div></div>
              <div class="stat"><div class="n" :style="impPreview.invalid ? 'color:var(--c-danger)' : ''">{{ impPreview.invalid }}</div><div class="l">有问题</div></div>
              <div class="stat"><div class="n">{{ impPreview.blankSkipped || 0 }}</div><div class="l">空行跳过</div></div>
            </div>

            <c-card title="导入设置" sub="分类不存在时如何处理、同分类重名怎么处理" style="margin-bottom:16px">
              <div class="form-grid">
                <div class="field" style="grid-column:span 2">
                  <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                    <input type="checkbox" v-model="impAutoCreate" style="margin-top:2px"
                           @change="refreshPreview" />
                    <span style="font-size:var(--fs-sm)">
                      <strong>分类不存在时自动创建</strong>（默认勾选）
                      <span class="muted" style="display:block;font-size:var(--fs-xs);margin-top:2px">
                        缺失的层级按路径顺序创建（is_system=0），排在同级末尾；不勾选则这一行报错。
                      </span>
                    </span>
                  </label>
                </div>
                <div class="field">
                  <label class="field-label">遇到同分类同名产品</label>
                  <select class="input" v-model="impMode" @change="refreshPreview">
                    <option value="skip">跳过（保留库中已有资料）</option>
                    <option value="update">更新已有记录（只覆盖表格里填了值的列）</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">当前解析文件</label>
                  <div class="input" style="display:flex;align-items:center">{{ impFileName }}</div>
                </div>
              </div>
            </c-card>

            <div v-if="impErrors.length" class="note warn" style="margin-bottom:14px">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                有 {{ impErrors.length }} 行存在问题，这些行<strong>不会被导入</strong>（前 30 行）：
                <div class="table-wrap mt-3" style="max-height:220px;overflow:auto">
                  <table class="data-table">
                    <thead><tr><th style="width:70px">行号</th><th>问题</th></tr></thead>
                    <tbody>
                      <tr v-for="r in impErrors.slice(0, 30)" :key="'e' + r.index">
                        <td>第 {{ r.index }} 行</td>
                        <td>{{ r.errors.join('；') }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div v-if="impWarnings.length" class="note" style="margin-bottom:14px">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                有 {{ impWarnings.length }} 行带提示（不影响导入）：
                <div v-for="r in impWarnings.slice(0, 20)" :key="'w' + r.index"
                     style="font-size:var(--fs-xs);margin-top:4px">
                  第 {{ r.index }} 行：{{ r.warnings.join('；') }}
                </div>
                <div v-if="impWarnings.length > 20" class="muted mt-3" style="font-size:var(--fs-xs)">
                  仅列出前 20 行
                </div>
              </div>
            </div>

            <div class="field-label" style="margin-bottom:6px">
              文件预览（前 50 行，共 {{ impPreview.total }} 行）
            </div>
            <div class="table-wrap" style="max-height:360px;overflow:auto">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width:56px">行号</th>
                    <th style="width:64px">状态</th>
                    <th>分类路径</th>
                    <th>产品名称</th>
                    <th style="width:88px;text-align:right">单价</th>
                    <th style="width:74px;text-align:right">货期(周)</th>
                    <th style="width:70px;text-align:right">折扣</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in impPreview.rows.slice(0, 50)" :key="'p' + r.index"
                      :class="r.errors.length ? 'row-error' : (r.warnings.length ? 'row-warn' : '')">
                    <td>{{ r.index }}</td>
                    <td>
                      <span v-if="r.errors.length" class="tag danger" style="font-size:10px">错误</span>
                      <span v-else-if="r.warnings.length" class="tag warning" style="font-size:10px">提示</span>
                      <span v-else class="tag success" style="font-size:10px">可导入</span>
                    </td>
                    <td class="muted" style="font-size:var(--fs-xs)">{{ r.data.category_path || '—' }}</td>
                    <td>{{ r.data.name || '(无名称)' }}</td>
                    <td style="text-align:right">{{ fmtMoney(r.data.price) }}</td>
                    <td style="text-align:right">{{ fmtWeeks(r.data.lead_time_weeks) }}</td>
                    <td style="text-align:right">{{ r.data.discount }}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <!-- 步骤 3：结果 -->
          <template v-else-if="impStep === 3 && impReport">
            <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
              <div class="stat"><div class="n" style="color:var(--c-success)">{{ impReport.imported }}</div><div class="l">成功导入</div></div>
              <div class="stat"><div class="n">{{ impReport.updated }}</div><div class="l">更新</div></div>
              <div class="stat"><div class="n">{{ impReport.skipped }}</div><div class="l">跳过</div></div>
              <div class="stat"><div class="n" :style="impReport.failed ? 'color:var(--c-danger)' : ''">{{ impReport.failed }}</div><div class="l">写入失败</div></div>
              <div class="stat"><div class="n" :style="impReport.invalid ? 'color:var(--c-warning)' : ''">{{ impReport.invalid }}</div><div class="l">校验未通过</div></div>
            </div>

            <div v-if="impReport.categoriesCreated" class="note" style="margin-bottom:14px">
              <c-icon name="check" :size="16" />
              <div style="font-size:var(--fs-sm)">
                导入过程中自动新建了 {{ impReport.categoriesCreated }} 个产品分类（is_system=0，已排到同级末尾）。
                左侧分类树已刷新。
              </div>
            </div>

            <div v-if="(impReport.errors || []).length" class="note warn">
              <c-icon name="alert" :size="16" />
              <div style="font-size:var(--fs-sm)">
                未导入明细（前 50 条）：
                <div class="table-wrap mt-3" style="max-height:260px;overflow:auto">
                  <table class="data-table">
                    <thead><tr><th style="width:70px">行号</th><th>原因</th></tr></thead>
                    <tbody>
                      <tr v-for="(e, i) in impReport.errors.slice(0, 50)" :key="'r' + i">
                        <td>第 {{ e.index }} 行</td>
                        <td style="color:var(--c-danger)">{{ e.message }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div v-if="!(impReport.errors || []).length" class="note">
              <c-icon name="check" :size="16" />
              <div style="font-size:var(--fs-sm)">全部行均处理完成，没有失败明细。</div>
            </div>
          </template>

          <template #footer>
            <span class="muted" style="font-size:var(--fs-xs);margin-right:auto">
              <template v-if="impStep === 1">模板第 2、3 行是示例，正式填写前可以删掉</template>
              <template v-else-if="impStep === 2">确认无误后点「确认导入」；写入前不会动数据</template>
              <template v-else>已完成，可刷新列表查看</template>
            </span>
            <button class="btn" @click="closeImport">{{ impStep === 3 ? '关闭' : '取消' }}</button>
            <button v-if="impStep === 2" class="btn btn-primary"
                    :disabled="impImporting || !impPreview.valid" @click="doImport">
              {{ impImporting ? '导入中…' : '确认导入（' + impPreview.valid + ' 行）' }}
            </button>
            <button v-if="impStep === 3" class="btn" @click="refreshAfterImport">刷新列表</button>
            <button v-if="impStep === 3" class="btn btn-primary" @click="resetImport">继续导入</button>
          </template>
        </c-drawer>
      </div>`,
    setup() {
      return { api: CRM.api };
    }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.products = ProductsPage;

})(window.CRM);
