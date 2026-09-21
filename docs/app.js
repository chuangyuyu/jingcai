/* ============================================================
   竞彩 1球 · 比分双选差值 — 网页应用
   依赖：core.js（业务逻辑）、vendor/xlsx.full.min.js（浏览器端 Excel 导出）
   数据流：GitHub Pages 上的 data/days/*.json 为云端数据；
          本页抓取/回填产生的改动先存本机 localStorage（"待同步"），
          配置 GitHub 令牌后一键同步到云端。
   ============================================================ */
(function () {
  'use strict';

  var JC = window.JCCore;
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  // ---------------------------------------------------------------- 状态

  var state = {
    days: {},          // date -> dayDoc（云端 + 本地未同步，已合并）
    dirty: {},         // date -> dayDoc（本地未同步的整份日数据）
    numbers: null,     // 编号历史（docs/data/numbers.json）
    alertDismissed: false,
    settings: loadSettings(),
    rows: [],          // 展平后的全部行
    filters: { range: '30', league: '', onlySettled: false, onlyValue: false, onlySingle: false },
    sort: { key: 'date', dir: -1 },
    shownRows: 200,
    busy: false
  };

  var LS_SETTINGS = 'jc_settings_v1';
  var LS_DIRTY = 'jc_dirty_v1';

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch (e) {}
    // 在 GitHub Pages 上自动识别仓库
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
  function fmtOdds(v) { return v == null ? '—' : Number(v).toFixed(2); }
  function fmt3(v) { return v == null ? '—' : Number(v).toFixed(3); }
  function fmtDiff(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(3); }
  function fmtPct(v, digits) { return v == null ? '—' : (v * 100).toFixed(digits == null ? 1 : digits) + '%'; }
  function todayStr() { return JC.localDateStr(); }

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

  // 优先经 GitHub API 读取（绕过 Pages 缓存延迟，需令牌）；否则读本站相对路径
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
    state.rows.forEach(function (r) {
      var t = (r.o2 && r.o2.at) || (r.o1 && r.o1.at) || '';
      if (t > lastAt) lastAt = t;
    });
    var txt = '数据 ' + state.rows.length + ' 场 · ' + dates.length + ' 天（' +
      (dates.length ? dates[0] + ' ~ ' + dates[dates.length - 1] : '—') + '）' +
      ' · 最近抓取 ' + (lastAt ? lastAt.replace('T', ' ').slice(0, 16) : '—');
    if (dirtyCount) txt += ' · 待同步 ' + dirtyCount + ' 天';
    if (extra) txt += ' · ' + extra;
    setStatus(txt, dirtyCount ? 'warn' : 'ok');
  }

  // ---------------------------------------------------------------- 抓取

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
      if (!matches.length) throw new Error('接口未返回任何在售比赛');
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
      matches.forEach(function (m) { if (m.diff != null) complete++; });
      rebuildRows(); render(); updateStatusLine('刚抓取');
      toast('已抓取 ' + matches.length + ' 场（' + dates.join('、') + '），其中 ' + complete + ' 场可计算差值' +
        (added ? '，新增 ' + added + ' 场' : ''));
      if (canSync()) return syncToGitHub(true);
    }).catch(function (e) {
      setStatus('抓取失败：' + e.message, 'err');
      toast('抓取失败：' + e.message + '（请确认网络可访问体彩官网）', true);
    }).then(function () {
      state.busy = false;
      btn.disabled = false;
    });
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
        // 赛果接口按真实开赛日过滤：凌晨场属于次日，查询范围 +1 天
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
      rebuildRows(); render();
      updateStatusLine('刚回填赛果');
      toast(changedTotal ? ('已回填 ' + changedTotal + ' 场比赛结果') : '没有新的比赛结果');
      if (changedTotal && canSync()) return syncToGitHub(true);
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
    return 'https://api.github.com/repos/' + state.settings.owner + '/' + state.settings.repo +
      '/contents/' + path;
  }
  // 返回 {sha, doc}；文件不存在返回 {sha:null, doc:null}
  function ghGetFile(path) {
    return fetch(ghUrl(path) + '?ref=' + encodeURIComponent(state.settings.branch || 'main'), { headers: ghHeaders(), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return { sha: null, doc: null };
        if (!r.ok) throw new Error('GitHub 读取失败 HTTP ' + r.status + '（检查令牌权限）');
        return r.json().then(function (j) {
          var text = b64DecodeUtf8(j.content || '');
          var doc = null;
          try { doc = JSON.parse(text); } catch (e) {}
          return { sha: j.sha, doc: doc };
        });
      });
  }
  function ghPutFile(path, doc, message, sha) {
    var body = {
      message: message,
      content: b64EncodeUtf8(JSON.stringify(doc, null, 1)),
      branch: state.settings.branch || 'main'
    };
    if (sha) body.sha = sha;
    return fetch(ghUrl(path), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409) throw new Error('CONFLICT');
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error('GitHub 写入失败 HTTP ' + r.status + (j.message ? '：' + j.message : ''));
        });
      }
      return r.json();
    });
  }
  function b64EncodeUtf8(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function b64DecodeUtf8(b64) {
    var bin = atob((b64 || '').replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function syncToGitHub(silentIfClean) {
    if (!canSync()) {
      if (!silentIfClean) {
        toast('尚未配置 GitHub 仓库/令牌：数据已保存在本机浏览器。到「更多 → 设置」配置后可同步到云端。', true);
      }
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
          if (e.message === 'CONFLICT') return pushOne(path, d); // 云端被其他设备更新过，重取再合并推一次
          throw e;
        });
      });
    });
    return chain.then(function () {
      // 更新索引
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
      toast('已同步 ' + dates.length + ' 天数据到 GitHub（GitHub Pages 刷新可能有 1~2 分钟延迟）');
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

  // ---------------------------------------------------------------- 筛选与渲染

  function filteredRows() {
    var today = todayStr();
    var f = state.filters;
    return state.rows.filter(function (r) {
      if (f.range === '7' && r.date < JC.addDays(today, -6)) return false;
      if (f.range === '30' && r.date < JC.addDays(today, -29)) return false;
      if (f.range === 'month' && String(r.date).slice(0, 7) !== today.slice(0, 7)) return false;
      if (f.league && r.league !== f.league) return false;
      if (f.onlySettled && r.isOneGoal == null) return false;
      if (f.onlyValue && r.diff == null) return false;
      if (f.onlySingle && r.isSingleWin !== true) return false;
      return true;
    });
  }

  function render() {
    var rows = filteredRows();
    renderTiles(rows);
    renderDistChart(rows);
    renderRatioChart(rows);
    renderDeltaChart(rows);
    renderSingleTable(rows);
    renderDeltaTable(rows);
    renderBinsTable(rows);
    renderDataTable(rows);
    renderLeagueOptions();
    renderAlerts();
    renderNumbers();
  }

  // ---------------------------------------------------------------- 编号追踪

  function renderAlerts() {
    var banner = $('#alert-banner');
    var st = state.numbers ? JC.numbersStats(state.numbers, {}) : null;
    var alerts = st ? st.alerts : [];
    if (!alerts.length || state.alertDismissed) { banner.hidden = true; return; }
    var top = alerts.slice(0, 4).map(function (a) {
      return '编号 <b>' + a.num + '</b> 的 <b>' + a.label + '</b> 已 <b>' + a.daysSince + ' 天</b>未出现' +
        (a.avgGap ? '（该组合历史约 ' + a.avgGap + ' 天/次，最近 ' + a.lastDate + '）' : '（最近 ' + a.lastDate + '）');
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
      $('#num-select').innerHTML = '<option value="">（暂无数据）</option>';
      $('#bucket-select').innerHTML = JC.GOAL_LABELS.map(function (l, i) { return '<option value="' + i + '">' + l + '</option>'; }).join('');
      $('#num-dist-table tbody').innerHTML = '<tr><td colspan="5" class="muted">编号历史尚未生成：本机任务下一次运行后自动出现</td></tr>';
      $('#tracker-table tbody').innerHTML = '';
      return;
    }
    $('#num-last-date').textContent = st.lastDate;
    $('#num-days').textContent = st.days;

    var sel = $('#num-select');
    if (sel.dataset.filled !== 'v1') {
      sel.innerHTML = st.nums.map(function (n) {
        return '<option value="' + n.num + '">' + n.num + (n.active ? '' : '（已停用）') + '</option>';
      }).join('');
      sel.dataset.filled = 'v1';
    }
    var bs = $('#bucket-select');
    if (!bs.options.length) {
      bs.innerHTML = JC.GOAL_LABELS.map(function (l, i) { return '<option value="' + i + '">' + l + '</option>'; }).join('');
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
      res += '最近出现 ' + c.lastDate + '，距今 ' + c.daysSince + ' 天；连续未出现 ' + c.streak + ' 次；历史出现 ' + c.count + ' 次';
      if (c.daysSince >= st.alertDays) res += '　【已超过 ' + st.alertDays + ' 天警戒线】';
    }
    el.textContent = res;
    el.className = 'num-result' + (!c.never && c.daysSince >= st.alertDays ? ' st-alert' : '');
    $('#num-dist-table tbody').innerHTML = n.combos.map(function (b) {
      var cls = '';
      if (!b.never && b.daysSince >= st.alertDays) cls = 'st-alert';
      else if (!b.never && b.daysSince >= st.alertDays * 0.6) cls = 'st-near';
      return '<tr><td>' + b.label + (b.bucket === bucket ? ' ◀' : '') + '</td><td class="num">' + b.count +
        '</td><td>' + (b.lastDate || '从未出现') + '</td><td class="num ' + cls + '">' + (b.daysSince != null ? b.daysSince : '—') +
        '</td><td class="num">' + b.streak + '</td></tr>';
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
        if (onlyAlerts && c.daysSince < st.alertDays) return;
        rows.push({ num: n.num, c: c });
      });
    });
    rows.sort(function (a, b) { return b.c.daysSince - a.c.daysSince; });
    var shown = rows.slice(0, 60);
    var tbody = $('#tracker-table tbody');
    if (!shown.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">' + (onlyAlerts ? '当前没有达到警戒线的项目' : '暂无数据') + '</td></tr>';
      return;
    }
    tbody.innerHTML = shown.map(function (x) {
      var c = x.c;
      var stCls = c.daysSince >= st.alertDays ? 'st-alert' : (c.daysSince >= st.alertDays * 0.6 ? 'st-near' : 'st-ok');
      var stTxt = c.daysSince >= st.alertDays ? '超警戒' : (c.daysSince >= st.alertDays * 0.6 ? '接近警戒' : '正常');
      var rowCls = c.daysSince >= st.alertDays ? 'row-alert' : (c.daysSince >= st.alertDays * 0.6 ? 'row-near' : '');
      return '<tr class="' + rowCls + '"><td>' + x.num + '</td><td>' + c.label + '</td><td>' + c.lastDate +
        '</td><td class="num ' + stCls + '">' + c.daysSince + '</td><td class="num">' + (c.avgGap != null ? c.avgGap : '—') +
        '</td><td class="num">' + c.streak +
        '</td><td class="num">' + c.count + '</td><td class="' + stCls + '">' + stTxt + '</td></tr>';
    }).join('') + (rows.length > shown.length ? '<tr><td colspan="8" class="muted">仅显示 60 项（按距今天数排序，共 ' + rows.length + ' 项）</td></tr>' : '');
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
    var st = JC.stats(rows, 0.05).summary;
    var tiles = [
      { k: '场次（当前筛选）', v: st.total, sub: st.twoCaptureCount ? '两次快照 ' + st.twoCaptureCount : '' },
      { k: '已出赛果', v: st.settled, sub: st.total ? '占 ' + fmtPct(st.settled / st.total, 0) : '' },
      { k: '1球赛果', v: st.oneGoalCount, sub: st.settled ? '占已出 ' + fmtPct(st.oneGoalRatio) : '' },
      { k: '单关场次', v: st.singleCount, sub: st.singleSettled ? '其中已出 ' + st.singleSettled : '官方开放胜平负单关' },
      { k: '单关1球占比', v: fmtPct(st.singleOneGoalRatio), sub: st.nonSingleGroup.oneGoalRatio != null ? '非单关 ' + fmtPct(st.nonSingleGroup.oneGoalRatio) : '对比非单关' },
      { k: '平均差值（1球场次）', v: fmtDiff(st.avgDiffOne), cls: st.avgDiffOne > 0 ? 'pos' : (st.avgDiffOne < 0 ? 'neg' : ''), sub: '正=1球更划算' }
    ];
    $('#tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="v ' + (t.cls || '') + '">' + t.v +
        '</div><div class="k">' + t.k + (t.sub ? ' · <span class="muted">' + t.sub + '</span>' : '') + '</div></div>';
    }).join('');
  }

  // 根据数据范围选择图表箱宽，保证柱子数量不超过 maxBins
  function pickWidth(rows, maxBins) {
    var diffs = rows.map(function (r) { return r.diff; }).filter(function (v) { return v != null; });
    if (diffs.length < 2) return 0.05;
    var span = Math.max.apply(null, diffs) - Math.min.apply(null, diffs);
    var widths = [0.05, 0.1, 0.2, 0.5, 1, 2];
    for (var i = 0; i < widths.length; i++) {
      if (span / widths[i] <= maxBins) return widths[i];
    }
    return 2;
  }

  function niceCeil(n) {
    // 全部为 4 的倍数，保证 0/25/50/75/100% 刻度都是整数
    var steps = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 80, 100, 120, 160, 200, 240, 300, 400, 500, 600, 800, 1000];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= n) return steps[i];
    return Math.ceil(n / 100) * 100;
  }

  function renderDistChart(rows) {
    var chart = $('#chart-dist');
    var labels = $('#xlabels-dist');
    var st = JC.stats(rows, pickWidth(rows, 16));
    var hasData = st.summary.settled > 0 && st.bins.length > 0;
    $('#chart-dist-empty').hidden = hasData;
    chart.style.display = hasData ? '' : 'none';
    labels.style.display = hasData ? '' : 'none';
    $('#legend-dist').innerHTML =
      '<span class="chip"><span class="sw" style="background:var(--series-1)"></span>1球（1:0/0:1）</span>' +
      '<span class="chip"><span class="sw" style="background:var(--series-2)"></span>非1球</span>';
    if (!hasData) { chart.innerHTML = ''; labels.innerHTML = ''; return; }

    var maxCount = Math.max.apply(null, st.bins.map(function (b) { return b.count; }));
    var top = niceCeil(maxCount);
    var html = '';
    // 网格线与刻度
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      var bottom = p * 100;
      html += '<div class="gl' + (p === 0 ? ' zero' : '') + '" style="bottom:' + bottom + '%"></div>';
      html += '<div class="ytick" style="bottom:' + bottom + '%">' + Math.round(top * p) + '</div>';
    });
    st.bins.forEach(function (b, i) {
      var hOne = b.oneCount / top * 100;
      var hNon = b.nonOneCount / top * 100;
      var nonTop = b.nonOneCount > 0;
      html += '<div class="bin" data-i="' + i + '">' +
        (b.nonOneCount > 0 ? '<div class="seg non' + (nonTop ? ' top' : '') + '" style="height:' + hNon + '%"></div>' : '') +
        (b.oneCount > 0 ? '<div class="seg one' + (!nonTop ? ' top' : '') + '" style="height:' + hOne + '%"></div>' : '') +
        (b.count === 0 ? '<div class="mark"></div>' : '') +
        '</div>';
    });
    chart.innerHTML = html;
    chart._bins = st.bins;
    labels.innerHTML = st.bins.map(function (b) {
      return '<div class="xl">' + b.lo.toFixed(2) + '</div>';
    }).join('');
    labels._bins = st.bins;

    chart.onmousemove = function (ev) {
      var binEl = ev.target.closest ? ev.target.closest('.bin') : null;
      if (!binEl || !chart._bins) { hideTooltip(); return; }
      var b = chart._bins[Number(binEl.dataset.i)];
      if (!b) { hideTooltip(); return; }
      showTooltip(ev, '差值 ' + b.label + '<br>共 ' + b.count + ' 场' +
        '<br>1球 ' + b.oneCount + ' 场（' + fmtPct(b.oneRatio) + '）' +
        '<br>非1球 ' + b.nonOneCount + ' 场');
    };
    chart.onmouseleave = hideTooltip;
  }

  function renderRatioChart(rows) {
    var chart = $('#chart-ratio');
    var labels = $('#xlabels-ratio');
    var st = JC.stats(rows, pickWidth(rows, 16));
    var hasData = st.summary.settled > 0 && st.bins.length > 0;
    $('#chart-ratio-empty').hidden = hasData;
    chart.style.display = hasData ? '' : 'none';
    labels.style.display = hasData ? '' : 'none';
    if (!hasData) { chart.innerHTML = ''; labels.innerHTML = ''; return; }

    var html = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      html += '<div class="gl' + (p === 0 ? ' zero' : '') + '" style="bottom:' + (p * 100) + '%"></div>';
      html += '<div class="ytick" style="bottom:' + (p * 100) + '%">' + Math.round(p * 100) + '%</div>';
    });
    st.bins.forEach(function (b, i) {
      var h = b.oneRatio != null ? b.oneRatio * 100 : 0;
      html += '<div class="bin" data-i="' + i + '">' +
        (b.count > 0 ? '<div class="seg bar-ratio" style="height:' + h + '%"></div>' : '<div class="mark"></div>') +
        '</div>';
    });
    var overall = st.summary.oneGoalRatio;
    if (overall != null) {
      html += '<div class="ref-line" style="bottom:' + (overall * 100) + '%"><span class="ref-label">总体 ' + fmtPct(overall) + '</span></div>';
    }
    chart.innerHTML = html;
    chart._bins = st.bins;
    labels.innerHTML = st.bins.map(function (b) { return '<div class="xl">' + b.lo.toFixed(2) + '</div>'; }).join('');

    chart.onmousemove = function (ev) {
      var binEl = ev.target.closest ? ev.target.closest('.bin') : null;
      if (!binEl || !chart._bins) { hideTooltip(); return; }
      var b = chart._bins[Number(binEl.dataset.i)];
      if (!b) { hideTooltip(); return; }
      showTooltip(ev, '差值 ' + b.label + '<br>1球占比 ' + fmtPct(b.oneRatio) +
        '<br>样本 ' + b.count + ' 场' + (b.count < 5 ? '（样本少，仅供参考）' : ''));
    };
    chart.onmouseleave = hideTooltip;
  }

  function renderBinsTable(rows) {
    var st = JC.stats(rows, 0.05);
    var tbody = $('#bins-table tbody');
    if (!st.bins.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无已出赛果的数据</td></tr>';
      return;
    }
    tbody.innerHTML = st.bins.map(function (b) {
      var ratioCls = '';
      if (b.oneRatio != null && b.count >= 5 && st.summary.oneGoalRatio != null) {
        ratioCls = b.oneRatio >= st.summary.oneGoalRatio ? 'diff-pos' : 'diff-neg';
      }
      return '<tr><td>' + b.label + '</td><td class="num">' + b.count + '</td><td class="num">' + b.oneCount +
        '</td><td class="num">' + b.nonOneCount + '</td><td class="num ' + ratioCls + '">' + fmtPct(b.oneRatio) +
        '</td><td class="num">' + fmtDiff(b.avgDiff) + '</td></tr>';
    }).join('');
  }

  // 差值变化 ①→② 分档 → 1球占比
  function renderDeltaChart(rows) {
    var chart = $('#chart-delta');
    var labels = $('#xlabels-delta');
    var st = JC.stats(rows, pickWidth(rows, 16));
    var hasData = st.summary.deltaSettled > 0 && st.deltaBins.some(function (b) { return b.count > 0; });
    $('#chart-delta-empty').hidden = hasData;
    chart.style.display = hasData ? '' : 'none';
    labels.style.display = hasData ? '' : 'none';
    if (!hasData) { chart.innerHTML = ''; labels.innerHTML = ''; return; }
    var shortLabels = ['↓≥0.10', '↓0.03~0.10', '±0.03', '↑0.03~0.10', '↑≥0.10'];
    var html = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      html += '<div class="gl' + (p === 0 ? ' zero' : '') + '" style="bottom:' + (p * 100) + '%"></div>';
      html += '<div class="ytick" style="bottom:' + (p * 100) + '%">' + Math.round(p * 100) + '%</div>';
    });
    st.deltaBins.forEach(function (b, i) {
      var h = b.oneRatio != null ? b.oneRatio * 100 : 0;
      html += '<div class="bin" data-i="' + i + '">' +
        (b.count > 0 ? '<div class="seg bar-ratio" style="height:' + h + '%"></div>' : '<div class="mark"></div>') +
        '</div>';
    });
    var overall = st.summary.oneGoalRatio;
    if (overall != null) {
      html += '<div class="ref-line" style="bottom:' + (overall * 100) + '%"><span class="ref-label">总体 ' + fmtPct(overall) + '</span></div>';
    }
    chart.innerHTML = html;
    chart._bins = st.deltaBins;
    labels.innerHTML = st.deltaBins.map(function (b, i) { return '<div class="xl">' + shortLabels[i] + '</div>'; }).join('');
    chart.onmousemove = function (ev) {
      var binEl = ev.target.closest ? ev.target.closest('.bin') : null;
      if (!binEl || !chart._bins) { hideTooltip(); return; }
      var b = chart._bins[Number(binEl.dataset.i)];
      if (!b) { hideTooltip(); return; }
      showTooltip(ev, '变化：' + b.label + '<br>1球占比 ' + fmtPct(b.oneRatio) +
        '<br>样本 ' + b.count + ' 场 · 平均变化 ' + fmtDiff(b.avgDelta) + (b.count < 5 ? '（样本少，仅供参考）' : ''));
    };
    chart.onmouseleave = hideTooltip;
  }

  // 单关 vs 非单关对比表
  function renderSingleTable(rows) {
    var st = JC.stats(rows, 0.05);
    var s = st.summary;
    var tbody = $('#single-table tbody');
    var mk = function (name, g) {
      var ratioCls = '';
      if (g.oneRatio != null && s.oneGoalRatio != null) {
        ratioCls = g.oneRatio >= s.oneGoalRatio ? 'diff-pos' : 'diff-neg';
      }
      return '<tr><td>' + name + '</td><td class="num">' + g.count + '</td><td class="num">' + g.settled +
        '</td><td class="num">' + g.oneGoalCount + '</td><td class="num ' + ratioCls + '">' + fmtPct(g.oneRatio) +
        '</td><td class="num">' + fmtDiff(g.avgDiff) + '</td></tr>';
    };
    tbody.innerHTML = mk('单场胜平负（单关）', s.singleGroup) + mk('非单关场次', s.nonSingleGroup);
  }

  // 差值变化分档明细表
  function renderDeltaTable(rows) {
    var st = JC.stats(rows, 0.05);
    var tbody = $('#delta-table tbody');
    if (!st.summary.deltaSettled) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无两次快照齐全且已出赛果的数据</td></tr>';
      return;
    }
    tbody.innerHTML = st.deltaBins.map(function (b) {
      var ratioCls = '';
      if (b.oneRatio != null && b.count >= 5 && st.summary.oneGoalRatio != null) {
        ratioCls = b.oneRatio >= st.summary.oneGoalRatio ? 'diff-pos' : 'diff-neg';
      }
      return '<tr><td>' + b.label + '</td><td class="num">' + b.count + '</td><td class="num">' + b.oneCount +
        '</td><td class="num">' + b.nonOneCount + '</td><td class="num ' + ratioCls + '">' + fmtPct(b.oneRatio) +
        '</td><td class="num">' + fmtDiff(b.avgDelta) + '</td></tr>';
    }).join('');
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

  function renderDataTable(rows) {
    var sorted = sortRows(rows);
    var shown = sorted.slice(0, state.shownRows);
    var tbody = $('#data-table tbody');
    tbody.innerHTML = shown.map(function (r) {
      var d1 = r.o1.diff, d2 = r.o2.diff;
      var cls1 = d1 == null ? '' : (d1 > 0 ? 'diff-pos' : 'diff-neg');
      var cls2 = d2 == null ? '' : (d2 > 0 ? 'diff-pos' : 'diff-neg');
      var dirCls = r.dir === '↑' ? 'dir-up' : (r.dir === '↓' ? 'dir-down' : 'dir-flat');
      var oneTxt = r.isOneGoal == null ? '' : (r.isOneGoal ? '是' : '否');
      var oneCls = r.isOneGoal === true ? 'one-yes' : (r.isOneGoal === false ? 'one-no' : '');
      var singleTxt = r.isSingleWin == null ? '' : (r.isSingleWin ? '是' : '否');
      var singleCls = r.isSingleWin === true ? 'single-yes' : '';
      return '<tr>' +
        '<td>' + r.date + '</td>' +
        '<td>' + escapeHtml(r.matchNumStr) + '</td>' +
        '<td>' + escapeHtml(r.league) + '</td>' +
        '<td class="match-cell">' + escapeHtml(r.home) + '<span class="vs">vs</span>' + escapeHtml(r.away) + '</td>' +
        '<td>' + escapeHtml(r.kickoff) + '</td>' +
        '<td class="' + singleCls + '">' + singleTxt + '</td>' +
        '<td class="num">' + fmtOdds(r.o1.ttg1) + '</td>' +
        '<td class="num">' + fmtOdds(r.o1.s10) + '</td>' +
        '<td class="num">' + fmtOdds(r.o1.s01) + '</td>' +
        '<td class="num">' + fmt3(r.o1.optimized) + '</td>' +
        '<td class="num ' + cls1 + '">' + fmtDiff(d1) + '</td>' +
        '<td class="num">' + fmtOdds(r.o2.ttg1) + '</td>' +
        '<td class="num">' + fmtOdds(r.o2.s10) + '</td>' +
        '<td class="num">' + fmtOdds(r.o2.s01) + '</td>' +
        '<td class="num">' + fmt3(r.o2.optimized) + '</td>' +
        '<td class="num ' + cls2 + '">' + fmtDiff(d2) + '</td>' +
        '<td class="' + dirCls + '">' + (r.dir || '') + (r.diffDelta != null ? ' ' + fmtDiff(r.diffDelta) : '') + '</td>' +
        '<td>' + (r.score || '') + '</td>' +
        '<td class="' + oneCls + '">' + oneTxt + '</td>' +
        '<td class="muted">' + escapeHtml(r.times) + '</td>' +
        '</tr>';
    }).join('');
    $('#data-more').hidden = sorted.length <= state.shownRows;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  function exportBrowserExcel() {
    var rows = filteredRows();
    if (!rows.length) { toast('当前筛选下没有数据', true); return; }
    var wb = XLSX.utils.book_new();
    var months = {};
    rows.forEach(function (r) { var m = String(r.date).slice(0, 7); (months[m] = months[m] || []).push(r); });
    Object.keys(months).sort().forEach(function (m) {
      var aoa = [JC.CSV_HEADERS].concat(months[m].map(function (r) { return JC.rowToCells(r); }));
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 12 },
        { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 8 }, { wch: 7 }, { wch: 17 }];
      XLSX.utils.book_append_sheet(wb, ws, m.slice(0, 31));
    });
    // 统计表
    var st = JC.stats(rows, 0.05);
    var s = st.summary;
    var preg = function (v) { return v == null ? '' : Number((v * 100).toFixed(1)) + '%'; };
    var aoa2 = [
      ['统计（导出时间 ' + JC.nowIso() + '，当前筛选）'], [],
      ['总场次', s.total], ['其中含两次抓取的场次', s.twoCaptureCount], ['已出赛果场次', s.settled],
      ['其中1球赛果场次', s.oneGoalCount], ['1球占比', preg(s.oneGoalRatio)],
      ['平均差值（全部已出）', s.avgDiffAll], ['平均差值（1球场次）', s.avgDiffOne], ['平均差值（非1球场次）', s.avgDiffNon],
      [], ['单关 vs 非单关', '场次', '已出赛果', '1球场次', '1球占比', '平均差值'],
      ['单场胜平负（单关）', s.singleGroup.count, s.singleGroup.settled, s.singleGroup.oneGoalCount, preg(s.singleGroup.oneGoalRatio), s.singleGroup.avgDiff],
      ['非单关场次', s.nonSingleGroup.count, s.nonSingleGroup.settled, s.nonSingleGroup.oneGoalCount, preg(s.nonSingleGroup.oneGoalRatio), s.nonSingleGroup.avgDiff],
      [], ['差值区间', '总场次', '1球场次', '非1球场次', '1球占比', '平均差值']
    ].concat(st.bins.map(function (b) {
      return [b.label, b.count, b.oneCount, b.nonOneCount, preg(b.oneRatio), b.avgDiff];
    })).concat([
      [], ['差值变化 ①→②', '场次', '1球场次', '非1球场次', '1球占比', '平均变化量']
    ]).concat(st.deltaBins.map(function (b) {
      return [b.label, b.count, b.oneCount, b.nonOneCount, preg(b.oneRatio), b.avgDelta];
    }));
    var ws2 = XLSX.utils.aoa_to_sheet(aoa2);
    ws2['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws2, '统计');
    var ws3 = XLSX.utils.aoa_to_sheet([
      ['优化赔率 = 1:0赔率 × 0:1赔率 ÷ (1:0赔率 + 0:1赔率)'],
      ['差值 = 1球赔率 − 优化赔率（正数：押1球回报更高；负数：押两个比分双选回报更高）'],
      ['①/② = 当天第一次(11:00)/第二次(17:00)抓取的快照；变化 = 第二次差值 − 第一次差值的方向（↑/↓/→）；第二次抓取时已开赛的比赛只有①列。'],
      ['数据来源：中国体育彩票官方接口；本文件由网页端即时导出，完整版见仓库 excel/ 目录。'],
      ['仅为个人数据分析用途，不构成投注建议。']
    ]);
    ws3['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws3, '说明');
    XLSX.writeFile(wb, '竞彩1球-差值记录_' + todayStr() + '.xlsx');
    toast('已导出 ' + rows.length + ' 行（当前筛选）');
  }

  function exportCSV() {
    var rows = filteredRows();
    if (!rows.length) { toast('当前筛选下没有数据', true); return; }
    var blob = new Blob([JC.toCSV(rows)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '竞彩1球-差值记录_' + todayStr() + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ---------------------------------------------------------------- 设置对话框

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

  // ---------------------------------------------------------------- 事件绑定

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

    // 更多菜单
    var menu = $('#menu-list');
    $('#btn-more').onclick = function (ev) { ev.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', function () { menu.hidden = true; });
    menu.onclick = function () { setTimeout(function () { menu.hidden = true; }, 0); };

    // 页签
    $$('.tab').forEach(function (t) {
      t.onclick = function () {
        $$('.tab').forEach(function (x) { x.classList.remove('active'); });
        t.classList.add('active');
        $('#view-stats').hidden = t.dataset.view !== 'stats';
        $('#view-data').hidden = t.dataset.view !== 'data';
      };
    });

    // 筛选（两套控件同步）
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
    $('#only-value').onchange = function () { state.filters.onlyValue = this.checked; render(); };

    // 编号追踪
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

    // 表头排序
    $$('#data-table th[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var key = th.dataset.sort;
        if (state.sort.key === key) state.sort.dir = -state.sort.dir;
        else { state.sort.key = key; state.sort.dir = -1; }
        renderDataTable(filteredRows());
      };
    });
    $('#btn-more-rows').onclick = function () { state.shownRows += 300; renderDataTable(filteredRows()); };
  }

  // ---------------------------------------------------------------- 启动

  bind();
  loadAll();

  // 调试钩子（仅供开发排查用）
  window.__jcDebug = { state: state, render: render, rebuildRows: rebuildRows, filteredRows: filteredRows, exportBrowserExcel: exportBrowserExcel, exportCSV: exportCSV };
})();
