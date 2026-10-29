/**
 * 客户表单结构定义（1.23 精简版）
 *
 * 客户表单只管客户资料本身，项目、回款与成本在客户详情里维护（一个客户可管理多个项目）。
 * 4 个区块、16 个字段，一屏 2 列就能放下：
 *   资料（公司名称 / 客户编号 / 行业 / 客户来源 / 标签）
 *   地址（省 / 市 / 区县 + 详细地址 + 归属地州）
 *   联系人（主联系人：姓名 / 职务 / 手机 / 生日）
 *   回访与备注（回访日期 / 定期提醒天数 / 备注）
 *
 * 字典类字段统一带 allowAdd，可在表单内直接「+ 新增选项」。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /* 单选（字典） */
  const sel = (key, label, category, opts) => Object.assign({
    key, label, type: 'select', category, allowAdd: true, span: 1
  }, opts || {});

  /* 文本 */
  const txt = (key, label, opts) => Object.assign({
    key, label, type: 'text', span: 1
  }, opts || {});

  const BLOCKS = [
    {
      key: 'profile',
      title: '资料',
      always: true,
      desc: '只有公司名称是必填；客户编号留空会按 KH-年份-序号 自动生成',
      fields: [
        txt('name', '公司名称', {
          required: true, span: 2,
          placeholder: '工商注册全称，例如：中国石油天然气股份有限公司独山子石化分公司'
        }),
        txt('customer_no', '客户编号', {
          placeholder: '留空自动生成，如 KH-2026-0001',
          hint: '可手改，全库唯一'
        }),
        sel('industry', '行业', 'industry', { hint: '列表可筛选，首页按行业分布统计' }),
        sel('source', '客户来源', 'customer_source'),
        { key: 'tag_ids', label: '标签', type: 'tags', span: 2 }
      ]
    },
    {
      key: 'address',
      title: '地址',
      desc: '填写「市 / 地区」后会自动归属到地州，用于按区域筛选与客户分布',
      always: true,
      fields: [
        txt('province', '省 / 自治区', { placeholder: '新疆维吾尔自治区' }),
        txt('city', '市 / 地区', { hint: '如「乌鲁木齐市」「喀什地区」——填写后自动归入地州统计' }),
        txt('district', '区 / 县', { hint: '如「天山区」「库尔勒市」' }),
        txt('address', '详细地址', { span: 2 }),
        {
          key: 'region_code', label: '归属地州', type: 'region', span: 2,
          hint: '由地址自动匹配；也可手动指定。用于客户分布与按区域筛选'
        }
      ]
    },
    {
      key: 'contact',
      title: '联系人（主联系人）',
      desc: '一客户只填一个主联系人；第二个人请到客户详情底部「附加联系人」里维护',
      always: true,
      fields: [
        txt('contact_name', '姓名', { placeholder: '例如：王建国' }),
        sel('contact_position', '职务', 'contact_position', { allowAdd: true }),
        txt('contact_phone', '手机', { placeholder: '例如：13909920001' }),
        txt('contact_birthday', '生日', { type: 'date', hint: '生日提醒会用到' })
      ]
    },
    {
      key: 'follow',
      title: '回访与备注',
      desc: '填了「定期提醒天数」后，每次记录跟进都会自动排下次回访时间',
      always: true,
      fields: [
        txt('next_follow_at', '回访日期', {
          type: 'datetime-local',
          hint: '到期后首页与列表会红色提醒'
        }),
        txt('follow_cycle_days', '定期提醒天数', {
          type: 'number', placeholder: '例如：30',
          hint: '0 = 不自动排；记录跟进后按「跟进日期 + 天数」生成下次回访'
        }),
        txt('remark', '备注', { type: 'textarea', span: 2, rows: 3 })
      ]
    }
  ];

  /* 列表页筛选字段（只留行业、来源、地州） */
  const FILTERS = [
    { key: 'industry', label: '行业', category: 'industry' },
    { key: 'source', label: '客户来源', category: 'customer_source' },
    /* region 特殊：选项来自行政区划表（地州），不是字典 */
    { key: 'region_code', label: '归属地州', category: null, source: 'region' }
  ];

  /* 列表页快捷筛选（1.23 新口径） */
  const QUICKS = [
    { key: 'today', label: '今日待跟进' },
    { key: 'overdue', label: '已逾期' },
    { key: 'no_follow', label: '从未跟进' },
    { key: 'month_new', label: '本月新增' }
  ];

  /* 列表排序 */
  const SORTS = [
    { key: 'customer_no', label: '客户编号' },
    { key: 'name', label: '公司名称（拼音）' },
    { key: 'next_follow_at', label: '下次回访' },
    { key: 'updated_at', label: '最近修改' },
    { key: 'created_at', label: '建档时间' }
  ];

  /* 字段中文名（用于详情展示与变更记录） */
  const FIELD_LABEL = {};
  for (const b of BLOCKS) for (const f of b.fields) FIELD_LABEL[f.key] = f.label;

  CRM.customerForm = { BLOCKS, FILTERS, QUICKS, SORTS, FIELD_LABEL };

})(window.CRM);
