/*!
 * 竞彩足球「各进球数赔率 vs 比分多选优化赔率」差值分析与进球数预测 — 共享核心库 v3
 * ============================================================
 * 本文件是全部业务逻辑的唯一事实来源，同时被三端使用：
 *   1. GitHub Pages 网页      docs/app.js（浏览器直接 <script> 引入）
 *   2. 本机定时任务脚本       scripts/daily.js（Node 环境 require）
 *   3. Edge 油猴脚本          userscript/jingcai.user.js（构建时内联）
 *
 * 核心思路（用户确认）：
 *   · 对每个进球数 G（0~7+）：总进球G的赔率 vs 该进球数【所有比分】的多选优化赔率，差值对比；
 *   · 两种口径并行记录：
 *       口径A（多选优化保底）: optA = 1 ÷ Σ(1/各比分赔率)   —— G=1 时即 ab/(a+b)（等回报拆注的保底回报）
 *       口径B（简单平均）    : avgB = 各比分赔率的算术平均
 *     差值A = 总进球G赔率 − optA；差值B = 总进球G赔率 − avgB
 *   · 0球只有 0:0 一个比分，无法"优化/平均"→ 两种口径都没有差值；
 *     0球的差值由【全进球数曲线拟合】（二次拟合，g=1..7 的差值 → g=0 的预测值）给出。
 *   · 预测双轨：
 *       基线 = 差值最小的进球数（0球用拟合值参与比较）
 *       自修正模型 = 近30天"差值排名 × 进球数"的经验命中率表（稳健：爆冷场次不纳入更新）
 *   · 每场在赛果落定时冻结当时的预测（用该场之前的窗口，杜绝未来数据泄漏），长期对比两轨命中率。
 *
 * 数据来源（中国体育彩票官方 Web API，需中国大陆网络）：
 *   赔率: /gateway/jc/football/getMatchCalculatorV1.qry   赛果: /gateway/uniform/football/getUniformMatchResultV1.qry
 *   两个接口均返回 Access-Control-Allow-Origin: *，浏览器可直接跨域调用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.JCCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '3.4.0';
  var API_BASE = 'https://webapi.sporttery.cn';

  var ODDS_URL = API_BASE + '/gateway/jc/football/getMatchCalculatorV1.qry' +
    '?poolCode=had,hhad,ttg,crs,hafu&channel=c';

  // 官方比赛详情（头信息）接口：比分、队徽、赛事/战绩（CORS *，浏览器可直连）
  function matchHeadUrl(matchId) {
    return API_BASE + '/gateway/uniform/football/getMatchHeadV1.qry?source=web&sportteryMatchId=' + matchId;
  }

  // 官方比赛详情页（析：赔率分析；详细：含比分过程/直播）
  function officialDetailUrl(matchId, showType) {
    return 'https://www.sporttery.cn/jc/zqdz/index.html?showType=' + (showType || 2) + '&mid=' + matchId;
  }

  function resultUrl(beginDate, endDate, pageNo) {
    return API_BASE + '/gateway/uniform/football/getUniformMatchResultV1.qry' +
      '?matchBeginDate=' + beginDate + '&matchEndDate=' + endDate +
      '&leagueId=&pageSize=30&pageNo=' + (pageNo || 1) + '&isFix=0&matchPage=1&pcOrWap=1';
  }

  var NODE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Referer': 'https://www.sporttery.cn/',
    'Accept': 'application/json, text/plain, */*'
  };

  // ---------------------------------------------------------------- 工具

  function num(v) {
    var n = parseFloat(v);
    return (isFinite(n) && n > 0) ? n : null;
  }
  function round3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function localDateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
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
  function dateOf(iso) { return String(iso || '').slice(0, 10); }
  function daysBetween(a, b) {
    if (!a || !b) return null;
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((Date.UTC(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2])) -
      Date.UTC(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]))) / 86400000);
  }
  function fmtAt(iso) { return iso ? String(iso).slice(5, 16).replace('T', ' ') : ''; }

  function isOneGoalScore(score) { return score === '1:0' || score === '0:1'; }

  function goalsFromScore(score) {
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(score || '').trim());
    return m ? Number(m[1]) + Number(m[2]) : null;
  }

  function bucketOfGoals(g) { return g == null ? null : Math.min(g, 7); } // 7 = 7+球
  function bucketLabel(b) { return b === 7 ? '7+球' : b + '球'; }
  var GOAL_LABELS = ['0球', '1球', '2球', '3球', '4球', '5球', '6球', '7+球'];

  // ---------------------------------------------------------------- 场次编号 / 销售日

  function numOf(matchNumStr) {
    var m = /(\d{3})\s*$/.exec(String(matchNumStr || ''));
    return m ? m[1] : null;
  }
  var WEEK_CHARS = { '日': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
  function slateDateOf(matchNumStr, matchDate) {
    if (!matchDate) return null;
    var m = /^周([日一二三四五六])\s*\d{3}\s*$/.exec(String(matchNumStr || '').trim());
    if (!m) return matchDate;
    var p = String(matchDate).split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return d.getDay() === WEEK_CHARS[m[1]] ? matchDate : addDays(matchDate, -1);
  }

  // 赛果接口按"真实开赛日"过滤（凌晨场真实开赛日=次日），回填时范围 +1 天
  function resultRangeFor(date) { return [date, addDays(date, 1)]; }

  // ---------------------------------------------------------------- 网络

  async function fetchJson(url, isNode) {
    var res = await fetch(url, isNode ? { headers: NODE_HEADERS } : { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url);
    var text = await res.text();
    var data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('返回内容不是 JSON（可能被 WAF 拦截或接口有变）：' + text.slice(0, 120)); }
    if (data && data.success === false) {
      throw new Error('接口返回错误：' + (data.errorMessage || data.errorCode || '未知'));
    }
    return data;
  }

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

  // ---------------------------------------------------------------- 解析

  // 官方赔率 JSON → 比赛记录（capture 内含完整玩法池，供后续任意口径重算）
  function parseOdds(raw, capturedAt) {
    var out = [];
    var groups = (raw && raw.value && raw.value.matchInfoList) || [];
    groups.forEach(function (g) {
      (g.subMatchList || []).forEach(function (m) {
        var ttg = m.ttg || {}, crs = m.crs || {}, had = m.had || {};
        // 比分矩阵 {"h:a": odds}（不含 胜其他/平其他/负其他）
        var scores = null;
        var other = null;
        if (Object.keys(crs).length) {
          scores = {};
          Object.keys(crs).forEach(function (k) {
            var mm = /^s(\d{2})s(\d{2})$/.exec(k);
            var v = num(crs[k]);
            if (mm && v != null) scores[Number(mm[1]) + ':' + Number(mm[2])] = v;
          });
          var ow = num(crs.s1sh), od = num(crs.s1sd), ol = num(crs.s1sa);
          if (ow != null || od != null || ol != null) other = { win: ow, draw: od, lose: ol };
        }
        // 总进球 0~7+ 赔率数组（s0..s7）
        var goals = null;
        if (ttg.s0 != null || ttg.s1 != null) {
          goals = [];
          for (var i = 0; i <= 7; i++) goals.push(num(ttg['s' + i]));
        }
        var singleWin = null, singleHcp = null;
        (m.poolList || []).forEach(function (p) {
          var code = String(p.poolCode || '').toUpperCase();
          if (code === 'HAD') singleWin = Number(p.single) === 1;
          else if (code === 'HHAD') singleHcp = Number(p.single) === 1;
        });
        var odds = {
          // 旧字段（兼容旧版数据与展示）
          ttg1: num(ttg.s1), s10: num(crs.s01s00), s01: num(crs.s00s01),
          had: [num(had.h), num(had.d), num(had.a)],
          // v3：完整池
          goals: goals,
          scores: scores,
          other: other
        };
        out.push({
          matchId: m.matchId,
          businessDate: m.businessDate || g.businessDate,
          matchDate: m.matchDate || m.businessDate || g.businessDate,
          matchNumStr: m.matchNumStr || '',
          league: m.leagueAbbName || m.leagueAllName || '',
          home: m.homeTeamAbbName || m.homeTeamAllName || '',
          away: m.awayTeamAbbName || m.awayTeamAllName || '',
          matchTime: m.matchTime || '',
          matchStatus: m.matchStatus || m.sellStatus || '',
          isSingleWin: singleWin,
          isSingleHandicap: singleHcp,
          captures: [{ at: capturedAt, odds: odds }],
          totalCaptures: 1,
          result: null,
          pred: null   // 预测在赛果落定时冻结 {"baseA":g,"modelA":g,"baseB":g,"modelB":g,"window":n,"at":iso}
        });
      });
    });
    return out;
  }

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
        scoreRaw: (typeof m.sectionsNo999 === 'string' ? m.sectionsNo999.trim() : ''),
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

  // ---------------------------------------------------------------- 差值计算（核心）

  // 最小二乘拟合：给定点 (x_i, y_i)，拟合二次曲线 y = c0 + c1 x + c2 x^2（点<3 时退化直线），
  // 返回在 x=0 处的预测值（用于 0 球的差值）
  function fitValueAt0(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var deg = n >= 3 ? 2 : 1;
    // 正规方程
    var m = deg + 1;
    var A = [], B = [];
    for (var i = 0; i < m; i++) { A.push(new Array(m).fill(0)); B.push(0); }
    for (var k = 0; k < n; k++) {
      for (var r = 0; r < m; r++) {
        for (var c = 0; c < m; c++) A[r][c] += Math.pow(xs[k], r + c);
        B[r] += ys[k] * Math.pow(xs[k], r);
      }
    }
    // 高斯消元
    for (var col = 0; col < m; col++) {
      var piv = col;
      for (var rr = col + 1; rr < m; rr++) if (Math.abs(A[rr][col]) > Math.abs(A[piv][col])) piv = rr;
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      var tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
      var tb = B[col]; B[col] = B[piv]; B[piv] = tb;
      for (var r2 = 0; r2 < m; r2++) {
        if (r2 === col) continue;
        var f = A[r2][col] / A[col][col];
        for (var c2 = col; c2 < m; c2++) A[r2][c2] -= f * A[col][c2];
        B[r2] -= f * B[col];
      }
    }
    var coef = [];
    for (var i2 = 0; i2 < m; i2++) coef.push(B[i2] / A[i2][i2]);
    return coef[0]; // x=0 处
  }

  // 由一次赔率快照计算全部进球数的差值（两种口径）+ 0球拟合值 + 基线预测
  // 关键口径：竞彩比分矩阵只覆盖到 5:2 / 2:5（总进球≥7 仅这两个格子），
  //   真正的 7+ 比分（6:0、4:3、6:1…）全部在「胜其他/平其他/负其他」三档里，
  //   因此 7+球 的多选优化 = 矩阵≥7 的格子 ∪ 其他三档；缺失其他档时 7+ 不参与预测。
  function goalDiffs(odds) {
    if (!odds || !odds.goals || !odds.scores) return null;
    var groups = [];
    var xsA = [], ysA = [], xsB = [], ysB = [];
    for (var g = 0; g <= 7; g++) {
      var ttg = odds.goals[g] != null ? odds.goals[g] : null;
      var list = [];
      Object.keys(odds.scores).forEach(function (sc) {
        var tot = goalsFromScore(sc);
        if (tot == null) return;
        var b = Math.min(tot, 7);
        if (b === g) list.push({ score: sc, odds: odds.scores[sc] });
      });
      if (g === 7 && odds.other) {
        if (odds.other.win != null) list.push({ score: '胜其他', odds: odds.other.win });
        if (odds.other.draw != null) list.push({ score: '平其他', odds: odds.other.draw });
        if (odds.other.lose != null) list.push({ score: '负其他', odds: odds.other.lose });
      }
      list.sort(function (a, b2) { return String(a.score).localeCompare(String(b2.score)); });
      var optA = null, avgB = null;
      var canCompute = list.length >= 2 && ttg != null && !(g === 7 && !odds.other);
      if (canCompute) {
        var sumInv = 0, sum = 0;
        list.forEach(function (c) { sumInv += 1 / c.odds; sum += c.odds; });
        optA = round3(1 / sumInv);
        avgB = round3(sum / list.length);
      }
      var diffA = (optA != null && ttg != null) ? round3(ttg - optA) : null;
      var diffB = (avgB != null && ttg != null) ? round3(ttg - avgB) : null;
      var relA = (optA != null && ttg != null) ? Math.round((ttg / optA - 1) * 10000) / 10000 : null;
      var relB = (avgB != null && ttg != null) ? Math.round((ttg / avgB - 1) * 10000) / 10000 : null;
      if (g >= 1) {
        if (diffA != null) { xsA.push(g); ysA.push(Math.max(-5, Math.min(15, diffA))); }
        if (diffB != null) { xsB.push(g); ysB.push(Math.max(-5, Math.min(15, diffB))); }
      }
      groups.push({ g: g, label: bucketLabel(g), ttg: ttg, optA: optA, avgB: avgB, diffA: diffA, diffB: diffB, relA: relA, relB: relB, scores: list });
    }
    var fit0A = fitValueAt0(xsA, ysA);
    var fit0B = fitValueAt0(xsB, ysB);
    if (fit0A != null) groups[0].diffA = round3(fit0A);
    if (fit0B != null) groups[0].diffB = round3(fit0B);
    // 基线预测只用口径A：口径B的"平均赔率"随档位指数放大（多选个数的天然效应），
    // 其差值取最小在数学上必然偏向高档位，没有跨档可比性 —— B 仅记录差值/相对差值，
    // 并参与"模型B"（按相对差值排名学习）供对比分析。
    var predBaseA = argminG(groups, 'diffA');
    return {
      groups: groups,
      fit0A: fit0A != null ? round3(fit0A) : null,
      fit0B: fit0B != null ? round3(fit0B) : null,
      predBaseA: predBaseA,
      predBaseB: null
    };
  }

  function argminG(groups, key) {
    var best = null, bestV = null;
    groups.forEach(function (x) {
      if (x[key] == null) return;
      if (bestV == null || x[key] < bestV) { bestV = x[key]; best = x.g; }
    });
    return best;
  }

  // ---------------------------------------------------------------- 自修正模型

  // 样本：{ date, diffs: [d0..d7]（d0 为拟合值，可为 null 则该项不参与排名）, actual: g }
  // 特征：每个进球数的差值在 8 项中的排名（1=最小）。学习"某进球数在排名 r 时的历史命中率"。
  // 稳健更新：赛果排名 >= maxActualRank（深冷门）的场次不纳入学习。
  function modelRank(rank, diffs, g) {
    // 计算 g 的排名（升序，1 起；NULL 项不参与）
    var vals = [];
    for (var k = 0; k <= 7; k++) if (diffs[k] != null) vals.push({ g: k, v: diffs[k] });
    vals.sort(function (a, b) { return a.v - b.v; });
    for (var i = 0; i < vals.length; i++) if (vals[i].g === g) return i + 1;
    return null;
  }

  function modelTrain(samples, opts) {
    opts = opts || {};
    var maxActualRank = opts.maxActualRank || 6;
    var table = [];  // table[g][r] = { hit, total }
    for (var g = 0; g <= 7; g++) {
      table.push([]);
      for (var r = 0; r <= 8; r++) table[g].push({ hit: 0, total: 0 });
    }
    var excluded = 0;
    samples.forEach(function (s) {
      if (s.actual == null || !s.diffs) return;
      var rankActual = modelRank(0, s.diffs, s.actual);
      if (rankActual == null) return;
      if (rankActual >= maxActualRank) { excluded++; return; } // 爆冷剔除
      s.diffs.forEach(function (d, g2) {
        if (d == null) return;
        var rk = modelRank(0, s.diffs, g2);
        if (rk == null) return;
        table[g2][rk].total++;
        if (g2 === s.actual) table[g2][rk].hit++;
      });
    });
    return { table: table, excluded: excluded, used: samples.length - excluded };
  }

  // 用模型对一场比赛做预测：取"同排名下历史命中率最高"的进球数（拉普拉斯平滑，平票用基线）
  function modelPredict(model, diffs, fallbackG) {
    if (!model || !diffs) return fallbackG == null ? null : fallbackG;
    var best = null, bestScore = -1;
    for (var g = 0; g <= 7; g++) {
      if (diffs[g] == null) continue;
      var rk = modelRank(0, diffs, g);
      if (rk == null) continue;
      var cell = model.table[g][rk];
      var score = (cell.hit + 0.2) / (cell.total + 1); // 平滑
      if (score > bestScore) { bestScore = score; best = g; }
    }
    return best == null ? fallbackG : best;
  }

  // 从已出赛果的比赛集合中提取模型样本（指定口径），窗口 = endDate 往前 windowDays 天。
  // 取消 / 推迟补赛的场次不纳入（意外情况造成偏差，避免污染模型）。
  function modelSamples(matches, key, opts) {
    opts = opts || {};
    var windowDays = opts.windowDays || 30;
    var endDate = opts.endDate || null;
    var out = [];
    (matches || []).forEach(function (m) {
      if (!m.result || m.result.score == null) return;
      if (m.result.cancelled || m.result.rescheduled) return;
      var cap = lastCaptureBefore(m);
      if (!cap) return;
      var d = goalDiffs(cap.odds);
      if (!d) return;
      var diffs = d.groups.map(function (x) { return x[key]; });
      if (opts.excludeMatchId != null && m.matchId === opts.excludeMatchId) return;
      var slate = m.businessDate || dateOf(cap.at);
      if (endDate && slate >= endDate) return;   // 只用窗口截止日之前的数据（防泄漏）
      if (windowDays && endDate && daysBetween(slate, endDate) > windowDays) return;
      out.push({ date: slate, diffs: diffs, actual: bucketOfGoals(goalsFromScore(m.result.score)) });
    });
    return out;
  }

  function lastCaptureBefore(m) {
    m = normalizeMatch(m);
    return m.captures.length ? m.captures[m.captures.length - 1] : null;
  }

  // ---------------------------------------------------------------- 合并 / 规整

  function sameOdds(x, y) {
    try { return JSON.stringify(x) === JSON.stringify(y); } catch (e) { return false; }
  }
  function cmpMatch(a, b) {
    var t = String(a.matchTime || '').localeCompare(String(b.matchTime || ''));
    if (t !== 0) return t;
    return String(a.matchNumStr || '').localeCompare(String(b.matchNumStr || ''));
  }

  function normalizeMatch(m) {
    if (!m) return m;
    if (!m.captures) {
      m.captures = [];
      if (m.odds) {
        m.captures.push({ at: m.oddsAt || '', odds: m.odds });
      }
      m.totalCaptures = m.captureCount || m.captures.length;
      delete m.odds; delete m.optimized; delete m.diff;
      delete m.oddsAt; delete m.captureCount;
    }
    if (m.isSingleWin === undefined) m.isSingleWin = null;
    if (m.isSingleHandicap === undefined) m.isSingleHandicap = null;
    if (m.pred === undefined) m.pred = null;
    return m;
  }

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
      var needAppend = !last || changed ||
        dateOf(last.at) !== dateOf(capturedAt) ||
        (String(last.at).slice(11, 13) < '14' ? 'A' : 'B') !== (String(capturedAt).slice(11, 13) < '14' ? 'A' : 'B');
      if (needAppend) {
        old.captures.push({ at: capturedAt, odds: incCap.odds });
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

  function applyResults(dayDoc, results, at) {
    var byId = {};
    (results || []).forEach(function (r) { byId[r.matchId] = r; });
    var filled = 0, changed = 0;
    (dayDoc.matches || []).forEach(function (m) {
      var r = byId[m.matchId];
      if (!r) return;
      if (!r.score) {
        // 明确取消的比赛（赛果原文含"取消"）：记录标记，供界面展示与统计排除
        if (r.scoreRaw && String(r.scoreRaw).indexOf('取消') >= 0 && !(m.result && m.result.cancelled)) {
          m.result = { score: null, cancelled: true, status: r.status, at: at };
          changed++;
        }
        return;
      }
      // 推迟判定：赛果的真实开赛日与记录不一致 → 补赛（意外情况，不用于模型学习/回测）
      var rescheduled = !!(r.date && m.matchDate && r.date !== m.matchDate);
      var prev = m.result;
      if (!prev || prev.score !== r.score || !!prev.rescheduled !== rescheduled || !!prev.cancelled) changed++;
      m.result = {
        score: r.score,
        halfScore: r.halfScore,
        goals: goalsFromScore(r.score),
        rescheduled: rescheduled,
        status: r.status,
        at: at
      };
      filled++;
    });
    if (changed > 0) dayDoc.updatedAt = at;
    return { filled: filled, changed: changed };
  }

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
      var map = {};
      old.captures.concat(m.captures).forEach(function (c) {
        if (!c || !c.at) return;
        var prev = map[c.at];
        if (!prev || (!prev.odds.scores && c.odds.scores)) map[c.at] = c;
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
      if (m.result && (!old.result || String(m.result.at || '') >= String(old.result.at || ''))) old.result = m.result;
      if (m.pred && (!old.pred || String(m.pred.at || '') >= String(old.pred.at || ''))) old.pred = m.pred;
    });
    out.matches = Object.keys(byId).map(function (k) { return byId[k]; }).sort(cmpMatch);
    return out;
  }

  // 赛果落定后为一场比赛冻结预测（窗口 = 该场销售日之前，防泄漏）
  function freezePrediction(match, allMatches, opts) {
    opts = opts || {};
    var cap = lastCaptureBefore(match);
    if (!cap) return null;
    var d = goalDiffs(cap.odds);
    if (!d) return null;
    var diffsA = d.groups.map(function (x) { return x.diffA; });
    var diffsB = d.groups.map(function (x) { return x.relB; }); // B口径用相对差值（绝对差值不可跨档比较）
    var slate = match.businessDate || match.matchDate;
    var windowDays = (opts.model && opts.model.windowDays) || 30;
    var maxRank = (opts.model && opts.model.maxActualRank) || 6;
    var samplesA = modelSamples(allMatches, 'diffA', { windowDays: windowDays, endDate: slate });
    var samplesB = modelSamples(allMatches, 'relB', { windowDays: windowDays, endDate: slate });
    var modelA = modelTrain(samplesA, { maxActualRank: maxRank });
    var modelB = modelTrain(samplesB, { maxActualRank: maxRank });
    return {
      baseA: d.predBaseA, modelA: modelPredict(modelA, diffsA, d.predBaseA),
      baseB: null, modelB: modelPredict(modelB, diffsB, null),
      fit0A: d.fit0A, fit0B: d.fit0B,
      windowA: modelA.used, windowB: modelB.used,
      ver: VERSION,
      at: nowIso()
    };
  }

  // ---------------------------------------------------------------- 展平 / 导出

  function flatRows(dayDocs) {
    var rows = [];
    (dayDocs || []).forEach(function (d) {
      (d.matches || []).forEach(function (m0) {
        var m = normalizeMatch(m0);
        var cap = m.captures[m.captures.length - 1] || null;
        var diffs = cap ? goalDiffs(cap.odds) : null;
        var actual = (m.result && m.result.goals != null) ? bucketOfGoals(m.result.goals) : null;
        var cancelled = !!(m.result && m.result.cancelled);
        var rescheduled = !!(m.result && m.result.rescheduled);
        var excluded = cancelled || rescheduled; // 取消/推迟补赛：展示但排除于模型学习与回测
        var pred = m.pred || null;
        var oddsOf = function (g) {
          if (g == null || !diffs) return null;
          var out = null;
          (diffs.groups || []).forEach(function (x) { if (x.g === g) out = x.ttg; });
          return out;
        };
        var predBaseA = pred ? pred.baseA : (diffs ? diffs.predBaseA : null);
        var predA = pred ? pred.modelA : null;
        var predB = pred ? pred.modelB : null;
        rows.push({
          matchId: m.matchId,
          date: d.date || m.businessDate || '',
          matchDate: m.matchDate || m.businessDate || d.date || '',
          kickoff: ((m.matchDate || '').slice(5) + ' ' + (m.matchTime || '').slice(0, 5)).trim(),
          matchNumStr: m.matchNumStr || '',
          league: m.league || '',
          home: m.home || '',
          away: m.away || '',
          isSingleWin: m.isSingleWin === true ? true : (m.isSingleWin === false ? false : null),
          hasDetail: !!(diffs && diffs.groups.some(function (x) { return x.diffA != null; })),
          diffs: diffs,           // { groups, fit0A, fit0B, predBaseA, predBaseB } | null
          baseA: diffs ? diffs.predBaseA : null,
          baseB: diffs ? diffs.predBaseB : null,
          predA: predA,
          predB: predB,
          predBaseA: predBaseA,
          predBaseB: pred ? pred.baseB : null,
          oddsBaseA: oddsOf(predBaseA),   // 预测进球数对应的赔率（该场最后一次记录）
          oddsA: oddsOf(predA),
          oddsB: oddsOf(predB),
          score: m.result && m.result.score ? m.result.score : null,
          halfScore: m.result && m.result.halfScore ? m.result.halfScore : null,
          actual: actual,
          cancelled: cancelled,
          rescheduled: rescheduled,
          excluded: excluded,
          hitBaseA: (pred && pred.baseA != null && actual != null) ? pred.baseA === actual : null,
          hitModelA: (pred && pred.modelA != null && actual != null) ? pred.modelA === actual : null,
          hitBaseB: (pred && pred.baseB != null && actual != null) ? pred.baseB === actual : null,
          hitModelB: (pred && pred.modelB != null && actual != null) ? pred.modelB === actual : null,
          oddsAt: cap ? cap.at : '',
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

  function labelG(g) { return g == null ? '' : bucketLabel(g); }

  // 预测统计：基线/模型在给定行集合上的命中率（仅统计有预测且已出结果的场次）
  function predStats(rows) {    var st = {
      settled: 0, withPred: 0,
      baseA: { n: 0, hit: 0 }, modelA: { n: 0, hit: 0 },
      baseB: { n: 0, hit: 0 }, modelB: { n: 0, hit: 0 },
      byGoal: []   // 各实际进球数的场次数
    };
    for (var i = 0; i <= 7; i++) st.byGoal.push(0);
    (rows || []).forEach(function (r) {
      if (r.actual == null || r.excluded) return;
      st.settled++;
      st.byGoal[r.actual]++;
      if (r.predBaseA != null) { st.withPred++; st.baseA.n++; if (r.hitBaseA) st.baseA.hit++; }
      if (r.predA != null) { st.modelA.n++; if (r.hitModelA) st.modelA.hit++; }
      if (r.predBaseB != null) { st.baseB.n++; if (r.hitBaseB) st.baseB.hit++; }
      if (r.predB != null) { st.modelB.n++; if (r.hitModelB) st.modelB.hit++; }
    });
    ['baseA', 'modelA', 'baseB', 'modelB'].forEach(function (k) {
      st[k].rate = st[k].n ? st[k].hit / st[k].n : null;
    });
    return st;
  }

  // ---------------------------------------------------------------- 模拟投注

  var DEFAULT_BET_STAKE = 100;

  function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }

  // 模拟投注：对每场已出结果的比赛，按固定金额投注"预测的进球数"，猜中按该进球数的赔率返还。
  // 赔率口径（用户指定）：取该场【最后一次记录】的总进球赔率（r.diffs.groups[g].ttg）。
  // 三条预测轨道分别计算：baseA（基线）、modelA（自修正模型）、modelB（B口径模型·对照）。
  // 返回 { stake, tracks{轨道:{bets,wins,staked,returned,profit,roi,daily[]}}, summaryDaily[], details[] }
  function bettingStats(rows, stake) {
    stake = stake || DEFAULT_BET_STAKE;
    var tracks = {
      baseA: { key: 'baseA', bets: 0, wins: 0, staked: 0, returned: 0 },
      modelA: { key: 'modelA', bets: 0, wins: 0, staked: 0, returned: 0 },
      modelB: { key: 'modelB', bets: 0, wins: 0, staked: 0, returned: 0 }
    };
    var dayMap = {};
    var details = [];
    (rows || []).forEach(function (r) {
      if (r.actual == null || !r.diffs || r.excluded) return;
      var picks = { baseA: r.predBaseA, modelA: r.predA, modelB: r.predB };
      var grpOf = function (g) {
        var out = null;
        (r.diffs.groups || []).forEach(function (x) { if (x.g === g) out = x; });
        return out;
      };
      var det = {
        date: r.date, matchNumStr: r.matchNumStr, league: r.league, home: r.home, away: r.away,
        actual: r.actual, predA: r.predA, oddsA: null, pnlA: null,
        predBaseA: r.predBaseA, pnlBaseA: null, predB: r.predB, pnlB: null
      };
      var any = false;
      ['baseA', 'modelA', 'modelB'].forEach(function (k) {
        var g = picks[k];
        if (g == null) return;
        var grp = grpOf(g);
        var odds = grp ? grp.ttg : null;
        if (odds == null) return; // 该档无赔率 → 这一轨不下注
        any = true;
        var win = (r.actual === g);
        var ret = win ? stake * odds : 0;
        var t = tracks[k];
        t.bets++; t.staked += stake; t.returned += ret;
        if (win) t.wins++;
        var day = dayMap[r.date] = dayMap[r.date] || { date: r.date, baseA: 0, modelA: 0, modelB: 0, bets: 0, winsA: 0 };
        day[k] += ret - stake;
        if (k === 'modelA') {
          if (win) day.winsA++;
          det.oddsA = odds;
          det.pnlA = round2(ret - stake);
        } else if (k === 'baseA') det.pnlBaseA = round2(ret - stake);
        else det.pnlB = round2(ret - stake);
      });
      if (any) {
        dayMap[r.date].bets++;
        details.push(det);
      }
    });
    ['baseA', 'modelA', 'modelB'].forEach(function (k) {
      var t = tracks[k];
      t.profit = round2(t.returned - t.staked);
      t.roi = t.staked ? t.profit / t.staked : null;
      t.staked = round2(t.staked); t.returned = round2(t.returned);
    });
    var cum = { baseA: 0, modelA: 0, modelB: 0 };
    var summaryDaily = Object.keys(dayMap).sort().map(function (d) {
      var day = dayMap[d];
      ['baseA', 'modelA', 'modelB'].forEach(function (k) { day[k] = round2(day[k]); cum[k] = round2(cum[k] + day[k]); });
      day.cumBaseA = cum.baseA; day.cumModelA = cum.modelA; day.cumModelB = cum.modelB;
      return day;
    });
    var run = 0;
    details.forEach(function (det) {
      if (det.pnlA != null) { run = round2(run + det.pnlA); det.cumA = run; }
    });
    return { stake: stake, tracks: tracks, summaryDaily: summaryDaily, details: details };
  }

  // ---------------------------------------------------------------- 编号追踪（保持）

  var DEFAULT_NUM_BUCKETS = [
    { label: '0球', lo: 0, hi: 0 }, { label: '1球', lo: 1, hi: 1 }, { label: '2球', lo: 2, hi: 2 },
    { label: '3球', lo: 3, hi: 3 }, { label: '4球', lo: 4, hi: 4 }, { label: '5球', lo: 5, hi: 5 },
    { label: '6球', lo: 6, hi: 6 }, { label: '7+球', lo: 7, hi: null }
  ];

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

  function numbersStats(doc, opts) {
    opts = opts || {};
    var days = (doc && doc.days) || {};
    var dates = Object.keys(days).sort();
    var alertCount = opts.alertCount || (doc && doc.alertCount) || 30;
    var activeWithin = opts.activeWithinDays || 7;
    var buckets = opts.buckets || (doc && doc.buckets) || DEFAULT_NUM_BUCKETS;
    var watchNums = opts.nums || (doc && doc.nums) || null;
    if (!dates.length) return { days: 0, firstDate: null, lastDate: null, alertCount: alertCount, nums: [], buckets: buckets, alerts: [] };
    var lastDate = dates[dates.length - 1];
    var numSet = {};
    dates.forEach(function (d) { Object.keys(days[d] || {}).forEach(function (n) { numSet[n] = true; }); });
    var numList = Object.keys(numSet).sort();
    if (watchNums && watchNums.length) {
      numList = watchNums.filter(function (n) { return numSet[n]; });
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
      var combos = buckets.map(function (bk, k) {
        var lh = lastHit[k];
        return {
          bucket: k, label: bk.label, count: counts[k], lastDate: lh,
          daysSince: lh ? daysBetween(lh, lastDate) : (firstSeen ? daysBetween(firstSeen, lastDate) : null),
          never: !lh, streak: streak[k], active: active
        };
      });
      return { num: num, occurrences: occ, firstSeen: firstSeen, lastSeen: lastSeen, active: active, counts: counts, combos: combos };
    });
    var alerts = [];
    nums.forEach(function (n) {
      if (!n.active) return;
      n.combos.forEach(function (c) {
        if (!c.never && c.streak >= alertCount) {
          alerts.push({ num: n.num, bucket: c.bucket, label: c.label, streak: c.streak, lastDate: c.lastDate, count: c.count, daysSince: c.daysSince });
        }
      });
    });
    alerts.sort(function (a, b) { return b.streak - a.streak; });
    return { days: dates.length, firstDate: dates[0], lastDate: lastDate, alertCount: alertCount, nums: nums, buckets: buckets, alerts: alerts };
  }

  // ---------------------------------------------------------------- 文件名

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
    matchHeadUrl: matchHeadUrl,
    officialDetailUrl: officialDetailUrl,
    NODE_HEADERS: NODE_HEADERS,
    fetchJson: fetchJson,
    fetchAllResults: fetchAllResults,
    parseOdds: parseOdds,
    parseResults: parseResults,
    normScore: normScore,
    normalizeMatch: normalizeMatch,
    mergeDay: mergeDay,
    mergeDocs: mergeDocs,
    applyResults: applyResults,
    // v3 核心
    goalDiffs: goalDiffs,
    fitValueAt0: fitValueAt0,
    modelTrain: modelTrain,
    modelPredict: modelPredict,
    modelSamples: modelSamples,
    freezePrediction: freezePrediction,
    goalsFromScore: goalsFromScore,
    bucketOfGoals: bucketOfGoals,
    bucketLabel: bucketLabel,
    GOAL_LABELS: GOAL_LABELS,
    labelG: labelG,
    isOneGoalScore: isOneGoalScore,
    // 编号追踪
    numOf: numOf,
    slateDateOf: slateDateOf,
    daysBetween: daysBetween,
    numbersStats: numbersStats,
    parseGoalGroups: parseGoalGroups,
    DEFAULT_NUM_BUCKETS: DEFAULT_NUM_BUCKETS,
    // 展平 / 统计
    flatRows: flatRows,
    predStats: predStats,
    bettingStats: bettingStats,
    DEFAULT_BET_STAKE: DEFAULT_BET_STAKE,
    dayFileName: dayFileName,
    parseDayFileName: parseDayFileName,
    localDateStr: localDateStr,
    nowIso: nowIso,
    addDays: addDays,
    round3: round3,
    fmtAt: fmtAt
  };
});
