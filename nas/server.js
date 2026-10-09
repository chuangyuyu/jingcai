#!/usr/bin/env node
/**
 * 竞彩进球数预测 · NAS 服务（静态网页 + 定时抓取）
 * ============================================================
 * 运行于 Docker 容器内（见仓库根目录 docker-compose.yml），零第三方依赖。
 *   · 静态网页：把 docs/ 作为网站根目录对外提供（默认端口 8788）
 *   · 定时任务：按 config.json 的 times（默认 8:00~23:00 每小时，北京时间）自动执行
 *     node scripts/daily.js（抓赔率 + 回填赛果 + 编号/历史维护 + 封盘冻结，完整流程）
 *   · 启动补跑：容器启动时若今日还没有抓取记录，立即补跑一次
 *   · 手动执行：浏览器访问 /api/run?mode=both（可选在 config.json 的 nas.runKey 设访问口令）
 *   · 状态查询：/api/status 返回时间、下次执行、数据概况
 * 日志：docker logs jingcai 或 NAS 上 仓库目录/logs/daily.log
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = path.join(DOCS, 'data');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}
const CONFIG = loadConfig();
// 定时槽位：config.json 的 times 数组（默认 8:00~23:00 每小时整点；夜间 0-8 点不执行）
const TIMES = (Array.isArray(CONFIG.times) && CONFIG.times.length)
  ? CONFIG.times.map(function (t) { return String(t); }).filter(function (t) { return /^\d{1,2}:\d{2}$/.test(t); })
  : ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];
const RUN_KEY = (CONFIG.nas && CONFIG.nas.runKey) || '';
// 每个整点执行完整流程（both：抓赔率 + 回填赛果 + 编号/历史维护 + 封盘冻结）
const SLOTS = TIMES.map(function (t) { return { time: t, mode: 'both' }; });

function coreVersion() {
  try {
    const src = fs.readFileSync(path.join(DOCS, 'core.js'), 'utf8');
    const m = /VERSION\s*=\s*'([^']+)'/.exec(src);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

// ---------------------------------------------------------------- 任务执行

const state = {
  running: null,          // { mode, at }
  lastRuns: {},           // slot标签/手动 -> { at, mode, exit, durationMs }
  lastDailyFinishedAt: null
};

function runDaily(mode, label) {
  return new Promise(function (resolve) {
    if (state.running) {
      log('已有任务在运行（' + state.running.mode + '），本次请求忽略：' + label);
      return resolve({ started: false, reason: 'busy' });
    }
    const allowed = ['both', 'odds', 'results', 'check'];
    if (allowed.indexOf(mode) < 0) mode = 'both';
    const args = ['scripts/daily.js', mode, '--no-push']; // NAS 端不推送 GitHub（无代理环境）
    state.running = { mode: mode, at: new Date().toISOString(), label: label };
    log('开始执行：node ' + args.join(' ') + '（' + label + '）');
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = function (buf) {
      String(buf).split(/\r?\n/).forEach(function (line) { if (line.trim()) log('  | ' + line); });
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('close', function (code) {
      const info = { at: new Date().toISOString(), mode: mode, exit: code, durationMs: Date.now() - startedAt };
      state.lastRuns[label] = info;
      state.running = null;
      state.lastDailyFinishedAt = info.at;
      log('执行结束：' + label + '，退出码 ' + code + '，耗时 ' + Math.round(info.durationMs / 1000) + 's');
      resolve({ started: true, exit: code });
    });
  });
}

// 启动补跑：若今天还没有任何抓取记录，立即跑一次（覆盖 NAS 重启错过当天定时的情况）
function catchUpIfNeeded() {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));
    let latest = '';
    Object.keys(idx.dates || {}).forEach(function (d) {
      const t = (idx.dates[d] && idx.dates[d].updatedAt) || '';
      if (t > latest) latest = t;
    });
    const today = new Date();
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const todayStr = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
    if (!latest || latest.slice(0, 10) < todayStr) {
      log('启动补跑：今日尚无抓取记录（最近一次：' + (latest || '无') + '），先跑一次 both');
      runDaily('both', '启动补跑');
    } else {
      log('启动检查：今日已有抓取记录（' + latest + '），按定时执行即可');
    }
  } catch (e) {
    log('启动补跑检查跳过：' + e.message);
  }
}

// 定时器：每 20 秒检查一次，到点触发（同一槽位每天只触发一次）
const firedToday = {};
function tick() {
  const now = new Date();
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  const hhmm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  const todayStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  SLOTS.forEach(function (slot, i) {
    const key = i + '@' + todayStr;
    if (hhmm === slot.time && !firedToday[key]) {
      firedToday[key] = true;
      runDaily(slot.mode, '定时 ' + slot.time);
    }
  });
}

function nextRunTimes() {
  const now = new Date();
  return SLOTS.map(function (s) {
    const p = s.time.split(':');
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(p[0]), Number(p[1]), 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return { time: s.time, mode: s.mode, nextAt: t.toISOString() };
  });
}

// ---------------------------------------------------------------- 静态服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end('bad path'); }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(DOCS, urlPath));
  if (!filePath.startsWith(DOCS)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + urlPath);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache' // 局域网访问：始终取最新（数据/代码更新立即可见）
    });
    res.end(buf);
  });
}

function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj, null, 1));
}

function readDataSummary() {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8'));
    const dates = Object.keys(idx.dates || {}).sort();
    let total = 0;
    dates.forEach(function (d) { total += (idx.dates[d] && idx.dates[d].count) || 0; });
    return { days: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null, matches: total, updatedAt: idx.updatedAt || null };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- HTTP

const server = http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/api/status') {
    return json(res, {
      ok: true,
      service: 'jingcai-nas',
      coreVersion: coreVersion(),
      serverTime: new Date().toISOString(),
      timezone: process.env.TZ || '(system)',
      times: SLOTS,
      nextRuns: nextRunTimes(),
      running: state.running,
      lastRuns: state.lastRuns,
      data: readDataSummary(),
      runKeyRequired: !!RUN_KEY
    });
  }

  if (p === '/api/run') {
    if (RUN_KEY && u.searchParams.get('key') !== RUN_KEY) {
      return json(res, { ok: false, error: '缺少或错误的口令（config.json 的 nas.runKey）' }, 403);
    }
    const mode = u.searchParams.get('mode') || 'both';
    runDaily(mode, '手动 /api/run').then(function (r) {
      json(res, { ok: r.started !== false, result: r }, r.started === false ? 409 : 200);
    });
    return;
  }

  return serveStatic(req, res);
});

server.listen(PORT, function () {
  log('竞彩进球数预测 · NAS 服务已启动');
  log('  网页地址：http://<NAS的IP>:' + PORT + '/');
  log('  定时执行：每天 ' + SLOTS[0].time + ' ~ ' + SLOTS[SLOTS.length - 1].time + ' 每小时整点一次（共 ' + SLOTS.length + ' 次；容器时区 ' + (process.env.TZ || '系统') + '）');
  log('  手动执行：http://<NAS的IP>:' + PORT + '/api/run?mode=both' + (RUN_KEY ? '&key=口令' : ''));
  log('  核心库版本：' + coreVersion());
  log('  数据概况：' + JSON.stringify(readDataSummary()));
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'exceljs'))) {
    log('  提示：未找到 node_modules/exceljs，Excel 生成将跳过；可在容器内执行 npm install 安装（纯JS依赖，Windows 拷贝的 node_modules 亦可直接用）');
  }
  setTimeout(catchUpIfNeeded, 5000);
  setInterval(tick, 20000);
});
