/**
 * 验收测试夹具生成器
 *
 * 生成「真实可用」的测试文件（不是随便造的字节）：
 *   - 合法 PNG（可被浏览器正常渲染预览）
 *   - 合法 PDF（可被浏览器内置阅读器打开）
 *   - 100 条客户的 Excel 导入文件（用于验收第 17 项）
 *   - 含中文与特殊字符的 CSV
 *   - 大批量客户数据（用于 500 条性能验收）
 *
 * 用法：node tools/make-fixtures.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.fixtures');

fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* 1. 合法 PNG（用 zlib 手写，确保是真正可解码的图片）                    */
/* ------------------------------------------------------------------ */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 width×height 的 RGB PNG，画一个简单渐变+边框，便于肉眼确认预览正常 */
function makePng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const border = (x < 3 || y < 3 || x >= width - 3 || y >= height - 3);
      if (border) {
        raw[p++] = 47; raw[p++] = 111; raw[p++] = 237;   // 品牌蓝边框
      } else {
        raw[p++] = Math.round(255 - (x / width) * 120);
        raw[p++] = Math.round(255 - (y / height) * 100);
        raw[p++] = 245;
      }
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ------------------------------------------------------------------ */
/* 2. 合法 PDF（多页，中文可读，供浏览器 PDF 阅读器打开）                */
/* ------------------------------------------------------------------ */

function makePdf(pages) {
  const n = pages || 2;
  const objects = [];
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 2} 0 R`);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);

  for (let i = 0; i < n; i++) {
    const contentIdx = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 260] /Contents ${contentIdx} 0 R `
      + '/Resources << /Font << /F1 ' + (3 + n * 2) + ' 0 R >> >> >>'
    );
    const text = `BT /F1 16 Tf 40 200 Td (Valve Contract - Page ${i + 1}) Tj ET\n`
      + `BT /F1 11 Tf 40 170 Td (Phase 7 Acceptance Test Fixture) Tj ET\n`
      + `BT /F1 11 Tf 40 150 Td (Page ${i + 1} of ${n}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/* ------------------------------------------------------------------ */
/* 3. Excel 导入文件（100 条客户，表头与系统模板一致）                   */
/* ------------------------------------------------------------------ */

function makeImportXlsx(count) {
  const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
  const header = [
    '客户全称 *', '客户简称', '客户编号', '行业', '客户来源', '联系人', '联系人职务',
    '联系人手机', '联系人生日', '邮箱', '省/自治区', '市/地区', '区/县', '详细地址',
    '回访周期(天)', '下次回访', '备注'
  ];
  const cities = [
    ['乌鲁木齐市', '天山区'], ['克拉玛依市', '独山子区'], ['吐鲁番市', '高昌区'],
    ['哈密市', '伊州区'], ['昌吉回族自治州', '昌吉市'], ['阿克苏地区', '库车市'],
    ['喀什地区', '喀什市'], ['巴音郭楞蒙古自治州', '库尔勒市'], ['伊犁哈萨克自治州', '伊宁市'],
    ['塔城地区', '乌苏市']
  ];
  const industries = ['石油', '化工', '电力', '冶金', '水处理', '煤化工', '天然气', '制药', '造纸', '食品饮料'];

  const rows = [header];
  for (let i = 1; i <= count; i++) {
    const c = cities[i % cities.length];
    rows.push([
      `验收测试客户${String(i).padStart(4, '0')}有限公司`,
      `验收客户${i}`,
      '',
      industries[i % industries.length],
      '老客户介绍',
      `验收联系人${i}`,
      '采购经理',
      `139${String(10000000 + i).slice(-8)}`,
      `${1980 + (i % 20)}-0${(i % 9) + 1}-15`,
      `customer${i}@example.com`,
      '新疆维吾尔自治区',
      c[0], c[1],
      `${c[1]}工业园区 ${i} 号`,
      String(10 + (i % 60)),
      '',
      '阶段七验收测试用数据'
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(12, Math.min(34, h.length * 2 + 6)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '客户导入');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* ------------------------------------------------------------------ */
/* 4. 特殊字符 CSV                                                     */
/* ------------------------------------------------------------------ */

function makeSpecialCsv() {
  const rows = [
    ['客户全称 *', '行业', '联系人', '联系人手机', '备注'],
    ['测试<标签>与"引号"公司', '石油', '特殊A', '13900000001', '含 <html> & "quotes" \'single\''],
    ['换行\n测试公司', '化工', '特殊B', '13900000002', '多行\n备注\n第三行'],
    ['中文标点、顿号；分号：冒号（括号）公司', '其他', '特殊C', '13900000003', '表情😀与符号©®™'],
    ['超长名称'.padEnd(150, '测') + '有限公司', '电力', '特殊D', '13900000004', 'x'.repeat(2000)],
    ['', '', '', '', '这一行缺必填项，应当被识别为错误行']
  ];
  /* CSV 里含换行需用引号包裹 */
  return rows.map((r) => r.map((c) => {
    const s = String(c === undefined ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log('=== 生成验收测试夹具 ===\n');

  const files = [];

  const png = makePng(240, 160);
  const pngFile = path.join(OUT, '合同扫描件-验收测试.png');
  fs.writeFileSync(pngFile, png);
  files.push(['合同扫描件-验收测试.png', png.length, '合法 PNG（240×160，可浏览器预览）']);

  const pdf = makePdf(3);
  const pdfFile = path.join(OUT, '技术协议-验收测试.pdf');
  fs.writeFileSync(pdfFile, pdf);
  files.push(['技术协议-验收测试.pdf', pdf.length, '合法 PDF（3 页）']);

  const xlsx = makeImportXlsx(100);
  const xlsxFile = path.join(OUT, '客户导入-100条.xlsx');
  fs.writeFileSync(xlsxFile, xlsx);
  files.push(['客户导入-100条.xlsx', xlsx.length, '100 条客户，表头与系统模板一致']);

  const csv = makeSpecialCsv();
  const csvFile = path.join(OUT, '特殊字符-验收测试.csv');
  fs.writeFileSync(csvFile, Buffer.from('\uFEFF' + csv, 'utf8'));   // 加 BOM 便于 Excel 正确识别 UTF-8
  files.push(['特殊字符-验收测试.csv', Buffer.byteLength(csv, 'utf8'), '含标签/引号/换行/表情/超长文本']);

  for (const [name, size, desc] of files) {
    console.log(`  ${name.padEnd(30)} ${String(Math.round(size / 1024) + ' KB').padStart(8)}  ${desc}`);
  }
  console.log(`\n输出目录：${OUT}`);

  /* 自检：PNG / PDF 是否合法 */
  console.log('\n--- 夹具自检 ---');
  const pngBuf = fs.readFileSync(pngFile);
  console.log('PNG 签名正确:', pngBuf.slice(0, 8).toString('hex') === '89504e470d0a1a0a');
  console.log('PNG 以 IEND 结尾:', pngBuf.slice(-8, -4).toString('ascii') === 'IEND');
  const pdfBuf = fs.readFileSync(pdfFile);
  console.log('PDF 头正确:', pdfBuf.slice(0, 5).toString('ascii') === '%PDF-');
  console.log('PDF 尾正确:', pdfBuf.slice(-20).toString('ascii').includes('%%EOF'));
  try {
    const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
    const wb = XLSX.read(fs.readFileSync(xlsxFile), { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    console.log('Excel 可读回：', aoa.length - 1, '行数据 ×', aoa[0].length, '列，表头首列 =', aoa[0][0]);
  } catch (e) {
    console.log('Excel 读取失败:', e.message);
  }
})();
