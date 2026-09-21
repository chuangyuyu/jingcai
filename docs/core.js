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

  var VERSION = '2.2.1';
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

  // 赛果接口按「真实开赛日」过滤（凌晨场的真实开赛日 = 次日，例如周日晚 00:00 欧战属于周六销售日）。
  // 因此回填某天数据文件的赛果时，必须多查一天，否则凌晨场永远匹配不到。
  // 返回 [date, date+1]，三端（定时脚本/网页/油猴）统一使用。
  function resultRangeFor(date) { return [date, addDays(date, 1)]; }

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

  // ---------------------------------------------------------------- 编号追踪（编号 × 总进球数）

  // 场次编号的数字部分：'周日001' → '001'
  function numOf(matchNumStr) {
    var m = /(\d{3})\s*$/.exec(String(matchNumStr || ''));
    return m ? m[1] : null;
  }

  // 全场比分 → 总进球数：'2:1' → 3
  function goalsFromScore(score) {
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(score || '').trim());
    return m ? Number(m[1]) + Number(m[2]) : null;
  }

  // 两个 yyyy-mm-dd 之间的日历天数（b − a）
  function daysBetween(a, b) {
    if (!a || !b) return null;
    var pa = a.split('-'), pb = b.split('-');
    var ta = Date.UTC(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
    var tb = Date.UTC(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
    return Math.round((tb - ta) / 86400000);
  }

  var GOAL_LABELS = ['0球', '1球', '2球', '3球', '4球', '5球', '6球', '7+球'];

  // 默认进球数分档（0~6 各自 + 7+ 合并，通用默认）；
  // 用户的追踪口径在 numbers.json 的 buckets 字段里（由 config.json 的 numTrack.goalGroups 生成）
  var DEFAULT_NUM_BUCKETS = [
    { label: '0球', lo: 0, hi: 0 }, { label: '1球', lo: 1, hi: 1 }, { label: '2球', lo: 2, hi: 2 },
    { label: '3球', lo: 3, hi: 3 }, { label: '4球', lo: 4, hi: 4 }, { label: '5球', lo: 5, hi: 5 },
    { label: '6球', lo: 6, hi: 6 }, { label: '7+球', lo: 7, hi: null }
  ];

  // 解析分档配置："0,1,2,3,4,5+" → [{label:'0球',lo:0,hi:0},...,{label:'5+球',lo:5,hi:null}]
  function parseGoalGroups(spec) {
    if (!spec) return null;
    var parts = String(spec).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var out = [];
    parts.forEach(function (p) {
      var m = /^(\d+)\s*\+$/.exec(p);
      if (m) { out.push({ label: m[1] + '+球', lo: Number(m[1]), hi: null }); return; }
      var n = Number(p);
      if (isFinite(n)) out.push({ label: n + '球', lo: n, hi: n });
    });
    return out.length ? out : null;
  }

  function bucketIndexOf(buckets, goals) {
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      if (goals >= b.lo && (b.hi == null || goals <= b.hi)) return i;
    }
    return -1;
  }

  // 编号 × 进球数 的历史统计与"连续未出现"追踪。
  // doc: { updatedAt, alertDays?, nums?: ['001'..], buckets?: [{label,lo,hi}], days: { '2026-09-20': { '001': 2, ... } } }
  //   · nums    —— 关注范围（编号列表；不设则统计全部编号）
  //   · buckets —— 进球数分档（不设则用 DEFAULT_NUM_BUCKETS：0~6 各自 + 7+）
  // 返回 { days, firstDate, lastDate, alertDays, nums, buckets, alerts:[...], ... }
  //   · 「距今」= 最近一次出现（该编号打出该档进球数）到最近数据日的日历天数；
  //   · 「该出指数」= 距今 ÷ 历史平均间隔（越大概率上越"该出"）；
  //   · 警戒列表只纳入仍然活跃（近 activeWithinDays 天出现过）的编号、且历史上出现过至少一次的分档；
  //   · 从未出现过的分档以 never:true 标出（查询器可见，不进警戒）。
  function numbersStats(doc, opts) {
    opts = opts || {};
    var days = (doc && doc.days) || {};
    var dates = Object.keys(days).sort();
    var alertDays = opts.alertDays || (doc && doc.alertDays) || 30;
    var activeWithin = opts.activeWithinDays || 7;
    var buckets = opts.buckets || (doc && doc.buckets) || DEFAULT_NUM_BUCKETS;
    var watchNums = opts.nums || (doc && doc.nums) || null;
    if (!dates.length) return { days: 0, firstDate: null, lastDate: null, alertDays: alertDays, nums: [], buckets: buckets, alerts: [] };
    var lastDate = dates[dates.length - 1];
    var numSet = {};
    dates.forEach(function (d) { Object.keys(days[d] || {}).forEach(function (n) { numSet[n] = true; }); });
    var numList = Object.keys(numSet).sort();
    if (watchNums && watchNums.length) {
      numList = watchNums.filter(function (n) { return numSet[n]; }); // 只看关注编号（数据里出现过的）
    }
    var nums = numList.map(function (num) {
      var counts = buckets.map(function () { return 0; });
      var lastHit = buckets.map(function () { return null; });
      var streak = buckets.map(function () { return 0; });
      var occ = 0, firstSeen = null, lastSeen = null;
      dates.forEach(function (d) {
        var g = (days[d] || {})[num];
        if (g == null) return;
        occ++;
        if (!firstSeen) firstSeen = d;
        lastSeen = d;
        var b = bucketIndexOf(buckets, g);
        for (var k = 0; k < buckets.length; k++) {
          if (k === b) { counts[k]++; lastHit[k] = d; streak[k] = 0; }
          else streak[k] += 1;
        }
      });
      var active = lastSeen != null && daysBetween(lastSeen, lastDate) <= activeWithin;
      var span = firstSeen && lastSeen ? Math.max(1, daysBetween(firstSeen, lastDate)) : null;
      var combos = buckets.map(function (bk, k) {
        var lh = lastHit[k];
        var avgGap = (span && counts[k] > 0) ? Math.max(1, Math.round(span / counts[k])) : null;
        var daysSince = lh ? daysBetween(lh, lastDate) : (firstSeen ? daysBetween(firstSeen, lastDate) : null);
        return {
          bucket: k,
          label: bk.label,
          count: counts[k],
          lastDate: lh,
          daysSince: daysSince,
          never: !lh,
          streak: streak[k],
          avgGap: avgGap,   // 该组合历史上平均多少天出现一次（近似值）
          anomaly: (avgGap && lh && daysSince != null) ? Math.round(daysSince / avgGap * 10) / 10 : null, // 该出指数
          active: active
        };
      });
      return { num: num, occurrences: occ, firstSeen: firstSeen, lastSeen: lastSeen, active: active, counts: counts, combos: combos };
    });
    var alerts = [];
    nums.forEach(function (n) {
      if (!n.active) return;
      n.combos.forEach(function (c) {
        if (!c.never && c.daysSince != null && c.daysSince >= alertDays) {
          alerts.push({
            num: n.num, bucket: c.bucket, label: c.label, daysSince: c.daysSince,
            lastDate: c.lastDate, streak: c.streak, count: c.count,
            avgGap: c.avgGap, anomaly: c.anomaly
          });
        }
      });
    });
    // 按「该出指数」排序（距今 ÷ 平均间隔），罕见组合自然沉底；无指数时退回按距今天数
    alerts.sort(function (a, b) {
      var ra = a.anomaly != null ? a.anomaly : 0;
      var rb = b.anomaly != null ? b.anomaly : 0;
      if (rb !== ra) return rb - ra;
      return b.daysSince - a.daysSince;
    });
    return { days: dates.length, firstDate: dates[0], lastDate: lastDate, alertDays: alertDays, nums: nums, buckets: buckets, alerts: alerts };
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
    resultRangeFor: resultRangeFor,
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
    numOf: numOf,
    goalsFromScore: goalsFromScore,
    daysBetween: daysBetween,
    numbersStats: numbersStats,
    GOAL_LABELS: GOAL_LABELS,
    DEFAULT_NUM_BUCKETS: DEFAULT_NUM_BUCKETS,
    parseGoalGroups: parseGoalGroups,
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
