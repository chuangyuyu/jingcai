// ==UserScript==
// @name         竞彩1球差值助手
// @namespace    jingcai-1qiu-diff
// @version      1.0.0
// @description  在体彩官网抓取竞彩足球「1球赔率 vs 比分(1:0/0:1)双选优化赔率」的差值，浮窗展示今日场次，可同步到你的 GitHub 仓库（配合 GitHub Pages 网页使用）
// @author       jingcai-1qiu-diff
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
 * 竞彩足球「1球赔率 vs 比分双选优化赔率」差值记录工具 — 共享核心库
 * ============================================================
 * 本文件是全部业务逻辑的唯一事实来源，同时被三端使用：
 *   1. GitHub Pages 网页      docs/app.js（浏览器直接 <script> 引入）
 *   2. 本机定时任务脚本       scripts/daily.js（Node 环境 require）
 *   3. Edge 油猴脚本          userscript/jingcai.user.js（构建时由 scripts/build-userscript.js 内联）
 * 修改业务逻辑（接口、公式、字段）只需改这一个文件。
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

  var VERSION = '1.0.0';
  var API_BASE = 'https://webapi.sporttery.cn';

  // 赔率接口：一次返回当前在售的全部比赛和全部玩法赔率
  //   ttg.s1     = 总进球「1球」赔率
  //   crs.s01s00 = 比分 1:0 赔率     crs.s00s01 = 比分 0:1 赔率
  //   had.h/d/a  = 胜平负（顺带记录，便于后续扩展分析）
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

  // 本地时区带偏移的 ISO 时间戳，如 2026-09-20T12:30:05+08:00
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

  // ---------------------------------------------------------------- 数据解析

  // 官方赔率 JSON → 比赛记录数组
  function parseOdds(raw, capturedAt) {
    var out = [];
    var groups = (raw && raw.value && raw.value.matchInfoList) || [];
    groups.forEach(function (g) {
      (g.subMatchList || []).forEach(function (m) {
        var ttg = m.ttg || {}, crs = m.crs || {}, had = m.had || {};
        var rec = {
          matchId: m.matchId,
          businessDate: m.businessDate || g.businessDate,
          matchDate: m.matchDate || m.businessDate || g.businessDate, // 真实开赛日历日（凌晨场与销售日不同）
          matchNumStr: m.matchNumStr || '',
          league: m.leagueAbbName || m.leagueAllName || '',
          home: m.homeTeamAbbName || m.homeTeamAllName || '',
          away: m.awayTeamAbbName || m.awayTeamAllName || '',
          matchTime: m.matchTime || '',
          matchStatus: m.matchStatus || m.sellStatus || '',
          odds: {
            ttg1: num(ttg.s1),          // 总进球「1球」
            s10: num(crs.s01s00),       // 比分 1:0
            s01: num(crs.s00s01),       // 比分 0:1
            had: [num(had.h), num(had.d), num(had.a)]
          },
          oddsAt: capturedAt,
          captureCount: 1,
          result: null
        };
        var c = computeDiff(rec.odds.ttg1, rec.odds.s10, rec.odds.s01);
        rec.optimized = c.optimized;
        rec.diff = c.diff;
        out.push(rec);
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

  // ---------------------------------------------------------------- 计算

  // 双选优化：押 1 元按 1/s10 : 1/s01 的比例拆成两注，无论哪个比分命中，
  // 回报均为 s10*s01/(s10+s01) 元（等回报拆分）。这就是「优化赔率」。
  function computeDiff(ttg1, s10, s01) {
    var a = num(s10), b = num(s01), c = num(ttg1);
    if (a == null || b == null || c == null) return { optimized: null, diff: null };
    var opt = (a * b) / (a + b);
    return { optimized: round3(opt), diff: round3(c - opt) };
  }

  // ---------------------------------------------------------------- 合并

  function sameOdds(x, y) {
    try { return JSON.stringify(x) === JSON.stringify(y); } catch (e) { return false; }
  }

  function cmpMatch(a, b) {
    var t = String(a.matchTime || '').localeCompare(String(b.matchTime || ''));
    if (t !== 0) return t;
    return String(a.matchNumStr || '').localeCompare(String(b.matchNumStr || ''));
  }

  // 把新抓到的比赛合并进某天的数据文件：
  //   - 新比赛追加；已有的比赛用最新赔率覆盖（保留赛果字段，回填和赔率刷新互不干扰）
  //   - 返回 {day, added, updated}，调用方据此决定是否落盘 / 提交
  function mergeDay(dayDoc, incomingMatches, capturedAt) {
    dayDoc = dayDoc || { date: '', matches: [] };
    if (!dayDoc.matches) dayDoc.matches = [];
    var byId = {};
    dayDoc.matches.forEach(function (m) { byId[m.matchId] = m; });
    var added = 0, updated = 0;
    (incomingMatches || []).forEach(function (inc) {
      var old = byId[inc.matchId];
      if (!old) { byId[inc.matchId] = inc; added++; return; }
      var o = inc.odds || {};
      var hasOdds = o.ttg1 != null || o.s10 != null || o.s01 != null || (o.had && o.had[0] != null);
      if (hasOdds) {
        if (!sameOdds(old.odds, inc.odds)) updated++;
        old.odds = inc.odds;
        old.optimized = inc.optimized;
        old.diff = inc.diff;
        old.oddsAt = capturedAt;
        old.captureCount = (old.captureCount || 1) + 1;
        old.matchStatus = inc.matchStatus || old.matchStatus;
        old.matchTime = inc.matchTime || old.matchTime;
        old.matchDate = inc.matchDate || old.matchDate;
        old.league = inc.league || old.league;
        old.home = inc.home || old.home;
        old.away = inc.away || old.away;
      }
    });
    dayDoc.matches = Object.keys(byId).map(function (k) { return byId[k]; }).sort(cmpMatch);
    dayDoc.updatedAt = capturedAt;
    return { day: dayDoc, added: added, updated: updated };
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

  // 文档级合并（用于多端数据汇合：如网页本地改动 + 云端旧文件）。
  // 规则：同一场比赛，赔率取 oddsAt 更新的一份；赛果取已有结果/更新的一份。
  function mergeDocs(a, b) {
    if (!a) return b;
    if (!b) return a;
    var out = {
      date: a.date || b.date,
      updatedAt: [a.updatedAt, b.updatedAt].filter(Boolean).sort().pop() || null,
      matches: []
    };
    var byId = {};
    (a.matches || []).forEach(function (m) { byId[m.matchId] = m; });
    (b.matches || []).forEach(function (m) {
      var old = byId[m.matchId];
      if (!old) { byId[m.matchId] = m; return; }
      if (m.oddsAt && (!old.oddsAt || m.oddsAt > old.oddsAt)) {
        old.odds = m.odds; old.optimized = m.optimized; old.diff = m.diff;
        old.oddsAt = m.oddsAt;
        old.captureCount = Math.max(old.captureCount || 1, m.captureCount || 1);
        old.matchStatus = m.matchStatus || old.matchStatus;
        old.matchTime = m.matchTime || old.matchTime;
        old.matchDate = m.matchDate || old.matchDate;
        old.league = m.league || old.league;
        old.home = m.home || old.home;
        old.away = m.away || old.away;
      }
      if (m.result && (!old.result || String(m.result.at || '') >= String(old.result.at || ''))) {
        old.result = m.result;
      }
    });
    out.matches = Object.keys(byId).map(function (k) { return byId[k]; }).sort(cmpMatch);
    return out;
  }

  // ---------------------------------------------------------------- 展平 / 导出

  // 把若干天数据文件展平成"每场一行"的表格行（网页表格、Excel、CSV 共用）
  function flatRows(dayDocs) {
    var rows = [];
    (dayDocs || []).forEach(function (d) {
      (d.matches || []).forEach(function (m) {
        var o = m.odds || {};
        rows.push({
          date: d.date || m.businessDate || '',
          matchDate: m.matchDate || m.businessDate || d.date || '',
          kickoff: ((m.matchDate || '').slice(5) + ' ' + (m.matchTime || '').slice(0, 5)).trim(),
          matchNumStr: m.matchNumStr || '',
          league: m.league || '',
          home: m.home || '',
          away: m.away || '',
          matchTime: m.matchTime || '',
          ttg1: o.ttg1 != null ? o.ttg1 : null,
          s10: o.s10 != null ? o.s10 : null,
          s01: o.s01 != null ? o.s01 : null,
          optimized: m.optimized != null ? m.optimized : null,
          diff: m.diff != null ? m.diff : null,
          score: m.result ? m.result.score : null,
          halfScore: m.result ? m.result.halfScore : null,
          isOneGoal: m.result ? !!m.result.isOneGoal : null,
          oddsAt: m.oddsAt || null
        });
      });
    });
    rows.sort(function (a, b) {
      var d = String(a.date).localeCompare(String(b.date));
      if (d !== 0) return d;
      var t = String(a.matchTime).localeCompare(String(b.matchTime));
      if (t !== 0) return t;
      return String(a.matchNumStr).localeCompare(String(b.matchNumStr));
    });
    return rows;
  }

  var CSV_HEADERS = ['日期', '场次编号', '联赛', '主队', '客队', '开赛时间',
    '1球赔率', '1:0赔率', '0:1赔率', '优化赔率', '差值', '全场比分', '半场比分', '是否1球', '赔率更新时间'];

  function rowToCells(r) {
    return [
      r.date, r.matchNumStr, r.league, r.home, r.away, r.kickoff,
      r.ttg1, r.s10, r.s01, r.optimized, r.diff,
      r.score || '未出', r.halfScore || '',
      r.isOneGoal == null ? '' : (r.isOneGoal ? '是' : '否'),
      r.oddsAt || ''
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

  // 对表格行做统计：总体概览 + 差值分箱分布（分箱同时统计 1球/非1球 场次和 1球占比）
  function stats(rows, binWidth) {
    binWidth = binWidth || 0.05;
    var settled = (rows || []).filter(function (r) { return r.diff != null && r.isOneGoal != null; });
    var one = settled.filter(function (r) { return r.isOneGoal; });
    var non = settled.filter(function (r) { return !r.isOneGoal; });
    var avg = function (arr) {
      if (!arr.length) return null;
      return arr.reduce(function (s, r) { return s + r.diff; }, 0) / arr.length;
    };
    var summary = {
      total: (rows || []).length,
      settled: settled.length,
      oneGoalCount: one.length,
      oneGoalRatio: settled.length ? one.length / settled.length : null,
      avgDiffAll: round3(avg(settled)),
      avgDiffOne: round3(avg(one)),
      avgDiffNon: round3(avg(non))
    };

    var bins = [];
    if (settled.length) {
      var diffs = settled.map(function (r) { return r.diff; });
      var min = Math.min.apply(null, diffs), max = Math.max.apply(null, diffs);
      // 箱数控制在 8~60 之间，自动调整箱宽
      var w = binWidth;
      while ((max - min) / w > 60) w *= 2;
      while ((max - min) / w < 8 && w > 0.005) w /= 2;
      var start = Math.floor(min / w) * w;
      var n = Math.ceil((max - start) / w) + 1;
      for (var i = 0; i < n; i++) {
        var lo = round3(start + i * w);
        var hi = round3(start + (i + 1) * w);
        var inBin = settled.filter(function (r) { return r.diff >= lo && (i === n - 1 ? r.diff <= hi : r.diff < hi); });
        var bOne = inBin.filter(function (r) { return r.isOneGoal; }).length;
        var bAvg = inBin.length ? inBin.reduce(function (s, r) { return s + r.diff; }, 0) / inBin.length : null;
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
    return { summary: summary, bins: bins, binWidth: binWidth };
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
    mergeDay: mergeDay,
    mergeDocs: mergeDocs,
    applyResults: applyResults,
    flatRows: flatRows,
    rowToCells: rowToCells,
    CSV_HEADERS: CSV_HEADERS,
    toCSV: toCSV,
    stats: stats,
    dayFileName: dayFileName,
    parseDayFileName: parseDayFileName,
    localDateStr: localDateStr,
    nowIso: nowIso,
    addDays: addDays,
    round3: round3
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
      var added = 0;
      Object.keys(byDate).forEach(function (d) {
        var doc = days[d] || { date: d, matches: [] };
        var r = JC.mergeDay(doc, byDate[d], at);
        days[d] = r.day; added += r.added;
        markDirty(d);
      });
      setDays(days);
      GM_setValue(K_LAST, JC.localDateStr());
      var complete = matches.filter(function (m) { return m.diff != null; }).length;
      say('抓取完成：' + matches.length + ' 场（新增 ' + added + '，可算差值 ' + complete + '）');
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
      '#jcq-panel .pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#1f4e79;color:#fff;',
      'border-radius:20px;padding:8px 14px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);',
      'font:12px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}'
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
      '<button data-act="fold">—</button></div>' +
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
        pill.className = 'pill';
        pill.textContent = '竞彩1球差值';
        pill.onclick = function () { fold(false); renderPanel(); };
        document.body.appendChild(pill);
      }
      pill.style.display = '';
    } else {
      panel.style.display = '';
      if (pill) pill.style.display = 'none';
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
    var matches = days[showDate].matches.slice().sort(function (a, b) { return (a.matchTime || '').localeCompare(b.matchTime || ''); });
    var dirty = getDirty();
    var complete = matches.filter(function (m) { return m.diff != null; }).length;
    statEl.textContent = showDate + ' · ' + matches.length + ' 场 · 可算差值 ' + complete +
      (dirty.length ? ' · 待同步 ' + dirty.length + ' 天' : (canSync() ? ' · 已配置云端' : ' · 未配置云端'));

    var rows = matches.map(function (m) {
      var d = m.diff;
      var cls = d == null ? '' : (d > 0 ? 'pos' : 'neg');
      return '<tr><td>' + esc(m.matchNumStr) + '</td>' +
        '<td>' + esc(m.home) + ' vs ' + esc(m.away) + '</td>' +
        '<td class="num">' + fmt(m.odds && m.odds.ttg1) + '</td>' +
        '<td class="num">' + fmt3(m.optimized) + '</td>' +
        '<td class="num ' + cls + '">' + fmtDiff(d) + '</td>' +
        '<td>' + (m.result ? m.result.score : '') + '</td></tr>';
    }).join('');
    listEl.innerHTML = '<table><thead><tr><th>编号</th><th>对阵</th><th>1球</th><th>优化</th><th>差值</th><th>赛果</th></tr></thead><tbody>' + rows + '</tbody></table>';
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
