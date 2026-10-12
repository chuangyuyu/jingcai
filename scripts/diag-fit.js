#!/usr/bin/env node
/**
 * 诊断工具：0球拟合中"负差值"处理方式对比（只读、不写数据）——node scripts/diag-fit.js
 * 背景：差值A = 总进球赔率 − 多选优化赔率；负值 = 该档被"牺牲"（赔率平衡被挪走；
 *       6/7+球另叠加比分池结构性缺格：6:0/0:6 在「其他」里且与≥7球混合）。
 * 对比 raw/clip0/abs/drop/neighbor/median 以及"只用 g=1..5 拟合"（现采用）对
 * 基线预测的影响，并列出各处理结论不同的场次。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JC = require('../docs/core.js');

const DATA = path.join(__dirname, '..', 'docs', 'data');
const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
const docs = Object.keys(idx.dates).sort().map(d => JSON.parse(fs.readFileSync(path.join(DATA, 'days', d + '.json'), 'utf8')));

function stabilize(vals, mode) {
  var out = vals.slice();
  for (var i = 0; i < out.length; i++) {
    var v = out[i];
    if (v == null || v >= 0) continue;
    if (mode === 'raw') continue;
    if (mode === 'clip0') { out[i] = 0; continue; }
    if (mode === 'abs') { out[i] = -v; continue; }
    if (mode === 'drop') { out[i] = null; continue; }
    if (mode === 'median') {
      var p = vals.filter(x => x != null && x >= 0).sort((a, b) => a - b);
      out[i] = p.length ? (p.length % 2 ? p[(p.length - 1) / 2] : (p[p.length / 2 - 1] + p[p.length / 2]) / 2) : 0;
      continue;
    }
    // neighbor
    var l = null, r = null;
    for (var j = i - 1; j >= 0; j--) if (vals[j] != null && vals[j] >= 0) { l = vals[j]; break; }
    for (var k = i + 1; k < vals.length; k++) if (vals[k] != null && vals[k] >= 0) { r = vals[k]; break; }
    out[i] = (l != null && r != null) ? (l + r) / 2 : (l != null ? l : (r != null ? r : 0));
  }
  return out;
}

const modes = ['raw', 'clip0', 'abs', 'drop', 'neighbor', 'median', 'low5', 'low5n'];
const stat = {};
modes.forEach(m => stat[m] = { n: 0, hit: 0, rankSum: 0, fit0Min: 0, fit0MinHit: 0, zeroActual: 0, zeroHit: 0 });

// low5：只用 g=1..5 拟合（6/7+ 结构性缺格不进曲线）；low5n 在其上先做 neighbor
function fitPointsFor(raw, mode) {
  let vals = raw.slice();
  if (mode === 'low5' || mode === 'low5n') {
    if (mode === 'low5n') vals = stabilize(vals, 'neighbor');
    vals = vals.map((v, i) => (i >= 5 ? null : v)); // 只保留 g=1..5
  } else {
    vals = stabilize(vals, mode);
  }
  const xs = [], ys = [];
  for (let i = 0; i < 7; i++) if (vals[i] != null) { xs.push(i + 1); ys.push(Math.max(-5, Math.min(15, vals[i]))); }
  return JC.fitValueAt0(xs, ys);
}

let negTotal = 0, matchesWithNeg = 0, negByBucket = new Array(8).fill(0);
const examples = [];

docs.forEach(doc => {
  (doc.matches || []).forEach(m => {
    const cap = (m.captures || [])[m.captures.length - 1];
    if (!cap || !m.result || m.result.goals == null || m.result.cancelled || m.result.rescheduled) return;
    const d = JC.goalDiffs(cap.odds);
    if (!d) return;
    const actual = JC.bucketOfGoals(m.result.goals);
    const raw = [];
    for (let g = 1; g <= 7; g++) raw.push(d.groups[g].diffA);
    let hasNeg = raw.some(v => v != null && v < 0);
    if (hasNeg) {
      matchesWithNeg++;
      raw.forEach((v, i) => { if (v != null && v < 0) { negTotal++; negByBucket[i + 1]++; } });
    }
    modes.forEach(mode => {
      const fit0 = fitPointsFor(raw, mode);
      const vec = [fit0].concat(raw);
      let best = null, bv = Infinity;
      for (let g = 0; g <= 7; g++) {
        if (vec[g] == null) continue;
        if (vec[g] < bv) { bv = vec[g]; best = g; }
      }
      const fit0IsMin = best === 0;
      const sorted = vec.filter(v => v != null).slice().sort((a, b) => a - b);
      const rank = raw[actual - 1] == null ? null : (actual === 0 ? (fit0 == null ? null : sorted.indexOf(fit0) + 1) : sorted.indexOf(raw[actual - 1]) + 1);
      const s = stat[mode];
      s.n++;
      if (best === actual) s.hit++;
      if (rank != null) s.rankSum += rank;
      if (fit0IsMin) { s.fit0Min++; if (best === actual) s.fit0MinHit++; }
      if (actual === 0) { s.zeroActual++; if (best === 0) s.zeroHit++; }
      if (mode === 'raw' && hasNeg && fit0 != null) {
        const fit0b = fitPointsFor(raw, 'low5');
        const vecB = [fit0b].concat(raw);
        let bestB = null, bvB = Infinity;
        for (let g = 0; g <= 7; g++) { if (vecB[g] == null) continue; if (vecB[g] < bvB) { bvB = vecB[g]; bestB = g; } }
        if (best !== bestB) examples.push({ date: doc.date, t: m.matchNumStr + ' ' + m.league, actual, rawPick: best, nbrPick: bestB, fit0: fit0 && fit0.toFixed(2), fit0b: fit0b && fit0b.toFixed(2), raws: raw.map(v => v == null ? '·' : v.toFixed(1)).join(',') });
      }
    });
  });
});

console.log('样本：已结算且有完整差值', stat.raw.n, '场；其中含负差值', matchesWithNeg, '场（负值共', negTotal, '个）');
console.log('负值分布（按档）:', negByBucket.map((c, g) => c ? g + '球×' + c : null).filter(Boolean).join(' '));
console.log('');
console.log('处理方式     基线命中   实际档平均排名   fit0成为最小次数(其中命中)   实际0球场次(其中命中=预测0)');
modes.forEach(mode => {
  const s = stat[mode];
  const meanRank = (s.rankSum / s.n).toFixed(2);
  console.log(mode.padEnd(10) + '  ' + (s.hit + '/' + s.n).padEnd(10) + '  ' + meanRank.padEnd(14) + '  ' +
    (s.fit0Min + '(' + s.fit0MinHit + ')').padEnd(24) + '  ' + s.zeroActual + '(' + s.zeroHit + ')');
});
console.log('');
console.log('raw 与 neighbor 结论不同的场次:');
examples.forEach(e => console.log('  ' + e.date + ' ' + e.t + ' 实际' + e.actual + '球 | raw选' + e.rawPick + ' neighbor选' + e.nbrPick + ' | fit0=' + e.fit0 + ' vs ' + e.fit0b + ' | 差值[' + e.raws + ']'));
