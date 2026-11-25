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
 *   idle-git    Git 패널(Changes)과 편집기(파일 하나)를 보이게 두고 아무것도 하지 않는다(입력 재기 없음)
 *   idle-closed 페이지를 닫고 기다린다(서버·데몬 지표만)
 *
 * 단계마다: 메인 스레드 사용률(TaskDuration/벽시계), 긴 작업, JS 힙, DOM 노드, 이벤트 리스너,
 * 요청·WebSocket·SSE 메시지 수와 바이트, 입력 지연(키 → 화면에 그려짐), 서버·데몬 CPU·RSS,
 * 서버·데몬 깨어남(top IDLEW·CSW 차분), 서버·데몬이 띄운 외부 프로세스(감싸개 로그, --bin 일 때만).
 * 측정 방법은 proc-metrics.mjs 머리 주석.
 *
 * 사용: node scripts/perf/scenario.mjs --port <n> (--bin <otterminal> | --home <격리 홈>) [--windows 4] [--tabs 3]
 *        [--visible 2] [--hidden 6] [--rate 40] [--phase-s 30] [--idle-s 60] [--long-min 10] [--only idle,load]
 *        [--out <json>]
 *   --bin   그 바이너리로 새 격리 인스턴스를 띄우고(PATH 앞에 감싸개) 끝나면 내린다. 외부 프로세스 수는 이때만 잰다.
 *   --home  이미 떠 있는 인스턴스에 붙는다(감싸개 없음 — spawns 는 null).
 *   --idle-fg <명령>  유휴 단계(idle·idle-after·idle-git·idle-closed) 동안 에이전트 탭의 전경에서 그 명령을 돌린다
 *           (예: 'sleep 86400' — 입력을 기다리는 에이전트 흉내). 데몬의 전경 이름 조회는 전경이 셸이 아닐 때만 ps 를 띄운다.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from '@playwright/test';

