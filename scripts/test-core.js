#!/usr/bin/env node
/**
 * 核心逻辑自检（不访问网络）：node scripts/test-core.js
 * 覆盖：进球数差值（两口径）、0球曲线拟合、自修正模型（训练/预测/爆冷剔除）、
 *       预测冻结（防泄漏）、展平/命中统计、编号追踪、销售日归属、旧数据兼容
 */
'use strict';

const JC = require('../docs/core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  →  ' + extra : '')); }
}
function near(a, b, eps) { return a != null && b != null && Math.abs(a - b) <= (eps || 0.0005); }

console.log('== 基础工具 ==');
{
  ok('goalsFromScore', JC.goalsFromScore('2:1') === 3 && JC.goalsFromScore('0:0') === 0 && JC.goalsFromScore('') === null);
  ok('bucketOfGoals（7+归并）', JC.bucketOfGoals(7) === 7 && JC.bucketOfGoals(9) === 7 && JC.bucketOfGoals(0) === 0);
  ok('numOf / slateDateOf', JC.numOf('周日001') === '001' &&
    JC.slateDateOf('周三004', '2026-09-02') === '2026-09-02' &&
    JC.slateDateOf('周二004', '2026-09-02') === '2026-09-01');
  ok('resultRangeFor', JC.resultRangeFor('2026-09-30')[1] === '2026-10-01');
}

console.log('== 曲线拟合（0球差值）==');
{
  // 二次曲线 y = 2 - x + 0.5x²：点 (1,1.5) (2,2) (3,3.5) → x=0 处应为 2
  ok('二次拟合取 x=0', near(JC.fitValueAt0([1, 2, 3], [1.5, 2, 3.5]), 2, 0.001));
  // 两点退化为直线：(1,3) (2,1) → x=0 处 5
  ok('两点退化为直线', near(JC.fitValueAt0([1, 2], [3, 1]), 5, 0.001));
  ok('不足两点返回 null', JC.fitValueAt0([1], [3]) === null);
}

