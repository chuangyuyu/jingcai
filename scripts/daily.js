#!/usr/bin/env node
/**
 * 每日数据任务（本机 Windows 任务计划程序调用，也可手动运行）
 * ============================================================
 * 用法：
 *   node scripts/daily.js              # 抓赔率 + 回填赛果（默认，等价于 both）
 *   node scripts/daily.js odds         # 只抓取/刷新赔率（当天 + 在售场次）
 *   node scripts/daily.js results      # 只回填最近未出结果的场次赛果
 *   node scripts/daily.js both --push  # 完成后 git 提交并推送（--push 也可省略，默认读 config.json）
 *   node scripts/daily.js odds --no-push --no-excel   # 只抓数据，不推送、不生成 Excel
 *
 * 写入位置：
 *   docs/data/days/YYYY-MM-DD.json   每天一个数据文件（每场比赛一行）
 *   docs/data/index.json             已有日期的索引
 *   docs/excel/竞彩1球-差值记录.xlsx   全量 Excel（按月分 sheet + 统计表 + 说明表）
 *   logs/daily.log                   运行日志
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JC = require('../docs/core.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');
const EXCEL_DIR = path.join(ROOT, 'docs', 'excel');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'daily.log');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

// ---------------------------------------------------------------- 基础工具

function log(msg) {
  const line = `[${JC.nowIso()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
}

function loadConfig() {
  return Object.assign({ autoPush: true, backfillDays: 10 }, loadJson(path.join(ROOT, 'config.json'), {}));
}

function loadDay(date) {
  return loadJson(path.join(DAYS_DIR, date + '.json'), null);
}

function saveDay(day) {
  saveJson(path.join(DAYS_DIR, day.date + '.json'), day);
}

function loadIndex() {
  const idx = loadJson(INDEX_FILE, null);
  if (!idx || typeof idx !== 'object' || !idx.dates) return { updatedAt: null, dates: {} };
  return idx;
}

function saveIndex(idx) {
  saveJson(INDEX_FILE, idx);
}

// ---------------------------------------------------------------- git 同步

function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }, opts));
}

function hasRemote() {
  try { git(['remote', 'get-url', 'origin']); return true; }
  catch (e) { return false; }
}

function gitPullRebase() {
  try {
    git(['pull', '--rebase', '--autostash']);
    log('git pull --rebase 完成');
    return true;
  } catch (e) {
    log('git pull 失败（可稍后手动处理）：' + String(e.stderr || e.message).trim().slice(0, 300));
    return false;
  }
}

function gitCommitAndPush(message) {
  if (!hasRemote()) {
    log('未配置 git remote origin，跳过推送（数据已保存在本地，按 README 配置后可重新运行 --push）');
    return false;
  }
  try {
    const status = git(['status', '--porcelain', 'docs']);
    if (!status.trim()) { log('没有数据变化，无需提交'); return true; }
    git(['add', 'docs']);
    git(['commit', '-m', message]);
    log('已提交：' + message);
  } catch (e) {
    log('git 提交失败：' + String(e.stderr || e.message).trim().slice(0, 300));
    return false;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      git(['push']);
      log('已推送到 GitHub');
      return true;
    } catch (e) {
      log(`git push 第 ${attempt} 次失败，尝试 pull --rebase 后重试…`);
      if (!gitPullRebase()) break;
    }
  }
  log('推送失败：请在本机仓库目录手动执行 git push 排查（数据已提交在本地）');
  return false;
}

// ---------------------------------------------------------------- 赔率抓取

async function runOdds() {
  log('开始抓取赔率…');
  const raw = await JC.fetchJson(JC.ODDS_URL, true);
  const capturedAt = JC.nowIso();
  const matches = JC.parseOdds(raw, capturedAt);
  if (!matches.length) { log('接口未返回任何比赛（可能今天没有在售场次）'); return { added: 0, updated: 0, dates: [] }; }

  const byDate = {};
  matches.forEach(m => { (byDate[m.businessDate] = byDate[m.businessDate] || []).push(m); });

  const index = loadIndex();
  let totalAdded = 0, totalUpdated = 0;
  const touchedDates = [];
  Object.keys(byDate).sort().forEach(date => {
    const day = loadDay(date) || { date, matches: [] };
    const r = JC.mergeDay(day, byDate[date], capturedAt);
    saveDay(r.day);
    index.dates[date] = { count: r.day.matches.length, updatedAt: capturedAt };
    index.updatedAt = capturedAt;
    totalAdded += r.added; totalUpdated += r.updated;
    touchedDates.push(date);
    log(`  ${date}: 新增 ${r.added} 场，刷新 ${r.updated} 场，共 ${r.day.matches.length} 场`);
  });
  saveIndex(index);
  log(`赔率抓取完成：新增 ${totalAdded}，刷新 ${totalUpdated}，涉及日期 ${touchedDates.join(', ')}`);
  return { added: totalAdded, updated: totalUpdated, dates: touchedDates };
}

// ---------------------------------------------------------------- 赛果回填

async function runResults(config) {
  const today = JC.localDateStr();
  const minDate = JC.addDays(today, -(config.backfillDays || 10));
  const index = loadIndex();
  const candidates = Object.keys(index.dates)
    .filter(d => d <= today && d >= minDate)
    .sort();
  log(`检查赛果回填：候选日期 ${candidates.join(', ') || '（无）'}`);
  let totalChanged = 0, totalFilled = 0;
  const touchedDates = [];
  for (const date of candidates) {
    const day = loadDay(date);
    if (!day || !day.matches.some(m => !m.result)) continue; // 全部已有赛果，跳过
    let results;
    try {
      results = await JC.fetchAllResults(date, date, true);
    } catch (e) {
      log(`  ${date}: 赛果接口出错 — ${e.message}`);
      continue;
    }
    const at = JC.nowIso();
    const r = JC.applyResults(day, results, at);
    if (r.changed > 0) {
      saveDay(day);
      index.dates[date] = { count: day.matches.length, updatedAt: at };
      index.updatedAt = at;
      touchedDates.push(date);
    }
    totalChanged += r.changed; totalFilled += r.filled;
    log(`  ${date}: 接口返回 ${results.length} 条赛果，命中 ${r.filled} 场，新回填 ${r.changed} 场`);
  }
  if (touchedDates.length) saveIndex(index);
  log(`赛果回填完成：新回填 ${totalChanged} 场`);
  return { changed: totalChanged, filled: totalFilled, dates: touchedDates };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('odds') ? 'odds' : args.includes('results') ? 'results' : 'both';
  const config = loadConfig();
  const doPush = args.includes('--push') || (!args.includes('--no-push') && config.autoPush);
  const doExcel = !args.includes('--no-excel');

  log(`=== 任务开始（模式：${mode}${doPush ? '，完成后推送' : ''}）===`);
  if (doPush && hasRemote()) gitPullRebase(); // 先同步远端，避免冲突

  const parts = [];
  if (mode === 'odds' || mode === 'both') {
    const r = await runOdds();
    if (r.added || r.updated) parts.push(`赔率 +${r.added}/~${r.updated}（${r.dates.join(' ')}）`);
  }
  if (mode === 'results' || mode === 'both') {
    const r = await runResults(config);
    if (r.changed) parts.push(`赛果回填 ${r.changed} 场（${r.dates.join(' ')}）`);
  }

  if (doExcel) {
    try {
      const { generateExcel } = require('./export-excel.js');
      const info = await generateExcel();
      log(`Excel 已生成：${info.file}（${info.rows} 行）`);
      if (info.rows) parts.push('Excel 更新');
    } catch (e) {
      log('Excel 生成失败：' + e.message);
    }
  }

  if (doPush && parts.length) {
    gitCommitAndPush('data: ' + parts.join('；'));
  }
  log('=== 任务结束 ===');
}

main().catch(e => {
  log('任务异常终止：' + (e && e.stack || e));
  process.exitCode = 1;
});