import { bootNetCollector, longTasksFromTrace } from './boot-metrics.mjs';
import { countSpawns, cpuPct, installWrappers, parsePsSample, parseSpawnLog, topArgs, topWakeups } from './proc-metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = arg('port');
const BIN = arg('bin', '');
let HOME = arg('home', '');
if (!PORT || (!BIN && !HOME)) {
  console.error('--port 와, --bin 또는 --home 중 하나가 필요하다');
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
  idleS: +arg('idle-s', 60),
  probes: +arg('probes', 20),
  tui: process.argv.includes('--tui'),
};
const ONLY = arg('only', 'boot,idle,load,contention,remote,long,idle-git,idle-closed').split(',');
const LOAD_PHASES = ['load', 'contention', 'remote', 'long'];
const OUT = arg('out', '');
const IDLE_FG = arg('idle-fg', '');
const URL = `http://127.0.0.1:${PORT}/`;
const SIM = join(HERE, 'agent-sim.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 설계 §6 의 깨어남 표본 간격(top -s). 단계가 이보다 짧으면 단계 길이로 줄인다.
const TOP_INTERVAL_S = 30;
const LOOP_MS = 200;
const UI_WAIT_MS = 30000;
// 화면 전환(Git 창 열기·페이지 닫기) 뒤 측정 전에 기다리는 시간 — 전환이 일으킨 일회성 일을 구간 밖에 둔다.
const SETTLE_MS = 3000;
const ISOLATED_HOME_RE = /격리 홈: (\S+)/;
const STRIPPED_ENV = /^OTTERMINAL_|^PORT$/;
// ── 격리 인스턴스(--bin) ─────────────────────────────────────────────────
// 감싸개는 서버가 뜨기 전에 PATH 앞에 있어야 서버·데몬이 물려받는다. 감싸개 로그의 PPID 로 누가 띄웠는지 가린다.
let SPAWN_LOG = '';
if (BIN) {
  const run = mkdtempSync(join(tmpdir(), 'otter-perf-'));
  const wrapDir = join(run, 'wrap');
  SPAWN_LOG = join(run, 'spawn.log');
  writeFileSync(SPAWN_LOG, '');
  const wrapped = installWrappers(wrapDir, SPAWN_LOG, process.env.PATH || '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIPPED_ENV.test(k)));
  env.PATH = `${wrapDir}:${process.env.PATH || ''}`;
  const out = execFileSync(BIN, ['start', '--isolated', '--port', PORT], { env, encoding: 'utf8' });
  HOME = ISOLATED_HOME_RE.exec(out)?.[1] || '';
  if (!HOME) {
    console.error('격리 홈을 읽지 못했다:\n' + out);
    process.exit(1);
  }
  console.log('── isolated', JSON.stringify({ port: PORT, home: HOME, wrapped }));
  process.on('exit', () => {
    execFileSync(BIN, ['stop', '--all', '--port', PORT, '--home', HOME], { env: { ...env, OTTERMINAL_HOME: HOME }, stdio: 'ignore' });
    rmSync(run, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
  });
}

const ctl = (...a) =>
  execFileSync(join(HOME, 'bin/otterctl'), a, {
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', OTTERMINAL_HOME: HOME, OTTERMINAL_PORT: PORT },
    encoding: 'utf8',
  });
const ctlJson = (...a) => JSON.parse(ctl(...a));
// new-window·new-tab 의 답(newTabs)은 브라우저의 echo 다. 서버가 그 uuid 를 아는 것은 브라우저의 워크스페이스 PUT 뒤라서
// (`layout-controller.js` `_mkWindow` 는 저장을 기다리지 않는다) 곧바로 `--at <uuid>` 로 쓰면 400 이 날 수 있다.
const WS_KNOWN_POLL_MS = 100;
const WS_KNOWN_TRIES = 50;
async function waitKnownTab(uuid) {
  for (let i = 0; i < WS_KNOWN_TRIES; i++) {
    if (ctlJson('list-workspace', '--json').some((t) => t.uuid === uuid)) return;
    await sleep(WS_KNOWN_POLL_MS);
  }
  throw new Error(`list-workspace 에 탭 ${uuid} 가 ${WS_KNOWN_TRIES * WS_KNOWN_POLL_MS} ms 안에 나타나지 않았다`);
}

// ── 서버·데몬 ─────────────────────────────────────────────────────────────
function serverPids() {
  const srv = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0];
  const dmn = execFileSync('cat', [join(HOME, 'paned.pid')], { encoding: 'utf8' }).trim();
  return { server: +srv, daemon: +dmn };
}
function psOf(pids) {
  return parsePsSample(execFileSync('ps', ['-o', 'pid=,rss=,time=', '-p', pids.join(',')], { encoding: 'utf8' }));
}
const execFileP = promisify(execFile);
// 단계 시작에 띄워 끝에 거둔다. top 의 첫 표본은 곧바로, 둘째는 간격 뒤다.
function topRun(pids, seconds) {
  const interval = Math.max(1, Math.min(TOP_INTERVAL_S, Math.floor(seconds)));
  return execFileP('top', topArgs(pids, interval), { encoding: 'utf8' }).then(({ stdout }) => topWakeups(stdout, pids, interval));
}
function spawnsIn(pids, fromMs, toMs) {
  if (!SPAWN_LOG) return null;
  return countSpawns(parseSpawnLog(readFileSync(SPAWN_LOG, 'utf8')), pids, fromMs / 1000, toMs / 1000);
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
  await waitKnownTab(first);
  hiddenTabs.push(first);
  for (let t = 1; t < CFG.tabs; t++) {
    const nt = ctlJson('new-tab', '-n', '--at', first);
    await waitKnownTab(nt.newTabs[0].uuid);
    hiddenTabs.push(nt.newTabs[0].uuid);
  }
}
ctl('focus', probeTab.uuid);
await sleep(1500);
await page.locator('#area .pn.focused .xterm-screen').click();
ws = ctlJson('list-workspace', '--json');
result.layout = { tabs: ws.length, visibleAgents: Math.min(CFG.visible, visibleTabs.length), hiddenAgents: Math.min(CFG.hidden, hiddenTabs.length) };

const pids = serverPids();
// how.page: 페이지 지표를 잰다(닫힌 뒤에는 거짓). how.probes: 입력 지연을 잰다(키 입력은 PTY 입출력을 일으킨다).
async function measure(name, seconds, opts = {}, how = { page: true, probes: true }) {
  const startM = how.page ? await metrics() : null;
  const startNet = { ...net, byPath: { ...net.byPath } };
  const startPs = psOf([pids.server, pids.daemon]);
  if (how.page) await page.evaluate(() => { window.__perf.long = []; });
  const t = Date.now();
  const wake = topRun([pids.server, pids.daemon], seconds);
  const lat = [];
  const probeEvery = (seconds * 1000) / (CFG.probes + 1);
  let nextProbe = t + probeEvery;
  while (Date.now() - t < seconds * 1000) {
    if (how.probes && Date.now() >= nextProbe && lat.length < CFG.probes) {
      nextProbe += probeEvery;
      const ch = String.fromCharCode(97 + (lat.length % 26));
      await page.keyboard.press('Control+U');
      await sleep(150);
      const pr = page.evaluate(([c, cap]) => window.__perf.arm(c, cap), [ch, 5000]);
      await sleep(20);
      await page.keyboard.type(ch);
      lat.push(await pr);
    }
    await sleep(LOOP_MS);
  }
  const tEnd = Date.now();
  const wall = (tEnd - t) / 1000;
  const endPs = psOf([pids.server, pids.daemon]);
  const wakeups = await wake;
  const r = { seconds: wall };
  if (how.page) {
    const endM = await metrics();
    const long = await page.evaluate(() => window.__perf.long.slice());
    if (how.probes) await page.keyboard.press('Control+U');
    const sorted = lat.slice().sort((a, b) => a - b);
    const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
    Object.assign(r, {
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
    });
  }
  Object.assign(r, {
    serverCpuPct: cpuPct(startPs[pids.server].cpuS, endPs[pids.server].cpuS, wall),
    daemonCpuPct: cpuPct(startPs[pids.daemon].cpuS, endPs[pids.daemon].cpuS, wall),
    serverRssMB: endPs[pids.server].rssMB,
    daemonRssMB: endPs[pids.daemon].rssMB,
    serverWakeups: wakeups[pids.server],
    daemonWakeups: wakeups[pids.daemon],
    spawns: spawnsIn(pids, t, tEnd),
  });
  if (how.page) {
    r.topRequestsPerMin = Object.entries(net.byPath)
      .map(([k, v]) => [k, ((v - (startNet.byPath[k] || 0)) * 60) / wall])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }
  result.phases[name] = { ...r, ...opts };
  console.log(`── ${name}`, JSON.stringify(r, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
  return r;
}

// idle-git: 작은 저장소를 만들어 그 Repo 창(Git 사이드 Changes)과 편집기 탭을 띄운다.
// 저장소를 만드는 git 은 이 스크립트의 자식이라 서버·데몬 호출로 세지 않는다.
async function openGitAndEditor() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'otter-perf-git-')));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=perf', '-c', 'user.email=perf@localhost', ...a]);
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), 'perf\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  await page.evaluate((r) => window.app.git.openGitWindow(r), repo);
  await page.waitForSelector('#area .ed-win .ed-side', { timeout: UI_WAIT_MS });
  await page.evaluate(() => window.app.testing.edSetSide(window.app.testing.aw(), 'changes'));
  await page.waitForSelector('#area .ed-side .git-view.git-changes', { state: 'visible', timeout: UI_WAIT_MS });
  await page.evaluate(() => window.app.testing.loadScreen('remote'));
  await page.evaluate((p) => window.app.testing.execRemote('openEditorTab', { filePath: p }), join(repo, 'README.md'));
  await page.waitForSelector('#area .ed-win .cm-editor', { state: 'visible', timeout: UI_WAIT_MS });
  return repo;
}

