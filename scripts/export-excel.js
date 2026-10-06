#!/usr/bin/env node
/**
 * 由 docs/data 下的 JSON 数据生成全量 Excel（v3：进球数差值 + 预测）
 * ============================================================
 * 工作表：
 *   每月一张（2026-09 …）：每场一行——预测（基线/模型，A/B 两口径）、实际进球、命中
 *   「差值明细」：每场 × 每个进球数一行——总进球赔率、多选优化赔率A、差值A、平均赔率B、差值B
 *   「模型统计」：预测命中率概览 + 排名×进球数 命中率矩阵（自修正模型的核心表）
 *   「编号统计」「编号追踪」：编号维度（保持）
 *   「说明」：口径与公式
 * 同时输出 docs/excel/records.csv（预测主表 CSV，UTF-8 带 BOM）
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

const COLOR_HEADER_BG = 'FF1F4E79';
const COLOR_POSITIVE = 'FF107C41';
const COLOR_NEGATIVE = 'FFC00000';
const COLOR_MUTED = 'FF808080';
const COLOR_SINGLE = 'FFB85C00';

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_BG } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  row.height = 20;
}

// ---------------- 每月工作表 ----------------
const MONTH_COLUMNS = [
  { header: '日期', key: 'date', width: 12 },
  { header: '场次编号', key: 'matchNumStr', width: 10 },
  { header: '联赛', key: 'league', width: 13 },
  { header: '主队', key: 'home', width: 16 },
  { header: '客队', key: 'away', width: 16 },
  { header: '开赛时间', key: 'kickoff', width: 12 },
  { header: '单关胜平负', key: 'singleText', width: 10 },
  { header: '实际进球', key: 'actualText', width: 9 },
  { header: '基线A预测', key: 'baseA', width: 10 },
  { header: '模型A预测', key: 'modelA', width: 10 },
  { header: '模型B预测', key: 'modelB', width: 10 },
  { header: '模型A命中', key: 'hitModelA', width: 10 },
  { header: '模型B命中', key: 'hitModelB', width: 10 },
  { header: '抓取时间', key: 'oddsAt', width: 16 },
  { header: '结果时间', key: 'resultAt', width: 16 }
];

function addMonthSheet(wb, month, rows) {
  const ws = wb.addWorksheet(month);
  ws.columns = MONTH_COLUMNS;
  rows.forEach(r => {
    ws.addRow({
      date: r.date, matchNumStr: r.matchNumStr, league: r.league, home: r.home, away: r.away,
      kickoff: r.kickoff,
      singleText: r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否'),
      actualText: r.actual == null ? '' : JC.labelG(r.actual),
      baseA: r.predBaseA == null ? '' : (JC.labelG(r.predBaseA) + (r.oddsBaseA != null ? ' @' + r.oddsBaseA : '')),
      modelA: r.predA == null ? '' : (JC.labelG(r.predA) + (r.oddsA != null ? ' @' + r.oddsA : '')),
      modelB: r.predB == null ? '' : (JC.labelG(r.predB) + (r.oddsB != null ? ' @' + r.oddsB : '')),
      hitModelA: r.hitModelA == null ? '' : (r.hitModelA ? '✓' : '✗'),
      hitModelB: r.hitModelB == null ? '' : (r.hitModelB ? '✓' : '✗'),
      oddsAt: JC.fmtAt(r.oddsAt), resultAt: JC.fmtAt(r.resultAt)
    });
  });
  const head = ws.getRow(1);
  styleHeader(head);
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 6 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: MONTH_COLUMNS.length } };
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const single = row.getCell('singleText');
    if (single.value === '是') single.font = { bold: true, color: { argb: COLOR_SINGLE } };
    else if (single.value === '否') single.font = { color: { argb: COLOR_MUTED } };
    ['hitModelA', 'hitModelB'].forEach(k => {
      const c = row.getCell(k);
      if (c.value === '✓') c.font = { bold: true, color: { argb: COLOR_POSITIVE } };
      else if (c.value === '✗') c.font = { color: { argb: COLOR_NEGATIVE } };
    });
    ['actualText', 'baseA', 'modelA', 'modelB'].forEach(k => { row.getCell(k).alignment = { horizontal: 'center' }; });
  }
  return ws;
}

// ---------------- 差值明细 ----------------
function addDiffDetailSheet(wb, rows) {
  const detail = rows.filter(r => r.diffs && r.hasDetail);
  const ws = wb.addWorksheet('差值明细');
  ws.columns = [
    { header: '日期', width: 12 }, { header: '编号', width: 9 }, { header: '主队', width: 15 }, { header: '客队', width: 15 },
    { header: '进球数', width: 8 },
    { header: '总进球赔率', width: 11 },
    { header: '优化赔率A(多选)', width: 14 }, { header: '差值A', width: 10 }, { header: '相对差值A(%)', width: 12 },
    { header: '平均赔率B', width: 11 }, { header: '差值B', width: 10 }, { header: '相对差值B(%)', width: 12 },
    { header: '比分(赔率)', width: 52 }
  ];
  styleHeader(ws.getRow(1));
  detail.forEach(r => {
    const gs = r.diffs.groups || [];
    gs.forEach(g => {
      const row = ws.addRow([
        r.date, r.matchNumStr, r.home, r.away, g.label,
        g.ttg, g.optA, g.diffA, g.relA != null ? Math.round(g.relA * 1000) / 10 : null,
        g.avgB, g.diffB, g.relB != null ? Math.round(g.relB * 1000) / 10 : null,
        g.scores.map(c => c.score + '=' + c.odds).join(' ')
      ]);
      row.getCell(6).numFmt = '0.00';
      row.getCell(7).numFmt = '0.000';
      row.getCell(8).numFmt = '+0.000;-0.000;0.000';
      row.getCell(9).numFmt = '+0.0;-0.0;0.0';
      row.getCell(10).numFmt = '0.00';
      row.getCell(11).numFmt = '+0.000;-0.000;0.000';
      row.getCell(12).numFmt = '+0.0;-0.0;0.0';
      if (typeof row.getCell(8).value === 'number') row.getCell(8).font = { color: { argb: row.getCell(8).value >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE } };
      if (g.g === 0) row.font = { color: { argb: COLOR_MUTED } }; // 0球为拟合值
    });
  });
  if (!detail.length) ws.addRow(['（暂无差值明细：需在售期抓取到含比分矩阵的快照后自动出现）']);
  return ws;
}

// ---------------- 模型统计 ----------------
function addModelSheet(wb, rows, config) {
  const ws = wb.addWorksheet('模型统计');
  ws.columns = [{ width: 22 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 40 }];
  const modelCfg = (config && config.model) || { windowDays: 30, maxActualRank: 6 };
  const st = JC.predStats(rows);

  ws.addRow(['进球数预测 · 模型统计（截至 ' + JC.nowIso() + '）']).font = { bold: true, size: 14 };
  ws.addRow([]);
  ws.addRow(['总体']).font = { bold: true, size: 12 };
  const pct = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');
  ws.addRow(['已出赛果场次', st.settled]);
  ws.addRow(['其中有预测的场次', st.withPred]);
  ws.addRow(['基线A 命中率（差值最小项）', st.baseA.n ? (st.baseA.hit + '/' + st.baseA.n + ' = ' + pct(st.baseA.rate)) : '—']);
  ws.addRow(['模型A 命中率（自修正）', st.modelA.n ? (st.modelA.hit + '/' + st.modelA.n + ' = ' + pct(st.modelA.rate)) : '—']);
  ws.addRow(['模型B 命中率（简单平均口径·对照）', st.modelB.n ? (st.modelB.hit + '/' + st.modelB.n + ' = ' + pct(st.modelB.rate)) : '—']);
  ws.addRow(['说明：口径B的平均赔率随比分个数放大，差值不可跨档比较，不产出基线预测（详见"说明"表）。']).font = { color: { argb: COLOR_MUTED } };
  ws.addRow([]);

  // 近 N 天窗口
  const endDate = JC.localDateStr();
  const winFrom = JC.addDays(endDate, -(modelCfg.windowDays || 30));
  const winRows = rows.filter(r => r.date >= winFrom);
  const stW = JC.predStats(winRows);
  ws.addRow([`近 ${modelCfg.windowDays || 30} 天窗口（${winFrom} ~ ${endDate}）`]).font = { bold: true, size: 12 };
  ws.addRow(['窗口内有预测场次', stW.withPred]);
  ws.addRow(['窗口基线A命中率', stW.baseA.n ? (stW.baseA.hit + '/' + stW.baseA.n + ' = ' + pct(stW.baseA.rate)) : '—']);
  ws.addRow(['窗口模型A命中率', stW.modelA.n ? (stW.modelA.hit + '/' + stW.modelA.n + ' = ' + pct(stW.modelA.rate)) : '—']);
  ws.addRow(['窗口模型B命中率', stW.modelB.n ? (stW.modelB.hit + '/' + stW.modelB.n + ' = ' + pct(stW.modelB.rate)) : '—']);
  ws.addRow([]);

  // 排名 × 进球数 命中率矩阵（口径A，窗口内样本，剔除爆冷后）
  ws.addRow([`自修正模型明细：各进球数在"差值排名 r"时的历史命中率（口径A，近 ${modelCfg.windowDays || 30} 天，剔除排名≥${modelCfg.maxActualRank || 6}的爆冷场）`]).font = { bold: true, size: 12 };
  const samples = [];
  winRows.forEach(r => {
    if (r.actual == null || !r.diffs) return;
    samples.push({ date: r.date, diffs: (r.diffs.groups || []).map(g => g.diffA), actual: r.actual });
  });
  const model = JC.modelTrain(samples, { maxActualRank: modelCfg.maxActualRank });
  ws.addRow(['学习样本', model.used + ' 场（另剔除爆冷 ' + model.excluded + ' 场）']).font = { color: { argb: COLOR_MUTED } };
  const headRow = ws.addRow(['进球数 ＼ 差值排名'].concat([1, 2, 3, 4, 5, 6, 7, 8].map(r => '第' + r)));
  styleHeader(headRow);
  for (let g = 0; g <= 7; g++) {
    const cells = [JC.labelG(g)];
    for (let r = 1; r <= 8; r++) {
      const cell = model.table[g][r];
      cells.push(cell.total ? (Math.round(cell.hit / cell.total * 100) + '% (' + cell.hit + '/' + cell.total + ')') : '');
    }
    const row = ws.addRow(cells);
    row.getCell(1).font = { bold: true };
    for (let r = 1; r <= 8; r++) {
      const c = row.getCell(r + 1);
      c.alignment = { horizontal: 'center' };
      const cell = model.table[g][r];
      if (cell.total >= 3 && cell.hit / cell.total >= 0.5) c.font = { bold: true, color: { argb: COLOR_POSITIVE } };
      else if (cell.total) c.font = { color: { argb: COLOR_MUTED } };
    }
  }
  ws.addRow([]);
  ws.addRow(['说明：模型的预测 = 取"该进球数在它当前差值排名下、历史上命中率最高"的进球数（平滑处理，样本<3 的行仅供参考）。']);
  return ws;
}

// ---------------- 编号统计 / 编号追踪 ----------------
function addNumbersSheets(wb, numsDoc) {
  const st = JC.numbersStats(numsDoc || {}, {});
  if (!st.days) return;
  const ws1 = wb.addWorksheet('编号统计');
  ws1.columns = [{ header: '编号', width: 8 }, { header: '出现天数', width: 10 }]
    .concat(st.buckets.map(b => ({ header: b.label, width: 9 })));
  st.nums.forEach(n => {
    const r = ws1.addRow([n.num, n.occurrences].concat(n.counts));
    if (!n.active) r.font = { color: { argb: COLOR_MUTED } };
  });
  styleHeader(ws1.getRow(1));
  ws1.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];

  const ws2 = wb.addWorksheet('编号追踪');
  ws2.columns = [{ width: 12 }].concat(st.buckets.map(() => ({ width: 9 })));
  ws2.addRow(['编号追踪：单元格 = 该编号该档进球数的"连续未出现次数"（该编号每踢一场未出该档 +1；截至 ' + st.lastDate + '，警戒线 ' + st.alertCount + ' 次）']).font = { bold: true, size: 12 };
  ws2.addRow([]);
  ws2.addRow(['⚠ 达到警戒线的项目（按连续未出现次数排序）']).font = { bold: true, size: 12 };
  const hh = ws2.addRow(['编号', '进球数', '连续未出现(次)', '最近出现', '历史次数']);
  styleHeader(hh);
  if (st.alerts.length) {
    st.alerts.forEach(a => {
      const r = ws2.addRow([a.num, a.label, a.streak, a.lastDate, a.count]);
      r.font = { bold: true, color: { argb: COLOR_NEGATIVE } };
    });
  } else {
    ws2.addRow(['（当前没有项目超过警戒线）']);
  }
  ws2.addRow([]);
  ws2.addRow(['全部编号 × 进球数矩阵（数字=连续未出现次数；"从未"=历史数据中未出现过）']).font = { italic: true, size: 11 };
  const mh = ws2.addRow(['编号'].concat(st.buckets.map(b => b.label)));
  styleHeader(mh);
  st.nums.forEach(n => {
    const row = ws2.addRow([n.num + (n.active ? '' : '(停用)')].concat(n.combos.map(c => c.never ? '从未' : c.streak)));
    row.getCell(1).alignment = { horizontal: 'center' };
    n.combos.forEach((c, i) => {
      const cell = row.getCell(i + 2);
      cell.alignment = { horizontal: 'center' };
      if (!c.never) {
        if (c.streak >= st.alertCount) {
          cell.font = { bold: true, color: { argb: COLOR_NEGATIVE } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7D7' } };
        } else if (c.streak >= st.alertCount * 0.6) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDEBD0' } };
        }
      } else {
        cell.font = { color: { argb: COLOR_MUTED } };
      }
    });
  });
}

// ---------------- 说明 ----------------
function addHelpSheet(wb, config) {
  const ws = wb.addWorksheet('说明');
  ws.columns = [{ width: 112 }];
  const modelCfg = (config && config.model) || { windowDays: 30, maxActualRank: 6 };
  const lines = [
    '竞彩足球「各进球数赔率 vs 比分优化赔率」差值分析与进球数预测',
    '',
    '【核心公式】',
    '  对每个进球数 G（0球~7+球）：',
    '    口径A（多选优化保底）: 优化赔率A = 1 ÷ Σ(1/该进球数每个比分的赔率)',
    '      含义：把 1 元按赔率倒数比例拆注押该进球数的所有比分，无论哪个比分命中，',
    '      保底回报 = 优化赔率A（1球时即 6.40×10.50/(6.40+10.50) 这类公式）',
    '      注意：7+球 = 比分矩阵中总进球≥7的格子（仅 5:2、2:5）∪ 胜其他/平其他/负其他 三档',
    '      （真正的 6:0、4:3、6:1 等 7+ 比分都在"其他"里）；缺"其他"档时 7+ 不参与预测',
    '    口径B（简单平均）: 平均赔率B = 该进球数各比分赔率的算术平均',
    '    差值A = 总进球G赔率 − 优化赔率A；差值B = 总进球G赔率 − 平均赔率B',
    '    相对差值 = 总进球G赔率 ÷ 优化(平均)赔率 − 1（百分比，仅记录参考）',
    '  · 0球只有 0:0 一个比分，无法优化/平均 → 无差值；',
    '    0球的差值由"全进球数二次曲线拟合"给出（用 g=1..7 的真实差值外推，不按 0 硬填）。',
    '',
    '【预测双轨】',
    '  基线：预测 = 差值最小的进球数（0球用拟合值参与比较）',
    '  自修正模型：按"差值排名 × 进球数"统计近 ' + (modelCfg.windowDays || 30) + ' 天的历史命中率，',
    '    取"该进球数在当前排名下命中率最高"者作为预测；',
    '    稳健性：赛果排名 ≥ ' + (modelCfg.maxActualRank || 6) + ' 的深冷门场次不纳入学习（防爆冷破坏函数）。',
    '  每场比赛的预测在其赛果落定时冻结（只使用该场之前的数据，杜绝未来数据泄漏），两轨同场对比。',
    '',
    '【模拟投注】',
    '  · 每场固定投入（config.json 的 bet.stake，默认 100 元）押"预测的进球数"（三条轨道分别统计：模型A/基线A/模型B）；',
    '  · 猜中按该场【最后一次记录】的该进球数赔率返还，未中损失本金；',
    '  · 「模拟投注」表含：汇总、逐场明细（含累计盈亏）、逐日汇总；网页统计页有对应的每日盈亏图。',
    '',
    '【数据口径】',
    '  · 赔率、赛果来自中国体育彩票官方 Web API；每次抓取保留完整玩法池（总进球0-7+、比分矩阵）。',
    '  · 预测列格式"X球 @赔率"：@后为该预测进球数对应的赔率（该场最后一次记录），便于核对与回测对照。',
    '  · 凌晨开赛的比赛属于前一"销售日"（预测窗口按销售日切分）。',
    '  · 由于需保存完整比分矩阵，本功能仅对"升级后抓取"的场次生效（旧快照只有1球数据）。',
    '',
    '【免责声明】',
    '  本表仅为个人数据分析用途，数据版权归中国体育彩票（sporttery.cn）所有，不构成任何投注建议。'
  ];
  lines.forEach((t, i) => {
    const row = ws.addRow([t]);
    if (i === 0) row.font = { bold: true, size: 14 };
    if (/^【.*】$/.test(t)) row.font = { bold: true, size: 12 };
  });
  return ws;
}

// ---------------- 模拟投注 ----------------
function addBetSheet(wb, rows, config) {
  const stake = (config.bet && config.bet.stake) || 100;
  const bet = JC.bettingStats(rows, stake);
  const ws = wb.addWorksheet('模拟投注');
  ws.columns = [{ width: 12 }, { width: 10 }, { width: 13 }, { width: 15 }, { width: 15 },
    { width: 9 }, { width: 9 }, { width: 9 }, { width: 11 }, { width: 12 }, { width: 11 }, { width: 11 }];
  ws.addRow(['模拟投注：每场固定 ' + stake + ' 元押"预测的进球数"；猜中按该场最后一次记录的该进球数赔率返还（口径与网页一致，可在 config.json 的 bet.stake 调整金额）']).font = { bold: true, size: 12 };
  ws.addRow([]);
  ws.addRow(['汇总']).font = { bold: true, size: 12 };
  styleHeader(ws.addRow(['轨道', '投注场次', '命中', '总投入', '总回报', '净盈亏', '回报率']));
  const betLabel = { modelA: '模型A（自修正）', baseA: '基线A（差值最小项）', modelB: '模型B（对照）' };
  ['modelA', 'baseA', 'modelB'].forEach(k => {
    const t = bet.tracks[k];
    const r = ws.addRow([betLabel[k], t.bets, t.wins, t.staked, t.returned, t.profit, t.roi == null ? null : t.roi]);
    r.getCell(7).numFmt = '0.0%';
    if (t.profit != null) r.getCell(6).font = { bold: true, color: { argb: t.profit >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE } };
  });
  ws.addRow([]);
  ws.addRow(['逐场明细（模型A 为主，另列其他轨道盈亏；累计为模型A）']).font = { bold: true, size: 12 };
  styleHeader(ws.addRow(['日期', '编号', '联赛', '主队', '客队', '预测A', '赔率A', '实际进球', '模型A盈亏', '模型A累计', '基线A盈亏', '模型B盈亏']));
  bet.details.forEach(d => {
    const r = ws.addRow([d.date, d.matchNumStr, d.league, d.home, d.away,
      JC.labelG(d.predA), d.oddsA, JC.labelG(d.actual), d.pnlA, d.cumA, d.pnlBaseA, d.pnlB]);
    r.getCell(7).numFmt = '0.00';
    [9, 10, 11, 12].forEach(i => { r.getCell(i).numFmt = '+0.00;-0.00;0.00'; });
    if (d.pnlA != null) r.getCell(9).font = { color: { argb: d.pnlA >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE } };
    if (d.cumA != null) r.getCell(10).font = { bold: true, color: { argb: d.cumA >= 0 ? COLOR_POSITIVE : COLOR_NEGATIVE } };
  });
  if (!bet.details.length) ws.addRow(['（暂无：需完整比分池快照 + 已冻结预测 + 已出赛果）']);
  ws.addRow([]);
  ws.addRow(['逐日汇总']).font = { bold: true, size: 12 };
  styleHeader(ws.addRow(['日期', '场次', '模型A命中', '当日(模型A)', '累计(模型A)', '累计(基线A)', '累计(模型B)']));
  bet.summaryDaily.forEach(d => {
    const r = ws.addRow([d.date, d.bets, d.winsA, d.modelA, d.cumModelA, d.cumBaseA, d.cumModelB]);
    [4, 5, 6, 7].forEach(i => { r.getCell(i).numFmt = '+0.00;-0.00;0.00'; });
  });
  if (!bet.summaryDaily.length) ws.addRow(['（暂无）']);
  return ws;
}

async function generateExcel() {
  const config = loadJson(path.join(ROOT, 'config.json'), {});
  const index = loadJson(path.join(DATA_DIR, 'index.json'), { dates: {} });
  const dates = Object.keys(index.dates || {}).sort();
  const docs = dates.map(d => loadJson(path.join(DAYS_DIR, d + '.json'), null)).filter(Boolean);
  const rows = JC.flatRows(docs);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'jingcai-goals-predict';
  wb.created = new Date();

  const months = {};
  rows.forEach(r => {
    const m = String(r.date).slice(0, 7);
    (months[m] = months[m] || []).push(r);
  });
  Object.keys(months).sort().forEach(m => addMonthSheet(wb, m, months[m]));
  if (!rows.length) wb.addWorksheet('数据（暂无）');
  addDiffDetailSheet(wb, rows);
  addModelSheet(wb, rows, config);
  addBetSheet(wb, rows, config);
  addNumbersSheets(wb, loadJson(path.join(DATA_DIR, 'numbers.json'), null));
  addHelpSheet(wb, config);

  fs.mkdirSync(EXCEL_DIR, { recursive: true });
  const file = path.join(EXCEL_DIR, '竞彩进球数预测.xlsx');
  await wb.xlsx.writeFile(file);
  // 旧的 1 球文件名清理（存在则删除，避免混淆）
  const oldFile = path.join(EXCEL_DIR, '竞彩1球-差值记录.xlsx');
  if (fs.existsSync(oldFile)) { try { fs.unlinkSync(oldFile); } catch (e) {} }

  // CSV：预测主表
  const csvHead = ['日期', '场次编号', '联赛', '主队', '客队', '开赛时间', '单关胜平负', '实际进球',
    '基线A预测', '模型A预测', '模型B预测', '模型A命中', '模型B命中', '抓取时间', '结果时间'];
  const csvLines = [csvHead.join(',')];
  const esc = s => { s = s == null ? '' : String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  rows.forEach(r => {
    csvLines.push([
      r.date, r.matchNumStr, r.league, r.home, r.away, r.kickoff,
      r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否'),
      r.actual == null ? '' : JC.labelG(r.actual),
      r.predBaseA == null ? '' : (JC.labelG(r.predBaseA) + (r.oddsBaseA != null ? ' @' + r.oddsBaseA : '')),
      r.predA == null ? '' : (JC.labelG(r.predA) + (r.oddsA != null ? ' @' + r.oddsA : '')),
      r.predB == null ? '' : (JC.labelG(r.predB) + (r.oddsB != null ? ' @' + r.oddsB : '')),
      r.hitModelA == null ? '' : (r.hitModelA ? '√' : '×'),
      r.hitModelB == null ? '' : (r.hitModelB ? '√' : '×'),
      JC.fmtAt(r.oddsAt), JC.fmtAt(r.resultAt)
    ].map(esc).join(','));
  });
  fs.writeFileSync(path.join(EXCEL_DIR, 'records.csv'), '﻿' + csvLines.join('\r\n'), 'utf8');

  return { file, rows: rows.length, dates: dates.length };
}

if (require.main === module) {
  generateExcel().then(info => {
    console.log('Excel 已生成：' + info.file + '（' + info.rows + ' 行，' + info.dates + ' 天）');
  }).catch(e => { console.error('生成失败：', e); process.exit(1); });
}

module.exports = { generateExcel };
