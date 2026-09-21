#!/usr/bin/env node
/**
 * 每日数据任务（本机 Windows 任务计划程序调用，也可手动运行）
 * ============================================================
 * 用法：
 *   node scripts/daily.js              # 抓赔率 + 回填赛果（默认，等价于 both）
 *   node scripts/daily.js odds         # 抓取赔率（当天 + 在售场次）+ 回填赛果
 *   node scripts/daily.js results      # 只回填赛果
 *   node scripts/daily.js both --push  # 完成后 git 提交并推送（--push 也可省略，默认读 config.json）
 *   node scripts/daily.js odds --no-push --no-excel   # 只抓数据，不推送、不生成 Excel
 *   node scripts/daily.js check        # 环境自检（迁移/排障用）
 *   node scripts/daily.js numbers --backfill 400   # 一次性回补编号历史（默认回补 180 天）
 *
 * 说明：无论哪种模式都会回填赛果（含凌晨场：查询范围自动 +1 天），
 *       并维护"编号 × 进球数"历史（docs/data/numbers.json，用于编号追踪警戒）。
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
const { detectProxy, ensureGitProxy } = require('./lib/proxy.js');

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
  return Object.assign({
    autoPush: true, backfillDays: 10, gitProxy: '', alertCount: 30,
    // 编号追踪的关注范围：编号 001~010；进球数 0/1/2/3/4 各自统计，5 及以上合并为 5+
    // 预警口径：连续未出现「次数」（该编号有比赛但没打出该档进球数）达到 alertCount → 警戒
    numTrack: { nums: ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'], goalGroups: '0,1,2,3,4,5+' }
  }, loadJson(path.join(ROOT, 'config.json'), {}));
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

// 每次 git 操作前自动探测本地代理（端口可能变化），并同步到本仓库 git 配置。
// config.json 的 gitProxy 可手动指定（如 "http://127.0.0.1:7890"），留空则自动探测。
async function gitEnsureProxy() {
  try {
    const cfg = loadConfig();
    const r = await ensureGitProxy(ROOT, { hint: cfg.gitProxy || '' });
    if (r.proxy) {
      log(`代理检测：${r.proxy.source} ${r.proxy.url}` + (r.changed ? `（已更新 git 配置${r.previous ? '，原为 ' + r.previous : ''}）` : '（git 配置未变）'));
    } else if (r.changed) {
      log(`未探测到可用代理，已清除过期配置（原 ${r.removed}），将尝试直连 GitHub`);
    } else {
      log('未探测到本地代理，将尝试直连 GitHub');
    }
    return r;
  } catch (e) {
    log('代理探测出错（按现有 git 配置继续）：' + e.message);
    return {};
  }
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

async function gitCommitAndPush(message) {
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
      log(`git push 第 ${attempt} 次失败，重新探测代理并 pull --rebase 后重试…`);
      if (attempt === 1) await gitEnsureProxy(); // 端口可能变了，重新探测
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
  let totalAdded = 0, totalUpdated = 0, totalCaptured = 0;
  const touchedDates = [];
  Object.keys(byDate).sort().forEach(date => {
    const day = loadDay(date) || { date, matches: [] };
    const r = JC.mergeDay(day, byDate[date], capturedAt);
    saveDay(r.day);
    index.dates[date] = { count: r.day.matches.length, updatedAt: capturedAt };
    index.updatedAt = capturedAt;
    totalAdded += r.added; totalUpdated += r.updated; totalCaptured += r.captured;
    touchedDates.push(date);
    log(`  ${date}: 新增 ${r.added} 场，快照 +${r.captured}（其中 ${r.updated} 场赔率有变化），共 ${r.day.matches.length} 场`);
  });
  saveIndex(index);
  log(`赔率抓取完成：新增 ${totalAdded}，快照 +${totalCaptured}，赔率变化 ${totalUpdated}，涉及日期 ${touchedDates.join(', ')}`);
  return { added: totalAdded, updated: totalUpdated, captured: totalCaptured, dates: touchedDates };
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
      // 赛果接口按"真实开赛日"过滤：凌晨场属于次日，必须多查一天（否则凌晨场永远回填不上）
      const [begin, end] = JC.resultRangeFor(date);
      results = await JC.fetchAllResults(begin, end, true);
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

// ---------------------------------------------------------------- 编号追踪（编号 × 总进球数 历史）

const NUMBERS_FILE = path.join(DATA_DIR, 'numbers.json');

function loadNumbers() {
  const doc = loadJson(NUMBERS_FILE, null);
  if (!doc || typeof doc !== 'object' || !doc.days) return { updatedAt: null, days: {} };
  return doc;
}

// 维护 docs/data/numbers.json：每天（按"销售日"）记录 { 编号: 总进球数 }
//   · 编号只在销售日内唯一（周三004 与 周二004 可能是两场比赛），因此一天的数据 =
//     真实日期 s 的日间场 + 真实日期 s+1 的凌晨场；一次查询 [s, s+1] 后按销售日归属；
//   · 每次运行保证最近 3 个销售日为最新；更早的销售日已定稿就跳过；
//   · --backfill N 时向后回补 N 天（一次性种子历史，限速请求）。
const NUMBERS_SCHEMA = 2;

async function runNumbers(config, opts) {
  opts = opts || {};
  const doc = loadNumbers();
  if (doc.schema !== NUMBERS_SCHEMA) {
    if (Object.keys(doc.days || {}).length) log('编号历史升级为「按销售日」口径（修复跨日同号覆盖问题），重新回补…');
    doc.days = {};
    doc.schema = NUMBERS_SCHEMA;
  }
  doc.alertCount = config.alertCount || doc.alertCount || 30;
  delete doc.alertDays; // 旧口径字段，清理
  // 关注范围与分档（写入 numbers.json，网页/油猴/Excel 均按此口径统计）
  const track = config.numTrack || {};
  doc.nums = (Array.isArray(track.nums) && track.nums.length) ? track.nums : null;
  doc.buckets = JC.parseGoalGroups(track.goalGroups) || undefined;
  if (!doc.buckets) delete doc.buckets;

  const today = JC.localDateStr();
  // 销售日 s 的数据 = 真实日期 s（日间场）+ s+1（凌晨场）；查询后按前缀星期归属
  const from = opts.backfillDays ? JC.addDays(today, -opts.backfillDays) : JC.addDays(today, -2);
  let fetched = 0, written = 0;
  for (let s = from; s <= today; s = JC.addDays(s, 1)) {
    const settled = s <= JC.addDays(today, -2); // 销售日过去两天后数据已定稿
    if (settled && doc.days[s]) continue;
    let rs;
    try {
      rs = await JC.fetchAllResults(s, JC.addDays(s, 1), true);
    } catch (e) {
      log(`  编号历史 ${s}: 接口出错 — ${e.message}`);
      continue;
    }
    const map = {};
    rs.forEach(r => {
      if (JC.slateDateOf(r.matchNumStr, r.date) !== s) return; // 凌晨场归前一个销售日
      const num = JC.numOf(r.matchNumStr);
      const g = r.score ? JC.goalsFromScore(r.score) : null;
      if (num && g != null) map[num] = g;
    });
    if (Object.keys(map).length) { doc.days[s] = map; written++; }
    fetched++;
    if (opts.backfillDays) await new Promise(r => setTimeout(r, 120)); // 回补历史时限速
  }
  doc.updatedAt = JC.nowIso();
  saveJson(NUMBERS_FILE, doc);

  const st = JC.numbersStats(doc, { alertCount: doc.alertCount });
  log(`编号历史：共 ${st.days} 个销售日（${st.firstDate} ~ ${st.lastDate}），本次检查 ${fetched} 天、写入 ${written} 天`);
  if (st.alerts.length) {
    log(`⚠ 编号追踪：${st.alerts.length} 项已连续 ≥${st.alertCount} 次未出现 —— ` +
      st.alerts.slice(0, 5).map(a => `${a.num}的${a.label}（连续 ${a.streak} 次，最近 ${a.lastDate}）`).join('；') +
      (st.alerts.length > 5 ? ' 等' : ''));
  } else {
    log(`编号追踪：当前没有连续 ≥${st.alertCount} 次未出现的项目`);
  }
  return { days: st.days, fetched, written, alerts: st.alerts };
}

// ---------------------------------------------------------------- 环境自检

function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error((label || '操作') + '超时')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

// node scripts/daily.js check —— 迁移/排障用：逐项检查运行环境并给出结论
async function runCheck() {
  console.log('=== 竞彩1球差值 · 环境自检 ===');
  console.log('时间：' + JC.nowIso() + '（核心库 v' + JC.VERSION + '）');
  console.log('目录：' + ROOT + '\n');
  let fails = 0;
  const ok = function (name, pass, detail) {
    if (!pass) fails++;
    console.log((pass ? '  [通过] ' : '  [需处理] ') + name + (detail ? ' —— ' + detail : ''));
  };

  ok('Node.js 版本', Number(process.versions.node.split('.')[0]) >= 18, 'v' + process.versions.node + '（需 >= 18）');

  try { require('exceljs'); ok('依赖 exceljs', true, '已安装'); }
  catch (e) { ok('依赖 exceljs', false, '未安装：请在本目录运行 npm install（或双击 一键安装.cmd）'); }

  try {
    const raw = await withTimeout(JC.fetchJson(JC.ODDS_URL, true), 20000, '赔率接口');
    const n = JC.parseOdds(raw, JC.nowIso()).length;
    ok('体彩赔率接口（需国内网络）', true, '正常，当前在售 ' + n + ' 场');
  } catch (e) { ok('体彩赔率接口（需国内网络）', false, e.message); }
  try {
    const d = JC.localDateStr();
    const rs = await withTimeout(JC.fetchAllResults(d, d, true), 20000, '赛果接口');
    ok('体彩赛果接口', true, '正常，今日已出赛果 ' + rs.length + ' 条');
  } catch (e) { ok('体彩赛果接口', false, e.message); }

  let proxy = null;
  try { proxy = await detectProxy({ hint: loadConfig().gitProxy || '' }); } catch (e) {}
  ok('本地代理探测', true, proxy ? (proxy.url + '（来源：' + proxy.source + '）') : '未发现可用代理（若是直连网络，属正常）');

  if (hasRemote()) {
    const r = await ensureGitProxy(ROOT, { hint: loadConfig().gitProxy || '' });
    ok('git 代理配置', true, r.proxy ? ('已适配为 ' + r.proxy.url + (r.changed ? '（本次更新）' : '')) : '直连模式');
    try {
      const out = execFileSync('git', ['ls-remote', 'origin', 'main'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 40000 });
      ok('GitHub 远端连通', out.trim().length > 0, '远端 main：' + out.trim().split(/\s/)[0].slice(0, 10) + '…');
    } catch (e) {
      ok('GitHub 远端连通', false, '连接失败：检查网络；国内直连被拦截时请先开启代理软件');
    }
    try {
      const url = git(['remote', 'get-url', 'origin']).trim();
      ok('git 远端 origin', true, url);
    } catch (e) { /* 上面已覆盖 */ }
  } else {
    ok('git 远端 origin', false, '未配置：git remote add origin https://github.com/你的用户名/仓库名.git');
  }

  try {
    execFileSync('schtasks', ['/query', '/tn', '竞彩1球-上午抓取'], { stdio: 'pipe', encoding: 'buffer' });
    ok('计划任务（每天 11:00 / 17:00 两次）', true, '已注册（上午抓取 / 下午抓取）');
  } catch (e) {
    let legacy = false;
    try {
      execFileSync('schtasks', ['/query', '/tn', '竞彩1球-早间抓取回填'], { stdio: 'pipe', encoding: 'buffer' });
      legacy = true;
    } catch (e2) { /* 新旧都没有 */ }
    ok('计划任务（每天 11:00 / 17:00 两次）', false, legacy
      ? '仍是旧版任务（晚间 21:00）：请用管理员 PowerShell 重新运行 scripts\\register-tasks.ps1 -InteractiveUser 更新为 11:00/17:00'
      : '未注册：管理员 PowerShell 运行 scripts\\register-tasks.ps1 -InteractiveUser');
  }

  const index = loadIndex();
  const dates = Object.keys(index.dates || {});
  const total = dates.reduce(function (s, d) { return s + (index.dates[d].count || 0); }, 0);
  ok('本地数据', true, dates.length ? (dates.length + ' 天（' + dates[0] + ' ~ ' + dates[dates.length - 1] + '），共 ' + total + ' 场') : '暂无数据：双击 手动执行.cmd 即可开始抓取');

  try {
    const nst = JC.numbersStats(loadNumbers(), { alertCount: loadConfig().alertCount });
    ok('编号追踪数据', true, nst.days
      ? (nst.days + ' 天（' + nst.firstDate + ' ~ ' + nst.lastDate + '），当前警戒 ' + nst.alerts.length + ' 项')
      : '暂无：运行 node scripts\\daily.js numbers --backfill 400 回补历史');
  } catch (e) { ok('编号追踪数据', false, e.message); }

  console.log('\n结果：' + (fails ? fails + ' 项需要处理（见上方 [需处理] 项）' : '全部通过 ✓'));
  if (fails) process.exitCode = 1;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('check')) { await runCheck(); return; }
  const mode = args.includes('odds') ? 'odds' : args.includes('results') ? 'results' :
    args.includes('numbers') ? 'numbers' : 'both';
  const bfIdx = args.indexOf('--backfill');
  const backfillDays = bfIdx >= 0 ? (Number(args[bfIdx + 1]) || 180) : 0;
  const config = loadConfig();
  const doPush = args.includes('--push') || (!args.includes('--no-push') && config.autoPush);
  const doExcel = !args.includes('--no-excel');

  log(`=== 任务开始（模式：${mode}${backfillDays ? '，回补 ' + backfillDays + ' 天历史' : ''}${doPush ? '，完成后推送' : ''}）===`);
  if (doPush && hasRemote()) {
    await gitEnsureProxy(); // 每次执行前自动探测代理（端口可能变化）
    gitPullRebase();        // 先同步远端，避免冲突
  }

  const parts = [];
  if (mode === 'odds' || mode === 'both') {
    const r = await runOdds();
    if (r.added || r.updated || r.captured) parts.push(`赔率 新增${r.added} 变化${r.updated} 快照+${r.captured}（${r.dates.join(' ')}）`);
  }
  // 每次执行都回填赛果（包括下午的 odds 任务和手动执行），保证结果及时更新
  if (mode !== 'numbers') {
    const r = await runResults(config);
    if (r.changed) parts.push(`赛果回填 ${r.changed} 场（${r.dates.join(' ')}）`);
  }
  // 维护编号历史（编号追踪数据），并检查警戒项
  {
    const r = await runNumbers(config, { backfillDays });
    if (r.alerts.length) parts.push(`编号警戒 ${r.alerts.length} 项`);
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
    await gitCommitAndPush('data: ' + parts.join('；'));
  }
  log('=== 任务结束 ===');
}

main().catch(e => {
  log('任务异常终止：' + (e && e.stack || e));
  process.exitCode = 1;
});
