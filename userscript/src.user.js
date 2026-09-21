// ==UserScript==
// @name         竞彩1球差值助手
// @namespace    jingcai-1qiu-diff
// @version      2.2.2
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

// [[CORE]]

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
        var range = JC.resultRangeFor(d); // 凌晨场真实开赛日=次日，范围 +1 天
        return JC.fetchAllResults(range[0], range[1], false).then(function (results) {
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

  // ---------------------------------------------------------------- 编号追踪提醒

  var alertInfo = null; // { alerts, alertCount, lastDate, days }

  function repoRawPath(path) {
    var s = getSettings();
    var owner = s.owner || 'chuangyuyu';
    var repo = s.repo || 'jingcai';
    var branch = s.branch || 'main';
    return 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + path;
  }

  // 从仓库读取编号历史（只读，无需令牌），计算警戒项
  function refreshAlerts() {
    fetch(repoRawPath('docs/data/numbers.json'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (doc) {
        if (!doc) return;
        var st = JC.numbersStats(doc, {});
        alertInfo = { alerts: st.alerts, alertCount: st.alertCount, lastDate: st.lastDate, days: st.days };
        renderPanel();
      })
      .catch(function () { /* 网络不可用时静默 */ });
  }

  function showAlerts() {
    if (!alertInfo) { say('正在获取编号追踪数据…'); refreshAlerts(); return; }
    var a = alertInfo.alerts;
    if (!a.length) {
      window.alert('编号追踪：当前没有连续 ≥' + alertInfo.alertCount + ' 次未出现的项目\n（数据截至 ' + alertInfo.lastDate + '，共 ' + alertInfo.days + ' 天）');
      return;
    }
    window.alert('编号追踪提醒（数据截至 ' + alertInfo.lastDate + '，警戒线 ' + alertInfo.alertCount + ' 次）\n\n' +
      a.slice(0, 15).map(function (x) {
        return '编号 ' + x.num + ' 的 ' + x.label + '：已连续 ' + x.streak + ' 次未出现（最近 ' + x.lastDate + '，历史 ' + x.count + ' 次）';
      }).join('\n') +
      (a.length > 15 ? '\n…等共 ' + a.length + ' 项' : ''));
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
    if (alertInfo && alertInfo.alerts.length) {
      statEl.textContent += ' · ⚠ ' + alertInfo.alerts.length + '项连续未出≥' + alertInfo.alertCount + '次';
      statEl.style.color = '#c0392b';
    } else {
      statEl.style.color = '#666';
    }

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
  GM_registerMenuCommand('查看编号追踪提醒', showAlerts);
  GM_registerMenuCommand('设置 GitHub 仓库/令牌', openSettings);
  GM_registerMenuCommand('导出数据 JSON', exportJson);
  GM_registerMenuCommand('清除本机数据', clearAll);

  ensurePanel();
  keepAlive();
  renderPanel();
  refreshAlerts();

  // 每天首次访问自动抓取一次（抓完接着回填赛果，保证结果及时更新）
  var today = JC.localDateStr();
  if (GM_getValue(K_LAST, '') !== today) {
    capture(false).then(function (ok) {
      if (ok) { GM_setValue(K_LAST, today); return backfill(); }
      renderPanel();
    });
  }
})();
