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
