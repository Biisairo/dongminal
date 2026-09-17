import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * `scripts/daemon-fingerprint.sh` 의 정의역 — `DAEMON_STALENESS_SRS` FR-DFP-2.
 *
 * 이 스크립트가 하는 일의 전부가 **무엇을 세는가**이고, 그 범위가 새면 판정이
 * 통째로 쓸모를 잃는다:
 *
 *   · 웹서버로 새면 — 거의 모든 빌드가 불일치로 읽힌다. 그때 이 기능은 "늘
 *     `--restart-daemon`" 과 같아지고, 매번 터미널 세션을 잃는다.
 *   · 데몬을 빠뜨리면 — 낡은 데몬이 "일치" 로 읽힌다. 고친 줄 알았던 버그를
 *     다시 보는 것이 바로 그 상태다.
 *
 * 그래서 두 방향을 모두 못박는다.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/daemon-fingerprint.sh');

const run = (...args) =>
  execFileSync(script, args, { cwd: root, encoding: 'utf8' }).trim();

const files = (...args) => run('--files', ...args).split('\n').filter(Boolean);

test('FR-DFP-2: 정의역은 데몬이 실행하는 것이다', () => {
  const list = files();
  assert.ok(list.includes('internal/daemon/boot/boot.go'), '데몬 진입점이 빠졌다');
  assert.ok(list.some((f) => f.startsWith('internal/daemon/ipc/')), '데몬 IPC 가 빠졌다');
  assert.ok(list.some((f) => f.startsWith('internal/shared/toolhub/')), 'PTY 소유자가 빠졌다');
});

test('FR-DFP-2: 웹서버와 제어 명령은 세지 않는다', () => {
  const leaked = files().filter(
    (f) => f.startsWith('internal/webserver/') || f.startsWith('internal/ctl/') || f.startsWith('web/'),
  );
  assert.deepEqual(leaked, [], '데몬 프로세스에 없는 코드가 지문에 들어왔다');
});

test('D-2: cmd/dongminal 은 정의역 밖이다', () => {
  const leaked = files().filter((f) => f.startsWith('cmd/'));
  assert.deepEqual(leaked, [], 'main 은 웹서버 코드 전부를 의존한다 — 넣으면 늘 불일치가 된다');
});

test('FR-DFP-2: go:embed 자산도 센다', () => {
  // shared/runtime 이 헬퍼와 에이전트 플러그인을 담는다. 자산만 바뀐 빌드도
  // 데몬이 **설치하는 것**을 바꾸므로, 소스만 세면 그 변경을 놓친다.
  const embedded = files().filter((f) => !f.endsWith('.go'));
  assert.ok(embedded.length > 0, 'embed 자산이 하나도 세이지 않았다');
});

test('FR-DFP-2: 같은 소스는 같은 지문이다', () => {
  // 경로·시각·빌드 환경이 섞이면 같은 소스가 기계마다 다른 값을 내고, 그러면
  // 릴리스 산출물의 재현성이 깨진다 (build.sh 의 REPRO_FLAGS 와 같은 근거).
  assert.equal(run(), run());
});

test('FR-DFP-2: 지문은 12자 hex 다', () => {
  assert.match(run(), /^[0-9a-f]{12}$/);
});

test('FR-DFP-2: 대상이 다르면 지문도 다르다', () => {
  // platform 이 OS 마다 다른 파일을 갖는다. 호스트 기준으로 한 번만 세면
  // 크로스 산출물의 지문이 그 바이너리의 내용과 무관해진다.
  const darwin = run('--os', 'darwin', '--arch', 'arm64');
  const windows = run('--os', 'windows', '--arch', 'amd64');
  assert.notEqual(darwin, windows);
});
