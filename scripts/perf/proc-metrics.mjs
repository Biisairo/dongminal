/**
 * scenario.mjs 의 서버·데몬 측정 (M4_DESIGN §6, PERF 4.4).
 *
 *   외부 프로세스  격리 인스턴스 PATH 앞에 감싸개(ps·lsof·pgrep·git·rg)를 둔다. 감싸개는 '시각 PPID 이름 인자' 를
 *                  한 줄 적고 진짜 실행 파일로 exec 한다. 단계 구간 안에서 PPID 가 서버·데몬인 줄을 센다 —
 *                  루프 표본으로는 놓치는 짧은 프로세스와 데몬 자식까지 잡는다.
 *   깨어남         `top -l 2 -s <간격> -stats pid,cpu,idlew,csw`. 기본 모드(-c n)의 IDLEW·CSW 는 프로세스가 생긴 뒤의
 *                  누적 계수다(두 표본이 같거나 커지고, 늘면 `+` 꼬리표). 그래서 두 표본의 차분이 간격 동안의 수다.
 *                  IDLEW 는 코어를 유휴에서 깨운 횟수라 기계가 바쁘면(유휴 0%) 0 에 가깝다. CSW(문맥 전환)는 기계 부하와
 *                  무관하게 깨어날 때마다 는다.
 *   유휴 CPU       `ps -o time=` 의 CPU 초 차분 ÷ 벽시계.
 */
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WRAPPED_COMMANDS = ['ps', 'lsof', 'pgrep', 'git', 'rg'];
export const TOP_STATS = ['pid', 'cpu', 'idlew', 'csw'];
const TOP_SAMPLES = 2;
const EXEC_BITS = 0o111;
const WRAPPER_MODE = 0o755;
const KB_PER_MB = 1024;
const SEC_PER_MIN = 60;
const SEC_PER_HOUR = 3600;
const SEC_PER_DAY = 86400;

const shq = (s) => `'${s.replaceAll("'", "'\\''")}'`;

/** PATH 순서로 실행 가능한 `name` 을 찾되 `skipDir`(감싸개 자리)은 건너뛴다. 없으면 null. */
export function resolveReal(name, pathEnv, skipDir) {
  for (const dir of pathEnv.split(':')) {
    if (!dir || dir === skipDir) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile() && st.mode & EXEC_BITS) return p;
  }
  return null;
}

/** 시각(EPOCHREALTIME, 초)·PPID·이름·인자를 한 줄 적고 진짜 실행 파일로 exec 하는 zsh 감싸개. */
export function wrapperScript(name, real, log) {
  return [
    '#!/bin/zsh -f',
    'zmodload zsh/datetime',
    `print -r -- "$EPOCHREALTIME $PPID ${name} $*" >> ${shq(log)}`,
    `exec ${shq(real)} "$@"`,
    '',
  ].join('\n');
}

/** `dir` 에 감싸개를 만든다. 이름 → 진짜 경로(PATH 에 없으면 null, 감싸개도 만들지 않는다). */
export function installWrappers(dir, log, pathEnv, names = WRAPPED_COMMANDS) {
  mkdirSync(dir, { recursive: true });
  const real = {};
  for (const n of names) {
    real[n] = resolveReal(n, pathEnv, dir);
    if (!real[n]) continue;
    const p = join(dir, n);
    writeFileSync(p, wrapperScript(n, real[n], log));
    chmodSync(p, WRAPPER_MODE);
  }
  return real;
}

/** 감싸개 로그 → [{t, ppid, name, args}]. 형식이 맞지 않는 줄은 버린다. */
export function parseSpawnLog(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+(?:\.\d+)?) (\d+) (\S+)(?: (.*))?$/.exec(line);
    if (m) out.push({ t: +m[1], ppid: +m[2], name: m[3], args: m[4] ?? '' });
  }
  return out;
}

/** 구간 [fromS, toS) 에서 PPID 가 서버·데몬인 호출 수. byCmd 키는 '<server|daemon> <이름>'. */
export function countSpawns(entries, parents, fromS, toS) {
  const r = { total: 0, server: 0, daemon: 0, byCmd: {} };
  for (const e of entries) {
    if (e.t < fromS || e.t >= toS) continue;
    const who = e.ppid === parents.server ? 'server' : e.ppid === parents.daemon ? 'daemon' : '';
    if (!who) continue;
    r.total++;
    r[who]++;
    const k = `${who} ${e.name}`;
    r.byCmd[k] = (r.byCmd[k] || 0) + 1;
  }
  return r;
}

/** `ps -o time=` 값([일-][시:]분:초) → 초. 읽지 못하면 NaN. */
export function parsePsTime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return NaN;
  const [, d = '0', h = '0', mm, ss] = m;
  return +d * SEC_PER_DAY + +h * SEC_PER_HOUR + +mm * SEC_PER_MIN + parseFloat(ss);
}

/** `ps -o pid=,rss=,time=` 출력 → {pid: {rssMB, cpuS}}. */
export function parsePsSample(out) {
  const m = {};
  for (const l of out.trim().split('\n')) {
    const [pid, rss, time] = l.trim().split(/\s+/);
    if (!pid || !time) continue;
    m[+pid] = { rssMB: +rss / KB_PER_MB, cpuS: parsePsTime(time) };
  }
  return m;
}

/** CPU 초 차분 ÷ 벽시계 × 100. 벽시계가 0 이하면 null. */
export function cpuPct(startS, endS, wallS) {
  return wallS > 0 ? (100 * (endS - startS)) / wallS : null;
}

export function topArgs(pids, intervalS) {
  return ['-l', String(TOP_SAMPLES), '-s', String(intervalS), '-stats', TOP_STATS.join(','), ...pids.flatMap((p) => ['-pid', String(p)])];
}

/** top 로그 모드 출력 → 표본마다 {pid: {cpu, idlew, csw}}. 값 끝의 +·- 꼬리표는 뗀다. */
export function parseTopSamples(out) {
  const samples = [];
  let cols = null;
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[0] === 'PID') {
      cols = f.map((c) => c.replace('%', '').toLowerCase());
      samples.push({});
      continue;
    }
    if (!cols || !/^\d+$/.test(f[0])) {
      cols = null;
      continue;
    }
    const row = {};
    cols.forEach((c, i) => {
      if (c !== 'pid') row[c] = parseFloat(f[i]);
    });
    samples[samples.length - 1][+f[0]] = row;
  }
  return samples;
}

/** 첫 표본과 끝 표본의 IDLEW·CSW 차분과 초당 값. 표본이 둘 미만이거나 pid 가 빠지면 null. */
export function topWakeups(out, pids, seconds) {
  const s = parseTopSamples(out);
  const r = {};
  for (const pid of pids) {
    const a = s[0]?.[pid];
    const b = s.length > 1 ? s[s.length - 1][pid] : undefined;
    if (!a || !b) {
      r[pid] = null;
      continue;
    }
    const idlew = b.idlew - a.idlew;
    const csw = b.csw - a.csw;
    r[pid] = { idlew, csw, idlewPerS: idlew / seconds, cswPerS: csw / seconds };
  }
  return r;
}