console.log('== 进球数差值（两种口径）==');
{
  const odds = {
    goals: [9.50, 4.10, 4.30, 5.20, 9.00, 19.0, 41.0, 15.0],   // 0..7+ 总进球赔率
    scores: {
      '0:0': 9.50,
      '1:0': 6.40, '0:1': 10.50,
      '1:1': 6.80, '2:0': 9.00, '0:2': 13.00,
      '2:1': 8.00, '1:2': 11.00, '3:0': 15.00,
      '4:0': 41.0, '3:1': 21.0, '2:2': 13.0,
      '5:2': 51.0, '4:3': 61.0, '3:4': 71.0, '2:5': 81.0, '4:4': 91.0
    },
    other: { win: 15.0, draw: 21.0, lose: 25.0 }
  };
  const d = JC.goalDiffs(odds);
  ok('返回 8 个进球数分组', d && d.groups.length === 8);
  const g1 = d.groups[1];
  ok('1球口径A = 1/(1/6.4+1/10.5) ≈ 3.976', near(g1.optA, 3.976));
  ok('1球口径A差值 = +0.124', near(g1.diffA, 0.124));
  ok('1球口径B均值 = 8.45，差值 = -4.35', near(g1.avgB, 8.45) && near(g1.diffB, -4.35));
  const g2 = d.groups[2];
  ok('2球口径A = 1/(1/6.8+1/9+1/13) ≈ 2.984', near(g2.optA, 2.984, 0.002));
  ok('2球口径B均值 = 9.60', near(g2.avgB, 9.6));
  ok('0球两种口径均无差值', d.groups[0].optA === null && d.groups[0].avgB === null);
  ok('0球差值来自拟合（非空）', d.groups[0].diffA != null && d.fit0A != null);
  ok('7+球含矩阵≥7的比分 + 其他三档（共8项）', d.groups[7].scores.length === 8, 'len=' + d.groups[7].scores.length);
  ok('7+球包含胜/平/负其他', d.groups[7].scores.some(s => s.score === '胜其他') &&
    d.groups[7].scores.some(s => s.score === '平其他') && d.groups[7].scores.some(s => s.score === '负其他'));
  ok('1球相对差值A ≈ +3.1%', near(g1.relA, 0.0312, 0.001), 'relA=' + g1.relA);
  ok('基线预测为合法进球数（B口径不产出基线）', d.predBaseA >= 0 && d.predBaseA <= 7 && d.predBaseB === null);
  // 无完整池（旧数据）返回 null
  ok('旧数据（无比分矩阵）返回 null', JC.goalDiffs({ ttg1: 4.1, s10: 6.4, s01: 10.5, had: [] }) === null);

  // ★ 回归测试（用户实测报告）：7+球只含 5:2/2:5 两个冷门格时差值会异常巨大（约 −45），
  //   必须并入"其他"三档后 7+ 差值回到正常量级、不再霸占"差值最小"。
  {
    const realLike = {
      goals: [10.5, 4.4, 3.2, 3.8, 6.2, 12.5, 25, 40],
      scores: {
        '0:0': 10.5, '1:0': 6.4, '0:1': 10.5, '1:1': 6.8, '2:0': 9.0, '0:2': 13.0,
        '2:1': 8.0, '1:2': 11.0, '3:0': 15.0, '3:1': 21.0, '2:2': 13.0, '3:2': 28.0,
        '4:0': 41.0, '4:1': 45.0, '4:2': 55.0, '5:0': 90.0, '5:1': 95.0, '2:5': 200.0, '5:2': 150.0
      },
      other: { win: 55, draw: 550, lose: 300 }
    };
    const dr = JC.goalDiffs(realLike);
    ok('7+球差值回到正常量级（> 0）', dr.groups[7].diffA != null && dr.groups[7].diffA > 0, 'diff7=' + dr.groups[7].diffA);
    ok('差值最小不再是 7+球', dr.predBaseA !== 7, 'pred=' + dr.predBaseA);
    // 缺"其他"三档时：7+ 不参与预测（保守处理）
    const noOther = JSON.parse(JSON.stringify(realLike));
    delete noOther.other;
    const dr2 = JC.goalDiffs(noOther);
    ok('缺其他档时 7+ 差值为 null 且不参与预测', dr2.groups[7].diffA === null && dr2.predBaseA !== 7);
  }
}

console.log('== 自修正模型（排名×进球数 命中率表）==');
{
  // 构造样本：2球 在差值排名第2时连续命中 4 次；0球 排名第1 命中 1 次
  const mkDiffs = (targetG, rank) => {
    // 8 个差值按 1..8 排布，目标进球数的值 = rank（排名即 rank，无并列）
    const others = [];
    for (let i = 0; i < 8; i++) if (i !== targetG) others.push(i);
    const vals = new Array(8);
    let vi = 0;
    for (let r = 1; r <= 8; r++) {
      if (r === rank) vals[targetG] = r;
      else { vals[others[vi]] = r; vi++; }
    }
    return vals;
  };
  const samples = [];
  for (let i = 0; i < 4; i++) samples.push({ date: 'D' + i, diffs: mkDiffs(2, 2), actual: 2 });
  samples.push({ date: 'D9', diffs: mkDiffs(0, 1), actual: 0 });
  samples.push({ date: 'D8', diffs: mkDiffs(5, 8), actual: 5 });   // 深冷门：应被剔除
  const model = JC.modelTrain(samples, { maxActualRank: 6 });
  ok('剔除深冷门 1 场', model.excluded === 1, 'excluded=' + model.excluded);
  ok('2球×排名2 命中 4 次', model.table[2][2].hit === 4 && model.table[2][2].total === 4);
  const pred = JC.modelPredict(model, mkDiffs(2, 2), 0);
  ok('模型预测：2球排名2 → 预测 2球', pred === 2, 'pred=' + pred);
  // 数据不足时回退基线
  const predFallback = JC.modelPredict(null, mkDiffs(3, 3), 3);
  ok('无模型回退基线', predFallback === 3);
}

