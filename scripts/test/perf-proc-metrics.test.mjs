import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  WRAPPED_COMMANDS,
  countSpawns,
  cpuPct,
  installWrappers,
  parsePsSample,
  parsePsTime,
  parseSpawnLog,
  parseTopSamples,
  resolveReal,
  topArgs,
  topWakeups,
  wrapperScript,
} from '../perf/proc-metrics.mjs';

/**
 * 성능 이슈 4.4: scenario.mjs 의 서버·데몬 측정 (M4_DESIGN §6) — 외부 프로세스 감싸개, 깨어남(top), 유휴 CPU(ps time 차분).
 */

const ZSH = '/bin/zsh';

test('감싸개 대상은 설계 §6 의 다섯이다', () => {
  assert.deepEqual(WRAPPED_COMMANDS, ['ps', 'lsof', 'pgrep', 'git', 'rg']);
});

test('감싸개는 시각·PPID·이름·인자를 적고 진짜 실행 파일로 exec 한다', () => {
  const s = wrapperScript('ps', '/bin/ps', '/tmp/x y/spawn.log');
  assert.match(s, /^#!\/bin\/zsh -f\n/);
  assert.match(s, /zmodload zsh\/datetime/);
  assert.match(s, /print -r -- "\$EPOCHREALTIME \$PPID ps \$\*" >> '\/tmp\/x y\/spawn\.log'/);
  assert.match(s, /exec '\/bin\/ps' "\$@"\n$/);
});

test('경로의 작은따옴표는 셸 인용을 깨지 않는다', () => {
  const s = wrapperScript('git', "/o'k/git", "/l'og");
  assert.ok(s.includes("exec '/o'\\''k/git'"));
  assert.ok(s.includes(">> '/l'\\''og'"));
});

test('진짜 실행 파일은 감싸개 디렉터리를 건너뛰고 PATH 순서로 찾는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-real-'));
  const wrap = join(root, 'wrap');
  const a = join(root, 'a');
  const b = join(root, 'b');
  for (const d of [wrap, a, b]) execFileSync('mkdir', ['-p', d]);
  for (const d of [wrap, b]) execFileSync('sh', ['-c', `printf '#!/bin/sh\n' > "$1/tool" && chmod +x "$1/tool"`, 'sh', d]);
  execFileSync('sh', ['-c', `printf 'x' > "$1/tool"`, 'sh', a]); // 실행 권한 없음 → 건너뜀
  assert.equal(resolveReal('tool', [wrap, a, b].join(':'), wrap), join(b, 'tool'));
  assert.equal(resolveReal('none', [wrap, a, b].join(':'), wrap), null);
  assert.equal(resolveReal('tool', '', wrap), null);
  rmSync(root, { recursive: true, force: true });
});

test('설치한 감싸개를 거친 호출이 로그에 남고 진짜 결과를 낸다', { skip: !existsSync(ZSH) }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-wrap-'));
  const dir = join(root, 'wrap');
  const log = join(root, 'spawn.log');
  const real = installWrappers(dir, log, process.env.PATH || '');
  assert.equal(real.ps, resolveReal('ps', process.env.PATH || '', dir));
  for (const n of WRAPPED_COMMANDS) {
    if (!real[n]) continue;
    assert.ok(statSync(join(dir, n)).mode & 0o100, `${n} 감싸개는 실행 가능해야 한다`);
  }
  const before = Date.now() / 1000;
  const out = execFileSync(join(dir, 'ps'), ['-o', 'pid=', '-p', String(process.pid)], { encoding: 'utf8' });
  assert.equal(+out.trim(), process.pid);
  const [e] = parseSpawnLog(readFileSync(log, 'utf8'));
  assert.equal(e.ppid, process.pid);
  assert.equal(e.name, 'ps');
  assert.equal(e.args, `-o pid= -p ${process.pid}`);
  assert.ok(e.t >= before - 1 && e.t <= Date.now() / 1000 + 1);
  rmSync(root, { recursive: true, force: true });
});

test('PATH 에 없는 명령은 감싸개를 만들지 않고 null 로 알린다', { skip: !existsSync(ZSH) }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-miss-'));
  const real = installWrappers(join(root, 'wrap'), join(root, 'l'), '/nonexistent', ['ps']);
  assert.deepEqual(real, { ps: null });
  assert.equal(existsSync(join(root, 'wrap', 'ps')), false);
  rmSync(root, { recursive: true, force: true });
});

