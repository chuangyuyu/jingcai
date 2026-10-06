/* ============================================================
   比赛详情页（match.html?d=YYYY-MM-DD&id=matchId）
   · 静态数据：来自本仓库捕获的快照（全部赔率池 + 预测 + 赛果 + 差值）
   · 实时数据：从竞彩官方接口 getMatchHeadV1 拉取（比分/队徽/赛事/战绩，CORS *）
   · 赛前：赔率、开赛时间、对阵、赛事信息；进行中：+实时比分与刷新，附官网直播链接；
     赛后：+赛果、预测命中与模拟投注盈亏
   ============================================================ */
(function () {
  'use strict';
  var JC = window.JCCore;
  var $ = function (s) { return document.querySelector(s); };
  var q = new URLSearchParams(location.search);
  var DATE = q.get('d') || '';
  var MID = Number(q.get('id'));

  var state = { match: null, day: null, stake: 100, head: null, timer: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(t, cls) {
    $('#status').textContent = t;
    $('#dot').className = 'dot ' + (cls || '');
  }
  function fmtOdds(v) { return v == null ? '—' : Number(v).toFixed(2); }
  function fmtMoney(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2); }

  // ---------------------------------------------------------------- 数据加载

  function loadDay() {
    if (!DATE || !MID) { setStatus('缺少参数：需要 ?d=日期&id=比赛ID', 'err'); return Promise.reject(new Error('缺少参数')); }
    setStatus('正在加载比赛数据…', 'busy');
    return fetch('data/days/' + DATE + '.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('未找到 ' + DATE + ' 的数据文件');
      return r.json();
    }).then(function (doc) {
      state.day = doc;
      var found = null;
      (doc.matches || []).forEach(function (m) { if (Number(m.matchId) === MID) found = m; });
      if (!found) throw new Error('在该日数据中未找到这场比赛（ID ' + MID + '）');
      state.match = JC.normalizeMatch(found);
      return fetch('data/numbers.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
    }).then(function (nums) {
      state.stake = (nums && nums.betStake) || 100;
      // 训练"实时模型"（用全部历史数据，供赛前/赛中显示模型A预测）
      return loadAllDaysForModel();
    }).catch(function (e) {
      setStatus('加载失败：' + e.message, 'err');
      $('#md-main').innerHTML = '<div class="card"><p>' + esc(e.message) + '</p><p><button onclick="location.href=\'index.html\'">返回数据表</button></p></div>';
      throw e;
    });
  }

  // 拉取全部日数据并训练实时模型（与主页一致的口径）
  function loadAllDaysForModel() {
    return fetch('data/index.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { dates: {} }; }, function () { return { dates: {} }; })
      .then(function (idx) {
        var dates = Object.keys((idx && idx.dates) || {}).sort();
        state.allDays = [];
        var i = 0, running = 0, done = 0;
        return new Promise(function (resolve) {
          if (!dates.length) return resolve();
          var limit = 6;
          function next() {
            while (running < limit && i < dates.length) {
              (function (d) {
                running++; i++;
                fetch('data/days/' + d + '.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
                  .then(function (doc) { if (doc) state.allDays.push(doc); })
                  .then(function () { running--; done++; if (done === dates.length) resolve(); else next(); });
              })(i);
            }
          }
          next();
        });
      })
      .then(function () {
        var all = [];
        (state.allDays || []).forEach(function (doc) { (doc.matches || []).forEach(function (m) { all.push(m); }); });
        state.allMatches = all;
        var today = JC.localDateStr();
        var samples = JC.modelSamples(all, 'diffA', { windowDays: 30, endDate: JC.addDays(today, 1) });
        state.liveModel = JC.modelTrain(samples, { maxActualRank: 6 });
      });
  }

  // ---------------------------------------------------------------- 实时数据（官方头信息接口）

  function fetchHead() {
    return fetch(JC.matchHeadUrl(MID), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      state.head = (j && j.value && Object.keys(j.value).length) ? j.value : null;
      return state.head;
    }).catch(function () { return null; });
  }

  // ---------------------------------------------------------------- 计算

  function computeView() {
    var m = state.match;
    var caps = m.captures || [];
    var last = caps[caps.length - 1] || null;
    var diffs = last ? JC.goalDiffs(last.odds) : null;
    var first = caps.length > 1 ? JC.goalDiffs(caps[0].odds) : null;
    var kickoffMs = m.matchDate ? new Date(m.matchDate + 'T' + (m.matchTime || '00:00:00') + '+08:00').getTime() : null;
    var now = Date.now();
    var cancelled = !!(m.result && m.result.cancelled);
    var rescheduled = !!(m.result && m.result.rescheduled);
    var finished = !!(m.result && m.result.score);
    var phase = cancelled ? 'cancelled' : (finished ? 'post' : (kickoffMs && now >= kickoffMs ? 'live' : 'pre'));
    // 三轨道预测与赔率
    var oddsOf = function (g) {
      if (g == null || !diffs) return null;
      var out = null;
      (diffs.groups || []).forEach(function (x) { if (x.g === g) out = x.ttg; });
      return out;
    };
    var pred = m.pred || null;
    var tracks = [];
    if (pred) {
      tracks = [
        { key: 'baseA', name: '基线A（差值最小项）', g: pred.baseA, odds: oddsOf(pred.baseA) },
        { key: 'modelA', name: '模型A（自修正）', g: pred.modelA, odds: oddsOf(pred.modelA) },
        { key: 'modelB', name: '模型B（B口径·对照）', g: pred.modelB, odds: oddsOf(pred.modelB) }
      ];
    } else if (diffs) {
      var diffsA = (diffs.groups || []).map(function (x) { return x.diffA; });
      var liveModelG = state.liveModel ? JC.modelPredict(state.liveModel, diffsA, diffs.predBaseA) : null;
      tracks = [
        { key: 'baseA', name: '基线A（差值最小项）', g: diffs.predBaseA, odds: oddsOf(diffs.predBaseA) },
        { key: 'modelA', name: '模型A（实时自修正）', g: liveModelG, odds: oddsOf(liveModelG) },
        { key: 'modelB', name: '模型B（实时·对照）', g: null, odds: null }
      ];
    }
    var actual = (m.result && m.result.goals != null) ? JC.bucketOfGoals(m.result.goals) : null;
    tracks.forEach(function (t) {
      t.hit = (actual != null && t.g != null) ? (t.g === actual) : null;
      t.pnl = (t.hit == null || t.odds == null) ? null : (t.hit ? t.odds * state.stake - state.stake : -state.stake);
    });
    return { caps: caps, last: last, diffs: diffs, first: first, phase: phase, kickoffMs: kickoffMs, tracks: tracks, actual: actual, pred: pred, cancelled: cancelled, rescheduled: rescheduled };
  }

  // ---------------------------------------------------------------- 渲染

  var PHASE_TXT = { pre: '未开赛', live: '进行中', post: '已结束', cancelled: '已取消' };

  function render() {
    var m = state.match;
    var v = computeView();
    var head = state.head;
    var title = (m.matchNumStr || '') + ' · ' + (m.league || '') + ' · ' + m.home + ' vs ' + m.away;
    $('#md-title').textContent = title;
    document.title = title + ' — 竞彩进球数预测';
    setStatus('数据已加载（' + v.caps.length + ' 次快照；赔率以最后一次为准）· ' + JC.fmtAt(v.last ? v.last.at : ''), 'ok');

    var html = '';

    // ① 对阵与状态
    var score = null;
    if (m.result && m.result.score) score = m.result.score;
    else if (head && head.fullCourtGoal) score = head.fullCourtGoal;
    var homeLogo = head && head.homeTeamLogoPath ? 'https:' + head.homeTeamLogoPath : null;
    var awayLogo = head && head.awayTeamLogoPath ? 'https:' + head.awayTeamLogoPath : null;
    html += '<div class="card">' +
      '<div class="md-row"><span class="md-phase ' + v.phase + '">' + PHASE_TXT[v.phase] + '</span>' +
      (m.isSingleWin ? '<span class="md-phase" style="background:rgba(184,92,0,.12);color:#b85c00">单关</span>' : '') +
      '<span class="md-k">' + esc(m.matchNumStr) + '</span><span class="md-k">' + esc(m.league) + '</span>' +
      '<span class="md-k">开赛 ' + esc(m.matchDate) + ' ' + esc((m.matchTime || '').slice(0, 5)) + '</span>' +
      (head && head.matchDateTime && head.matchDateTime !== (m.matchDate + ' ' + (m.matchTime || '').slice(0, 5)) ? '<span class="md-k">官方时间 ' + esc(head.matchDateTime) + '</span>' : '') +
      '</div>' +
      '<div class="md-head" style="margin-top:8px">' +
      '<div class="md-team">' + (homeLogo ? '<img src="' + esc(homeLogo) + '" alt="" onerror="this.style.display=\'none\'">' : '') + '<div class="nm">' + esc(m.home) + '</div></div>' +
      '<div class="md-vs">' + (score ? '<div class="md-score">' + esc(score) + '</div>' : '<div class="md-score" style="color:var(--ink-muted)">VS</div>') +
      (m.result && m.result.halfScore ? '<div class="md-sub">半场 ' + esc(m.result.halfScore) + '</div>' : '') +
      '<div class="md-sub">' + (v.phase === 'live' ? '比赛进行中…' : (v.phase === 'post' ? (v.rescheduled ? '全场（推迟补赛，不计入模型与回测）' : '全场（90分钟）') : (v.phase === 'cancelled' ? '比赛已取消' : '尚未开赛'))) + '</div></div>' +
      '<div class="md-team">' + (awayLogo ? '<img src="' + esc(awayLogo) + '" alt="" onerror="this.style.display=\'none\'">' : '') + '<div class="nm">' + esc(m.away) + '</div></div>' +
      '</div>';
    if (head && (head.tournamentCnName || head.seasonName)) {
      html += '<div class="md-row" style="margin-top:8px"><span class="md-k">赛事：' + esc(head.tournamentCnName || '') + ' ' + esc(head.seasonName || '') +
        (head.phaseName ? ' · ' + esc(head.phaseName) : '') + (head.groupName ? ' · ' + esc(head.groupName) : '') + '</span></div>';
      var hs = head.wbsjStats && head.wbsjStats.home, as = head.wbsjStats && head.wbsjStats.away;
      var hasStats = hs && as && (hs.sWinMatchCnt || hs.sDrawMatchCnt || hs.sLossGoalMatchCnt || as.sWinMatchCnt || as.sDrawMatchCnt || as.sLossGoalMatchCnt);
      if (hasStats) {
        html += '<div class="md-row"><span class="md-k">赛季战绩：' + esc(m.home) + ' ' + (hs.sWinMatchCnt || 0) + '胜' + (hs.sDrawMatchCnt || 0) + '平' + (hs.sLossGoalMatchCnt || 0) + '负' +
          ' ｜ ' + esc(m.away) + ' ' + (as.sWinMatchCnt || 0) + '胜' + (as.sDrawMatchCnt || 0) + '平' + (as.sLossGoalMatchCnt || 0) + '负</span></div>';
      }
    }
    html += '<div class="md-row md-links" style="margin-top:10px">' +
      '<a href="' + JC.officialDetailUrl(MID, 2) + '" target="_blank" rel="noopener">官方分析页</a>' +
      '<a href="' + JC.officialDetailUrl(MID, 3) + '" target="_blank" rel="noopener">官方详细/比分直播</a>' +
      '</div></div>';

    // ② 预测与模拟投注
    if (v.tracks.length && v.diffs) {
      html += '<div class="card"><div class="card-head"><h2>预测与模拟投注（每场 ' + state.stake + ' 元）</h2></div>' +
        '<div class="table-scroll"><table class="grid"><thead><tr><th>轨道</th><th>预测进球数</th><th>赔率</th><th>结果</th><th>模拟盈亏</th></tr></thead><tbody>';
      v.tracks.forEach(function (t) {
        var hitTxt = t.hit == null ? (v.phase === 'post' ? '—' : '待定') : (t.hit ? '中 ✓' : '未中 ✗');
        var hitCls = t.hit === true ? 'diff-pos' : (t.hit === false ? 'diff-neg' : 'muted');
        var pnlCls = t.pnl == null ? '' : (t.pnl > 0 ? 'diff-pos' : (t.pnl < 0 ? 'diff-neg' : ''));
        html += '<tr><td>' + esc(t.name) + '</td><td><b>' + JC.labelG(t.g) + '</b></td><td>' + fmtOdds(t.odds) +
          '</td><td class="' + hitCls + '">' + hitTxt + '</td><td class="' + pnlCls + '"><b>' + fmtMoney(t.pnl) + '</b></td></tr>';
      });
      html += '</tbody></table></div>' +
        (v.pred ? '' : '<p class="card-sub" style="margin-top:6px">（未冻结：赛前显示实时预测，赛果落定后冻结存档）</p>') +
        '</div>';
    }

    // ③ 差值明细（8档）
    if (v.diffs) {
      var gs = v.diffs.groups || [];
      html += '<div class="card"><div class="card-head"><h2>各进球数赔率与差值（最后一次记录）</h2></div>' +
        '<div class="table-scroll"><table class="grid"><thead><tr><th>进球数</th><th>总进球赔率</th><th>优化A</th><th>差值A</th><th>相对A</th><th>平均B</th><th>差值B</th><th>标注</th></tr></thead><tbody>';
      gs.forEach(function (g) {
        var marks = [];
        if (v.actual != null && g.g === v.actual) marks.push('实际');
        v.tracks.forEach(function (t) { if (t.g != null && t.g === g.g) marks.push(t.key === 'baseA' ? '基线A' : (t.key === 'modelA' ? '模型A' : '模型B')); });
        var cls = '';
        if (v.actual != null && g.g === v.actual) cls = 'row-actual';
        else if (marks.length) cls = 'row-pred';
        html += '<tr class="' + cls + '"><td>' + g.label + (g.g === 0 ? '（拟合）' : '') + '</td>' +
          '<td>' + fmtOdds(g.ttg) + '</td><td>' + (g.optA == null ? '—' : g.optA) + '</td>' +
          '<td>' + (g.diffA == null ? '—' : (g.diffA > 0 ? '+' : '') + g.diffA.toFixed(3)) + '</td>' +
          '<td>' + (g.relA == null ? '—' : (g.relA * 100).toFixed(1) + '%') + '</td>' +
          '<td>' + (g.avgB == null ? '—' : g.avgB) + '</td>' +
          '<td>' + (g.diffB == null ? '—' : (g.diffB > 0 ? '+' : '') + g.diffB.toFixed(3)) + '</td>' +
          '<td>' + (marks.join(' / ') || '') + '</td></tr>';
      });
      html += '</tbody></table></div>' +
        '<p class="card-sub" style="margin-top:6px">0球的差值为全进球数二次曲线拟合值；7+球 = 比分矩阵中总进球≥7 的格子 ∪ 胜/平/负其他三档。</p></div>';

      // 比分矩阵
      var scores = (v.last && v.last.odds && v.last.odds.scores) || null;
      if (scores) {
        var maxSide = 5;
        html += '<div class="card"><div class="card-head"><h2>比分赔率矩阵（最后记录）</h2></div><div class="table-scroll"><table class="grid md-matrix"><thead><tr><th>主＼客</th>';
        for (var a = 0; a <= maxSide; a++) html += '<th>' + a + '</th>';
        html += '</tr></thead><tbody>';
        for (var h = 0; h <= maxSide; h++) {
          html += '<tr><th>' + h + '</th>';
          for (var aw = 0; aw <= maxSide; aw++) {
            var key = h + ':' + aw;
            var od = scores[key];
            html += '<td class="' + (od == null ? 'mx' : '') + '">' + (od == null ? '—' : od) + '</td>';
          }
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        var other = v.last.odds.other;
        if (other) {
          html += '<p class="card-sub" style="margin-top:6px">其他：胜其他 ' + fmtOdds(other.win) + ' ｜ 平其他 ' + fmtOdds(other.draw) + ' ｜ 负其他 ' + fmtOdds(other.lose) + '</p>';
        }
        var had = v.last.odds.had;
        if (had && had[0] != null) html += '<p class="card-sub">胜平负：主胜 ' + fmtOdds(had[0]) + ' ｜ 平 ' + fmtOdds(had[1]) + ' ｜ 客胜 ' + fmtOdds(had[2]) + '</p>';
        html += '</div>';
      }
    }

    // ④ 快照历史
    html += '<div class="card"><div class="card-head"><h2>记录快照</h2></div>';
    if (v.caps.length) {
      html += '<div class="md-row">' + v.caps.map(function (c, i) {
        return '<span class="md-k">第' + (i + 1) + '次：' + JC.fmtAt(c.at) + (i === v.caps.length - 1 ? '（最终记录，以下赔率与回测均以此为准）' : '') + '</span>';
      }).join('<br>') + '</div>';
    } else {
      html += '<p class="muted">无快照记录（该场为升级前抓取，缺完整赔率池）</p>';
    }
    html += '</div>';

    // ⑤ 官方链接
    html += '<div class="card md-links">' +
      '<a href="' + JC.officialDetailUrl(MID, 2) + '" target="_blank" rel="noopener">官方分析（析）</a>' +
      '<a href="' + JC.officialDetailUrl(MID, 3) + '" target="_blank" rel="noopener">官方详细 / 比分直播（详细）</a>' +
      '<a href="https://www.sporttery.cn/jc/zqsgkj/" target="_blank" rel="noopener">竞彩官网赛果开奖</a>' +
      '</div>';

    $('#md-main').innerHTML = html;
  }

  // ---------------------------------------------------------------- 启动

  $('#btn-back').onclick = function () { location.href = 'index.html'; };
  $('#btn-refresh').onclick = function () { setStatus('正在刷新实时数据…', 'busy'); fetchHead().then(function () { render(); }); };

  loadDay().then(function () {
    return fetchHead();
  }).then(function () {
    render();
    var v = computeView();
    if (v.phase === 'live') {
      setStatus('比赛进行中（每 30 秒自动刷新实时数据）', 'warn');
      state.timer = setInterval(function () { fetchHead().then(function () { render(); }); }, 30000);
    }
  }).catch(function () { /* 已在 loadDay 中处理 */ });
})();