console.log('== 预测冻结（防未来数据泄漏）==');
{
  const capOdds = {
    goals: [9.50, 4.10, 4.30, 5.20, 9.00, 19.0, 41.0, 15.0],
    scores: { '0:0': 9.5, '1:0': 6.4, '0:1': 10.5, '1:1': 6.8, '2:0': 9.0, '0:2': 13.0, '2:1': 8.0, '3:1': 21.0 }
  };
  const mkMatch = (id, slate, actual) => ({
    matchId: id, businessDate: slate, matchDate: slate, matchNumStr: '周一00' + id,
    captures: [{ at: slate + 'T11:00:00+08:00', odds: JSON.parse(JSON.stringify(capOdds)) }],
    result: actual != null ? { score: actual, goals: JC.goalsFromScore(actual), at: slate + 'T23:00:00+08:00' } : null,
    pred: null
  });
  const pool = [mkMatch(1, '2026-09-20', '2:1'), mkMatch(2, '2026-09-21', '1:0'), mkMatch(3, '2026-09-22', '0:0'), mkMatch(4, '2026-09-23', null)];
  // 冻结第 4 场的预测：窗口只应含前三场（销售日 < 09-23）
  const pred = JC.freezePrediction(pool[3], pool, { model: { windowDays: 30, maxActualRank: 6 } });
  ok('冻结预测含基线A与模型（B口径无基线）', pred && pred.baseA != null && pred.modelA != null && pred.baseB === null && pred.modelB != null);
  ok('冻结窗口为之前的 3 场', pred.windowA === 3, 'windowA=' + pred.windowA);
  const s = JC.modelSamples(pool, 'diffA', { windowDays: 30, endDate: '2026-09-23' });
  ok('样本不含当日及以后（防泄漏）', s.length === 3);
  const s2 = JC.modelSamples(pool, 'diffA', { windowDays: 1, endDate: '2026-09-23' });
  ok('窗口天数过滤有效（近1天）', s2.length === 1, 'len=' + s2.length);
}

console.log('== 展平与命中统计 ==');
{
  const capOdds = {
    goals: [9.50, 4.10, 4.30, 5.20, 9.00, 19.0, 41.0, 15.0],
    scores: { '0:0': 9.5, '1:0': 6.4, '0:1': 10.5, '1:1': 6.8, '2:0': 9.0, '0:2': 13.0, '2:1': 8.0, '3:1': 21.0 }
  };
  const day = { date: '2026-09-20', matches: [
    { matchId: 1, businessDate: '2026-09-20', matchDate: '2026-09-20', matchNumStr: '周日001', league: 'X', home: 'A', away: 'B',
      isSingleWin: true, captures: [{ at: '2026-09-20T11:00:00+08:00', odds: JSON.parse(JSON.stringify(capOdds)) }],
      result: { score: '2:1', goals: 3, at: 'T' }, pred: { baseA: 2, modelA: 2, baseB: 3, modelB: 2, at: 'T' } },
    { matchId: 2, businessDate: '2026-09-20', matchNumStr: '周日002', league: 'X', home: 'C', away: 'D',
      captures: [{ at: '2026-09-20T11:00:00+08:00', odds: { ttg1: 4.1, s10: 6.4, s01: 10.5, had: [] } }],
      result: null, pred: null }
  ] };
  const rows = JC.flatRows([day]);
  const r1 = rows.find(r => r.matchNumStr === '周日001');
  ok('v3 场次含差值明细', r1.hasDetail === true && r1.diffs.groups.length === 8);
  ok('命中判定：实际3球 vs 预测2球', r1.actual === 3 && r1.hitBaseA === false && r1.hitModelA === false);
  ok('数据行携带 matchId（用于详情页链接）', r1.matchId === 1);
  ok('预测赔率一并携带（2球赔率 4.30）', r1.oddsBaseA === 4.3 && r1.oddsA === 4.3, 'oA=' + r1.oddsA);
  const r2 = rows.find(r => r.matchNumStr === '周日002');
  ok('旧格式快照 → 无明细、无预测、无赔率', r2.hasDetail === false && r2.predA === null && r2.oddsA === null);
  ok('官方详情接口 URL', JC.matchHeadUrl(123).indexOf('sportteryMatchId=123') > 0 &&
    JC.officialDetailUrl(123, 2).indexOf('showType=2&mid=123') > 0);
  const st = JC.predStats(rows);
  ok('统计：1 场已出、基线 n=1', st.settled === 1 && st.baseA.n === 1 && st.baseA.hit === 0);
  ok('各进球数分布', st.byGoal[3] === 1);
}

