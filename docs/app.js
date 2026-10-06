/* ============================================================
   竞彩进球数差值分析 · 网页应用 v3
   依赖：core.js（业务逻辑）、vendor/xlsx.full.min.js（浏览器端 Excel 导出）
   数据流：GitHub Pages 上的 data/days/*.json 为云端数据；本页抓取/回填先存本机
          localStorage（"待同步"），配置 GitHub 令牌后一键同步到云端。
   ============================================================ */
(function () {
  'use strict';

  var JC = window.JCCore;
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var state = {
    days: {},
    dirty: {},
    numbers: null,
    alertDismissed: false,
    settings: loadSettings(),
    rows: [],
    filters: { range: '30', league: '', onlySettled: false, onlySingle: false },
    sort: { key: 'date', dir: -1 },
    shownRows: 200,
    modelCfg: { windowDays: 30, maxActualRank: 6 },
    betTrack: 'modelA',
    betStake: 100,
    _bet: null,
    busy: false
  };

  var LS_SETTINGS = 'jc_settings_v1';
  var LS_DIRTY = 'jc_dirty_v1';
  var LS_MODEL = 'jc_model_v1';

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch (e) {}
    if (!s.owner && /\.github\.io$/i.test(location.hostname)) {
      s.owner = location.hostname.split('.')[0];
      s.repo = (location.pathname.split('/')[1] || '');
    }
    if (!s.branch) s.branch = 'main';
    return s;
  }
  function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); }
  function loadDirty() {
    try { return JSON.parse(localStorage.getItem(LS_DIRTY) || '{}'); } catch (e) { return {}; }
  }
  function saveDirty() { localStorage.setItem(LS_DIRTY, JSON.stringify(state.dirty)); }
  function loadModelCfg() {
    try { return Object.assign(state.modelCfg, JSON.parse(localStorage.getItem(LS_MODEL) || '{}')); }
    catch (e) { return state.modelCfg; }
  }

  // ---------------------------------------------------------------- 小工具

  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = isErr ? 'err' : '';
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, isErr ? 6000 : 3200);
  }
  function setStatus(text, cls) {
    $('#status').textContent = text;
    $('#dot').className = 'dot ' + (cls || '');
  }
  function fmtDiff(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(3); }
  function fmtMoney(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2); }
  function fmtPct(v, digits) { return v == null ? '—' : (v * 100).toFixed(digits == null ? 1 : digits) + '%'; }
  function todayStr() { return JC.localDateStr(); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hitText(h) { return h == null ? '' : (h ? '✓' : '✗'); }
  function hitCls(h) { return h == null ? 'muted' : (h ? 'one-yes' : 'one-no'); }

  function mapLimit(list, limit, fn) {
    return new Promise(function (resolve) {
      var out = new Array(list.length), i = 0, running = 0, done = 0;
      if (!list.length) return resolve(out);
      function next() {
        while (running < limit && i < list.length) {
          (function (idx) {
            running++; i++;
            Promise.resolve(fn(list[idx], idx)).then(function (r) { out[idx] = r; }, function () { out[idx] = null; })
              .then(function () { running--; done++; if (done === list.length) resolve(out); else next(); });
          })(i);
        }
      }
      next();
    });
  }

  // ---------------------------------------------------------------- 数据加载

  function fetchJsonRel(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchDayFile(date) {
    var s = state.settings;
    var rel = 'data/days/' + date + '.json';
    if (s.owner && s.repo && s.token) {
      var api = 'https://api.github.com/repos/' + s.owner + '/' + s.repo +
        '/contents/docs/' + rel + '?ref=' + encodeURIComponent(s.branch || 'main');
      return fetch(api, {
        headers: { 'Authorization': 'Bearer ' + s.token, 'Accept': 'application/vnd.github.raw+json' },
        cache: 'no-store'
      }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) return fetchJsonRel(rel).catch(function () { return null; });
        return r.json();
      });
    }
    return fetchJsonRel(rel).then(function (d) { return d; }, function () { return null; });
  }

  function loadAll() {
    setStatus('正在加载云端数据…', 'busy');
    var local = loadDirty();
    state.dirty = local;
    loadModelCfg();
    var numbersPromise = fetchJsonRel('data/numbers.json').then(function (d) { return d; }, function () { return null; });
    return fetchJsonRel('data/index.json').catch(function () { return { dates: {} }; })
      .then(function (index) {
        var dates = Object.keys(index.dates || {});
        Object.keys(local).forEach(function (d) { if (dates.indexOf(d) < 0) dates.push(d); });
        dates.sort();
        if (!dates.length) return [];
        setStatus('正在加载云端数据…（0/' + dates.length + '）', 'busy');
        var loaded = 0;
        return mapLimit(dates, 6, function (d) {
          return fetchDayFile(d).then(function (remote) {
            loaded++;
            if (loaded % 10 === 0 || loaded === dates.length) {
              setStatus('正在加载云端数据…（' + loaded + '/' + dates.length + '）', 'busy');
            }
            return JC.mergeDocs(remote, local[d] || null);
          }).then(function (doc) { return doc ? [d, doc] : null; });
        });
      })
      .then(function (pairs) {
        state.days = {};
        (pairs || []).forEach(function (p) { if (p && p[1]) state.days[p[0]] = p[1]; });
        rebuildRows();
        return numbersPromise;
      })
      .then(function (numsDoc) {
        state.numbers = numsDoc;
        state.betStake = (numsDoc && numsDoc.betStake) || 100;
        render();
        updateStatusLine();
      })
      .catch(function (e) {
        setStatus('加载失败：' + e.message, 'err');
      });
  }

  function rebuildRows() {
    state.rows = JC.flatRows(Object.keys(state.days).sort().map(function (d) { return state.days[d]; }));
  }

  function updateStatusLine(extra) {
    var dates = Object.keys(state.days).sort();
    var dirtyCount = Object.keys(state.dirty).length;
    var lastAt = '';
    state.rows.forEach(function (r) { if (r.oddsAt > lastAt) lastAt = r.oddsAt; });
    var txt = '数据 ' + state.rows.length + ' 场 · ' + dates.length + ' 天（' +
      (dates.length ? dates[0] + ' ~ ' + dates[dates.length - 1] : '—') + '）' +
      ' · 最近抓取 ' + (lastAt ? lastAt.replace('T', ' ').slice(0, 16) : '—');
    if (dirtyCount) txt += ' · 待同步 ' + dirtyCount + ' 天';
    if (extra) txt += ' · ' + extra;
    setStatus(txt, dirtyCount ? 'warn' : 'ok');
  }

  // ---------------------------------------------------------------- 抓取 / 回填（浏览器端）

  function markDirty(date) { state.dirty[date] = state.days[date]; saveDirty(); }

  function captureOdds() {
    if (state.busy) return;
    state.busy = true;
    var btn = $('#btn-odds');
    btn.disabled = true;
    setStatus('正在从体彩官方接口抓取赔率…', 'busy');
    JC.fetchJson(JC.ODDS_URL, false).then(function (raw) {
      var at = JC.nowIso();
      var matches = JC.parseOdds(raw, at);
      if (!matches.length) throw new Error('接口未返回任何在售比赛（可能今天没有场次或在休市期）');
      var byDate = {};
      matches.forEach(function (m) { (byDate[m.businessDate] = byDate[m.businessDate] || []).push(m); });
      var dates = Object.keys(byDate).sort();
      var added = 0, updated = 0, complete = 0;
      dates.forEach(function (d) {
        var doc = state.days[d] || { date: d, matches: [] };
        var r = JC.mergeDay(doc, byDate[d], at);
        state.days[d] = r.day;
        added += r.added; updated += r.updated;
        markDirty(d);
      });
      matches.forEach(function (m) {
        var dd = JC.goalDiffs(m.captures[0].odds);
        if (dd && dd.groups.some(function (x) { return x.diffA != null; })) complete++;
      });
      rebuildRows(); render(); updateStatusLine('刚抓取');
      toast('已抓取 ' + matches.length + ' 场（' + dates.join('、') + '），其中 ' + complete + ' 场含完整比分池可参与预测');
      if (canSync()) return syncToGitHub(true);
    }).catch(function (e) {
      setStatus('抓取失败：' + e.message, 'err');
      toast('抓取失败：' + e.message + '（请确认网络可访问体彩官网）', true);
    }).then(function () {
      state.busy = false;
      btn.disabled = false;
    });
  }

  // 为本机数据补/重冻结预测（与服务器端 daily.js 相同的逻辑；算法升级后旧预测重算）
  function freezeLocalPredictions() {
    var all = [];
    Object.keys(state.days).forEach(function (d) { (state.days[d].matches || []).forEach(function (m) { all.push(m); }); });
    var frozen = 0;
    Object.keys(state.days).forEach(function (d) {
      var doc = state.days[d];
      var changed = false;
      (doc.matches || []).forEach(function (m) {
        if (!m.result || !m.result.score) return;
        if (m.pred && m.pred.ver === JC.VERSION) return;
        var p = JC.freezePrediction(m, all, { model: state.modelCfg });
        if (p) { m.pred = p; changed = true; frozen++; }
      });
      if (changed) markDirty(d);
    });
    return frozen;
  }

  function backfillResults() {
    if (state.busy) return;
    var today = todayStr();
    var minDate = JC.addDays(today, -14);
    var dates = Object.keys(state.days).filter(function (d) {
      return d <= today && d >= minDate && state.days[d].matches.some(function (m) { return !m.result; });
    }).sort();
    if (!dates.length) { toast('没有需要回填赛果的场次'); return; }
    state.busy = true;
    var btn = $('#btn-results');
    btn.disabled = true;
    setStatus('正在回填赛果（' + dates.length + ' 天）…', 'busy');
    var changedTotal = 0;
    var chain = Promise.resolve();
    dates.forEach(function (d) {
      chain = chain.then(function () {
        var range = JC.resultRangeFor(d);
        return JC.fetchAllResults(range[0], range[1], false).then(function (results) {
          var r = JC.applyResults(state.days[d], results, JC.nowIso());
          if (r.changed > 0) { markDirty(d); changedTotal += r.changed; }
        }).catch(function (e) {
          toast(d + ' 赛果获取失败：' + e.message, true);
        });
      });
    });
    chain.then(function () {
      var frozen = freezeLocalPredictions();
      rebuildRows(); render();
      updateStatusLine('刚回填赛果');
      toast(changedTotal ? ('已回填 ' + changedTotal + ' 场' + (frozen ? '，冻结预测 ' + frozen + ' 场' : '')) : '没有新的比赛结果');
      if ((changedTotal || frozen) && canSync()) return syncToGitHub(true);
    }).catch(function (e) {
      setStatus('回填失败：' + e.message, 'err');
    }).then(function () {
      state.busy = false;
      btn.disabled = false;
    });
  }

  // ---------------------------------------------------------------- GitHub 同步

  function canSync() { var s = state.settings; return !!(s.owner && s.repo && s.token); }

  function ghHeaders() {
    return {
      'Authorization': 'Bearer ' + state.settings.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  function ghUrl(path) {
    return 'https://api.github.com/repos/' + state.settings.owner + '/' + state.settings.repo + '/contents/' + path;
  }
  function ghGetFile(path) {
    return fetch(ghUrl(path) + '?ref=' + encodeURIComponent(state.settings.branch || 'main'), { headers: ghHeaders(), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { sha: null, doc: null };
        if (!r.ok) throw new Error('GitHub 读取失败 HTTP ' + r.status + '（检查令牌权限）');
        return r.json().then(function (j) {
          var doc = null;
          try { doc = JSON.parse(b64DecodeUtf8(j.content || '')); } catch (e) {}
          return { sha: j.sha, doc: doc };
        });
      });
  }
  function ghPutFile(path, doc, message, sha) {
    var body = { message: message, content: b64EncodeUtf8(JSON.stringify(doc, null, 1)), branch: state.settings.branch || 'main' };
    if (sha) body.sha = sha;
    return fetch(ghUrl(path), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409) throw new Error('CONFLICT');
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        throw new Error('GitHub 写入失败 HTTP ' + r.status + (j.message ? '：' + j.message : ''));
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

  function syncToGitHub(silentIfClean) {
    if (!canSync()) {
      if (!silentIfClean) toast('尚未配置 GitHub 仓库/令牌：数据已保存在本机浏览器。到「更多 → 设置」配置后可同步到云端。', true);
      return Promise.resolve(false);
    }
    var dates = Object.keys(state.dirty).sort();
    if (!dates.length) {
      if (!silentIfClean) toast('没有需要同步的改动');
      return Promise.resolve(true);
    }
    setStatus('正在同步 ' + dates.length + ' 天数据到 GitHub…', 'busy');
    var chain = Promise.resolve();
    dates.forEach(function (d) {
      chain = chain.then(function () {
        var path = 'docs/data/days/' + d + '.json';
        return pushOne(path, d).catch(function (e) {
          if (e.message === 'CONFLICT') return pushOne(path, d);
          throw e;
        });
      });
    });
    return chain.then(function () {
      var ipath = 'docs/data/index.json';
      return ghGetFile(ipath).then(function (g) {
        var idx = g.doc || { dates: {} };
        if (!idx.dates) idx.dates = {};
        Object.keys(state.days).forEach(function (d) {
          idx.dates[d] = { count: state.days[d].matches.length, updatedAt: state.days[d].updatedAt || JC.nowIso() };
        });
        idx.updatedAt = JC.nowIso();
        return ghPutFile(ipath, idx, 'data: 网页同步索引 ' + todayStr(), g.sha);
      });
    }).then(function () {
      saveDirty();
      updateStatusLine('已同步云端');
      toast('已同步 ' + dates.length + ' 天数据到 GitHub（Pages 刷新有 1~2 分钟延迟）');
      return true;
    }).catch(function (e) {
      setStatus('同步失败：' + e.message + '（数据仍保存在本机，可稍后重试）', 'err');
      toast('同步失败：' + e.message, true);
      return false;
    });

    function pushOne(path, d) {
      return ghGetFile(path).then(function (g) {
        var merged = JC.mergeDocs(g.doc, state.days[d]);
        return ghPutFile(path, merged, 'data: 网页同步 ' + d, g.sha).then(function () {
          state.days[d] = merged;
          delete state.dirty[d];
          saveDirty();
        });
      });
    }
  }

  // ---------------------------------------------------------------- 筛选 / 渲染

  function filteredRows() {
    var today = todayStr();
    var f = state.filters;
    return state.rows.filter(function (r) {
      if (f.range === '7' && r.date < JC.addDays(today, -6)) return false;
      if (f.range === '30' && r.date < JC.addDays(today, -29)) return false;
      if (f.range === 'month' && String(r.date).slice(0, 7) !== today.slice(0, 7)) return false;
      if (f.league && r.league !== f.league) return false;
      if (f.onlySettled && r.actual == null) return false;
      if (f.onlySingle && r.isSingleWin !== true) return false;
      return true;
    });
  }

  function render() {
    var rows = filteredRows();
    renderTiles(rows);
    renderBetting(rows);
    renderDailyHitChart(state.rows);   // 命中率走势用全量（窗口自身控制）
    renderGoalDistChart(rows);
    renderModelTable(state.rows);
    renderUpcomingCard(state.rows);
    renderDataTable(rows);
    renderLeagueOptions();
    renderAlerts();
    renderNumbers();
  }

  // ---------------------------------------------------------------- 模拟投注

  function renderBetting(rows) {
    var stake = state.betStake || 100;
    $('#bet-stake').textContent = stake;
    var bet = JC.bettingStats(rows, stake);
    state._bet = bet;
    var label = { modelA: '模型A', baseA: '基线A', modelB: '模型B（对照）' };
    $('#bet-summary-table tbody').innerHTML = ['modelA', 'baseA', 'modelB'].map(function (k) {
      var t = bet.tracks[k];
      var cls = t.profit == null ? '' : (t.profit > 0 ? 'diff-pos' : (t.profit < 0 ? 'diff-neg' : ''));
      return '<tr><td>' + label[k] + '</td><td class="num">' + t.bets + '</td><td class="num">' + t.wins +
        '</td><td class="num">' + t.staked + '</td><td class="num">' + t.returned +
        '</td><td class="num ' + cls + '"><b>' + fmtMoney(t.profit) + '</b></td><td class="num ' + cls + '">' + fmtPct(t.roi) + '</td></tr>';
    }).join('');
    renderBetChart(bet);
    var dt = $('#bet-daily-table tbody');
    if (!bet.summaryDaily.length) {
      dt.innerHTML = '<tr><td colspan="7" class="muted">暂无数据</td></tr>';
      return;
    }
    dt.innerHTML = bet.summaryDaily.slice().reverse().map(function (d) {
      var cls = d.modelA > 0 ? 'diff-pos' : (d.modelA < 0 ? 'diff-neg' : '');
      var ccls = d.cumModelA > 0 ? 'diff-pos' : (d.cumModelA < 0 ? 'diff-neg' : '');
      return '<tr><td>' + d.date + '</td><td class="num">' + d.bets + '</td><td class="num">' + d.winsA +
        '</td><td class="num ' + cls + '">' + fmtMoney(d.modelA) + '</td><td class="num ' + ccls + '"><b>' + fmtMoney(d.cumModelA) + '</b></td>' +
        '<td class="num">' + fmtMoney(d.cumBaseA) + '</td><td class="num">' + fmtMoney(d.cumModelB) + '</td></tr>';
    }).join('');
  }

  // 每日盈亏：以 0 为轴的上下双向柱（绿=盈利，红=亏损）
  function renderBetChart(bet) {
    var chart = $('#chart-bet');
    var labels = $('#xlabels-bet');
    var track = state.betTrack || 'modelA';
    var days = bet.summaryDaily;
    var hasData = days.length > 0;
    $('#chart-bet-empty').hidden = hasData;
    chart.style.display = hasData ? '' : 'none';
    labels.style.display = hasData ? '' : 'none';
    if (!hasData) { chart.innerHTML = ''; labels.innerHTML = ''; chart._days = null; return; }
    var maxAbs = 0;
    days.forEach(function (d) { maxAbs = Math.max(maxAbs, Math.abs(d[track])); });
    if (maxAbs <= 0) maxAbs = 100;
    var pow = Math.pow(10, Math.floor(Math.log10(maxAbs)));
    var top = Math.ceil(maxAbs / (pow / 2)) * (pow / 2);
    var cumKey = 'cum' + track.charAt(0).toUpperCase() + track.slice(1);
    var html = '';
    html += '<div class="gl" style="bottom:100%"></div><div class="ytick" style="bottom:100%">+' + Math.round(top) + '</div>';
    html += '<div class="gl" style="bottom:75%"></div><div class="ytick" style="bottom:75%">+' + Math.round(top / 2) + '</div>';
    html += '<div class="zero-line"></div><div class="ytick" style="bottom:50%">0</div>';
    html += '<div class="gl" style="bottom:25%"></div><div class="ytick" style="bottom:25%">-' + Math.round(top / 2) + '</div>';
    html += '<div class="gl zero" style="bottom:0%"></div><div class="ytick" style="bottom:0%">-' + Math.round(top) + '</div>';
    days.forEach(function (d, i) {
      var v = d[track];
      var h = Math.min(50, Math.abs(v) / top * 50);
      html += '<div class="bin pbin" data-i="' + i + '">' +
        (v !== 0 ? '<div class="pbar ' + (v > 0 ? 'up' : 'down') + '" style="height:' + Math.max(2, h) + '%"></div>' : '') +
        '</div>';
    });
    chart.innerHTML = html;
    chart._days = days;
    chart._track = track;
    chart._cumKey = cumKey;
    labels.innerHTML = days.map(function (d) { return '<div class="xl">' + d.date.slice(5) + '</div>'; }).join('');
    chart.onmousemove = function (ev) {
      var binEl = ev.target.closest ? ev.target.closest('.pbin') : null;
      if (!binEl || !chart._days) { hideTooltip(); return; }
      var d = chart._days[Number(binEl.dataset.i)];
      if (!d) { hideTooltip(); return; }
      var trackLabel = { modelA: '模型A', baseA: '基线A', modelB: '模型B' }[chart._track];
      showTooltip(ev, d.date + ' · ' + trackLabel + '<br>当日：' + fmtMoney(d[chart._track]) +
        '<br>累计：' + fmtMoney(d[chart._cumKey]) + '<br>模型A命中 ' + d.winsA + '/' + d.bets + ' 场');
    };
    chart.onmouseleave = hideTooltip;
  }

  function renderLeagueOptions() {
    var set = {};
    state.rows.forEach(function (r) { if (r.league) set[r.league] = 1; });
    var leagues = Object.keys(set).sort();
    [$('#league-filter'), $('#league-filter2')].forEach(function (sel) {
      var cur = sel.value;
      sel.innerHTML = '<option value="">全部联赛</option>' +
        leagues.map(function (l) { return '<option>' + escapeHtml(l) + '</option>'; }).join('');
      if (leagues.indexOf(cur) >= 0) sel.value = cur;
    });
  }

  function renderTiles(rows) {
    var st = JC.predStats(rows);
    var winFrom = JC.addDays(todayStr(), -(state.modelCfg.windowDays || 30));
    var stW = JC.predStats(rows.filter(function (r) { return r.date >= winFrom; }));
    var mt = JC.bettingStats(rows, state.betStake || 100).tracks.modelA;
    var tiles = [
      { k: '场次（当前筛选）', v: st.settled, sub: '共 ' + st.withPred + ' 场有预测' },
      { k: '模拟净盈亏（模型A）', v: fmtMoney(mt.profit), cls: mt.profit > 0 ? 'pos' : (mt.profit < 0 ? 'neg' : ''), sub: mt.bets + ' 场 · 回报率 ' + fmtPct(mt.roi) },
      { k: '基线A命中率（全部）', v: fmtPct(st.baseA.rate), sub: st.baseA.hit + '/' + st.baseA.n },
      { k: '模型A命中率（全部）', v: fmtPct(st.modelA.rate), sub: st.modelA.hit + '/' + st.modelA.n },
      { k: '模型A命中率（近' + (state.modelCfg.windowDays || 30) + '天）', v: fmtPct(stW.modelA.rate), sub: stW.modelA.hit + '/' + stW.modelA.n },
      { k: '口径B 模型命中率', v: fmtPct(st.modelB.rate), sub: 'B口径仅记录差值（无基线预测）' }
    ];
    $('#tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="v">' + t.v + '</div><div class="k">' + t.k +
        (t.sub ? ' · <span class="muted">' + t.sub + '</span>' : '') + '</div></div>';
    }).join('');
  }

  // 近 N 天每日命中率（基线A vs 模型A，按预测冻结日/比赛日分组）
  function renderDailyHitChart(rows) {
    var chart = $('#chart-daily');
    var labels = $('#xlabels-daily');
    var winFrom = JC.addDays(todayStr(), -(state.modelCfg.windowDays || 30));
    var byDate = {};
    rows.forEach(function (r) {
      if (r.date < winFrom || r.actual == null) return;
      var d = byDate[r.date] = byDate[r.date] || { baseN: 0, baseHit: 0, modelN: 0, modelHit: 0 };
      if (r.predBaseA != null) { d.baseN++; if (r.hitBaseA) d.baseHit++; }
      if (r.predA != null) { d.modelN++; if (r.hitModelA) d.modelHit++; }
    });
    var dates = Object.keys(byDate).sort();
    var hasData = dates.some(function (d) { return byDate[d].modelN || byDate[d].baseN; });
    $('#chart-daily-empty').hidden = hasData;
    chart.style.display = hasData ? '' : 'none';
    labels.style.display = hasData ? '' : 'none';
    if (!hasData) { chart.innerHTML = ''; labels.innerHTML = ''; $('#chart-daily')._info = null; return; }

    var html = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      html += '<div class="gl' + (p === 0 ? ' zero' : '') + '" style="bottom:' + (p * 100) + '%"></div>';
      html += '<div class="ytick" style="bottom:' + (p * 100) + '%">' + Math.round(p * 100) + '%</div>';
    });
    var info = [];
    dates.forEach(function (d) {
      var x = byDate[d];
      var baseRate = x.baseN ? x.baseHit / x.baseN : 0;
      var modelRate = x.modelN ? x.modelHit / x.modelN : 0;
      info.push({ date: d, baseN: x.baseN, baseHit: x.baseHit, modelN: x.modelN, modelHit: x.modelHit });
      html += '<div class="bin dbin" data-i="' + (info.length - 1) + '">' +
        '<div class="seg bar-model" style="height:' + (x.modelN ? modelRate * 100 : 0) + '%"></div>' +
        '<div class="seg bar-base" style="height:' + (x.baseN ? baseRate * 100 : 0) + '%"></div>' +
        '</div>';
    });
    chart.innerHTML = html;
    chart._info = info;
    labels.innerHTML = dates.map(function (d) { return '<div class="xl">' + d.slice(5) + '</div>'; }).join('');

    chart.onmousemove = function (ev) {
      var binEl = ev.target.closest ? ev.target.closest('.dbin') : null;
      if (!binEl || !chart._info) { hideTooltip(); return; }
      var x = chart._info[Number(binEl.dataset.i)];
      if (!x) { hideTooltip(); return; }
      showTooltip(ev, x.date + '<br>基线A：' + x.baseHit + '/' + x.baseN + '（' + fmtPct(x.baseN ? x.baseHit / x.baseN : null) + '）' +
        '<br>模型A：' + x.modelHit + '/' + x.modelN + '（' + fmtPct(x.modelN ? x.modelHit / x.modelN : null) + '）');
    };
    chart.onmouseleave = hideTooltip;
  }

  // 各进球数出现分布（实际频率）
  function renderGoalDistChart(rows) {
    var chart = $('#chart-goaldist');
    var labels = $('#xlabels-goaldist');
    var counts = [0, 0, 0, 0, 0, 0, 0, 0];
    var settled = 0;
    rows.forEach(function (r) { if (r.actual != null) { counts[r.actual]++; settled++; } });
    var hasData = settled > 0;
    $('#chart-goaldist-empty').hidden = hasData;
    chart.style.display = hasData ? '' : 'none';
    labels.style.display = hasData ? '' : 'none';
    if (!hasData) { chart.innerHTML = ''; labels.innerHTML = ''; chart._counts = null; return; }
    var maxC = Math.max.apply(null, counts);
    var top = Math.max(4, Math.ceil(maxC / 4) * 4);
    var html = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      html += '<div class="gl' + (p === 0 ? ' zero' : '') + '" style="bottom:' + (p * 100) + '%"></div>';
      html += '<div class="ytick" style="bottom:' + (p * 100) + '%">' + Math.round(top * p) + '</div>';
    });
    counts.forEach(function (c, g) {
      html += '<div class="bin gbin" data-g="' + g + '"><div class="seg bar-g' + (c ? '' : ' zero') + '" style="height:' + (c / top * 100) + '%"></div></div>';
    });
    chart.innerHTML = html;
    chart._counts = counts;
    chart._settled = settled;
    labels.innerHTML = JC.GOAL_LABELS.map(function (l) { return '<div class="xl">' + l + '</div>'; }).join('');
    chart.onmousemove = function (ev) {
      var binEl = ev.target.closest ? ev.target.closest('.gbin') : null;
      if (!binEl || !chart._counts) { hideTooltip(); return; }
      var g = Number(binEl.dataset.g);
      showTooltip(ev, JC.labelG(g) + '<br>出现 ' + chart._counts[g] + ' 次（' + fmtPct(chart._settled ? chart._counts[g] / chart._settled : null) + '，共 ' + chart._settled + ' 场已出）');
    };
    chart.onmouseleave = hideTooltip;
  }

  // 自修正模型明细：排名 × 进球数 命中率矩阵（口径A，近窗口）
  function renderModelTable(rows) {
    var winFrom = JC.addDays(todayStr(), -(state.modelCfg.windowDays || 30));
    var samples = [];
    rows.forEach(function (r) {
      if (r.date < winFrom || r.actual == null || !r.diffs) return;
      samples.push({ date: r.date, diffs: (r.diffs.groups || []).map(function (g) { return g.diffA; }), actual: r.actual });
    });
    var model = JC.modelTrain(samples, { maxActualRank: state.modelCfg.maxActualRank });
    var tbody = $('#model-table tbody');
    var head = '<tr><th>进球数＼排名</th>';
    for (var r = 1; r <= 8; r++) head += '<th class="num">第' + r + '</th>';
    head += '</tr>';
    $('#model-table thead').innerHTML = head;
    var html = '';
    for (var g = 0; g <= 7; g++) {
      html += '<tr><td><b>' + JC.labelG(g) + '</b></td>';
      for (var r2 = 1; r2 <= 8; r2++) {
        var cell = model.table[g][r2];
        var cls = '';
        if (cell.total >= 3 && cell.hit / cell.total >= 0.5) cls = 'diff-pos';
        else if (cell.total) cls = 'muted';
        html += '<td class="num ' + cls + '">' + (cell.total ? (Math.round(cell.hit / cell.total * 100) + '%') : '—') +
          (cell.total ? '<span class="tiny muted">(' + cell.hit + '/' + cell.total + ')</span>' : '') + '</td>';
      }
      html += '</tr>';
    }
    tbody.innerHTML = html;
    $('#model-sample').textContent = '学习样本 ' + model.used + ' 场（另剔除爆冷 ' + model.excluded +
      ' 场；窗口 ' + winFrom + ' ~ ' + todayStr() + '，口径A）';
  }

  // 即将开赛的预测列表（未出结果、有明细）
  function renderUpcomingCard(rows) {
    var up = rows.filter(function (r) { return r.actual == null && r.diffs; });
    up.sort(function (a, b) { return String(a.date + a.kickoff).localeCompare(String(b.date + b.kickoff)); });
    var tbody = $('#upcoming-table tbody');
    if (!up.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">暂无可预测的场次（需在售期抓取到含比分矩阵的快照）</td></tr>';
      return;
    }
    tbody.innerHTML = up.slice(0, 40).map(function (r) {
      var href = 'match.html?d=' + encodeURIComponent(r.date) + '&id=' + encodeURIComponent(r.matchId);
      return '<tr><td>' + r.date.slice(5) + '</td><td>' + escapeHtml(r.matchNumStr) + '</td><td>' + escapeHtml(r.league) + '</td>' +
        '<td>' + escapeHtml(r.home) + ' vs ' + escapeHtml(r.away) + '</td><td>' + escapeHtml(r.kickoff) + '</td>' +
        (r.isSingleWin ? '<td class="single-yes">是</td>' : '<td>—</td>') +
        '<td><a class="pred-link" href="' + href + '" target="_blank" rel="noopener"><b>' + JC.labelG(r.baseA) + '</b>' +
        (r.oddsBaseA != null ? ' <span class="tiny muted">@' + Number(r.oddsBaseA).toFixed(2) + '</span>' : '') + '</a></td>' +
        '<td class="muted"><span class="tiny">' + diffSummary(r) + '</span></td></tr>';
    }).join('');
  }
  function diffSummary(r) {
    if (!r.diffs) return '';
    var parts = [];
    (r.diffs.groups || []).forEach(function (g) {
      if (g.diffA != null) parts.push((g.g === 0 ? '0*' : g.g) + ':' + g.diffA.toFixed(2));
    });
    return parts.join(' ');
  }

  function sortRows(rows) {
    var key = state.sort.key, dir = state.sort.dir;
    return rows.slice().sort(function (a, b) {
      var x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return dir * String(x).localeCompare(String(y));
      return dir * (x - y);
    });
  }

  function predCell(r, g, odds) {
    if (g == null) return '<td>—</td>';
    var txt = '<b>' + JC.labelG(g) + '</b>' + (odds != null ? ' <span class="tiny muted">@' + Number(odds).toFixed(2) + '</span>' : '');
    if (r.matchId == null) return '<td>' + txt + '</td>';
    var href = 'match.html?d=' + encodeURIComponent(r.date) + '&id=' + encodeURIComponent(r.matchId);
    return '<td><a class="pred-link" href="' + href + '" target="_blank" rel="noopener" title="查看比赛详情">' + txt + '</a></td>';
  }

  function renderDataTable(rows) {
    var sorted = sortRows(rows);
    var shown = sorted.slice(0, state.shownRows);
    var tbody = $('#data-table tbody');
    tbody.innerHTML = shown.map(function (r) {
      return '<tr>' +
        '<td>' + r.date + '</td>' +
        '<td>' + escapeHtml(r.matchNumStr) + '</td>' +
        '<td>' + escapeHtml(r.league) + '</td>' +
        '<td class="match-cell">' + escapeHtml(r.home) + '<span class="vs">vs</span>' + escapeHtml(r.away) + '</td>' +
        '<td>' + escapeHtml(r.kickoff) + '</td>' +
        '<td class="' + (r.isSingleWin ? 'single-yes' : '') + '">' + (r.isSingleWin ? '是' : '—') + '</td>' +
        '<td><b>' + JC.labelG(r.actual) + '</b></td>' +
        predCell(r, r.predBaseA, r.oddsBaseA) +
        predCell(r, r.predA, r.oddsA) +
        predCell(r, r.predB, r.oddsB) +
        '<td class="' + hitCls(r.hitModelA) + '">' + hitText(r.hitModelA) + '</td>' +
        '<td class="' + hitCls(r.hitModelB) + '">' + hitText(r.hitModelB) + '</td>' +
        '<td class="muted">' + JC.fmtAt(r.oddsAt) + '</td>' +
        '</tr>';
    }).join('');
    $('#data-more').hidden = sorted.length <= state.shownRows;
    renderDataCards(shown, sorted.length);
  }

  function renderDataCards(shown, total) {
    var el = $('#data-cards');
    if (!shown.length) {
      el.innerHTML = '<div class="empty">当前筛选下没有数据</div>';
      return;
    }
    el.innerHTML = shown.map(function (r) {
      var hit = r.hitModelA == null ? '' : '<span class="' + hitCls(r.hitModelA) + '">' + (r.hitModelA ? '模型命中 ✓' : '模型未中 ✗') + '</span>';
      var href = 'match.html?d=' + encodeURIComponent(r.date) + '&id=' + encodeURIComponent(r.matchId);
      var oddsTxt = function (g, od) { return JC.labelG(g) + (od != null ? ' <span class="tiny muted">@' + Number(od).toFixed(2) + '</span>' : ''); };
      return '<div class="mcard">' +
        '<div class="mc-head"><span class="mc-num">' + escapeHtml(r.matchNumStr) + '</span>' +
        '<span class="mc-lg">' + escapeHtml(r.league) + '</span>' +
        (r.isSingleWin ? '<span class="mc-single">单关</span>' : '') +
        '<span class="mc-time">' + escapeHtml(r.kickoff) + '</span></div>' +
        '<div class="mc-teams">' + escapeHtml(r.home) + '<span class="vs">vs</span>' + escapeHtml(r.away) + '</div>' +
        '<div class="mc-diff"><a class="pred-link" href="' + href + '" target="_blank" rel="noopener">' +
        '<span class="mc-k">基线A</span><span class="mc-v">' + oddsTxt(r.predBaseA, r.oddsBaseA) + '</span></a>' +
        '<a class="pred-link" href="' + href + '" target="_blank" rel="noopener">' +
        '<span class="mc-k">模型A</span><span class="mc-v">' + oddsTxt(r.predA, r.oddsA) + '</span></a>' +
        '<span class="mc-k">模型B</span><span class="mc-v">' + oddsTxt(r.predB, r.oddsB) + '</span></div>' +
        '<div class="mc-foot"><span>实际 <b>' + (r.actual != null ? JC.labelG(r.actual) + '（' + r.score + '）' : '—') + '</b></span>' + hit +
        ' <a class="pred-link tiny" href="' + href + '" target="_blank" rel="noopener">详情 →</a></div>' +
        '</div>';
    }).join('') + (total > shown.length ? '<div class="muted" style="text-align:center;padding:6px;font-size:12px">仅显示前 ' + shown.length + ' 场，点下方"显示更多"</div>' : '');
  }

  // ---------------------------------------------------------------- 编号追踪（保持）

  function renderAlerts() {
    var banner = $('#alert-banner');
    var st = state.numbers ? JC.numbersStats(state.numbers, {}) : null;
    var alerts = st ? st.alerts : [];
    if (!alerts.length || state.alertDismissed) { banner.hidden = true; return; }
    var top = alerts.slice(0, 4).map(function (a) {
      return '编号 <b>' + a.num + '</b> 的 <b>' + a.label + '</b> 已连续 <b>' + a.streak + ' 次</b>未出现（最近 ' + a.lastDate + '）';
    }).join('；');
    $('#alert-text').innerHTML = '编号追踪提醒：' + top +
      (alerts.length > 4 ? '；等共 <b>' + alerts.length + '</b> 项达到警戒线' : '（共 ' + alerts.length + ' 项达到警戒线）') +
      '，建议持续关注。';
    banner.hidden = false;
  }

  function renderNumbers() {
    var doc = state.numbers;
    var st = doc ? JC.numbersStats(doc, {}) : null;
    if (!st || !st.days) {
      $('#num-last-date').textContent = '—';
      $('#num-days').textContent = '0';
      $('#num-scope').textContent = '';
      $('#num-select').innerHTML = '<option value="">（暂无数据）</option>';
      $('#bucket-select').innerHTML = JC.DEFAULT_NUM_BUCKETS.map(function (b) { return '<option>' + b.label + '</option>'; }).join('');
      $('#num-dist-table tbody').innerHTML = '<tr><td colspan="4" class="muted">编号历史尚未生成：本机任务下一次运行后自动出现</td></tr>';
      $('#tracker-table tbody').innerHTML = '';
      return;
    }
    $('#num-last-date').textContent = st.lastDate;
    $('#num-days').textContent = st.days;
    $('#num-scope').textContent = st.nums.length
      ? ('追踪范围：编号 ' + st.nums[0].num + '~' + st.nums[st.nums.length - 1].num + '（' + st.nums.length + ' 个）｜ 分档：' +
        st.buckets.map(function (b) { return b.label; }).join(' / ') + '（可在 config.json 调整）')
      : '';
    var sel = $('#num-select');
    if (sel.dataset.filled !== 'v1') {
      sel.innerHTML = st.nums.map(function (n) {
        return '<option value="' + n.num + '">' + n.num + (n.active ? '' : '（已停用）') + '</option>';
      }).join('');
      sel.dataset.filled = 'v1';
    }
    var bs = $('#bucket-select');
    if (bs.options.length !== st.buckets.length || bs.dataset.filled !== 'v1') {
      bs.innerHTML = st.buckets.map(function (b, i) { return '<option value="' + i + '">' + b.label + '</option>'; }).join('');
      bs.dataset.filled = 'v1';
    }
    renderNumQuery(st);
    renderTracker(st);
  }

  function renderNumQuery(st) {
    if (!st) st = JC.numbersStats(state.numbers || {}, {});
    var num = $('#num-select').value;
    var bucket = Number($('#bucket-select').value || 0);
    var n = null;
    st.nums.forEach(function (x) { if (x.num === num) n = x; });
    var el = $('#num-query-result');
    if (!n) { el.textContent = '—'; $('#num-dist-table tbody').innerHTML = ''; return; }
    var c = n.combos[bucket];
    var res = '编号 ' + n.num + ' · ' + c.label + '：';
    if (c.never) {
      res += '在已有数据中从未出现（该编号共出现 ' + n.occurrences + ' 天，自 ' + n.firstSeen + ' 起）';
    } else {
      res += '已连续 ' + c.streak + ' 次未出现（最近 ' + c.lastDate + '，历史出现 ' + c.count + ' 次）';
      if (c.streak >= st.alertCount) res += '　【已达到 ' + st.alertCount + ' 次警戒线】';
    }
    el.textContent = res;
    el.className = 'num-result' + (!c.never && c.streak >= st.alertCount ? ' st-alert' : '');
    $('#num-dist-table tbody').innerHTML = n.combos.map(function (b) {
      var cls = '';
      if (!b.never && b.streak >= st.alertCount) cls = 'st-alert';
      else if (!b.never && b.streak >= st.alertCount * 0.6) cls = 'st-near';
      return '<tr><td>' + b.label + (b.bucket === bucket ? ' ◀' : '') + '</td><td class="num ' + cls + '">' + b.streak +
        '</td><td>' + (b.lastDate || '从未出现') + '</td><td class="num">' + b.count + '</td></tr>';
    }).join('');
  }

  function renderTracker(st) {
    if (!st) st = JC.numbersStats(state.numbers || {}, {});
    var onlyAlerts = $('#only-alerts').checked;
    var rows = [];
    st.nums.forEach(function (n) {
      if (!n.active) return;
      n.combos.forEach(function (c) {
        if (c.never || c.count === 0) return;
        if (onlyAlerts && c.streak < st.alertCount) return;
        rows.push({ num: n.num, c: c });
      });
    });
    rows.sort(function (a, b) { return b.c.streak - a.c.streak; });
    var shown = rows.slice(0, 60);
    var tbody = $('#tracker-table tbody');
    if (!shown.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">' + (onlyAlerts ? '当前没有达到警戒线的项目' : '暂无数据') + '</td></tr>';
      return;
    }
    tbody.innerHTML = shown.map(function (x) {
      var c = x.c;
      var stCls = c.streak >= st.alertCount ? 'st-alert' : (c.streak >= st.alertCount * 0.6 ? 'st-near' : 'st-ok');
      var stTxt = c.streak >= st.alertCount ? '超警戒' : (c.streak >= st.alertCount * 0.6 ? '接近警戒' : '正常');
      var rowCls = c.streak >= st.alertCount ? 'row-alert' : (c.streak >= st.alertCount * 0.6 ? 'row-near' : '');
      return '<tr class="' + rowCls + '"><td>' + x.num + '</td><td>' + c.label +
        '</td><td class="num ' + stCls + '">' + c.streak +
        '</td><td>' + c.lastDate + '</td><td class="' + stCls + '">' + stTxt + '</td></tr>';
    }).join('') + (rows.length > shown.length ? '<tr><td colspan="5" class="muted">仅显示 60 项（按连续未出现次数排序，共 ' + rows.length + ' 项）</td></tr>' : '');
  }

  // ---------------------------------------------------------------- 提示框

  function showTooltip(ev, html) {
    var t = $('#tooltip');
    t.innerHTML = html;
    t.hidden = false;
    var x = ev.clientX + 12, y = ev.clientY - 10;
    var rect = t.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - 12;
    if (y < 8) y = 8;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  function hideTooltip() { $('#tooltip').hidden = true; }

  // ---------------------------------------------------------------- 导出

  function exportRows() { return filteredRows(); }

  function exportBrowserExcel() {
    var rows = exportRows();
    if (!rows.length) { toast('当前筛选下没有数据', true); return; }
    var wb = XLSX.utils.book_new();
    var months = {};
    rows.forEach(function (r) { var m = String(r.date).slice(0, 7); (months[m] = months[m] || []).push(r); });
    var head = ['日期', '场次编号', '联赛', '主队', '客队', '开赛时间', '单关胜平负', '实际进球',
      '基线A预测', '模型A预测', '模型B预测', '模型A命中', '模型B命中', '抓取时间'];
    Object.keys(months).sort().forEach(function (m) {
      var aoa = [head].concat(months[m].map(function (r) {
        return [r.date, r.matchNumStr, r.league, r.home, r.away, r.kickoff,
          r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否'),
          r.actual == null ? '' : JC.labelG(r.actual),
          r.predBaseA == null ? '' : (JC.labelG(r.predBaseA) + (r.oddsBaseA != null ? ' @' + r.oddsBaseA : '')),
          r.predA == null ? '' : (JC.labelG(r.predA) + (r.oddsA != null ? ' @' + r.oddsA : '')),
          r.predB == null ? '' : (JC.labelG(r.predB) + (r.oddsB != null ? ' @' + r.oddsB : '')),
          hitText(r.hitModelA), hitText(r.hitModelB), JC.fmtAt(r.oddsAt)];
      }));
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 12 }, { wch: 8 },
        { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, m.slice(0, 31));
    });
    var st = JC.predStats(rows);
    var preg = function (v) { return v == null ? '' : Number((v * 100).toFixed(1)) + '%'; };
    var aoa2 = [
      ['预测统计（导出时间 ' + JC.nowIso() + '，当前筛选）'], [],
      ['已出赛果场次', st.settled], ['其中有预测', st.withPred],
      ['基线A命中率', st.baseA.hit + '/' + st.baseA.n + ' = ' + preg(st.baseA.rate)],
      ['模型A命中率', st.modelA.hit + '/' + st.modelA.n + ' = ' + preg(st.modelA.rate)],
      ['基线B命中率', st.baseB.hit + '/' + st.baseB.n + ' = ' + preg(st.baseB.rate)],
      ['模型B命中率', st.modelB.hit + '/' + st.modelB.n + ' = ' + preg(st.modelB.rate)]
    ];
    var ws2 = XLSX.utils.aoa_to_sheet(aoa2);
    ws2['!cols'] = [{ wch: 22 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws2, '统计');
    var ws3 = XLSX.utils.aoa_to_sheet([
      ['口径A(多选优化)：优化赔率 = 1 ÷ Σ(1/该进球数每个比分的赔率)；差值A = 总进球赔率 − 优化赔率'],
      ['口径B(简单平均)：平均赔率 = 该进球数各比分赔率的算术平均；差值B = 总进球赔率 − 平均赔率'],
      ['0球只有 0:0 一个比分，无差值，由全进球数二次曲线拟合给出（表中以 0* 标注）。'],
      ['预测：基线=差值最小的进球数；模型=近30天"差值排名×进球数"经验命中率（剔除深冷门）。'],
      ['数据来源：中国体育彩票官方接口；本文件由网页端即时导出，完整版（含差值明细/模型矩阵）见仓库 Excel。']
    ]);
    ws3['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws3, '说明');
    XLSX.writeFile(wb, '竞彩进球数预测_' + todayStr() + '.xlsx');
    toast('已导出 ' + rows.length + ' 行（当前筛选）');
  }

  function exportCSV() {
    var rows = exportRows();
    if (!rows.length) { toast('当前筛选下没有数据', true); return; }
    var head = ['日期', '场次编号', '联赛', '主队', '客队', '开赛时间', '单关胜平负', '实际进球',
      '基线A预测', '模型A预测', '模型B预测', '模型A命中', '模型B命中'];
    var esc = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [head.join(',')];
    rows.forEach(function (r) {
      lines.push([r.date, r.matchNumStr, r.league, r.home, r.away, r.kickoff,
        r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否'),
        r.actual == null ? '' : JC.labelG(r.actual),
        r.predBaseA == null ? '' : (JC.labelG(r.predBaseA) + (r.oddsBaseA != null ? ' @' + r.oddsBaseA : '')),
        r.predA == null ? '' : (JC.labelG(r.predA) + (r.oddsA != null ? ' @' + r.oddsA : '')),
        r.predB == null ? '' : (JC.labelG(r.predB) + (r.oddsB != null ? ' @' + r.oddsB : '')),
        hitText(r.hitModelA), hitText(r.hitModelB)].map(esc).join(','));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '竞彩进球数预测_' + todayStr() + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ---------------------------------------------------------------- 设置

  function openSettings() {
    var s = state.settings;
    $('#set-owner').value = s.owner || '';
    $('#set-repo').value = s.repo || '';
    $('#set-branch').value = s.branch || 'main';
    $('#set-token').value = s.token || '';
    $('#dlg-settings').showModal();
  }
  function saveSettingsFromDialog() {
    state.settings = {
      owner: $('#set-owner').value.trim(),
      repo: $('#set-repo').value.trim(),
      branch: $('#set-branch').value.trim() || 'main',
      token: $('#set-token').value.trim()
    };
    saveSettings();
    $('#dlg-settings').close();
    toast(canSync() ? '设置已保存：可直接同步到云端' : '设置已保存（未填令牌时数据只存本机）');
    if (canSync() && Object.keys(state.dirty).length) syncToGitHub(true);
  }

  // ---------------------------------------------------------------- 事件

  function bind() {
    $('#btn-odds').onclick = captureOdds;
    $('#btn-results').onclick = backfillResults;
    $('#btn-sync').onclick = function () { syncToGitHub(false); };
    $('#btn-xlsx').onclick = exportBrowserExcel;
    $('#btn-csv').onclick = exportCSV;
    $('#btn-reload').onclick = function () { loadAll(); };
    $('#btn-settings').onclick = openSettings;
    $('#btn-save-settings').onclick = saveSettingsFromDialog;
    $('#btn-clear-token').onclick = function () {
      state.settings.token = '';
      saveSettings();
      $('#set-token').value = '';
      toast('令牌已清除');
    };

    var menu = $('#menu-list');
    $('#btn-more').onclick = function (ev) { ev.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', function () { menu.hidden = true; });
    menu.onclick = function () { setTimeout(function () { menu.hidden = true; }, 0); };

    $$('.tab').forEach(function (t) {
      t.onclick = function () {
        $$('.tab').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        $('#view-stats').hidden = t.dataset.view !== 'stats';
        $('#view-data').hidden = t.dataset.view !== 'data';
      };
    });

    function bindRange(sel, syncSel) {
      $$(sel + ' button').forEach(function (b) {
        b.onclick = function () {
          state.filters.range = b.dataset.range;
          $$(sel + ' button').forEach(function (x) { x.classList.toggle('active', x === b); });
          $$(syncSel + ' button').forEach(function (x) { x.classList.toggle('active', x.dataset.range === b.dataset.range); });
          render();
        };
      });
    }
    bindRange('#range-seg', '#range-seg2');
    bindRange('#range-seg2', '#range-seg');
    $('#league-filter').onchange = function () { state.filters.league = this.value; $('#league-filter2').value = this.value; render(); };
    $('#league-filter2').onchange = function () { state.filters.league = this.value; $('#league-filter').value = this.value; render(); };
    $('#only-settled').onchange = function () { state.filters.onlySettled = this.checked; $('#only-settled2').checked = this.checked; render(); };
    $('#only-settled2').onchange = function () { state.filters.onlySettled = this.checked; $('#only-settled').checked = this.checked; render(); };
    $('#only-single').onchange = function () { state.filters.onlySingle = this.checked; $('#only-single2').checked = this.checked; render(); };
    $('#only-single2').onchange = function () { state.filters.onlySingle = this.checked; $('#only-single').checked = this.checked; render(); };

    // 模拟投注：轨道切换
    $$('#bet-track-seg button').forEach(function (b) {
      b.onclick = function () {
        state.betTrack = b.dataset.track;
        $$('#bet-track-seg button').forEach(function (x) { x.classList.toggle('active', x === b); });
        if (state._bet) renderBetChart(state._bet);
      };
    });

    $$('#data-table th[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var key = th.dataset.sort;
        if (state.sort.key === key) state.sort.dir = -state.sort.dir;
        else { state.sort.key = key; state.sort.dir = -1; }
        renderDataTable(filteredRows());
      };
    });
    $('#btn-more-rows').onclick = function () { state.shownRows += 300; renderDataTable(filteredRows()); };

    $('#num-select').onchange = function () { renderNumQuery(); };
    $('#bucket-select').onchange = function () { renderNumQuery(); };
    $('#only-alerts').onchange = function () { renderTracker(); };
    $('#btn-alert-dismiss').onclick = function () { state.alertDismissed = true; $('#alert-banner').hidden = true; };
    $('#btn-alert-view').onclick = function () {
      state.alertDismissed = true; $('#alert-banner').hidden = true;
      $$('.tab').forEach(function (x) { x.classList.toggle('active', x.dataset.view === 'stats'); });
      $('#view-stats').hidden = false;
      $('#view-data').hidden = true;
      var card = $('#numbers-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }

  bind();
  loadAll();

  // 调试钩子（仅供开发排查用）
  window.__jcDebug = {
    state: state, render: render, rebuildRows: rebuildRows, filteredRows: filteredRows,
    exportBrowserExcel: exportBrowserExcel, exportCSV: exportCSV
  };
})();
