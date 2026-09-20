/**
 * 本地代理自动探测（用于让 git 访问 GitHub）
 * ============================================================
 * 背景：本机通过本地代理软件（Clash/v2ray 等）访问 GitHub，端口可能变化。
 * 策略：每次执行 git 操作前调用 ensureGitProxy()：
 *   1) 依次尝试候选代理：config.json 的 gitProxy 指定值 → Windows 系统代理设置
 *      （与 Edge 共用，注册表 HKCU\...\Internet Settings）→ 常见端口列表；
 *   2) 候选必须同时满足「端口在监听」且「能通过它 CONNECT 到 github.com:443」；
 *   3) 找到 → 写入本仓库 git 配置（http.proxy/https.proxy）；找不到 → 清除过期配置走直连。
 * 该逻辑对「直连网络（无代理）」的电脑同样成立：探测不到就直连。
 */
'use strict';

const net = require('net');
const { execFileSync } = require('child_process');

// 常见代理软件默认端口：Clash 7890/7897、v2ray 10809/10808、SS 1080、
// 以及其它常见本地监听端口
const COMMON_PORTS = [7890, 7897, 7891, 7899, 10809, 10808, 10810, 1080, 1081,
  8889, 8888, 8118, 8080, 2080, 20171, 33210, 4780, 7078];

// 探测单个 TCP 端口是否有服务在监听
function testPort(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    const sock = net.connect({ host: host, port: port });
    let done = false;
    const finish = function (ok) { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs || 800);
    sock.on('connect', function () { finish(true); });
    sock.on('timeout', function () { finish(false); });
    sock.on('error', function () { finish(false); });
    sock.on('close', function () { finish(false); });
  });
}

// 通过候选代理向目标发送 CONNECT 请求，验证它确实能代理 HTTPS
function testProxyConnect(port, targetHost, timeoutMs) {
  targetHost = targetHost || 'github.com';
  return new Promise(function (resolve) {
    const sock = net.connect({ host: '127.0.0.1', port: port });
    let buf = '';
    let done = false;
    const finish = function (ok) { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs || 5000);
    sock.on('connect', function () {
      sock.write('CONNECT ' + targetHost + ':443 HTTP/1.1\r\nHost: ' + targetHost + ':443\r\n\r\n');
    });
    sock.on('data', function (d) {
      buf += d.toString('latin1');
      if (/^HTTP\/1\.[01] 200/.test(buf)) finish(true);
      else if (buf.length > 300) finish(false);
    });
    sock.on('timeout', function () { finish(false); });
    sock.on('error', function () { finish(false); });
    sock.on('close', function () { finish(false); });
  });
}

// 读取 Windows 系统代理设置（Edge 使用的同一份配置）
function readSystemProxy() {
  if (process.platform !== 'win32') return [];
  const out = [];
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    // 即使 ProxyEnable=0 也把 ProxyServer 作为候选（有些工具只在启动时设置一次）
    const reg = execFileSync('reg', ['query', KEY, '/v', 'ProxyServer'], { encoding: 'latin1', stdio: 'pipe' });
    const m = /REG_SZ\s+(\S+)/.exec(reg);
    if (m) {
      const re = /([A-Za-z0-9.\-]+):(\d{2,5})/g;
      let g;
      while ((g = re.exec(m[1])) !== null) {
        const port = Number(g[2]);
        if (port > 0 && port < 65536) out.push({ host: g[1], port: port, source: '系统代理设置' });
      }
    }
  } catch (e) { /* 读不到就跳过 */ }
  return out;
}

// 探测可用代理；返回 {host, port, url, source} 或 null
async function detectProxy(opts) {
  opts = opts || {};
  const candidates = [];
  const seen = {};
  const push = function (c) {
    if (!c || !c.port || seen[c.port]) return;
    seen[c.port] = true;
    candidates.push(c);
  };
  // 1) 配置里显式指定的
  if (opts.hint) {
    const m = /([A-Za-z0-9.\-]+):(\d{2,5})/.exec(String(opts.hint));
    if (m) push({ host: m[1], port: Number(m[2]), source: 'config.json 指定' });
  }
  // 2) 系统代理设置
  readSystemProxy().forEach(push);
  // 3) 常见端口
  COMMON_PORTS.forEach(function (p) { push({ host: '127.0.0.1', port: p, source: '常见端口' }); });

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!(await testPort(c.host, c.port, 800))) continue;
    if (await testProxyConnect(c.port, opts.testHost || 'github.com')) {
      return { host: c.host, port: c.port, url: 'http://' + c.host + ':' + c.port, source: c.source };
    }
  }
  return null;
}

// 探测并同步到本仓库的 git 配置；返回 {changed, proxy, removed}
async function ensureGitProxy(repoRoot, opts) {
  opts = opts || {};
  const git = function (args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  };
  const current = function () {
    try { return git(['config', '--get', 'http.proxy']).trim(); } catch (e) { return ''; }
  };

  const proxy = await detectProxy(opts);
  const cur = current();
  if (proxy) {
    if (cur !== proxy.url) {
      git(['config', 'http.proxy', proxy.url]);
      git(['config', 'https.proxy', proxy.url]);
      return { changed: true, proxy: proxy, previous: cur || null };
    }
    return { changed: false, proxy: proxy, previous: null };
  }
  // 未探测到可用代理：清除可能过期的配置，让 git 直连（直连网络的电脑走这里）
  if (cur) {
    try { git(['config', '--unset', 'http.proxy']); } catch (e) {}
    try { git(['config', '--unset', 'https.proxy']); } catch (e) {}
    return { changed: true, proxy: null, removed: cur };
  }
  return { changed: false, proxy: null, removed: null };
}

module.exports = { detectProxy: detectProxy, ensureGitProxy: ensureGitProxy, testPort: testPort, testProxyConnect: testProxyConnect, COMMON_PORTS: COMMON_PORTS };