console.log('== 编号追踪（保持功能）==');
{
  const doc = { alertCount: 2, days: {
    '2026-09-01': { '001': 2, '002': 0 },
    '2026-09-02': { '001': 0, '002': 1 },
    '2026-09-03': { '001': 3, '002': 2 },
    '2026-09-04': { '001': 1, '002': 5 }
  } };
  const st = JC.numbersStats(doc);
  ok('基本统计（4天/2编号）', st.days === 4 && st.nums.length === 2);
  const n1 = st.nums.find(n => n.num === '001');
  ok('001的2球 连续 3 次未出', n1.combos[2].streak === 3 && n1.combos[2].count === 1);
  ok('警戒按次数（≥2）', st.alerts.length > 0 && st.alerts.every(a => a.streak >= 2));
  const stB = JC.numbersStats({ nums: ['001'], buckets: JC.parseGoalGroups('0,1,2,3,4,5+'), days: doc.days });
  ok('关注范围与分档生效', stB.nums.length === 1 && stB.buckets.length === 6 && stB.nums[0].combos.length === 6);
}

console.log('== 合并与兼容 ==');
{
  const inc = JC.parseOdds({ value: { matchInfoList: [{ businessDate: '2026-09-20', subMatchList: [{
    matchId: 7, businessDate: '2026-09-20', matchDate: '2026-09-20', matchNumStr: '周日007',
    leagueAbbName: 'L', homeTeamAbbName: 'H', awayTeamAbbName: 'A', matchTime: '20:00:00',
    ttg: { s0: '9.5', s1: '4.1', s2: '4.3' }, crs: { s01s00: '6.4', s00s01: '10.5' },
    poolList: [{ poolCode: 'HAD', single: 1 }]
  }] }] } }, 'T1');
  ok('parseOdds 抓取完整池', inc[0].captures[0].odds.goals && inc[0].captures[0].odds.goals[1] === 4.1);
  ok('single 标记保留', inc[0].isSingleWin === true);
  let day = { date: '2026-09-20', matches: [] };
  const r = JC.mergeDay(day, inc, '2026-09-20T11:00:00+08:00');
  ok('mergeDay 正常', r.added === 1 && r.day.matches[0].pred === null);
}

