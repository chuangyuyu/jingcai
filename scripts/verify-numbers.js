#!/usr/bin/env node
/**
 * 编号历史数据验证： node scripts/verify-numbers.js [--sample 5]
 * ============================================================
 * ① 交叉核对：用 docs/data/days/*.json（来自"赔率接口"的通路，
 *    其中 businessDate 是官方字段）逐场比对 numbers.json（来自"赛果接口"的通路，
 *    销售日由编号前缀推导）。两条通路互不依赖，可验证归属与数值是否正确。
 * ② 抽样重查：随机抽取 N 个历史销售日，重新调用官方接口、按相同规则重建，
 *    与 numbers.json 中存储的值逐场比对（验证落盘数据无写入错误）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JC = require('../docs/core.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  →  ' + extra : '')); }
}

function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }

(async () => {
  const numbers = loadJson(path.join(DATA_DIR, 'numbers.json'), null);
  if (!numbers || !numbers.days) { console.error('numbers.json 不存在'); process.exit(1); }
  console.log('=== 验证编号历史（' + Object.keys(numbers.days).length + ' 个销售日，截至 ' + numbers.updatedAt + '）===\n');

  // ---------- ① 与每日文件（官方 businessDate）交叉核对 ----------
  console.log('① 交叉核对：每日文件（赔率接口，官方 businessDate）× 编号历史（赛果接口推导）');
  const index = loadJson(path.join(DATA_DIR, 'index.json'), { dates: {} });
  let checked = 0, mismatch = [];
  Object.keys(index.dates || {}).sort().forEach(d => {
    const day = loadJson(path.join(DAYS_DIR, d + '.json'), null);
    if (!day) return;
    (day.matches || []).forEach(m => {
      if (!m.result || !m.result.score) return;
      const slate = m.businessDate;
      const num = JC.numOf(m.matchNumStr);
      const goals = JC.goalsFromScore(m.result.score);
      if (!slate || !num || goals == null) return;
      checked++;
      const stored = numbers.days[slate] ? numbers.days[slate][num] : undefined;
      if (stored !== goals) {
        mismatch.push(`${m.matchNumStr}(${slate}) 官方比分 ${m.result.score}=${goals}球，编号历史记录 ${stored}`);
      }
    });
  });
  ok(`已核对 ${checked} 场（有结果的场次）`, mismatch.length === 0, mismatch.slice(0, 8).join('；'));
  if (checked === 0) console.log('  （提示：每日文件还没有已出结果的场次，积累后会更有说服力）');

  // ---------- ② 随机抽样重查 ----------
  const sampleN = (() => {
    const i = process.argv.indexOf('--sample');
    return i >= 0 ? (Number(process.argv[i + 1]) || 5) : 5;
  })();
  const slates = Object.keys(numbers.days).sort();
  console.log(`\n② 抽样重查：随机 ${sampleN} 个历史销售日，重新调官方接口按相同规则重建比对`);
  if (!slates.length) { console.log('  （无数据）'); }
  const picks = [];
  for (let i = 0; i < Math.min(sampleN, slates.length); i++) {
    picks.push(slates[Math.floor(Math.random() * slates.length)]);
  }
  for (const s of [...new Set(picks)]) {
    let rs;
    try {
      rs = await JC.fetchAllResults(s, JC.addDays(s, 1), true);
    } catch (e) { ok(s + ' 重查', false, e.message); continue; }
    const rebuilt = {};
    rs.forEach(r => {
      if (JC.slateDateOf(r.matchNumStr, r.date) !== s) return;
      const num = JC.numOf(r.matchNumStr);
      const g = r.score ? JC.goalsFromScore(r.score) : null;
      if (num && g != null) rebuilt[num] = g;
    });
    const stored = numbers.days[s];
    const keys = Object.keys(rebuilt);
    const bad = keys.filter(k => stored[k] !== rebuilt[k]);
    ok(`${s}：${keys.length} 场全部一致`, bad.length === 0 && Object.keys(stored).length === keys.length,
      bad.length ? `不一致: ${bad.map(k => k + '(存${stored[k]} vs 实${rebuilt[k]})').join(',')}` : (Object.keys(stored).length !== keys.length ? `场次数不同：存 ${Object.keys(stored).length} vs 实 ${keys.length}` : ''));
  }

  console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证脚本异常：', e); process.exit(1); });
