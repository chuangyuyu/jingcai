#!/usr/bin/env node
/**
 * 由 docs/data 下的 JSON 数据生成全量 Excel 表
 * ============================================================
 * 用法： node scripts/export-excel.js   （daily.js 也会自动调用本模块的 generateExcel）
 * 输出：
 *   docs/excel/竞彩1球-差值记录.xlsx   按月分 sheet + 统计表 + 说明表
 *   docs/excel/records.csv             全量数据 CSV（UTF-8 带 BOM，Excel 可直接打开）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const JC = require('../docs/core.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');
const EXCEL_DIR = path.join(ROOT, 'docs', 'excel');

const COLOR_HEADER_BG = 'FF1F4E79';   // 表头深蓝
const COLOR_POSITIVE = 'FF107C41';    // 差值为正（1球更划算）绿
const COLOR_NEGATIVE = 'FFC00000';    // 差值为负（比分双选更划算）红
const COLOR_MUTED = 'FF808080';

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

// 表结构定义：key 与 JC.flatRows 输出字段一一对应
const COLUMNS = [
  { header: '日期', key: 'date', width: 12 },
  { header: '场次编号', key: 'matchNumStr', width: 10 },
  { header: '联赛', key: 'league', width: 14 },
  { header: '主队', key: 'home', width: 18 },
  { header: '客队', key: 'away', width: 18 },
  { header: '开赛时间', key: 'kickoff', width: 12 },
  { header: '1球赔率', key: 'ttg1', width: 10 },
  { header: '1:0赔率', key: 's10', width: 10 },
  { header: '0:1赔率', key: 's01', width: 10 },
  { header: '优化赔率', key: 'optimized', width: 11 },
  { header: '差值', key: 'diff', width: 10 },
  { header: '全场比分', key: 'score', width: 10 },
  { header: '半场比分', key: 'halfScore', width: 10 },
  { header: '是否1球', key: 'isOneGoalText', width: 10 },
  { header: '赔率更新时间', key: 'oddsAt', width: 21 }
];

function addMonthSheet(wb, month, rows) {
  const ws = wb.addWorksheet(month);
  ws.columns = COLUMNS;
  rows.forEach(r => {
    ws.addRow(Object.assign({}, r, {
      isOneGoalText: r.isOneGoal == null ? '' : (r.isOneGoal ? '是' : '否')
    }));
  });

  // 表头样式 + 冻结首行 + 筛选
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
  head.alignment = { horizontal: 'center', vertical: 'middle' };
  head.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  // 数据样式
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    row.getCell('ttg1').numFmt = '0.00';
    row.getCell('s10').numFmt = '0.00';
    row.getCell('s01').numFmt = '0.00';
    row.getCell('optimized').numFmt = '0.000';
    row.getCell('diff').numFmt = '+0.000;-0.000;0.000';
    const diffCell = row.getCell('diff');
    const v = diffCell.value;
    if (typeof v === 'number') {
      diffCell.font = { bold: true, color: { argb: v >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    }
    const one = row.getCell('isOneGoalText');
    if (one.value === '是') one.font = { bold: true, color: { argb: COLOR_POSITIVE } };
    else if (one.value === '否') one.font = { color: { argb: COLOR_MUTED } };
    ['date', 'matchNumStr', 'league', 'home', 'away', 'kickoff', 'score', 'halfScore', 'isOneGoalText']
      .forEach(k => { row.getCell(k).alignment = { horizontal: 'center' }; });
    ['ttg1', 's10', 's01', 'optimized', 'diff'].forEach(k => { row.getCell(k).alignment = { horizontal: 'right' }; });
  }
  return ws;
}

function addStatsSheet(wb, rows) {
  const ws = wb.addWorksheet('统计');
  ws.columns = [{ width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 40 }];
  const st = JC.stats(rows);
  const s = st.summary;
  const pct = v => (v == null ? '' : v);

  ws.addRow(['统计（截至 ' + JC.nowIso() + '）']).font = { bold: true, size: 14 };
  ws.addRow([]);
  ws.addRow(['总体概览']).font = { bold: true, size: 12 };
  ws.addRow(['总场次', s.total]);
  ws.addRow(['已出赛果场次', s.settled]);
  ws.addRow(['其中 1 球赛果场次', s.oneGoalCount]);
  ws.addRow(['1 球占比', pct(s.oneGoalRatio)]).getCell(2).numFmt = '0.0%';
  ws.addRow(['平均差值（全部已出）', s.avgDiffAll]).getCell(2).numFmt = '0.000';
  ws.addRow(['平均差值（1球场次）', s.avgDiffOne]).getCell(2).numFmt = '0.000';
  ws.addRow(['平均差值（非1球场次）', s.avgDiffNon]).getCell(2).numFmt = '0.000';
  ws.addRow([]);
  ws.addRow(['差值分布（按赛果分组）']).font = { bold: true, size: 12 };

  const headKeys = ['差值区间', '总场次', '1球场次', '非1球场次', '1球占比'];
  const headRow = ws.addRow(headKeys);
  headRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headRow.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { horizontal: 'center' };
  });
  st.bins.forEach(b => {
    const r = ws.addRow([b.label, b.count, b.oneCount, b.nonOneCount, b.oneRatio]);
    r.getCell(5).numFmt = '0.0%';
    if (b.oneRatio != null && b.count >= 5) {
      r.getCell(5).font = { bold: true, color: { argb: b.oneRatio >= (s.oneGoalRatio || 0) ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    }
  });
  ws.addRow([]);
  ws.addRow(['说明：仅统计「1球/1:0/0:1 三个赔率齐全且已出赛果」的场次。']);
  ws.addRow(['「1球占比」该行 1 球赛果场次数 ÷ 总场次数；样本 <5 场的行不建议解读。']);
  ws.addRow(['提示：网页版（GitHub Pages）中有该分布的柱状图，更直观。']);
  return ws;
}

function addHelpSheet(wb) {
  const ws = wb.addWorksheet('说明');
  ws.columns = [{ width: 110 }];
  const lines = [
    '竞彩足球「1球赔率 vs 比分双选优化赔率」差值记录',
    '',
    '【核心公式】',
    '  优化赔率 = 1:0赔率 × 0:1赔率 ÷ (1:0赔率 + 0:1赔率)',
    '  差值     = 1球赔率 − 优化赔率',
    '  正数：押「总进球1球」回报更高；负数：押「1:0 + 0:1 比分双选（等回报拆注）」回报更高。',
    '',
    '【优化赔率的含义】',
    '  把 1 元本金按赔率倒数比例拆成两注，分别押 1:0 和 0:1，使两注无论哪个比分命中，回报完全相同；',
    '  这个保底回报就是「优化赔率」。（例：1:0=6.40、0:1=10.50 → 优化赔率 = 6.40×10.50÷16.90 ≈ 3.98 元）',
    '',
    '【用法参考】',
    '  1球赔率 与 优化赔率 对应的是同一个事件（全场恰好进 1 球）：1:0 或 0:1。',
    '  两者赔率不同只是官方对两种投注方式抽水结构不同，差值记录的就是这个结构差异。',
    '  长期观察「赛果为 1 球的比赛」其差值的分布（统计表 / 网页图表），可辅助判断',
    '  在什么差值区间下，哪种下注方式更划算。',
    '',
    '【数据来源与口径】',
    '  · 赔率、赛果均来自中国体育彩票官方 Web API，每天定时抓取一次（见「赔率更新时间」列）。',
    '  · 每场比赛一行；赔率为抓取当时（最后一次）的在售赔率，会随官方调整而变化，记录以最后一次抓取为准。',
    '  · 只有 1球、1:0、0:1 三个赔率齐全的场次才计算优化赔率与差值（缺失的显示为空）。',
    '  · 「是否1球」按全场比分（90分钟）判定：1:0 或 0:1 记「是」。',
    '  · 赛果于比赛次日自动回填；未回填的比赛「全场比分」为空。',
    '',
    '【免责声明】',
    '  本表仅为个人数据分析用途，数据版权归中国体育彩票（sporttery.cn）所有，不构成任何投注建议。',
    '  请理性购彩。'
  ];
  lines.forEach((t, i) => {
    const row = ws.addRow([t]);
    if (i === 0) row.font = { bold: true, size: 14 };
    if (/^【.*】$/.test(t)) row.font = { bold: true, size: 12 };
  });
  return ws;
}

async function generateExcel() {
  const index = loadJson(path.join(DATA_DIR, 'index.json'), { dates: {} });
  const dates = Object.keys(index.dates || {}).sort();
  const docs = dates.map(d => loadJson(path.join(DAYS_DIR, d + '.json'), null)).filter(Boolean);
  const rows = JC.flatRows(docs);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'jingcai-1qiu-diff';
  wb.created = new Date();

  const months = {};
  rows.forEach(r => {
    const m = String(r.date).slice(0, 7);
    (months[m] = months[m] || []).push(r);
  });
  Object.keys(months).sort().forEach(m => addMonthSheet(wb, m, months[m]));
  if (!rows.length) wb.addWorksheet('数据（暂无）');
  addStatsSheet(wb, rows);
  addHelpSheet(wb);

  fs.mkdirSync(EXCEL_DIR, { recursive: true });
  const file = path.join(EXCEL_DIR, '竞彩1球-差值记录.xlsx');
  await wb.xlsx.writeFile(file);
  fs.writeFileSync(path.join(EXCEL_DIR, 'records.csv'), JC.toCSV(rows), 'utf8');
  return { file, rows: rows.length, dates: dates.length };
}

if (require.main === module) {
  generateExcel().then(info => {
    console.log('Excel 已生成：' + info.file + '（' + info.rows + ' 行，' + info.dates + ' 天）');
  }).catch(e => { console.error('生成失败：', e); process.exit(1); });
}

module.exports = { generateExcel };