console.log('== 模拟投注 ==');
{
  const mkRow = (date, pred, actual, odds) => ({
    date, matchNumStr: 'X', league: 'L', home: 'H', away: 'A',
    predA: pred, predBaseA: pred, predB: pred === 1 ? null : pred, actual,
    diffs: { groups: [0, 1, 2, 3, 4, 5, 6, 7].map(g => ({ g, ttg: g === pred ? odds : 9 })) }
  });
  const rows = [
    mkRow('2026-10-01', 2, 2, 4.0),   // 中：+300
    mkRow('2026-10-01', 1, 0, 3.0),   // 挂：-100
    mkRow('2026-10-02', 3, 2, 5.0),   // 挂：-100
    { date: '2026-10-02', matchNumStr: 'Y', predA: null, predBaseA: null, predB: null, actual: 1, diffs: null } // 无预测跳过
  ];
  const bet = JC.bettingStats(rows, 100);
  const t = bet.tracks;
  ok('模型A：3注1中 投入300 回报400 盈亏+100', t.modelA.bets === 3 && t.modelA.wins === 1 &&
    t.modelA.staked === 300 && t.modelA.returned === 400 && near(t.modelA.profit, 100));
  ok('模型A 回报率 ≈ 33.3%', near(t.modelA.roi, 1 / 3, 0.001));
  ok('基线A 与模型A一致（同预测）', t.baseA.bets === 3 && near(t.baseA.profit, 100));
  ok('模型B：2注1中 盈亏+200', t.modelB.bets === 2 && t.modelB.wins === 1 && near(t.modelB.profit, 200));
  ok('逐日：10-01 模型A +200', bet.summaryDaily[0].date === '2026-10-01' && near(bet.summaryDaily[0].modelA, 200) && bet.summaryDaily[0].winsA === 1);
  ok('逐日累计：10-02 模型A=+100 基线A=+100 模型B=+200',
    near(bet.summaryDaily[1].cumModelA, 100) && near(bet.summaryDaily[1].cumBaseA, 100) && near(bet.summaryDaily[1].cumModelB, 200));
  ok('逐场明细含赔率与累计', bet.details.length === 3 && bet.details[0].oddsA === 4.0 &&
    near(bet.details[0].cumA, 300) && near(bet.details[2].cumA, 100));
  // 该档无赔率时跳过该轨道
  const noOdds = [mkRow('2026-10-03', 4, 4, null)];
  const bet2 = JC.bettingStats(noOdds, 100);
  ok('无赔率不下注', bet2.tracks.modelA.bets === 0 && bet2.details.length === 0);
  // 自定义金额
  const bet3 = JC.bettingStats([mkRow('2026-10-04', 2, 2, 4.0)], 50);
  ok('自定义金额 50 元', near(bet3.tracks.modelA.profit, 150) && bet3.tracks.modelA.staked === 50);
}

console.log('== 取消/推迟场次 ==');
{
  const day = { date: '2026-10-01', matches: [
    { matchId: 1, matchDate: '2026-10-01', matchNumStr: 'A', captures: [], result: null },
    { matchId: 2, matchDate: '2026-10-01', matchNumStr: 'B', captures: [], result: null }
  ] };
  const rs = JC.parseResults([
    { matchId: 1, sectionsNo999: '取消', sectionsNo1: '', matchResultStatus: '0', matchDate: '2026-10-01' },
    { matchId: 2, sectionsNo999: '1:0', sectionsNo1: '0:0', matchResultStatus: '2', matchDate: '2026-10-03' } // 推迟2天
  ]);
  const r = JC.applyResults(day, rs, 'T');
  ok('取消场标记', day.matches[0].result && day.matches[0].result.cancelled === true);
  ok('推迟场标记（补赛日期≠原日期）', day.matches[1].result && day.matches[1].result.rescheduled === true && day.matches[1].result.score === '1:0');
  ok('changed 计数 = 2', r.changed === 2);
  const rows = JC.flatRows([day]);
  ok('flatRows 排除标记', rows.find(x => x.matchId === 1).excluded === true && rows.find(x => x.matchId === 2).excluded === true);
  // predStats / bettingStats 排除
  const st = JC.predStats([{ date: 'D', actual: 1, excluded: true, predBaseA: 1, hitBaseA: true, baseA: 1, predA: 1, hitModelA: true, predB: null, hitModelB: null, predBaseB: null, o1: {}, o2: {} }]);
  ok('predStats 排除取消/推迟', st.settled === 0 && st.modelA.n === 0);
  const bt = JC.bettingStats([{ date: 'D', actual: 1, excluded: true, diffs: { groups: [{ g: 1, ttg: 2 }] }, predA: 1, predBaseA: 1, predB: null, matchNumStr: 'X', league: 'L', home: 'H', away: 'A' }], 100);
  ok('bettingStats 排除取消/推迟', bt.tracks.modelA.bets === 0 && bt.details.length === 0);
  // modelSamples 排除（推迟）
  const pools = { goals: new Array(8).fill(2), scores: { '1:0': 5, '0:1': 6 } };
  const m1 = { matchId: 3, businessDate: '2026-10-01', result: { score: '1:0', rescheduled: true }, captures: [{ at: 'T', odds: pools }] };
  const m2 = { matchId: 4, businessDate: '2026-10-01', result: { score: '1:0' }, captures: [{ at: 'T', odds: pools }] };
  const m3 = { matchId: 5, businessDate: '2026-10-01', result: { score: null, cancelled: true }, captures: [{ at: 'T', odds: pools }] };
  const s = JC.modelSamples([m1, m2, m3], 'diffA', {});
  ok('modelSamples 排除推迟与取消场', s.length === 1 && s[0].actual === 1);
}