const agents = [...visibleTabs.slice(0, CFG.visible), ...hiddenTabs.slice(0, CFG.hidden)];
const startAgents = () => {
  for (const u of agents) ctl('send-input', '--at', u, '--execute', `python3 ${SIM} ${CFG.rate} 5${CFG.tui ? ' tui' : ''}`);
};
const stopAgents = () => {
  for (const u of agents) ctl('send-input', '--at', u, '\u0003');
};
const startIdleFg = async () => {
  if (!IDLE_FG) return;
  for (const u of agents) ctl('send-input', '--at', u, '--execute', IDLE_FG);
  await sleep(SETTLE_MS);
};

const loadRun = LOAD_PHASES.some((p) => ONLY.includes(p));
await startIdleFg();
if (ONLY.includes('idle')) await measure('idle', CFG.phaseS, { idleFg: IDLE_FG });
if (loadRun) {
  if (IDLE_FG) stopAgents();
  startAgents();
  await sleep(3000);
}
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
if (loadRun) {
  stopAgents();
  await sleep(2000);
  await startIdleFg();
  if (ONLY.includes('idle')) await measure('idle-after', CFG.phaseS, { idleFg: IDLE_FG });
}
if (ONLY.includes('idle-git')) {
  const repo = await openGitAndEditor();
  process.on('exit', () => rmSync(repo, { recursive: true, force: true }));
  await sleep(SETTLE_MS);
  await measure('idle-git', CFG.idleS, { repo, idleFg: IDLE_FG }, { page: true, probes: false });
}
if (ONLY.includes('idle-closed')) {
  await page.close();
  await sleep(SETTLE_MS);
  await measure('idle-closed', CFG.idleS, { idleFg: IDLE_FG }, { page: false, probes: false });
}

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
await browser.close();
