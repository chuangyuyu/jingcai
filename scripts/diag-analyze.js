#!/usr/bin/env node
/**
 * 诊断工具：模型对比（只读、不写任何数据）——node scripts/diag-analyze.js
 * 对每场"已结算且有差值"的比赛，对比命中情况：
 *   baseA          基线（差值最小项，含 0 球拟合值）
 *   frozen         当前冻结在数据里的 modelA
 *   v3recompute    用排名表模型重算（v3 算法等价复现）
 *   v5new          用当前 core.js 引擎重算（数据核心：只吃赔率与赔率变化，四因子权重自学习）
 * 改模型后用它快速对比"新旧预测在哪几场不同、谁更准"。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JC = require('../docs/core.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'docs', 'data');
const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
const docs = Object.keys(idx.dates).sort().map(d => JSON.parse(fs.readFileSync(path.join(DATA, 'days', d + '.json'), 'utf8')));
const all = [];
docs.forEach(doc => (doc.matches || []).forEach(m => all.push(m)));

const engine = JC.factorEngine({ matches: all, model: { windowDays: 30, maxActualRank: 6 } });

let n = 0;
const hits = { baseA: 0, frozen: 0, v3: 0, v4new: 0 };
const diffsList = [];
docs.forEach(doc => {
  (doc.matches || []).forEach(m => {
    const cap = (m.captures || [])[m.captures.length - 1];
    if (!cap || !m.result || m.result.goals == null || m.result.cancelled || m.result.rescheduled) return;
    const d = JC.goalDiffs(cap.odds);
    if (!d) return;
    const actual = JC.bucketOfGoals(m.result.goals);
    const diffsA = d.groups.map(x => x.diffA);
    const slate = m.businessDate || m.matchDate;
    const st = engine.stateFor(slate);
    const v3pred = JC.modelPredict(st.rankModel, diffsA, d.predBaseA);
    const fp = engine.predictFor(m, diffsA, { ttg: cap.odds.goals, captures: m.captures });
    const v4new = fp ? fp.goal : null;
    const frozen = m.pred && m.pred.modelA != null ? m.pred.modelA : null;
    n++;
    if (d.predBaseA === actual) hits.baseA++;
    if (frozen === actual) hits.frozen++;
    if (v3pred === actual) hits.v3++;
    if (v4new === actual) hits.v4new++;
    diffsList.push({
      date: slate, t: m.matchNumStr + ' ' + (m.league || ''), actual,
      baseA: d.predBaseA, frozen, v3: v3pred, v4new,
      same: (frozen === v4new ? '=' : 'DIFF')
    });
  });
});
console.log('已结算且有差值的场次:', n);
console.log('命中率: baseA ' + hits.baseA + '/' + n + ' (' + Math.round(hits.baseA / n * 100) + '%)' +
  ' | frozen旧预测 ' + hits.frozen + '/' + n + ' (' + Math.round(hits.frozen / n * 100) + '%)' +
  ' | v3重算 ' + hits.v3 + '/' + n + ' (' + Math.round(hits.v3 / n * 100) + '%)' +
  ' | v5新引擎 ' + hits.v4new + '/' + n + ' (' + Math.round(hits.v4new / n * 100) + '%)');
console.log('\n冻结值 ≠ 新引擎 的场次：');
diffsList.filter(x => x.same === 'DIFF').forEach(x => {
  console.log('  ' + x.date + ' ' + x.t + ' 实际' + x.actual + '球 | 基线' + x.baseA + ' | 冻结(旧)' + x.frozen + ' | v3' + x.v3 + ' | v5新' + x.v4new);
});
const w = engine.weightsFor(JC.localDateStr());
console.log('\n数据核心权重:', JSON.stringify({ 排名A: Math.round(w.rank * 100) + '%', 排名B: Math.round(w.relrank * 100) + '%', 市场: Math.round(w.market * 100) + '%', 趋势: Math.round(w.trend * 100) + '%', eval: w.eval }));
