#!/usr/bin/env node
/**
 * 核心逻辑自检（不访问网络）：node scripts/test-core.js
 * 覆盖：差值公式、解析、合并（赔率刷新/赛果保护）、文档合并、赛果回填、统计分箱、CSV
 */
'use strict';

const JC = require('../docs/core.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  →  ' + extra : '')); }
}
function near(a, b, eps) { return a != null && b != null && Math.abs(a - b) <= (eps || 0.0005); }

console.log('== 公式 ==');
{
  const r = JC.computeDiff(4.10, 6.40, 10.50);
  ok('优化赔率 = ab/(a+b) ≈ 3.976', near(r.optimized, 3.976), JSON.stringify(r));
  ok('差值 = 1球 − 优化 ≈ +0.124', near(r.diff, 0.124), JSON.stringify(r));
  const r2 = JC.computeDiff(null, 6.4, 10.5);
  ok('缺 1球赔率 → null', r2.optimized === null && r2.diff === null);
  ok('1:0 / 0:1 判定', JC.isOneGoalScore('1:0') && JC.isOneGoalScore('0:1') && !JC.isOneGoalScore('2:0'));
}

console.log('== 解析官方赔率 JSON ==');
const oddsFixture = {
  value: {
    matchInfoList: [{
      businessDate: '2026-09-20',
      subMatchList: [
        {
          matchId: 1, businessDate: '2026-09-20', matchDate: '2026-09-21', matchNumStr: '周日001',
          leagueAbbName: '意甲', homeTeamAbbName: '尤文', awayTeamAbbName: '亚特兰大', matchTime: '00:00:00', matchStatus: 'Selling',
          ttg: { s1: '5.10' }, crs: { s01s00: '7.50', s00s01: '13.00' }, had: { h: '1.55', d: '3.70', a: '4.70' }
        },
        {
          matchId: 2, businessDate: '2026-09-20', matchNumStr: '周日002',
          leagueAbbName: '西甲', homeTeamAbbName: 'A', awayTeamAbbName: 'B', matchTime: '20:00:00',
          ttg: {}, crs: {}, had: {}
        }
      ]
    }]
  }
};
const parsed = JC.parseOdds(oddsFixture, '2026-09-20T12:30:00+08:00');
ok('解析出 2 场', parsed.length === 2);
ok('场次1 差值正确', near(parsed[0].diff, 5.10 - (7.5 * 13 / 20.5)), JSON.stringify(parsed[0].diff));
ok('场次1 matchDate 保留（凌晨场）', parsed[0].matchDate === '2026-09-21');
ok('场次2 缺赔率 → diff 为 null', parsed[1].diff === null && parsed[1].optimized === null);

console.log('== 合并（mergeDay）==');
{
  let day = { date: '2026-09-20', matches: [] };
  let r = JC.mergeDay(day, parsed, '2026-09-20T12:30:00+08:00');
  ok('新增 2 场', r.added === 2 && r.day.matches.length === 2);
  day = r.day;
  // 回填赛果
  const res = JC.parseResults([{ matchId: 1, matchNumStr: '周日001', sectionsNo999: '1:0', sectionsNo1: '0:0', matchResultStatus: '2', matchDate: '2026-09-21' }]);
  const ar = JC.applyResults(day, res, '2026-09-21T10:05:00+08:00');
  ok('回填 1 场且标记为 1 球', ar.changed === 1 && day.matches.find(m => m.matchId === 1).result.isOneGoal === true);
  // 次日再抓赔率：赛果不能被覆盖
  const again = JC.parseOdds(oddsFixture, '2026-09-21T09:10:00+08:00');
  const r2 = JC.mergeDay(day, again, '2026-09-21T09:10:00+08:00');
  const m1 = r2.day.matches.find(m => m.matchId === 1);
  ok('刷新赔率后赛果保留', m1.result && m1.result.score === '1:0');
  ok('captureCount 递增', m1.captureCount === 2);
}

console.log('== mergeDocs（多端合并）==');
{
  const a = {
    date: '2026-09-20', updatedAt: 'T1', matches: [
      { matchId: 1, oddsAt: 'T1', odds: { ttg1: 4.1, s10: 6.4, s01: 10.5 }, optimized: 3.976, diff: 0.124, result: null }
    ]
  };
  const b = {
    date: '2026-09-20', updatedAt: 'T2', matches: [
      { matchId: 1, oddsAt: 'T2', odds: { ttg1: 4.0, s10: 6.4, s01: 10.5 }, optimized: 3.976, diff: 0.024, result: { score: '1:0', isOneGoal: true, at: 'T3' } }
    ]
  };
  const m = JC.mergeDocs(a, b);
  ok('赔率取更新的（T2）', near(m.matches[0].diff, 0.024));
  ok('赛果保留', m.matches[0].result && m.matches[0].result.score === '1:0');
  const m2 = JC.mergeDocs(a, null);
  ok('null 安全', m2 === a);
}

console.log('== 统计分箱 ==');
{
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({ date: '2026-09-20', diff: 0.1 + i * 0.05, isOneGoal: i % 4 === 0, score: i % 4 === 0 ? '1:0' : '2:1' });
  }
  rows.push({ date: '2026-09-20', diff: null, isOneGoal: null, score: null });
  const st = JC.stats(rows, 0.05);
  ok('已出赛果 20 场', st.summary.settled === 20);
  ok('1 球 5 场', st.summary.oneGoalCount === 5);
  ok('1 球占比 0.25', near(st.summary.oneGoalRatio, 0.25));
  const sum = st.bins.reduce((s, b) => s + b.count, 0);
  ok('分箱总数 = 20', sum === 20, 'sum=' + sum);
  ok('分箱带平均差值', st.bins[0].avgDiff != null);
  const st2 = JC.stats([{ diff: null, isOneGoal: null }], 0.05);
  ok('空数据安全', st2.summary.settled === 0 && st2.bins.length === 0);
}

console.log('== CSV ==');
{
  const rows = JC.flatRows([{
    date: '2026-09-20', matches: [{
      matchId: 1, matchNumStr: '周日001', league: '意甲', home: '尤文', away: '亚特兰大',
      matchTime: '00:00:00', matchDate: '2026-09-21', oddsAt: '2026-09-20T12:30:00+08:00',
      odds: { ttg1: 5.1, s10: 7.5, s01: 13 }, optimized: 4.756, diff: 0.344,
      result: { score: '1:0', halfScore: '0:0', isOneGoal: true }
    }]
  }]);
  const csv = JC.toCSV(rows);
  ok('CSV 含 BOM', csv.charCodeAt(0) === 0xFEFF);
  ok('CSV 含 1球 标记', csv.includes('是'));
  ok('kickoff 字段（09-21 00:00）', rows[0].kickoff === '09-21 00:00', rows[0].kickoff);
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