console.log('== 多因子修正模型（v4）==');
{
  // 构造一年式历史：'大球联' 恒 4:2（总6球），'小球联' 恒 0:1（总1球）
  const hist = { days: {} };
  let id = 1;
  for (let i = 0; i < 40; i++) {
    const d = JC.addDays('2026-01-01', i);
    hist.days[d] = {};
    hist.days[d]['h' + (id++)] = ['大球联', '攻强队', '客弱队' + i, 4, 2];
    hist.days[d]['h' + (id++)] = ['小球联', '守强队' + i, '守强队B' + i, 0, 1];
  }
  const rows = JC.historyRows(hist, null);
  ok('historyRows：提取全部比赛行', rows.length === 80);
  ok('historyRows：按日期过滤（防泄漏）', JC.historyRows(hist, '2026-01-11').length === 20);
  const t = JC.factorTables(rows);
  ok('factorTables：统计规模与球队攻防', t.n === 80 && t.leagues['大球联'].n === 40 && t.teams['攻强队'].gf === 160);

  // 无排名样本（diffs 全平）时，预测由联赛/球队因子决定：大球联 → 高进球，小球联 → 低进球
  const histBase = JSON.parse(JSON.stringify(hist)); // 快照：后续权重测试会往 hist 里追加实盘行
  const engine = JC.factorEngine({ matches: [], history: histBase, model: { windowDays: 30, maxActualRank: 6 } });
  const diffsFlat = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const pBig = engine.predictFor({ businessDate: '2026-02-20', league: '大球联', home: '攻强队', away: '某队X' }, diffsFlat);
  const pSmall = engine.predictFor({ businessDate: '2026-02-20', league: '小球联', home: '守强队z', away: '守强队y' }, diffsFlat);
  ok('联赛因子生效：大球联 → 高进球档', pBig && pBig.goal >= 5, 'goal=' + (pBig && pBig.goal));
  ok('联赛因子生效：小球联 → 低进球档', pSmall && pSmall.goal <= 2, 'goal=' + (pSmall && pSmall.goal));
  ok('预测附带因子信息（权重/历史样本数）', pBig && pBig.info && pBig.info.w.length === 5 && pBig.info.histN === 80);
  ok('球队因子期望进球：攻强队高于未知客队', pBig && pBig.info.lh != null && pBig.info.la != null && pBig.info.lh > pBig.info.la);

  // 市场因子：赔率隐含分布（低赔率档=市场峰值）
  const md = JC.marketDist([10, 8, 3.2, 4.5, 9, 19, 41, 15]);
  ok('市场因子：峰值在最低赔率档（2球）', md && md.indexOf(Math.max.apply(null, md)) === 2);
  ok('市场因子：缺赔率返回 null', JC.marketDist(null) === null && JC.marketDist([]) === null);

  // 趋势因子：较早→最新快照的差值变化（差值缩小的档被看好）
  const mkTOdds = (g3ttg) => ({
    goals: [9.5, 4.1, 4.3, g3ttg, 9.0, 19, 41, 15],
    scores: { '0:0': 9.5, '1:0': 6.4, '0:1': 10.5, '1:1': 6.8, '2:0': 9.0, '0:2': 13.0, '2:1': 8.0, '1:2': 11.0, '3:1': 21.0 }
  });
  const td = JC.trendDist([{ at: 'T1', odds: mkTOdds(5.2) }, { at: 'T2', odds: mkTOdds(4.4) }]);
  // 注意：0球的"拟合差值"随全曲线平移，会与 3球并列峰值（合理行为）；关键是 3球须严格高于未变化的 1/2 球
  const tdVals = td ? td.filter(v => v != null) : [];
  ok('趋势因子：3球差值缩小→趋势看好 3球', td && td[3] === Math.max.apply(null, tdVals) && td[3] > td[1] && td[3] > td[2],
    'td=' + JSON.stringify(td));
  ok('趋势因子：单快照不参与（null）', JC.trendDist([{ at: 'T1', odds: mkTOdds(5.2) }]) === null && JC.trendDist(null) === null);

  // 权重自学习：实盘样本与"实盘大球联"一致（恒 3:2），排名因子全平 → 联赛权重应超过排名权重
  const capOdds = { goals: [2, 2, 2, 2, 2, 2, 2, 2], scores: { '1:0': 5, '0:1': 6 }, other: { win: 15, draw: 21, lose: 25 } };
  const liveMatches = [];
  for (let i = 0; i < 40; i++) {
    const day = JC.addDays('2026-02-01', i);
    hist.days[day] = hist.days[day] || {};
    hist.days[day]['L' + i] = ['实盘大球联', 'X' + i, 'Y' + i, 3, 2];
    liveMatches.push({
      matchId: 100 + i, businessDate: day, matchDate: day, matchNumStr: '周一' + (100 + i),
      league: '实盘大球联', home: 'A' + i, away: 'B' + i,
      captures: [{ at: day + 'T11:00:00+08:00', odds: JSON.parse(JSON.stringify(capOdds)) }],
      result: { score: '3:2', goals: 5, at: day + 'T23:00:00+08:00' }, pred: null
    });
  }
  const eng2 = JC.factorEngine({ matches: liveMatches, history: hist, model: { windowDays: 30, maxActualRank: 6 } });
  const w = eng2.weightsFor('2026-03-15');
  ok('权重评测：样本数 > 0', w.eval.n > 0, 'n=' + w.eval.n);
  ok('权重集合完整（5 因子）', w.rank != null && w.league != null && w.team != null && w.market != null && w.trend != null);
  ok('联赛因子单独命中率高（与实盘一致）', w.eval.league != null && w.eval.league >= 0.7, 'league=' + w.eval.league);
  ok('权重自学习：联赛权重 > 排名权重（排名因子无效时自动让位）', w.league > w.rank,
    'w=' + JSON.stringify({ r: Math.round(w.rank * 100) / 100, l: Math.round(w.league * 100) / 100, t: Math.round(w.team * 100) / 100, m: Math.round(w.market * 100) / 100, tr: Math.round(w.trend * 100) / 100 }));

  // 严格防泄漏：给"未来日期"加极端历史，不应影响之前的预测
  const hist2 = JSON.parse(JSON.stringify(histBase));
  hist2.days['2026-06-01'] = { z1: ['大球联', '攻强队', '某队X', 9, 9] };
  const engineB = JC.factorEngine({ matches: [], history: hist2, model: { windowDays: 30, maxActualRank: 6 } });
  const pBig2 = engineB.predictFor({ businessDate: '2026-02-20', league: '大球联', home: '攻强队', away: '某队X' }, diffsFlat);
  ok('严格防泄漏：未来日期的历史不参与当日预测', pBig2.goal === pBig.goal && pBig2.info.histN === pBig.info.histN);

  // historyDayFromResults：销售日归属 + 字段解析
  const rs = JC.parseResults([{ matchId: 9, sectionsNo999: '2:1', sectionsNo1: '1:0', matchResultStatus: '2',
    matchDate: '2026-09-02', matchNumStr: '周三005', leagueNameAbbr: '英超', homeTeam: '曼城', awayTeam: '阿森纳' }]);
  const hm = JC.historyDayFromResults(rs, '2026-09-02');
  ok('historyDayFromResults：归属与字段', hm[9] && hm[9][0] === '英超' && hm[9][3] === 2 && hm[9][4] === 1);
  ok('historyStats：统计', JC.historyStats({ days: { 'D1': { a: [1], b: [2] }, 'D2': { c: [3] } } }).matches === 3);
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
