#!/usr/bin/env node
/**
 * 재현 시나리오 측정 (성능 기준선). 격리 인스턴스에 브라우저를 붙여 단계별로 잰다.
 *
 *   boot        첫 로드 — 걸린 시간, 힙, DOM, 요청 수(자원 종류별), 부팅 JS 바이트(풀린 크기·전송 크기),
 *               렌더러 메인 스레드의 16 ms 초과 작업(트레이스 RunTask). 구간은 이동부터 #boot 사라짐 + 2초
 *   idle        창·탭을 연 채 아무것도 하지 않는다
 *   load        에이전트 흉내(agent-sim.py)가 보이는 칸 V 개와 숨은 탭 A 개에서 출력한다
 *   contention  load + 기계에 CPU 부하(yes × 코어 수)
 *   remote      load + 브라우저 CPU 4배 감속 + 망 지연 150ms (약한 기기·원격)
 *   long        load 를 길게 돌리며 메모리 추이를 본다
 *
 * 단계마다: 메인 스레드 사용률(TaskDuration/벽시계), 긴 작업, JS 힙, DOM 노드, 이벤트 리스너,
 * 요청·WebSocket·SSE 메시지 수와 바이트, 입력 지연(키 → 화면에 그려짐), 서버·데몬 CPU·RSS.
 *
 * 사용: node scripts/perf/scenario.mjs --port <n> --home <격리 홈> [--windows 4] [--tabs 3]
 *        [--visible 2] [--hidden 6] [--rate 40] [--phase-s 30] [--long-min 10] [--only idle,load]
 *        [--out <json>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { bootNetCollector, longTasksFromTrace } from './boot-metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = arg('port');
const HOME = arg('home');
if (!PORT || !HOME) {
  console.error('--port 와 --home 이 필요하다');
  process.exit(2);
}
const CFG = {
  windows: +arg('windows', 4),
  tabs: +arg('tabs', 3),
  visible: +arg('visible', 2),
  hidden: +arg('hidden', 6),
  rate: +arg('rate', 40),
  phaseS: +arg('phase-s', 30),
  longMin: +arg('long-min', 10),
  probes: +arg('probes', 20),
  tui: process.argv.includes('--tui'),
};
const ONLY = arg('only', 'boot,idle,load,contention,remote,long').split(',');
const OUT = arg('out', '');
const URL = `http://127.0.0.1:${PORT}/`;
const SIM = join(HERE, 'agent-sim.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (...a) =>
  execFileSync(join(HOME, 'bin/otterctl'), a, {
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', OTTERMINAL_HOME: HOME, OTTERMINAL_PORT: PORT },
    encoding: 'utf8',
  });
const ctlJson = (...a) => JSON.parse(ctl(...a));

// ── 서버·데몬 ─────────────────────────────────────────────────────────────
function serverPids() {
  const srv = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0];
  const dmn = execFileSync('cat', [join(HOME, 'paned.pid')], { encoding: 'utf8' }).trim();
  return { server: +srv, daemon: +dmn };
}
function psOf(pids) {
  const out = execFileSync('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], { encoding: 'utf8' });
  const m = {};
  for (const l of out.trim().split('\n')) {
    const [pid, rss, time] = l.trim().split(/\s+/);
    const [mm, ss] = time.split(':');
    m[+pid] = { rssMB: +rss / 1024, cpuS: +mm * 60 + parseFloat(ss) };
  }
  return m;
}
function childPids(ppids) {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  const s = new Set();
  for (const l of out.trim().split('\n')) {
    const [pid, ppid] = l.trim().split(/\s+/).map(Number);
    if (ppids.includes(ppid)) s.add(pid);
  }
  return s;
}

// ── 브라우저 ──────────────────────────────────────────────────────────────
// 기본 헤드리스는 소프트웨어 WebGL(SwiftShader)이라 그리기 비용이 부풀려진다. 새 헤드리스는 GPU 를 쓴다.
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
await cdp.send('Network.enable');
const net = { requests: 0, wsFrames: 0, wsBytes: 0, sse: 0, sseBytes: 0, byPath: {} };
cdp.on('Network.requestWillBeSent', (e) => {
  net.requests++;
  const u = new globalThis.URL(e.request.url);
  const k = e.request.method + ' ' + u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|\d{3,}/g, ':id');
  net.byPath[k] = (net.byPath[k] || 0) + 1;
});
const bootNet = bootNetCollector();
cdp.on('Network.requestWillBeSent', (e) => bootNet.request(e));
cdp.on('Network.responseReceived', (e) => bootNet.response(e));
cdp.on('Network.dataReceived', (e) => bootNet.data(e));
cdp.on('Network.loadingFinished', (e) => bootNet.finished(e));
cdp.on('Network.webSocketFrameReceived', (e) => {
  net.wsFrames++;
  net.wsBytes += (e.response.payloadData || '').length;
});
cdp.on('Network.eventSourceMessageReceived', (e) => {
  net.sse++;
  net.sseBytes += (e.data || '').length;
});
const metrics = async () => {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
};

const result = { config: CFG, phases: {} };

// boot
await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
const t0 = Date.now();
await page.goto(URL);
await page.waitForSelector('#boot', { state: 'detached', timeout: 60000 });
await page.waitForFunction(() => !!(window.app && window.app.testing && window.app.testing.focusedTerminal()));
const bootMs = Date.now() - t0;
await sleep(2000);
{
  const boot = bootNet.summary();
  const long = longTasksFromTrace(JSON.parse((await browser.stopTracing()).toString()).traceEvents);
  const m = await metrics();
  const scripts = await page.evaluate(() => document.scripts.length);
  result.phases.boot = {
    bootMs,
    scripts,
    requests: net.requests,
    requestsByType: boot.byType,
    jsFiles: boot.jsFiles,
    jsBytes: boot.jsBytes,
    jsEncodedBytes: boot.jsEncodedBytes,
    longTasks16: long.count,
    longTask16MsMax: long.maxMs,
    longTask16Ms: long.tasksMs,
    jsHeapMB: m.JSHeapUsedSize / 2 ** 20,
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    scriptS: m.ScriptDuration,
    taskS: m.TaskDuration,
  };
  console.log('── boot', JSON.stringify(result.phases.boot, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
}

// in-page 계측: 긴 작업과 입력 지연
await page.evaluate(() => {
  window.__perf = { long: [] };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) window.__perf.long.push(e.duration);
  }).observe({ type: 'longtask', buffered: false });
  // 한 번 재기: 줄이 비어 있는 상태(프롬프트 뒤)에서 ch 를 치고, 그 글자가 커서 줄 끝에 그려진 프레임까지.
  window.__perf.arm = (ch, capMs) => {
    const term = window.app.testing.focusedTerminal().term;
    const line = () => {
      const b = term.buffer.active;
      const l = b.getLine(b.baseY + b.cursorY);
      return l ? l.translateToString(true) : '';
    };
    const before = line();
    let t0 = 0;
    const onKey = (e) => { if (e.key === ch) t0 = performance.now(); };
    document.addEventListener('keydown', onKey, true);
    return new Promise((res) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        sub.dispose();
        clearTimeout(cap);
        document.removeEventListener('keydown', onKey, true);
        res(v);
      };
      const sub = term.onWriteParsed(() => {
        const now = line();
        if (t0 && now !== before && now.endsWith(ch)) requestAnimationFrame(() => finish(performance.now() - t0));
      });
      const cap = setTimeout(() => finish(capMs), capMs);
    });
  };
});

// 창·탭 만들기
const probeTab = ctlJson('list-workspace', '--json')[0];
const visibleTabs = [];
for (let i = 0; i < CFG.visible; i++) {
  ctl('focus', probeTab.uuid);
  ctl('split-h');
  await sleep(600);
}
let ws = ctlJson('list-workspace', '--json');
for (const t of ws) if (t.windowUuid === probeTab.windowUuid && t.uuid !== probeTab.uuid) visibleTabs.push(t.uuid);
const hiddenTabs = [];
for (let w = 1; w < CFG.windows; w++) {
  const nw = ctlJson('new-window', '-n', '--name', 'perf-w' + w);
  const first = nw.newTabs[0].uuid;
  hiddenTabs.push(first);
  for (let t = 1; t < CFG.tabs; t++) {
    const nt = ctlJson('new-tab', '-n', '--at', first);
    hiddenTabs.push(nt.newTabs[0].uuid);
  }
}
ctl('focus', probeTab.uuid);
await sleep(1500);
await page.locator('#area .pn.focused .xterm-screen').click();
ws = ctlJson('list-workspace', '--json');
result.layout = { tabs: ws.length, visibleAgents: Math.min(CFG.visible, visibleTabs.length), hiddenAgents: Math.min(CFG.hidden, hiddenTabs.length) };

const pids = serverPids();
async function measure(name, seconds, opts = {}) {
  const startM = await metrics();
  const startNet = { ...net, byPath: { ...net.byPath } };
  const startPs = psOf([pids.server, pids.daemon]);
  const kids = new Set();
  await page.evaluate(() => { window.__perf.long = []; });
  const t = Date.now();
  const lat = [];
  const probeEvery = (seconds * 1000) / (CFG.probes + 1);
  let nextProbe = t + probeEvery;
  while (Date.now() - t < seconds * 1000) {
    for (const k of childPids([pids.server])) kids.add(k);
    if (Date.now() >= nextProbe && lat.length < CFG.probes) {
      nextProbe += probeEvery;
      const ch = String.fromCharCode(97 + (lat.length % 26));
      await page.keyboard.press('Control+U');
      await sleep(150);
      const pr = page.evaluate(([c, cap]) => window.__perf.arm(c, cap), [ch, 5000]);
      await sleep(20);
      await page.keyboard.type(ch);
      lat.push(await pr);
    }
    await sleep(200);
  }
  const wall = (Date.now() - t) / 1000;
  const endM = await metrics();
  const endPs = psOf([pids.server, pids.daemon]);
  const long = await page.evaluate(() => window.__perf.long.slice());
  await page.keyboard.press('Control+U');
  const sorted = lat.slice().sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
  const r = {
    seconds: wall,
    mainThreadBusyPct: (100 * (endM.TaskDuration - startM.TaskDuration)) / wall,
    scriptPct: (100 * (endM.ScriptDuration - startM.ScriptDuration)) / wall,
    layoutPct: (100 * (endM.LayoutDuration - startM.LayoutDuration + endM.RecalcStyleDuration - startM.RecalcStyleDuration)) / wall,
    longTasks: long.length,
    longTaskMsTotal: long.reduce((a, b) => a + b, 0),
    longTaskMsMax: long.length ? Math.max(...long) : 0,
    jsHeapMB: endM.JSHeapUsedSize / 2 ** 20,
    nodes: endM.Nodes,
    listeners: endM.JSEventListeners,
    requestsPerMin: ((net.requests - startNet.requests) * 60) / wall,
    wsFramesPerS: (net.wsFrames - startNet.wsFrames) / wall,
    wsKBps: (net.wsBytes - startNet.wsBytes) / 1024 / wall,
    ssePerMin: ((net.sse - startNet.sse) * 60) / wall,
    inputP50: pct(50),
    inputP95: pct(95),
    inputMax: sorted.length ? sorted[sorted.length - 1] : null,
    inputTimeouts: lat.filter((x) => x >= 5000).length,
    serverCpuPct: (100 * (endPs[pids.server].cpuS - startPs[pids.server].cpuS)) / wall,
    daemonCpuPct: (100 * (endPs[pids.daemon].cpuS - startPs[pids.daemon].cpuS)) / wall,
    serverRssMB: endPs[pids.server].rssMB,
    daemonRssMB: endPs[pids.daemon].rssMB,
    serverChildrenSpawned: kids.size,
    topRequestsPerMin: Object.entries(net.byPath)
      .map(([k, v]) => [k, ((v - (startNet.byPath[k] || 0)) * 60) / wall])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  };
  result.phases[name] = { ...r, ...opts };
  console.log(`── ${name}`, JSON.stringify(r, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
  return r;
}

const agents = [...visibleTabs.slice(0, CFG.visible), ...hiddenTabs.slice(0, CFG.hidden)];
const startAgents = () => {
  for (const u of agents) ctl('send-input', '--at', u, '--execute', `python3 ${SIM} ${CFG.rate} 5${CFG.tui ? ' tui' : ''}`);
};
const stopAgents = () => {
  for (const u of agents) ctl('send-input', '--at', u, '\u0003');
};

if (ONLY.includes('idle')) await measure('idle', CFG.phaseS);
startAgents();
await sleep(3000);
if (ONLY.includes('load')) await measure('load', CFG.phaseS);
if (ONLY.includes('contention')) {
  const hogs = cpus().map(() => spawn('yes', { stdio: 'ignore' }));
  await sleep(1000);
  await measure('contention', CFG.phaseS, { hogs: hogs.length });
  for (const h of hogs) h.kill();
  await sleep(2000);
}
if (ONLY.includes('remote')) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.5e6 / 8 * 8, uploadThroughput: 750e3 / 8 * 8 });
  await measure('remote', CFG.phaseS, { cpuThrottle: 4, latencyMs: 150 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}
if (ONLY.includes('long')) {
  const series = [];
  const end = Date.now() + CFG.longMin * 60000;
  while (Date.now() < end) {
    await sleep(30000);
    const m = await metrics();
    const ps = psOf([pids.server, pids.daemon]);
    series.push({
      min: (CFG.longMin * 60000 - (end - Date.now())) / 60000,
      jsHeapMB: m.JSHeapUsedSize / 2 ** 20,
      nodes: m.Nodes,
      listeners: m.JSEventListeners,
      serverRssMB: ps[pids.server].rssMB,
      daemonRssMB: ps[pids.daemon].rssMB,
    });
    console.log('   long', JSON.stringify(series[series.length - 1], (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
  }
  result.phases.long = { series };
  await measure('after-long', CFG.phaseS);
}
stopAgents();
await sleep(2000);
if (ONLY.includes('idle')) await measure('idle-after', CFG.phaseS);

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
await browser.close();
