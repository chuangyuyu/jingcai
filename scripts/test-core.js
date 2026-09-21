#!/usr/bin/env node
/**
 * 核心逻辑自检（不访问网络）：node scripts/test-core.js
 * 覆盖：差值公式、解析（含单关标记）、快照追加与合并、旧数据升级、
 *       展平（两次/箭头）、统计（单关分组+差值变化分档）、CSV
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
  ok('缺 1球赔率 → null', JC.computeDiff(null, 6.4, 10.5).diff === null);
  ok('1:0 / 0:1 判定', JC.isOneGoalScore('1:0') && JC.isOneGoalScore('0:1') && !JC.isOneGoalScore('2:0'));
}

console.log('== 赛果查询范围（凌晨场真实开赛日=次日，需 +1 天）==');
{
  const r = JC.resultRangeFor('2026-09-20');
  ok('resultRangeFor = [当天, 次日]', r[0] === '2026-09-20' && r[1] === '2026-09-21', JSON.stringify(r));
  ok('跨月正确', JC.resultRangeFor('2026-09-30')[1] === '2026-10-01');
}

console.log('== 解析官方赔率 JSON（v2：单关标记 + 快照）==');
const mkMatch = (over) => Object.assign({
  matchId: 1, businessDate: '2026-09-20', matchDate: '2026-09-20', matchNumStr: '周日001',
  leagueAbbName: '意甲', homeTeamAbbName: '尤文', awayTeamAbbName: '亚特兰大',
  matchTime: '20:00:00', matchStatus: 'Selling',
  ttg: { s1: '5.10' }, crs: { s01s00: '7.50', s00s01: '13.00' }, had: { h: '1.55', d: '3.70', a: '4.70' },
  poolList: [
    { poolCode: 'HAD', single: 1 }, { poolCode: 'HHAD', single: 0 },
    { poolCode: 'CRS', single: 1 }, { poolCode: 'TTG', single: 1 }
  ]
}, over || {});
const oddsRaw = { value: { matchInfoList: [{ businessDate: '2026-09-20', subMatchList: [
  mkMatch(),
  mkMatch({ matchId: 2, matchNumStr: '周日002', matchDate: '2026-09-21', matchTime: '00:00:00',
    poolList: [{ poolCode: 'HAD', single: 0 }], ttg: {}, crs: {}, had: {} })
] }] } };
{
  const parsed = JC.parseOdds(oddsRaw, '2026-09-20T11:00:00+08:00');
  ok('解析出 2 场', parsed.length === 2);
  ok('场次1 快照内含差值', near(parsed[0].captures[0].diff, 5.10 - (7.5 * 13 / 20.5)));
  ok('场次1 单关胜平负=是', parsed[0].isSingleWin === true);
  ok('场次2 单关胜平负=否', parsed[1].isSingleWin === false);
  ok('场次2 缺赔率 → 快照 diff 为 null', parsed[1].captures[0].diff === null);
  ok('凌晨场 matchDate 保留', parsed[1].matchDate === '2026-09-21');
}

console.log('== 快照追加规则（mergeDay）==');
{
  let day = { date: '2026-09-20', matches: [] };
  let r = JC.mergeDay(day, JC.parseOdds(oddsRaw, '2026-09-20T11:00:00+08:00'), '2026-09-20T11:00:00+08:00');
  ok('首次抓取：新增 2 场，各 1 次快照', r.added === 2 && r.captured === 2 && r.day.matches[0].captures.length === 1);
  day = r.day;

  // 同时段、赔率无变化（11:30 手动再点一次）→ 不追加
  r = JC.mergeDay(day, JC.parseOdds(oddsRaw, '2026-09-20T11:30:00+08:00'), '2026-09-20T11:30:00+08:00');
  ok('同时段重复抓取：不产生新快照', r.captured === 0 && day.matches[0].captures.length === 1);

  // 下午时段、赔率无变化 → 追加（跨时段）
  r = JC.mergeDay(day, JC.parseOdds(oddsRaw, '2026-09-20T17:00:00+08:00'), '2026-09-20T17:00:00+08:00');
  ok('跨时段抓取：追加第 2 次快照', r.captured === 2 && day.matches[0].captures.length === 2);
  ok('两快照同一赔率 → 无"变化"计数', r.updated === 0);

  // 回填赛果后再抓 → 赛果保留、仍最多 2 个快照
  const res = JC.parseResults([{ matchId: 1, sectionsNo999: '1:0', sectionsNo1: '0:0', matchResultStatus: '2' }]);
  JC.applyResults(day, res, '2026-09-21T11:00:00+08:00');
  const odds2 = JSON.parse(JSON.stringify(oddsRaw));
  odds2.value.matchInfoList[0].subMatchList[0].ttg.s1 = '4.80'; // 赔率变化
  odds2.value.matchInfoList[0].subMatchList[0].crs.s01s00 = '6.80';
  r = JC.mergeDay(day, JC.parseOdds(odds2, '2026-09-21T11:00:00+08:00'), '2026-09-21T11:00:00+08:00');
  const m1 = day.matches.find(m => m.matchId === 1);
  ok('跨天抓取：仍只保留最近 2 次快照', m1.captures.length === 2 && r.updated === 1);
  ok('刷新赔率后赛果保留', m1.result && m1.result.score === '1:0');
  ok('新快照为变化后的赔率', near(m1.captures[1].odds.ttg1, 4.8));
}

console.log('== 旧版单快照数据自动升级 ==');
{
  const old = {
    matchId: 9, businessDate: '2026-09-19', matchDate: '2026-09-19', matchNumStr: '周六009',
    league: '英超', home: 'A', away: 'B', matchTime: '22:00:00', matchStatus: 'Selling',
    odds: { ttg1: 4.0, s10: 6.0, s01: 12.0, had: [1.5, 4, 6] },
    optimized: 4.0, diff: 0.0, oddsAt: '2026-09-19T11:00:00+08:00', captureCount: 3, result: null
  };
  const m = JC.normalizeMatch(old);
  ok('odds → captures[0]', m.captures.length === 1 && near(m.captures[0].odds.ttg1, 4.0));
  ok('时间/计数保留', m.captures[0].at === '2026-09-19T11:00:00+08:00' && m.totalCaptures === 3);
  ok('旧字段清理', m.odds === undefined && m.oddsAt === undefined);
  const rows = JC.flatRows([{ date: '2026-09-19', matches: [old] }]);
  ok('展平后只有第一次数据、无箭头', rows[0].o2.at === '' && rows[0].dir === '' && rows[0].diff === 0);
}

console.log('== 展平（两次 + 箭头方向）==');
{
  let day = { date: '2026-09-20', matches: [] };
  day = JC.mergeDay(day, JC.parseOdds(oddsRaw, '2026-09-20T11:00:00+08:00'), '2026-09-20T11:00:00+08:00').day;
  const odds2 = JSON.parse(JSON.stringify(oddsRaw));
  odds2.value.matchInfoList[0].subMatchList[0].ttg.s1 = '4.60'; // 差值变小
  day = JC.mergeDay(day, JC.parseOdds(odds2, '2026-09-20T17:00:00+08:00'), '2026-09-20T17:00:00+08:00').day;
  const rows = JC.flatRows([day]);
  const r1 = rows.find(r => r.matchNumStr === '周日001');
  ok('两次快照都在', r1.o1.ttg1 === 5.1 && r1.o2.ttg1 === 4.6);
  ok('差值变化量 = 第二次−第一次', r1.diffDelta < 0, String(r1.diffDelta));
  ok('箭头方向 = 缩小 ↓', r1.dir === '↓', r1.dir);
  ok('times 展示串', /^09-20 11:00 \/ 09-20 17:00$/.test(r1.times), r1.times);
  const rows2 = JC.flatRows([day]);
  ok('主差值取最新一次', near(rows2.find(r => r.matchNumStr === '周日001').diff, r1.o2.diff));
}

console.log('== mergeDocs（多端并集）==');
{
  const A = { date: '2026-09-20', updatedAt: 'T1', matches: [{
    matchId: 1, captures: [{ at: '2026-09-20T11:00:00+08:00', odds: { ttg1: 5.0, s10: 7.5, s01: 13 }, optimized: 4.75, diff: 0.25 }], totalCaptures: 1, result: null }] };
  const B = { date: '2026-09-20', updatedAt: 'T2', matches: [{
    matchId: 1, captures: [{ at: '2026-09-20T17:00:00+08:00', odds: { ttg1: 4.6, s10: 7.5, s01: 13 }, optimized: 4.75, diff: -0.15 }], totalCaptures: 1,
    result: { score: '1:0', isOneGoal: true, at: 'T3' } }] };
  const m = JC.mergeDocs(A, B);
  ok('快照并集 = 2 个', m.matches[0].captures.length === 2);
  ok('赛果保留', m.matches[0].result && m.matches[0].result.score === '1:0');
  // 并集超过 2 → 保留最近两个
  const C = { date: '2026-09-20', matches: [{ matchId: 1, captures: [
    { at: '2026-09-20T11:00:00+08:00', odds: { ttg1: 5.0 }, diff: 0.25 },
    { at: '2026-09-20T17:00:00+08:00', odds: { ttg1: 4.6 }, diff: -0.15 },
    { at: '2026-09-21T11:00:00+08:00', odds: { ttg1: 4.4 }, diff: -0.35 }], totalCaptures: 3 }] };
  const m2 = JC.mergeDocs({ date: '2026-09-20', matches: [] }, C);
  // 直接 3 个也裁到 2（mergeDocs 对单边超长同样裁剪）
  ok('单边 3 快照被裁剪为最近 2 个', m2.matches[0].captures.length === 2 && m2.matches[0].captures[0].at.indexOf('17:00') > 0);
  ok('null 安全', JC.mergeDocs(A, null) === A);
}

console.log('== 统计（单关分组 + 差值变化分档）==');
{
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      date: '2026-09-20',
      diff: 0.1 + i * 0.05,
      diffDelta: i < 10 ? -0.05 : 0.05,
      isOneGoal: i % 4 === 0,
      isSingleWin: i % 2 === 0,
      o1: { at: '2026-09-20T11:00:00+08:00', diff: 0.1 + i * 0.05 },
      o2: { at: '2026-09-20T17:00:00+08:00', diff: 0.1 + i * 0.05 + (i < 10 ? -0.05 : 0.05) }
    });
  }
  rows.push({ date: '2026-09-20', diff: null, diffDelta: null, isOneGoal: null, isSingleWin: null, o1: { at: '' }, o2: { at: '' } });
  const st = JC.stats(rows, 0.05);
  ok('总 21 场，已出 20 场', st.summary.total === 21 && st.summary.settled === 20);
  ok('1 球场次 5、占比 0.25', st.summary.oneGoalCount === 5 && near(st.summary.oneGoalRatio, 0.25));
  ok('单关场次 10（未出结果的 null 不计）', st.summary.singleCount === 10, String(st.summary.singleCount));
  ok('单关分组已出=10', st.summary.singleGroup.settled === 10, JSON.stringify(st.summary.singleGroup));
  ok('非单关分组已出=10', st.summary.nonSingleGroup.settled === 10);
  ok('两次快照场次=20', st.summary.twoCaptureCount === 20);
  ok('变化分档共 5 档', st.deltaBins.length === 5);
  const sumDelta = st.deltaBins.reduce((s, b) => s + b.count, 0);
  ok('变化分档合计 = 20', sumDelta === 20, 'sum=' + sumDelta);
  ok('下降档=10、上升档=10', st.deltaBins[0].count + st.deltaBins[1].count === 10 && st.deltaBins[3].count + st.deltaBins[4].count === 10);
  ok('平均变化量 = 0', near(st.summary.avgDeltaAll, 0, 0.001));
  const sum = st.bins.reduce((s, b) => s + b.count, 0);
  ok('差值分箱总数 = 20', sum === 20, 'sum=' + sum);
}

console.log('== 编号追踪（编号 × 进球数）==');
{
  ok('numOf 提取编号', JC.numOf('周日001') === '001' && JC.numOf('周一030') === '030' && JC.numOf('') === null);
  ok('goalsFromScore', JC.goalsFromScore('2:1') === 3 && JC.goalsFromScore('0:0') === 0 && JC.goalsFromScore('5:2') === 7 && JC.goalsFromScore('') === null);

  const doc = { alertDays: 2, days: {
    '2026-09-01': { '001': 2, '002': 0, '003': 4 },
    '2026-09-02': { '001': 0, '002': 1 },                 // 003 当天没有这个编号
    '2026-09-03': { '001': 3, '002': 2, '003': 1 },
    '2026-09-04': { '001': 1, '002': 5 }
  } };
  const st = JC.numbersStats(doc);
  ok('共 4 天、3 个编号', st.days === 4 && st.nums.length === 3);
  ok('警戒线来自 doc.alertDays = 2', st.alertDays === 2);
  const n1 = st.nums.find(n => n.num === '001');
  ok('001 各进球桶次数', n1.counts[0] === 1 && n1.counts[1] === 1 && n1.counts[2] === 1 && n1.counts[3] === 1, JSON.stringify(n1.counts));
  const c2 = n1.combos[2]; // 2球
  ok('001的2球 最近 09-01、距今 3 天、连续 3 次', c2.lastDate === '2026-09-01' && c2.daysSince === 3 && c2.streak === 3);
  ok('001的2球 平均间隔 3 天、该出指数 1.0', c2.avgGap === 3 && c2.anomaly === 1, 'avgGap=' + c2.avgGap + ' anomaly=' + c2.anomaly);
  const n3 = st.nums.find(n => n.num === '003');
  ok('003 出现 2 天（缺失日不计数）', n3.occurrences === 2 && n3.lastSeen === '2026-09-03');
  ok('003的4球 距今 3 天', n3.combos[4].lastDate === '2026-09-01' && n3.combos[4].daysSince === 3);
  ok('从未出现的桶标记 never', n3.combos[7].never === true && n3.combos[7].count === 0);
  ok('警戒项共 5 个（2+2+1）', st.alerts.length === 5, JSON.stringify(st.alerts.map(a => a.num + a.label + a.daysSince)));
  ok('警戒按距今天数降序', st.alerts[0].daysSince === 3);
  ok('从未出现的组合不进警戒', !st.alerts.some(a => a.num === '003' && a.label === '7+球'));
  // 停用编号不进警戒：让 003 最后出现停在 09-01，数据延续到 09-12（间隔 11 天 > 7）
  const doc2 = JSON.parse(JSON.stringify(doc));
  delete doc2.days['2026-09-03']['003'];
  for (let d = 5; d <= 12; d++) {
    doc2.days['2026-09-' + (d < 10 ? '0' + d : d)] = { '001': 1, '002': 2 };
  }
  const st2 = JC.numbersStats(doc2);
  const n3b = st2.nums.find(n => n.num === '003');
  ok('003 变为停用（近7天未出现）', n3b.active === false, 'lastSeen=' + n3b.lastSeen + ' lastDate=' + st2.lastDate);
  ok('停用编号不进警戒', !st2.alerts.some(a => a.num === '003'));
  // 空数据安全
  const st0 = JC.numbersStats({ days: {} });
  ok('空数据安全', st0.days === 0 && st0.alerts.length === 0);
}

console.log('== CSV（25 列）==');
{
  const rows = JC.flatRows([{
    date: '2026-09-20', matches: [{
      matchId: 1, matchNumStr: '周日001', league: '意甲', home: '尤文', away: '亚特兰大',
      matchTime: '20:00:00', matchDate: '2026-09-20', isSingleWin: true,
      captures: [
        { at: '2026-09-20T11:00:00+08:00', odds: { ttg1: 5.1, s10: 7.5, s01: 13 }, optimized: 4.756, diff: 0.344 },
        { at: '2026-09-20T17:00:00+08:00', odds: { ttg1: 4.9, s10: 7.5, s01: 13 }, optimized: 4.756, diff: 0.144 }
      ],
      result: { score: '1:0', halfScore: '0:0', isOneGoal: true, at: '2026-09-21T11:00:00+08:00' }
    }]
  }]);
  const csv = JC.toCSV(rows);
  ok('CSV 含 BOM', csv.charCodeAt(0) === 0xFEFF);
  ok('表头 25 列', JC.CSV_HEADERS.length === 25, String(JC.CSV_HEADERS.length));
  ok('数据行 25 列', JC.rowToCells(rows[0]).length === 25);
  ok('CSV 含单关=是 / 箭头 ↓', csv.includes('是') && csv.includes('↓'));
  ok('kickoff 字段', rows[0].kickoff === '09-20 20:00', rows[0].kickoff);
}

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