test('로그 줄을 시각·PPID·이름·인자로 읽고 깨진 줄은 버린다', () => {
  const text = [
    '1700000000.125 501 ps -o pid=,comm= -p 1,2',
    '',
    'garbage',
    '1700000001.5 77 git',
    'x 5 ps',
    '1700000002 abc ps',
  ].join('\n');
  assert.deepEqual(parseSpawnLog(text), [
    { t: 1700000000.125, ppid: 501, name: 'ps', args: '-o pid=,comm= -p 1,2' },
    { t: 1700000001.5, ppid: 77, name: 'git', args: '' },
  ]);
  assert.deepEqual(parseSpawnLog(''), []);
});

test('단계 구간 안에서 PPID 가 서버·데몬인 줄만 센다', () => {
  const e = (t, ppid, name) => ({ t, ppid, name, args: '' });
  const entries = [
    e(99.9, 10, 'ps'), // 구간 전
    e(100, 10, 'ps'), // 시작 경계 포함
    e(101, 20, 'lsof'),
    e(102, 20, 'ps'),
    e(103, 30, 'git'), // 서버·데몬이 아닌 부모(셸 등)
    e(104.5, 10, 'git'),
    e(110, 10, 'ps'), // 끝 경계 제외
  ];
  assert.deepEqual(countSpawns(entries, { server: 10, daemon: 20 }, 100, 110), {
    total: 4,
    server: 2,
    daemon: 2,
    byCmd: { 'server ps': 1, 'server git': 1, 'daemon lsof': 1, 'daemon ps': 1 },
  });
  assert.deepEqual(countSpawns([], { server: 10, daemon: 20 }, 0, 1), { total: 0, server: 0, daemon: 0, byCmd: {} });
});

test('ps time 은 분:초, 시:분:초, 일-시:분:초를 초로 읽는다', () => {
  assert.equal(parsePsTime('0:00.03'), 0.03);
  assert.equal(parsePsTime('12:03.25'), 723.25);
  assert.equal(parsePsTime('1:02:03.50'), 3723.5);
  assert.equal(parsePsTime('2-01:00:00'), 2 * 86400 + 3600);
  assert.ok(Number.isNaN(parsePsTime('')));
  assert.ok(Number.isNaN(parsePsTime('x:y')));
});

test('ps 표본을 pid 별 RSS(MB)·CPU 초로 읽는다', () => {
  const out = '  501  2048   0:01.50\n 7777 10240 1:00.00\n';
  assert.deepEqual(parsePsSample(out), { 501: { rssMB: 2, cpuS: 1.5 }, 7777: { rssMB: 10, cpuS: 60 } });
  assert.deepEqual(parsePsSample(''), {});
});

test('CPU 사용률은 CPU 초 차분 ÷ 벽시계 × 100 이다', () => {
  assert.ok(Math.abs(cpuPct(1.5, 1.56, 60) - 0.1) < 1e-9);
  assert.equal(cpuPct(1, 1, 60), 0);
  assert.equal(cpuPct(1, 2, 0), null);
});

test('top 인자는 표본 2개·간격·열(pid,cpu,idlew,csw)·대상 pid 다', () => {
  assert.deepEqual(topArgs([11, 22], 30), ['-l', '2', '-s', '30', '-stats', 'pid,cpu,idlew,csw', '-pid', '11', '-pid', '22']);
});

const TOP = `Processes: 879 total, 11 running
2026/11/25 17:39:17
Load Avg: 22.74, 12.32, 7.87

PID    %CPU IDLEW CSW
501    0.0  10    467
7777   1.2  3     1000
Processes: 883 total, 22 running
2026/11/25 17:39:47

PID    %CPU IDLEW CSW
7777   0.4  9+    1600+
501    0.1  10    497+
`;

test('top 로그 출력을 표본마다 pid 별 값으로 읽는다(+ 꼬리표는 떼어 낸다)', () => {
  const s = parseTopSamples(TOP);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0][501], { cpu: 0, idlew: 10, csw: 467 });
  assert.deepEqual(s[1][7777], { cpu: 0.4, idlew: 9, csw: 1600 });
  assert.deepEqual(parseTopSamples(''), []);
});

test('깨어남은 첫 표본과 끝 표본의 누적값 차분이다(IDLEW·CSW 는 누적 계수)', () => {
  assert.deepEqual(topWakeups(TOP, [501, 7777], 30), {
    501: { idlew: 0, csw: 30, idlewPerS: 0, cswPerS: 1 },
    7777: { idlew: 6, csw: 600, idlewPerS: 0.2, cswPerS: 20 },
  });
});

test('표본이 모자라거나 pid 가 빠지면 그 pid 는 null 이다', () => {
  assert.deepEqual(topWakeups(TOP, [999], 30), { 999: null });
  assert.deepEqual(topWakeups(TOP.split('Processes: 883')[0], [501], 30), { 501: null });
});
