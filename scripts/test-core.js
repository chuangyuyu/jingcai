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
  ok('7+球含总进球≥7的比分（5:2/4:3/3:4/2:5/4:4）', d.groups[7].scores.length === 5);
  ok('基线预测为合法进球数', d.predBaseA >= 0 && d.predBaseA <= 7 && d.predBaseB >= 0 && d.predBaseB <= 7);
  // 无完整池（旧数据）返回 null
  ok('旧数据（无比分矩阵）返回 null', JC.goalDiffs({ ttg1: 4.1, s10: 6.4, s01: 10.5, had: [] }) === null);
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
  ok('冻结预测含基线与模型', pred && pred.baseA != null && pred.modelA != null && pred.baseB != null && pred.modelB != null);
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
  const r2 = rows.find(r => r.matchNumStr === '周日002');
  ok('旧格式快照 → 无明细、无预测', r2.hasDetail === false && r2.predA === null);
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

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
