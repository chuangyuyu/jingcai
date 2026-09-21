#!/usr/bin/env node
/**
 * 由 docs/data 下的 JSON 数据生成全量 Excel 表（v2：两次抓取 + 单关维度）
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
const COLOR_POSITIVE = 'FF107C41';    // 绿
const COLOR_NEGATIVE = 'FFC00000';    // 红
const COLOR_MUTED = 'FF808080';
const COLOR_SINGLE = 'FFB85C00';      // 单关标记（橙棕）

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

// 表结构定义：key 与 JC.flatRows 输出字段一一对应（o1=第一次抓取，o2=第二次抓取）
const COLUMNS = [
  { header: '日期', key: 'date', width: 12 },
  { header: '场次编号', key: 'matchNumStr', width: 10 },
  { header: '联赛', key: 'league', width: 14 },
  { header: '主队', key: 'home', width: 17 },
  { header: '客队', key: 'away', width: 17 },
  { header: '开赛时间', key: 'kickoff', width: 12 },
  { header: '单关胜平负', key: 'singleText', width: 11 },
  { header: '①1球', key: 'o1_ttg1', width: 8 },
  { header: '①1:0', key: 'o1_s10', width: 8 },
  { header: '①0:1', key: 'o1_s01', width: 8 },
  { header: '①优化', key: 'o1_opt', width: 9 },
  { header: '①差值', key: 'o1_diff', width: 9 },
  { header: '②1球', key: 'o2_ttg1', width: 8 },
  { header: '②1:0', key: 'o2_s10', width: 8 },
  { header: '②0:1', key: 'o2_s01', width: 8 },
  { header: '②优化', key: 'o2_opt', width: 9 },
  { header: '②差值', key: 'o2_diff', width: 9 },
  { header: '变化', key: 'dir', width: 6 },
  { header: '差值变化量', key: 'diffDelta', width: 11 },
  { header: '抓取时间（①/②）', key: 'times', width: 24 },
  { header: '全场比分', key: 'score', width: 9 },
  { header: '半场比分', key: 'halfScore', width: 9 },
  { header: '是否1球', key: 'isOneGoalText', width: 9 },
  { header: '结果更新时间', key: 'resultAt', width: 14 }
];

function rowValues(r) {
  return {
    date: r.date,
    matchNumStr: r.matchNumStr,
    league: r.league,
    home: r.home,
    away: r.away,
    kickoff: r.kickoff,
    singleText: r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否'),
    o1_ttg1: r.o1.ttg1, o1_s10: r.o1.s10, o1_s01: r.o1.s01,
    o1_opt: r.o1.optimized, o1_diff: r.o1.diff,
    o2_ttg1: r.o2.ttg1, o2_s10: r.o2.s10, o2_s01: r.o2.s01,
    o2_opt: r.o2.optimized, o2_diff: r.o2.diff,
    dir: r.dir || '',
    diffDelta: r.diffDelta,
    times: r.times || '',
    score: r.score || '',
    halfScore: r.halfScore || '',
    isOneGoalText: r.isOneGoal == null ? '' : (r.isOneGoal ? '是' : '否'),
    resultAt: JC.fmtAt(r.resultAt)
  };
}

function addMonthSheet(wb, month, rows) {
  const ws = wb.addWorksheet(month);
  ws.columns = COLUMNS;
  rows.forEach(r => ws.addRow(rowValues(r)));

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
  head.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  head.height = 24;
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 6 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    ['o1_ttg1', 'o1_s10', 'o1_s01', 'o2_ttg1', 'o2_s10', 'o2_s01'].forEach(k => { row.getCell(k).numFmt = '0.00'; });
    ['o1_opt', 'o1_diff', 'o2_opt', 'o2_diff', 'diffDelta'].forEach(k => { row.getCell(k).numFmt = '+0.000;-0.000;0.000'; });
    ['o1_diff', 'o2_diff'].forEach(k => {
      const c = row.getCell(k);
      if (typeof c.value === 'number') c.font = { bold: true, color: { argb: c.value >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    });
    const dirCell = row.getCell('dir');
    if (dirCell.value === '↑') dirCell.font = { bold: true, color: { argb: COLOR_NEGATIVE } };
    else if (dirCell.value === '↓') dirCell.font = { bold: true, color: { argb: COLOR_POSITIVE } };
    else if (dirCell.value === '→') dirCell.font = { color: { argb: COLOR_MUTED } };
    const st = row.getCell('singleText');
    if (st.value === '是') st.font = { bold: true, color: { argb: COLOR_SINGLE } };
    else if (st.value === '否') st.font = { color: { argb: COLOR_MUTED } };
    const one = row.getCell('isOneGoalText');
    if (one.value === '是') one.font = { bold: true, color: { argb: COLOR_POSITIVE } };
    else if (one.value === '否') one.font = { color: { argb: COLOR_MUTED } };
    ['date', 'matchNumStr', 'league', 'home', 'away', 'kickoff', 'singleText', 'dir',
      'score', 'halfScore', 'isOneGoalText', 'times', 'resultAt']
      .forEach(k => { row.getCell(k).alignment = { horizontal: 'center' }; });
    ['o1_ttg1', 'o1_s10', 'o1_s01', 'o1_opt', 'o1_diff', 'o2_ttg1', 'o2_s10', 'o2_s01', 'o2_opt', 'o2_diff', 'diffDelta']
      .forEach(k => { row.getCell(k).alignment = { horizontal: 'right' }; });
  }
  return ws;
}

function headRow(ws, cells) {
  const r = ws.addRow(cells);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  r.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { horizontal: 'center' };
  });
  return r;
}

function addStatsSheet(wb, rows) {
  const ws = wb.addWorksheet('统计');
  ws.columns = [{ width: 26 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }];
  const st = JC.stats(rows);
  const s = st.summary;

  ws.addRow(['统计（截至 ' + JC.nowIso() + '）']).font = { bold: true, size: 14 };
  ws.addRow([]);
  ws.addRow(['总体概览']).font = { bold: true, size: 12 };
  ws.addRow(['总场次', s.total]);
  ws.addRow(['其中含两次抓取的场次', s.twoCaptureCount]);
  ws.addRow(['已出赛果场次', s.settled]);
  ws.addRow(['其中 1 球赛果场次', s.oneGoalCount]);
  ws.addRow(['1 球占比', s.oneGoalRatio]).getCell(2).numFmt = '0.0%';
  ws.addRow(['平均差值（全部已出）', s.avgDiffAll]).getCell(2).numFmt = '0.000';
  ws.addRow(['平均差值（1球场次）', s.avgDiffOne]).getCell(2).numFmt = '0.000';
  ws.addRow(['平均差值（非1球场次）', s.avgDiffNon]).getCell(2).numFmt = '0.000';
  ws.addRow([]);

  ws.addRow(['单关 vs 非单关对比']).font = { bold: true, size: 12 };
  headRow(ws, ['分组', '场次', '已出赛果', '1球场次', '1球占比', '平均差值']);
  const g1 = s.singleGroup, g2 = s.nonSingleGroup;
  const gRow = (name, g) => {
    const r = ws.addRow([name, g.count, g.settled, g.oneGoalCount, g.oneRatio, g.avgDiff]);
    r.getCell(5).numFmt = '0.0%';
    r.getCell(6).numFmt = '0.000';
    if (g.oneRatio != null && s.oneGoalRatio != null) {
      r.getCell(5).font = { bold: true, color: { argb: g.oneRatio >= s.oneGoalRatio ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    }
  };
  gRow('单场胜平负（官方单关场次）', g1);
  gRow('非单关场次', g2);
  ws.addRow(['说明：单关场次为官方挑选开放"胜平负单关"的比赛（接口 poolList 中 HAD.single=1）。']);
  ws.addRow([]);

  ws.addRow(['差值分布（按赛果分组，差值取最新一次快照）']).font = { bold: true, size: 12 };
  headRow(ws, ['差值区间', '总场次', '1球场次', '非1球场次', '1球占比', '平均差值']);
  st.bins.forEach(b => {
    const r = ws.addRow([b.label, b.count, b.oneCount, b.nonOneCount, b.oneRatio, b.avgDiff]);
    r.getCell(5).numFmt = '0.0%';
    r.getCell(6).numFmt = '0.000';
    if (b.oneRatio != null && b.count >= 5 && s.oneGoalRatio != null) {
      r.getCell(5).font = { bold: true, color: { argb: b.oneRatio >= s.oneGoalRatio ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    }
  });
  ws.addRow([]);

  ws.addRow(['差值变化分布 ①→②（第二次 − 第一次，按赛果分组）']).font = { bold: true, size: 12 };
  headRow(ws, ['变化区间', '场次', '1球场次', '非1球场次', '1球占比', '平均变化量']);
  st.deltaBins.forEach(b => {
    const r = ws.addRow([b.label, b.count, b.oneCount, b.nonOneCount, b.oneRatio, b.avgDelta]);
    r.getCell(5).numFmt = '0.0%';
    r.getCell(6).numFmt = '+0.000;-0.000;0.000';
    if (b.oneRatio != null && b.count >= 5 && s.oneGoalRatio != null) {
      r.getCell(5).font = { bold: true, color: { argb: b.oneRatio >= s.oneGoalRatio ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    }
  });
  ws.addRow([]);
  ws.addRow(['说明：仅统计「两次快照齐全、已出赛果」的场次；样本 <5 场的行不建议解读。']);
  ws.addRow(['提示：网页版（GitHub Pages）中有以上两张分布的柱状图，更直观。']);
  return ws;
}

function addHelpSheet(wb) {
  const ws = wb.addWorksheet('说明');
  ws.columns = [{ width: 112 }];
  const lines = [
    '竞彩足球「1球赔率 vs 比分双选优化赔率」差值记录（v2：两次抓取 + 单关维度）',
    '',
    '【核心公式】',
    '  优化赔率 = 1:0赔率 × 0:1赔率 ÷ (1:0赔率 + 0:1赔率)',
    '  差值     = 1球赔率 − 优化赔率',
    '  正数：押「总进球1球」回报更高；负数：押「1:0 + 0:1 比分双选（等回报拆注）」回报更高。',
    '',
    '【优化赔率的含义】',
    '  把 1 元本金按赔率倒数比例拆成两注，分别押 1:0 和 0:1，使两注无论哪个比分命中回报完全相同；',
    '  这个保底回报就是「优化赔率」。（例：1:0=6.40、0:1=10.50 → 优化赔率 = 6.40×10.50÷16.90 ≈ 3.98 元）',
    '',
    '【两次抓取与"变化"列】',
    '  · 每天 11:00 与 17:00 各抓取一次，①/② 列分别对应第一、第二次抓取时的赔率与差值；',
    '  · 「变化」列 = 第二次差值相对第一次的方向：↑变大、↓缩小、→基本不变（±0.03 以内）；',
    '    差值为正时变大=更偏向1球，为负时缩水=更偏向比分双选，数值见「差值变化量」列；',
    '  · 若第二次抓取时比赛已开赛/停售，则只保留第一次数据（②列与变化列为空）；',
    '  · 每场比赛至多保留最近两次快照；分析用「差值」统一取最新一次快照。',
    '',
    '【单关维度】',
    '  官方会对部分场次开放「胜平负单关」（接口 poolList 中 HAD.single=1），这类场次一般被认为是',
    '  机构精挑细选的对阵。本表记录「单关胜平负」列，统计表中单独对比单关/非单关场次的',
    '  1 球出现率与差值表现，供交叉参考。',
    '',
    '【编号追踪】',
    '  · 每场比赛按编号（001 起）记录赛后实际总进球数（见「编号统计」表）。',
    '  · 当某个编号的某个进球数连续超过警戒线（config.json 的 alertDays，默认 30 天）没有出现时，',
    '    网页顶部会弹出横幅提醒，运行日志也会记录 —— 用于持续关注"该出了"的编号 × 进球数组合。',
    '  · 「距今」按日历天计（到最近数据日）；「连续未出现」按该编号实际出现的次数计；',
    '    只对近期仍活跃（近 7 天出现过）的编号、且历史上出现过至少一次的组合进入警戒。',
    '  · 「编号追踪」表中：红色 = 超警戒，橙色 = 接近警戒（60%），从未 = 历史数据中未出现过。',
    '',
    '【数据来源与口径】',
    '  · 赔率、赛果均来自中国体育彩票官方 Web API，定时抓取；赛果于比赛结束后回填。',
    '  · 只有 1球、1:0、0:1 三个赔率齐全的场次才计算优化赔率与差值（缺失的显示为空）。',
    '  · 凌晨开赛的比赛属于前一"销售日"，按销售日分组，「开赛时间」显示真实月-日。',
    '  · 「是否1球」按全场比分（90分钟）判定：1:0 或 0:1 记「是」。',
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

function addNumbersSheets(wb, numsDoc) {
  const st = JC.numbersStats(numsDoc || {}, {});
  if (!st.days) return;

  // —— 编号统计：每个编号的进球数分布（分档跟随 numbers.json 的 buckets）——
  const ws1 = wb.addWorksheet('编号统计');
  ws1.columns = [{ header: '编号', width: 8 }, { header: '出现天数', width: 10 }]
    .concat(st.buckets.map(b => ({ header: b.label, width: 9 })));
  st.nums.forEach(n => {
    const r = ws1.addRow([n.num, n.occurrences].concat(n.counts));
    r.getCell(1).alignment = { horizontal: 'center' };
    if (!n.active) r.font = { color: { argb: COLOR_MUTED } };
  });
  const h1 = ws1.getRow(1);
  h1.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h1.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { horizontal: 'center' };
  });
  ws1.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  ws1.addRow([]);
  ws1.addRow(['数据范围：' + st.firstDate + ' ~ ' + st.lastDate + '（共 ' + st.days + ' 天）；灰色编号 = 近 7 天未出现（已停用）。']);

  // —— 编号追踪：间隔矩阵 + 警戒列表 ——
  const ws2 = wb.addWorksheet('编号追踪');
  ws2.columns = [{ width: 12 }].concat(st.buckets.map(() => ({ width: 9 })));
  ws2.addRow(['编号追踪：单元格 = 该编号该进球数"距今未出现天数"（截至 ' + st.lastDate + '，警戒线 ' + st.alertDays + ' 天）']).font = { bold: true, size: 12 };
  ws2.addRow([]);
  ws2.addRow(['⚠ 达到警戒线的项目（按"该出指数"排序：距今 ÷ 历史平均间隔，越大概率上越"该出"）']).font = { bold: true, size: 12 };
  const hh = ws2.addRow(['编号', '进球数', '距今天数', '历史平均间隔(天)', '该出指数', '最近出现', '连续未出现(次)', '历史次数']);
  hh.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hh.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { horizontal: 'center' };
  });
  if (st.alerts.length) {
    st.alerts.forEach(a => {
      const r = ws2.addRow([a.num, a.label, a.daysSince, a.avgGap, a.anomaly, a.lastDate, a.streak, a.count]);
      r.font = { bold: true, color: { argb: COLOR_NEGATIVE } };
      [1, 2].forEach(i => { r.getCell(i).alignment = { horizontal: 'center' }; });
    });
  } else {
    ws2.addRow(['（当前没有项目超过警戒线）']);
  }
  ws2.addRow([]);
  ws2.addRow(['全部编号 × 进球数矩阵（数字=距今未出现天数；"从未"=历史数据中未出现过）']).font = { italic: true, size: 11 };
  const mh = ws2.addRow(['编号'].concat(st.buckets.map(b => b.label)));
  mh.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  mh.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { horizontal: 'center' };
  });
  st.nums.forEach(n => {
    const row = ws2.addRow([n.num + (n.active ? '' : '(停用)')].concat(n.combos.map(c => c.never ? '从未' : c.daysSince)));
    row.getCell(1).alignment = { horizontal: 'center' };
    n.combos.forEach((c, i) => {
      const cell = row.getCell(i + 2);
      cell.alignment = { horizontal: 'center' };
      if (!c.never) {
        if (c.daysSince >= st.alertDays) {
          cell.font = { bold: true, color: { argb: COLOR_NEGATIVE } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7D7' } };
        } else if (c.daysSince >= st.alertDays * 0.6) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDEBD0' } };
        }
      } else {
        cell.font = { color: { argb: COLOR_MUTED } };
      }
    });
  });
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
  addNumbersSheets(wb, loadJson(path.join(DATA_DIR, 'numbers.json'), null));
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
