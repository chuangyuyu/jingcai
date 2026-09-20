// ==UserScript==
// @name         竞彩1球差值助手
// @namespace    jingcai-1qiu-diff
// @version      2.0.1
// @description  在体彩官网抓取竞彩足球「1球赔率 vs 比分(1:0/0:1)双选优化赔率」的差值（每天两次快照+变化箭头、单关标记），浮窗展示今日场次，可同步到你的 GitHub 仓库（配合 GitHub Pages 网页使用）
// @author       jingcai-1qiu-diff
// @updateURL    https://raw.githubusercontent.com/chuangyuyu/jingcai/main/userscript/jingcai.user.js
// @downloadURL  https://raw.githubusercontent.com/chuangyuyu/jingcai/main/userscript/jingcai.user.js
// @match        https://www.lottery.gov.cn/jc/*
// @match        https://www.sporttery.cn/jc/*
// @match        https://m.lottery.gov.cn/*
// @match        https://m.sporttery.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* 本文件为源文件，实际安装的是 userscript/jingcai.user.js（由 scripts/build-userscript.js
   把 docs/core.js 内联后生成）。改业务逻辑请改 docs/core.js，改交互请改本文件，然后运行：
     npm run build:userscript
*/

/* ===== 以下为 docs/core.js 内联内容（构建生成，请勿手改本文件；改 core.js 后重新构建） ===== */
/*!
 * 竞彩足球「1球赔率 vs 比分双选优化赔率」差值记录工具 — 共享核心库 v2
 * ============================================================
 * 本文件是全部业务逻辑的唯一事实来源，同时被三端使用：
 *   1. GitHub Pages 网页      docs/app.js（浏览器直接 <script> 引入）
 *   2. 本机定时任务脚本       scripts/daily.js（Node 环境 require）
 *   3. Edge 油猴脚本          userscript/jingcai.user.js（构建时由 scripts/build-userscript.js 内联）
 * 修改业务逻辑（接口、公式、字段）只需改这一个文件。
 *
 * v2 变化：
 *   · 每场比赛保留最近两次抓取快照（captures[]，通常为当天 11:00 与 17:00），
 *     第二次差值旁可显示变化方向（↑变大 / ↓缩小 / →不变）；
 *   · 记录「单场胜平负」开关（poolList 中 HAD 玩法 single=1，即官方挑选的单关场次），
 *     统计支持单关/非单关分组对比；
 *   · 旧版（单快照）数据文件读取时自动升级，无需手工迁移。
 *
 * 数据来源（中国体育彩票官方 Web API，需要中国大陆网络才能访问）：
 *   赔率: /gateway/jc/football/getMatchCalculatorV1.qry
 *   赛果: /gateway/uniform/football/getUniformMatchResultV1.qry
 *   两个接口均返回 Access-Control-Allow-Origin: *，浏览器可直接跨域调用。
 *
 * 核心公式（用户确认口径）：
 *   优化赔率 = 1:0赔率 × 0:1赔率 ÷ (1:0赔率 + 0:1赔率)   —— 双选等回报拆分注码后每1元的保底回报
 *   差值     = 1球赔率 − 优化赔率                          —— 正数表示押「总进球1球」更划算
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.JCCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '2.0.0';
  var API_BASE = 'https://webapi.sporttery.cn';

  // 赔率接口：一次返回当前在售的全部比赛和全部玩法赔率
  //   ttg.s1     = 总进球「1球」赔率
  //   crs.s01s00 = 比分 1:0 赔率     crs.s00s01 = 比分 0:1 赔率
  //   had.h/d/a  = 胜平负（顺带记录）；poolList[].single = 该玩法是否可单关
  var ODDS_URL = API_BASE + '/gateway/jc/football/getMatchCalculatorV1.qry' +
    '?poolCode=had,hhad,ttg,crs,hafu&channel=c';

  function resultUrl(beginDate, endDate, pageNo) {
    return API_BASE + '/gateway/uniform/football/getUniformMatchResultV1.qry' +
      '?matchBeginDate=' + beginDate + '&matchEndDate=' + endDate +
      '&leagueId=&pageSize=30&pageNo=' + (pageNo || 1) + '&isFix=0&matchPage=1&pcOrWap=1';
  }

  // Node 环境附加浏览器请求头；浏览器环境浏览器禁止设置这些头，
  // 直接 fetch 即可（接口已开放 CORS）。
  var NODE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Referer': 'https://www.sporttery.cn/',
    'Accept': 'application/json, text/plain, */*'
  };

  // ---------------------------------------------------------------- 工具函数

  function num(v) {
    var n = parseFloat(v);
    return (isFinite(n) && n > 0) ? n : null;
  }

  function round3(x) {
    return x == null ? null : Math.round(x * 1000) / 1000;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 本地时区的 yyyy-mm-dd（不要用 toISOString，那是 UTC）
  function localDateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // 本地时区带偏移的 ISO 时间戳，如 2026-09-20T11:00:05+08:00
  function nowIso() {
    var d = new Date();
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return localDateStr(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' +
      pad2(d.getSeconds()) + sign + pad2(Math.floor(off / 60)) + ':' + pad2(off % 60);
  }

  function addDays(dateStr, n) {
    var p = dateStr.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + n);
    return localDateStr(d);
  }

  function isOneGoalScore(score) {
    return score === '1:0' || score === '0:1';
  }

  function dateOf(iso) { return String(iso || '').slice(0, 10); }

  // 抓取时段：上午(<14点) / 下午 —— 用于判断"同一天同一时段重复抓取"不重复记快照
  function slotOf(iso) {
    var hh = Number(String(iso || '').slice(11, 13));
    return (isFinite(hh) && hh < 14) ? 'A' : 'B';
  }

  // 展示用时间：'2026-09-20T11:00:05+08:00' → '09-20 11:00'
  function fmtAt(iso) {
    if (!iso) return '';
    return String(iso).slice(5, 16).replace('T', ' ');
  }

  // ---------------------------------------------------------------- 网络请求

  async function fetchJson(url, isNode) {
    var res = await fetch(url, isNode ? { headers: NODE_HEADERS } : { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url);
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); }
    catch (e) {
      throw new Error('返回内容不是 JSON（可能被 WAF 拦截或接口有变）：' + text.slice(0, 120));
    }
    if (data && data.success === false) {
      throw new Error('接口返回错误：' + (data.errorMessage || data.errorCode || '未知'));
    }
    return data;
  }

  // 抓取赛果（自动翻页），返回 parseResults 之后的数组
  async function fetchAllResults(beginDate, endDate, isNode) {
    var all = [], pageNo = 1, pages = 1;
    do {
      var data = await fetchJson(resultUrl(beginDate, endDate, pageNo), isNode);
      var v = data.value || {};
      pages = Number(v.pages || 1) || 1;
      all = all.concat(v.matchResult || []);
      pageNo++;
    } while (pageNo <= pages && pageNo <= 20);
    return parseResults(all);
  }

  // ---------------------------------------------------------------- 计算

  // 双选优化：押 1 元按 1/s10 : 1/s01 的比例拆成两注，无论哪个比分命中，
  // 回报均为 s10*s01/(s10+s01) 元（等回报拆分）。这就是「优化赔率」。
  function computeDiff(ttg1, s10, s01) {
    var a = num(s10), b = num(s01), c = num(ttg1);
    if (a == null || b == null || c == null) return { optimized: null, diff: null };
    var opt = (a * b) / (a + b);
    return { optimized: round3(opt), diff: round3(c - opt) };
  }

  function makeCapture(at, odds) {
    var c = computeDiff(odds.ttg1, odds.s10, odds.s01);
    return { at: at, odds: odds, optimized: c.optimized, diff: c.diff };
  }

  function sameOdds(x, y) {
    try { return JSON.stringify(x) === JSON.stringify(y); } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- 数据解析

  // 官方赔率 JSON → 比赛记录数组（v2：每次抓取生成一个快照 capture）
  function parseOdds(raw, capturedAt) {
    var out = [];
    var groups = (raw && raw.value && raw.value.matchInfoList) || [];
    groups.forEach(function (g) {
      (g.subMatchList || []).forEach(function (m) {
        var ttg = m.ttg || {}, crs = m.crs || {}, had = m.had || {};
        // 单关标记：从 poolList 读（HAD=胜平负单关，HHAD=让球胜平负单关）
        var singleWin = null, singleHcp = null;
        (m.poolList || []).forEach(function (p) {
          var code = String(p.poolCode || '').toUpperCase();
          if (code === 'HAD') singleWin = Number(p.single) === 1;
          else if (code === 'HHAD') singleHcp = Number(p.single) === 1;
        });
        var odds = {
          ttg1: num(ttg.s1),          // 总进球「1球」
          s10: num(crs.s01s00),       // 比分 1:0
          s01: num(crs.s00s01),       // 比分 0:1
          had: [num(had.h), num(had.d), num(had.a)]
        };
        out.push({
          matchId: m.matchId,
          businessDate: m.businessDate || g.businessDate,
          matchDate: m.matchDate || m.businessDate || g.businessDate, // 真实开赛日历日（凌晨场与销售日不同）
          matchNumStr: m.matchNumStr || '',
          league: m.leagueAbbName || m.leagueAllName || '',
          home: m.homeTeamAbbName || m.homeTeamAllName || '',
          away: m.awayTeamAbbName || m.awayTeamAllName || '',
          matchTime: m.matchTime || '',
          matchStatus: m.matchStatus || m.sellStatus || '',
          isSingleWin: singleWin,
          isSingleHandicap: singleHcp,
          captures: [makeCapture(capturedAt, odds)],
          totalCaptures: 1,
          result: null
        });
      });
    });
    return out;
  }

  // 官方赛果 JSON 条目 → 规整结果数组
  function parseResults(list) {
    return (list || []).map(function (m) {
      return {
        matchId: m.matchId,
        matchNumStr: m.matchNumStr,
        league: m.leagueNameAbbr || m.leagueName || '',
        home: m.homeTeam || m.allHomeTeam || '',
        away: m.awayTeam || m.allAwayTeam || '',
        date: m.matchDate,
        score: normScore(m.sectionsNo999),
        halfScore: normScore(m.sectionsNo1),
        status: m.matchResultStatus,
        had: [m.h, m.d, m.a]
      };
    }).filter(function (r) { return r.matchId; });
  }

  function normScore(s) {
    if (typeof s !== 'string') return null;
    s = s.trim();
    return /^\d{1,2}:\d{1,2}$/.test(s) ? s : null;
  }

  // ---------------------------------------------------------------- 记录规整（兼容旧版单快照数据）

  function normalizeMatch(m) {
    if (!m) return m;
    if (!m.captures) {
      m.captures = [];
      if (m.odds) {
        m.captures.push({
          at: m.oddsAt || '',
          odds: m.odds,
          optimized: m.optimized != null ? m.optimized : null,
          diff: m.diff != null ? m.diff : null
        });
      }
      m.totalCaptures = m.captureCount || m.captures.length;
      delete m.odds; delete m.optimized; delete m.diff;
      delete m.oddsAt; delete m.captureCount;
    }
    if (m.isSingleWin === undefined) m.isSingleWin = null;
    if (m.isSingleHandicap === undefined) m.isSingleHandicap = null;
    return m;
  }

  function latestCapture(m) {
    m = normalizeMatch(m);
    return m.captures.length ? m.captures[m.captures.length - 1] : null;
  }

  // ---------------------------------------------------------------- 合并

  function cmpMatch(a, b) {
    var t = String(a.matchTime || '').localeCompare(String(b.matchTime || ''));
    if (t !== 0) return t;
    return String(a.matchNumStr || '').localeCompare(String(b.matchNumStr || ''));
  }

  // 把新抓到的比赛合并进某天的数据文件（v2）：
  //   · 新比赛直接加入；已有比赛在以下任一情况追加一次快照（captures 最多保留最近 2 次）：
  //       赔率有变化 / 距上次快照跨天 / 跨时段（上午↔下午）
  //   · 与上次完全相同的同时段重复抓取不产生新快照（避免手动多点几次造成重复）
  //   · 单关标记、比赛状态等以最新抓取为准；赛果字段不受影响
  function mergeDay(dayDoc, incomingMatches, capturedAt) {
    dayDoc = dayDoc || { date: '', matches: [] };
    if (!dayDoc.matches) dayDoc.matches = [];
    var byId = {};
    dayDoc.matches.forEach(function (m) { byId[m.matchId] = normalizeMatch(m); });
    var added = 0, updated = 0, captured = 0;
    (incomingMatches || []).forEach(function (inc) {
      inc = normalizeMatch(inc);
      var old = byId[inc.matchId];
      if (!old) { byId[inc.matchId] = inc; added++; captured++; return; }
      if (inc.isSingleWin != null) old.isSingleWin = inc.isSingleWin;
      if (inc.isSingleHandicap != null) old.isSingleHandicap = inc.isSingleHandicap;
      old.matchStatus = inc.matchStatus || old.matchStatus;
      old.matchTime = inc.matchTime || old.matchTime;
      old.matchDate = inc.matchDate || old.matchDate;
      old.league = inc.league || old.league;
      old.home = inc.home || old.home;
      old.away = inc.away || old.away;

      var incCap = inc.captures[0];
      if (!incCap) return;
      var last = old.captures[old.captures.length - 1];
      var changed = last ? !sameOdds(last.odds, incCap.odds) : false;
      var needAppend = !last ||
        changed ||
        dateOf(last.at) !== dateOf(capturedAt) ||
        slotOf(last.at) !== slotOf(capturedAt);
      if (needAppend) {
        old.captures.push({ at: capturedAt, odds: incCap.odds, optimized: incCap.optimized, diff: incCap.diff });
        while (old.captures.length > 2) old.captures.shift();
        old.totalCaptures = (old.totalCaptures || 1) + 1;
        captured++;
        if (changed) updated++;
      }
    });
    dayDoc.matches = Object.keys(byId).map(function (k) { return byId[k]; }).sort(cmpMatch);
    dayDoc.updatedAt = capturedAt;
    return { day: dayDoc, added: added, updated: updated, captured: captured };
  }

  // 把赛果回填进某天的数据文件（只覆盖比分为数字的场次；记录变化量供调用方决定是否提交）
  function applyResults(dayDoc, results, at) {
    var byId = {};
    (results || []).forEach(function (r) { byId[r.matchId] = r; });
    var filled = 0, changed = 0;
    (dayDoc.matches || []).forEach(function (m) {
      var r = byId[m.matchId];
      if (!r || !r.score) return;
      var prev = m.result;
      if (!prev || prev.score !== r.score) changed++;
      m.result = {
        score: r.score,
        halfScore: r.halfScore,
        isOneGoal: isOneGoalScore(r.score),
        status: r.status,
        at: at
      };
      filled++;
    });
    if (changed > 0) dayDoc.updatedAt = at;
    return { filled: filled, changed: changed };
  }

  // 文档级合并（多端数据汇合：网页/油猴本地改动 + 云端旧文件）。
  // 同一场比赛：快照按时间取并集（保留最近 2 次）；单关标记、赛果取非空/更新的。
  function mergeDocs(a, b) {
    if (!a) return b;
    if (!b) return a;
    var trimCaptures = function (m) {
      while (m.captures && m.captures.length > 2) m.captures.shift();
      return m;
    };
    var out = {
      date: a.date || b.date,
      updatedAt: [a.updatedAt, b.updatedAt].filter(Boolean).sort().pop() || null,
      matches: []
    };
    var byId = {};
    (a.matches || []).forEach(function (m) { m = trimCaptures(normalizeMatch(m)); byId[m.matchId] = m; });
    (b.matches || []).forEach(function (m) {
      m = normalizeMatch(m);
      var old = byId[m.matchId];
      if (!old) { byId[m.matchId] = trimCaptures(m); return; }
      // 快照并集（按 at 去重，优先保留 diff 非空的一份），保留最近两次
      var map = {};
      old.captures.concat(m.captures).forEach(function (c) {
        if (!c || !c.at) return;
        var prev = map[c.at];
        if (!prev || (prev.diff == null && c.diff != null)) map[c.at] = c;
      });
      old.captures = Object.keys(map).sort().map(function (k) { return map[k]; });
      while (old.captures.length > 2) old.captures.shift();
      old.totalCaptures = (old.totalCaptures || 0) + (m.totalCaptures || m.captures.length) || old.captures.length;
      if (m.isSingleWin != null) old.isSingleWin = m.isSingleWin;
      if (m.isSingleHandicap != null) old.isSingleHandicap = m.isSingleHandicap;
      old.matchStatus = m.matchStatus || old.matchStatus;
      old.matchTime = m.matchTime || old.matchTime;
      old.matchDate = m.matchDate || old.matchDate;
      old.league = m.league || old.league;
      old.home = m.home || old.home;
      old.away = m.away || old.away;
      if (m.result && (!old.result || String(m.result.at || '') >= String(old.result.at || ''))) {
        old.result = m.result;
      }
    });
    out.matches = Object.keys(byId).map(function (k) { return byId[k]; }).sort(cmpMatch);
    return out;
  }

  // ---------------------------------------------------------------- 展平 / 导出

  function capFields(c) {
    if (!c) return { ttg1: null, s10: null, s01: null, optimized: null, diff: null, at: '' };
    var o = c.odds || {};
    return {
      ttg1: o.ttg1 != null ? o.ttg1 : null,
      s10: o.s10 != null ? o.s10 : null,
      s01: o.s01 != null ? o.s01 : null,
      optimized: c.optimized != null ? c.optimized : null,
      diff: c.diff != null ? c.diff : null,
      at: c.at || ''
    };
  }

  // 把若干天数据文件展平成"每场一行"的表格行（网页表格、Excel、CSV 共用）
  function flatRows(dayDocs) {
    var rows = [];
    (dayDocs || []).forEach(function (d) {
      (d.matches || []).forEach(function (m0) {
        var m = normalizeMatch(m0);
        var c1 = capFields(m.captures[0] || null);
        var c2 = capFields(m.captures[1] || null);
        var latest = m.captures[1] || m.captures[0] || null;
        var lf = capFields(latest);
        var delta = null, dir = '';
        if (c1.diff != null && c2.diff != null) {
          delta = round3(c2.diff - c1.diff);
          dir = delta > 0.0005 ? '↑' : (delta < -0.0005 ? '↓' : '→');
        }
        rows.push({
          date: d.date || m.businessDate || '',
          matchDate: m.matchDate || m.businessDate || d.date || '',
          kickoff: ((m.matchDate || '').slice(5) + ' ' + (m.matchTime || '').slice(0, 5)).trim(),
          matchNumStr: m.matchNumStr || '',
          league: m.league || '',
          home: m.home || '',
          away: m.away || '',
          isSingleWin: m.isSingleWin === true ? true : (m.isSingleWin === false ? false : null),
          o1: c1,
          o2: c2,
          diff: lf.diff,                       // 主差值：取最新一次快照
          diffDelta: delta,
          dir: dir,
          times: (c1.at ? fmtAt(c1.at) : '') + (c2.at ? ' / ' + fmtAt(c2.at) : ''),
          score: m.result ? m.result.score : null,
          halfScore: m.result ? m.result.halfScore : null,
          isOneGoal: m.result ? !!m.result.isOneGoal : null,
          resultAt: m.result ? (m.result.at || '') : ''
        });
      });
    });
    rows.sort(function (a, b) {
      var d = String(a.date).localeCompare(String(b.date));
      if (d !== 0) return d;
      var t = String(a.kickoff).localeCompare(String(b.kickoff));
      if (t !== 0) return t;
      return String(a.matchNumStr).localeCompare(String(b.matchNumStr));
    });
    return rows;
  }

  var CSV_HEADERS = ['日期', '场次编号', '联赛', '主队', '客队', '开赛时间', '单关胜平负',
    '①1球', '①1:0', '①0:1', '①优化赔率', '①差值', '①抓取时间',
    '②1球', '②1:0', '②0:1', '②优化赔率', '②差值', '②抓取时间', '变化', '差值变化量',
    '全场比分', '半场比分', '是否1球', '结果更新时间'];

  function rowToCells(r) {
    var one = function (v) { return v == null ? '' : (v ? '是' : '否'); };
    return [
      r.date, r.matchNumStr, r.league, r.home, r.away, r.kickoff,
      r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否'),
      r.o1.ttg1, r.o1.s10, r.o1.s01, r.o1.optimized, r.o1.diff, fmtAt(r.o1.at),
      r.o2.ttg1, r.o2.s10, r.o2.s01, r.o2.optimized, r.o2.diff, fmtAt(r.o2.at),
      r.dir, r.diffDelta,
      r.score || '', r.halfScore || '', one(r.isOneGoal), fmtAt(r.resultAt)
    ];
  }

  function toCSV(rows) {
    var esc = function (v) {
      if (v == null) return '';
      v = String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [CSV_HEADERS.join(',')];
    rows.forEach(function (r) { lines.push(rowToCells(r).map(esc).join(',')); });
    return '﻿' + lines.join('\r\n'); // BOM 让 Excel 正确识别 UTF-8
  }

  // ---------------------------------------------------------------- 统计

  // 差值变化的分档（第二次 − 第一次）
  var DELTA_BUCKETS = [
    { lo: null, hi: -0.10, label: '下降 ≥0.10（缩水明显）' },
    { lo: -0.10, hi: -0.03, label: '下降 0.03~0.10（小幅缩水）' },
    { lo: -0.03, hi: 0.03, label: '基本不变（±0.03）' },
    { lo: 0.03, hi: 0.10, label: '上升 0.03~0.10（小幅变大）' },
    { lo: 0.10, hi: null, label: '上升 ≥0.10（变大明显）' }
  ];

  function latestDiff(r) { return r.diff; }

  // 对表格行做统计：总体概览 + 差值分箱 + 单关分组对比 + 差值变化分档
  function stats(rows, binWidth) {
    rows = rows || [];
    binWidth = binWidth || 0.05;
    var withDiff = rows.filter(function (r) { return latestDiff(r) != null; });
    var settled = rows.filter(function (r) { return latestDiff(r) != null && r.isOneGoal != null; });
    var one = settled.filter(function (r) { return r.isOneGoal; });
    var non = settled.filter(function (r) { return !r.isOneGoal; });
    var avg = function (arr, f) {
      if (!arr.length) return null;
      return arr.reduce(function (s, r) { return s + f(r); }, 0) / arr.length;
    };
    var group = function (arr) {
      var gs = arr.filter(function (r) { return r.isOneGoal != null; });
      var go = gs.filter(function (r) { return r.isOneGoal; });
      return {
        count: arr.length,
        settled: gs.length,
        oneGoalCount: go.length,
        oneGoalRatio: gs.length ? go.length / gs.length : null,
        avgDiff: round3(avg(arr.filter(function (r) { return latestDiff(r) != null; }), function (r) { return latestDiff(r); }))
      };
    };
    var single = rows.filter(function (r) { return r.isSingleWin === true; });
    var nonSingle = rows.filter(function (r) { return r.isSingleWin === false; });
    var deltaRows = settled.filter(function (r) { return r.diffDelta != null; });

    var summary = {
      total: rows.length,
      settled: settled.length,
      oneGoalCount: one.length,
      oneGoalRatio: settled.length ? one.length / settled.length : null,
      avgDiffAll: round3(avg(settled, function (r) { return latestDiff(r); })),
      avgDiffOne: round3(avg(one, function (r) { return latestDiff(r); })),
      avgDiffNon: round3(avg(non, function (r) { return latestDiff(r); })),
      // v2：单关维度
      singleCount: single.length,
      singleSettled: group(single).settled,
      singleOneGoal: group(single).oneGoalCount,
      singleOneGoalRatio: group(single).oneGoalRatio,
      avgDiffSingle: group(single).avgDiff,
      nonSingleCount: nonSingle.length,
      nonSingleOneGoalRatio: group(nonSingle).oneGoalRatio,
      avgDiffNonSingle: group(nonSingle).avgDiff,
      singleGroup: group(single),
      nonSingleGroup: group(nonSingle),
      // v2：两次快照与变化
      twoCaptureCount: rows.filter(function (r) { return r.o2 && r.o2.at; }).length,
      deltaSettled: deltaRows.length,
      avgDeltaAll: round3(avg(deltaRows, function (r) { return r.diffDelta; })),
      avgDeltaOne: round3(avg(deltaRows.filter(function (r) { return r.isOneGoal; }), function (r) { return r.diffDelta; })),
      avgDeltaNon: round3(avg(deltaRows.filter(function (r) { return !r.isOneGoal; }), function (r) { return r.diffDelta; }))
    };

    // 差值分箱（按最新差值）
    var bins = [];
    if (settled.length) {
      var diffs = settled.map(function (r) { return latestDiff(r); });
      var min = Math.min.apply(null, diffs), max = Math.max.apply(null, diffs);
      var w = binWidth;
      while ((max - min) / w > 60) w *= 2;
      while ((max - min) / w < 8 && w > 0.005) w /= 2;
      var start = Math.floor(min / w) * w;
      var n = Math.ceil((max - start) / w) + 1;
      for (var i = 0; i < n; i++) {
        var lo = round3(start + i * w);
        var hi = round3(start + (i + 1) * w);
        var inBin = settled.filter(function (r) { return latestDiff(r) >= lo && (i === n - 1 ? latestDiff(r) <= hi : latestDiff(r) < hi); });
        var bOne = inBin.filter(function (r) { return r.isOneGoal; }).length;
        var bAvg = inBin.length ? inBin.reduce(function (s, r) { return s + latestDiff(r); }, 0) / inBin.length : null;
        bins.push({
          lo: lo, hi: hi,
          label: lo.toFixed(2) + ' ~ ' + hi.toFixed(2),
          count: inBin.length,
          oneCount: bOne,
          nonOneCount: inBin.length - bOne,
          oneRatio: inBin.length ? bOne / inBin.length : null,
          avgDiff: bAvg == null ? null : round3(bAvg)
        });
      }
    }

    // 差值变化分档（第二次 − 第一次），仅统计两次快照齐全且已出结果的场次
    var deltaBins = DELTA_BUCKETS.map(function (b) {
      var inB = deltaRows.filter(function (r) {
        if (b.lo != null && r.diffDelta < b.lo) return false;
        if (b.hi != null && r.diffDelta >= b.hi) return false;
        return true;
      });
      var bOne = inB.filter(function (r) { return r.isOneGoal; }).length;
      return {
        label: b.label,
        count: inB.length,
        oneCount: bOne,
        nonOneCount: inB.length - bOne,
        oneRatio: inB.length ? bOne / inB.length : null,
        avgDelta: inB.length ? round3(inB.reduce(function (s, r) { return s + r.diffDelta; }, 0) / inB.length) : null
      };
    });

    return { summary: summary, bins: bins, deltaBins: deltaBins, binWidth: binWidth };
  }

  // ---------------------------------------------------------------- 数据文件名

  function dayFileName(date) { return 'days/' + date + '.json'; }
  function parseDayFileName(name) {
    var m = /(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    return m ? m[1] : null;
  }

  return {
    VERSION: VERSION,
    API_BASE: API_BASE,
    ODDS_URL: ODDS_URL,
    resultUrl: resultUrl,
    NODE_HEADERS: NODE_HEADERS,
    fetchJson: fetchJson,
    fetchAllResults: fetchAllResults,
    parseOdds: parseOdds,
    parseResults: parseResults,
    normScore: normScore,
    computeDiff: computeDiff,
    isOneGoalScore: isOneGoalScore,
    normalizeMatch: normalizeMatch,
    latestCapture: latestCapture,
    mergeDay: mergeDay,
    mergeDocs: mergeDocs,
    applyResults: applyResults,
    flatRows: flatRows,
    rowToCells: rowToCells,
    CSV_HEADERS: CSV_HEADERS,
    toCSV: toCSV,
    stats: stats,
    DELTA_BUCKETS: DELTA_BUCKETS,
    dayFileName: dayFileName,
    parseDayFileName: parseDayFileName,
    localDateStr: localDateStr,
    nowIso: nowIso,
    addDays: addDays,
    round3: round3,
    fmtAt: fmtAt,
    slotOf: slotOf
  };
});


(function () {
  'use strict';

  var JC = window.JCCore || (typeof JCCore !== 'undefined' ? JCCore : null);
  if (!JC) { console.error('[竞彩1球差值] 核心库未加载'); return; }

  var K_SETTINGS = 'jc_settings';
  var K_DAYS = 'jc_days';
  var K_DIRTY = 'jc_dirty';
  var K_LAST = 'jc_last_capture';
  var K_COLLAPSED = 'jc_collapsed';

  // ---------------------------------------------------------------- 存取

  function getSettings() { return GM_getValue(K_SETTINGS, { owner: '', repo: '', branch: 'main', token: '' }); }
  function canSync() { var s = getSettings(); return !!(s.owner && s.repo && s.token); }
  function getDays() { return GM_getValue(K_DAYS, {}); }
  function setDays(d) { GM_setValue(K_DAYS, d); }
  function getDirty() { return GM_getValue(K_DIRTY, []); }
  function setDirty(arr) { GM_setValue(K_DIRTY, arr); }
  function markDirty(date) {
    var d = getDirty();
    if (d.indexOf(date) < 0) { d.push(date); setDirty(d); }
  }

  // ---------------------------------------------------------------- 通知

  var statusEl = null;
  function say(msg, isErr) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = isErr ? '#c0392b' : '#333'; }
    try { GM_notification({ text: msg, title: '竞彩1球差值', timeout: 4000, silent: true }); } catch (e) {}
    console.log('[竞彩1球差值]', msg);
  }

  // ---------------------------------------------------------------- 抓取

  var busy = false;
  function capture(manual) {
    if (busy) return Promise.resolve(false);
    busy = true;
    say('正在抓取赔率…');
    return JC.fetchJson(JC.ODDS_URL, false).then(function (raw) {
      var at = JC.nowIso();
      var matches = JC.parseOdds(raw, at);
      if (!matches.length) throw new Error('接口未返回在售比赛');
      var days = getDays();
      var byDate = {};
      matches.forEach(function (m) { (byDate[m.businessDate] = byDate[m.businessDate] || []).push(m); });
      var added = 0, captured = 0;
      Object.keys(byDate).forEach(function (d) {
        var doc = days[d] || { date: d, matches: [] };
        var r = JC.mergeDay(doc, byDate[d], at);
        days[d] = r.day; added += r.added; captured += r.captured;
        markDirty(d);
      });
      setDays(days);
      GM_setValue(K_LAST, JC.localDateStr());
      var complete = matches.filter(function (m) { return m.captures[0].diff != null; }).length;
      say('抓取完成：' + matches.length + ' 场（新增 ' + added + '，快照 +' + captured + '，可算差值 ' + complete + '）');
      renderPanel();
      if (canSync()) return sync();
      if (manual) say('已存本机（未配置 GitHub，暂存于油猴存储）');
      return true;
    }).catch(function (e) {
      say('抓取失败：' + e.message, true);
      return false;
    }).then(function (r) { busy = false; return r; });
  }

  function backfill() {
    if (busy) return Promise.resolve(false);
    busy = true;
    var days = getDays();
    var today = JC.localDateStr();
    var minDate = JC.addDays(today, -14);
    var dates = Object.keys(days).filter(function (d) {
      return d <= today && d >= minDate && days[d].matches.some(function (m) { return !m.result; });
    }).sort();
    if (!dates.length) { busy = false; say('没有需要回填的场次'); return Promise.resolve(false); }
    say('正在回填赛果（' + dates.length + ' 天）…');
    var changed = 0;
    var chain = Promise.resolve();
    dates.forEach(function (d) {
      chain = chain.then(function () {
        return JC.fetchAllResults(d, d, false).then(function (results) {
          var r = JC.applyResults(days[d], results, JC.nowIso());
          if (r.changed > 0) { markDirty(d); changed += r.changed; }
        }).catch(function (e) { say(d + ' 赛果失败：' + e.message, true); });
      });
    });
    return chain.then(function () {
      setDays(days);
      say(changed ? ('已回填 ' + changed + ' 场赛果') : '没有新的赛果');
      renderPanel();
      if (changed && canSync()) return sync();
      busy = false;
      return true;
    });
  }

  // ---------------------------------------------------------------- GitHub 同步

  function ghHeaders() {
    var s = getSettings();
    return { 'Authorization': 'Bearer ' + s.token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  }
  function ghUrl(path) {
    var s = getSettings();
    return 'https://api.github.com/repos/' + s.owner + '/' + s.repo + '/contents/' + path;
  }
  function ghGetFile(path) {
    var s = getSettings();
    return fetch(ghUrl(path) + '?ref=' + encodeURIComponent(s.branch || 'main'), { headers: ghHeaders(), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { sha: null, doc: null };
        if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
        return r.json().then(function (j) {
          var doc = null;
          try { doc = JSON.parse(b64DecodeUtf8(j.content || '')); } catch (e) {}
          return { sha: j.sha, doc: doc };
        });
      });
  }
  function ghPutFile(path, doc, message, sha) {
    var s = getSettings();
    var body = { message: message, content: b64EncodeUtf8(JSON.stringify(doc, null, 1)), branch: s.branch || 'main' };
    if (sha) body.sha = sha;
    return fetch(ghUrl(path), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409) throw new Error('CONFLICT');
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error('写入失败 HTTP ' + r.status + (j.message ? '：' + j.message : ''));
      });
      return r.json();
    });
  }
  function b64EncodeUtf8(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64DecodeUtf8(b64) {
    var bin = atob((b64 || '').replace(/\n/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function sync() {
    if (!canSync()) { say('未配置 GitHub（菜单 → 设置），数据仅存本机', true); return Promise.resolve(false); }
    var dirty = getDirty().slice().sort();
    if (!dirty.length) { say('没有待同步的改动'); return Promise.resolve(true); }
    say('正在同步 ' + dirty.length + ' 天到 GitHub…');
    var days = getDays();
    var chain = Promise.resolve();
    dirty.forEach(function (d) {
      chain = chain.then(function () {
        var path = 'docs/data/days/' + d + '.json';
        var attempt = function () {
          return ghGetFile(path).then(function (g) {
            var merged = JC.mergeDocs(g.doc, days[d]);
            return ghPutFile(path, merged, 'data: 油猴同步 ' + d, g.sha).then(function () {
              days[d] = merged; setDays(days);
              setDirty(getDirty().filter(function (x) { return x !== d; }));
            });
          });
        };
        return attempt().catch(function (e) {
          if (e.message === 'CONFLICT') return attempt();
          throw e;
        });
      });
    });
    return chain.then(function () {
      var ipath = 'docs/data/index.json';
      return ghGetFile(ipath).then(function (g) {
        var idx = g.doc || { dates: {} };
        if (!idx.dates) idx.dates = {};
        Object.keys(days).forEach(function (d) {
          idx.dates[d] = { count: days[d].matches.length, updatedAt: days[d].updatedAt || JC.nowIso() };
        });
        idx.updatedAt = JC.nowIso();
        return ghPutFile(ipath, idx, 'data: 油猴同步索引 ' + JC.localDateStr(), g.sha);
      });
    }).then(function () {
      say('已同步到 GitHub（网页端 1~2 分钟后可见）');
      renderPanel();
      return true;
    }).catch(function (e) {
      say('同步失败：' + e.message, true);
      return false;
    });
  }

  // ---------------------------------------------------------------- 设置

  function openSettings() {
    var s = getSettings();
    var owner = prompt('GitHub 用户名/组织（仓库所有者）：', s.owner || '');
    if (owner == null) return;
    var repo = prompt('仓库名：', s.repo || '');
    if (repo == null) return;
    var branch = prompt('分支：', s.branch || 'main');
    if (branch == null) return;
    var token = prompt('访问令牌（细粒度 Token，仅需该仓库 Contents 读写权限；留空则不同步）：', s.token || '');
    if (token == null) return;
    GM_setValue(K_SETTINGS, { owner: owner.trim(), repo: repo.trim(), branch: branch.trim() || 'main', token: token.trim() });
    say(canSync() ? '设置已保存，可直接同步' : '设置已保存（未填令牌，仅存本机）');
    renderPanel();
    if (canSync() && getDirty().length) sync();
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify({ exportedAt: JC.nowIso(), days: getDays() }, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '竞彩1球-油猴数据-' + JC.localDateStr() + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function clearAll() {
    if (!confirm('确定清除油猴里保存的全部数据？（不影响的 GitHub 仓库数据）')) return;
    GM_setValue(K_DAYS, {});
    GM_setValue(K_DIRTY, []);
    say('已清除本机数据');
    renderPanel();
  }

  // ---------------------------------------------------------------- 浮窗

  var panel, body, listEl, statEl;

  function ensurePanel() {
    if (panel) return;
    var style = document.createElement('style');
    style.textContent = [
      '#jcq-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:430px;max-width:92vw;',
      'background:#fff;color:#222;border:1px solid #d8d8d4;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);',
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}',
      '#jcq-panel .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1f4e79;color:#fff}',
      '#jcq-panel .hd b{font-size:13px;margin-right:auto}',
      '#jcq-panel .hd button{background:rgba(255,255,255,.15);color:#fff;border:0;border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit}',
      '#jcq-panel .hd button:hover{background:rgba(255,255,255,.3)}',
      '#jcq-panel .bd{padding:8px 10px;max-height:46vh;overflow:auto}',
      '#jcq-panel .stat{color:#666;margin-bottom:6px}',
      '#jcq-panel table{width:100%;border-collapse:collapse}',
      '#jcq-panel th,#jcq-panel td{padding:3px 4px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}',
      '#jcq-panel th{color:#888;font-weight:600}',
      '#jcq-panel td.num{text-align:right;font-variant-numeric:tabular-nums}',
      '#jcq-panel .pos{color:#0a7a2f;font-weight:700}',
      '#jcq-panel .neg{color:#c0392b;font-weight:700}',
      '#jcq-panel .single{color:#b85c00;font-weight:700}',
      '#jcq-pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#1f4e79;color:#fff;',
      'border-radius:20px;padding:9px 15px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);',
      'font:12px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;user-select:none;',
      'display:flex;align-items:center;gap:6px}',
      '#jcq-pill:hover{background:#2a6296}',
      '#jcq-pill::before{content:"";width:8px;height:8px;border-radius:50%;background:#7fd1a8}'
    ].join('');
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'jcq-panel';
    panel.innerHTML =
      '<div class="hd"><b>竞彩1球差值</b>' +
      '<button data-act="cap">刷新赔率</button>' +
      '<button data-act="res">回填赛果</button>' +
      '<button data-act="sync">同步</button>' +
      '<button data-act="set">设置</button>' +
      '<button data-act="fold" title="最小化为右下角浮标">—</button></div>' +
      '<div class="bd"><div class="stat" id="jcq-status"></div><div id="jcq-list"></div></div>';
    document.body.appendChild(panel);

    body = panel.querySelector('.bd');
    listEl = panel.querySelector('#jcq-list');
    statEl = panel.querySelector('#jcq-status');
    statusEl = statEl;

    panel.addEventListener('click', function (ev) {
      var act = ev.target && ev.target.dataset && ev.target.dataset.act;
      if (!act) return;
      if (act === 'cap') capture(true);
      else if (act === 'res') backfill();
      else if (act === 'sync') sync();
      else if (act === 'set') openSettings();
      else if (act === 'fold') fold(true);
    });

    if (GM_getValue(K_COLLAPSED, null) === null) {
      // 首次使用：赛程页展开，其他页面收起
      GM_setValue(K_COLLAPSED, !/zqszsc|\/jc\/(index|zqspf|zqbf|zqjq)/.test(location.pathname));
    }
    if (GM_getValue(K_COLLAPSED, false)) fold(true);
  }

  var pill = null;
  function fold(collapsed) {
    GM_setValue(K_COLLAPSED, collapsed);
    if (collapsed) {
      panel.style.display = 'none';
      if (!pill) {
        pill = document.createElement('div');
        pill.id = 'jcq-pill';
        pill.textContent = '竞彩1球差值';
        pill.title = '点击展开面板';
        pill.onclick = function () { fold(false); renderPanel(); };
        document.body.appendChild(pill);
      }
      pill.style.display = '';
    } else {
      panel.style.display = '';
      if (pill) pill.style.display = 'none';
    }
  }

  // 有些官网页面是 SPA，路由切换/重绘时可能把我们的面板和浮标从 DOM 里清掉；
  // 监听 body 变化，发现被移除就自动挂回去（不影响页面本身）
  function keepAlive() {
    if (!window.MutationObserver || !document.body) return;
    var scheduled = false;
    var check = function () {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        try {
          if (panel && !document.body.contains(panel)) document.body.appendChild(panel);
          if (pill && pill.style.display !== 'none' && !document.body.contains(pill)) document.body.appendChild(pill);
        } catch (e) { /* 忽略 */ }
      }, 400);
    };
    new MutationObserver(check).observe(document.body, { childList: true });
    if (document.documentElement) {
      new MutationObserver(check).observe(document.documentElement, { childList: true });
    }
  }

  function renderPanel() {
    if (!panel) return;
    var days = getDays();
    var dates = Object.keys(days).sort();
    if (!dates.length) {
      listEl.innerHTML = '<div style="color:#888;padding:8px 0">还没有数据，点「刷新赔率」开始。</div>';
      return;
    }
    // 展示最近一个有数据的日期（通常是今天）
    var showDate = dates[dates.length - 1];
    var today = JC.localDateStr();
    if (days[today]) showDate = today;
    var rows = JC.flatRows([days[showDate]]);
    var dirty = getDirty();
    var complete = rows.filter(function (r) { return r.diff != null; }).length;
    statEl.textContent = showDate + ' · ' + rows.length + ' 场 · 可算差值 ' + complete +
      (dirty.length ? ' · 待同步 ' + dirty.length + ' 天' : (canSync() ? ' · 已配置云端' : ' · 未配置云端'));

    var body = rows.map(function (r) {
      var cls = r.diff == null ? '' : (r.diff > 0 ? 'pos' : 'neg');
      var dirCls = r.dir === '↑' ? 'neg' : (r.dir === '↓' ? 'pos' : '');
      return '<tr><td>' + esc(r.matchNumStr) + '</td>' +
        '<td>' + esc(r.home) + ' vs ' + esc(r.away) + '</td>' +
        '<td class="single">' + (r.isSingleWin ? '单' : '') + '</td>' +
        '<td class="num">' + fmt(r.o1.ttg1) + '</td>' +
        '<td class="num ' + cls + '">' + fmtDiff(r.diff) + '</td>' +
        '<td class="' + dirCls + '">' + (r.dir || '') + '</td>' +
        '<td>' + (r.score || '') + '</td></tr>';
    }).join('');
    listEl.innerHTML = '<table><thead><tr><th>编号</th><th>对阵</th><th>单</th><th>1球①</th><th>差值</th><th>变化</th><th>赛果</th></tr></thead><tbody>' + body + '</tbody></table>';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(v) { return v == null ? '—' : Number(v).toFixed(2); }
  function fmt3(v) { return v == null ? '—' : Number(v).toFixed(3); }
  function fmtDiff(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(3); }

  // ---------------------------------------------------------------- 菜单与启动

  GM_registerMenuCommand('立即抓取赔率', function () { capture(true); });
  GM_registerMenuCommand('回填赛果', backfill);
  GM_registerMenuCommand('同步到 GitHub', sync);
  GM_registerMenuCommand('设置 GitHub 仓库/令牌', openSettings);
  GM_registerMenuCommand('导出数据 JSON', exportJson);
  GM_registerMenuCommand('清除本机数据', clearAll);

  ensurePanel();
  keepAlive();
  renderPanel();

  // 每天首次访问自动抓取一次
  var today = JC.localDateStr();
  if (GM_getValue(K_LAST, '') !== today) {
    capture(false).then(function (ok) {
      if (ok) GM_setValue(K_LAST, today);
      renderPanel();
    });
  }
})();
