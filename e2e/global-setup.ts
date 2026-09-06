import { execFileSync } from 'child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { basename } from 'path';

import { E2E_BIN, E2E_HOME, E2E_RUN_ENV } from '../playwright.config';
import { stopDaemon, stopDaemonsUnder } from './daemon-cleanup';
import { TMP, tmpPath } from './osenv';

// 이전 실행이 남긴 `<임시>/dongminal-e2e-*` 를 정리한다 (`TMP` 는 osenv 가 정한다).
//
// 이번 실행의 뿌리(E2E_HOME)는 건너뛴다 — 이름 접두사만 보고 지우면 우리 것까지
// 지운다. (종전에는 `webServer` 가 globalSetup 보다 먼저 떠서 이 실수가 곧바로
// "no such file or directory" 로 나타났다. 이제 서버는 워커가 띄우지만, 규약을
// 되돌릴 이유는 없다.)
function reapOldRuns() {
  const current = basename(E2E_HOME);
  let entries: string[] = [];
  try {
    entries = readdirSync(TMP);
  } catch {
    return; // 임시 디렉터리 읽기 불가 — 정리 생략
  }
  for (const entry of entries) {
    if (!entry.startsWith('dongminal-e2e-')) continue;
    if (entry === current) continue; // 이번 실행의 뿌리 — 보존
    const fullPath = tmpPath(entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    // 크래시로 남은 데몬의 PTY 회수. 옛 실행은 뿌리 자신이 홈이었고, 새 실행은
    // `w<i>` 가 홈이다 — 둘 다 본다.
    stopDaemon(fullPath);
    stopDaemonsUnder(fullPath);
    try {
      rmSync(fullPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // 지울 수 없는 항목은 건너뛴다
    }
  }
}

/**
 * 서버 바이너리를 **한 번** 만든다 (E2E_PARALLEL_SRS FR-EPL-8).
 *
 * 워커마다 `go run` 을 부르면 같은 컴파일을 N 번 기다린다 — 첫 테스트가 시작되기
 * 전에 N 번의 링크가 직렬로 돈다. 여기서 한 번 만들고 워커는 그것을 실행한다.
 */
function buildServer() {
  mkdirSync(E2E_HOME, { recursive: true });
  execFileSync('go', ['build', '-o', E2E_BIN, './cmd/dongminal'], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function globalSetup() {
  reapOldRuns();
  buildServer();
  // 워커에게 이 실행의 뿌리를 넘긴다. 설정 파일은 워커마다 다시 평가되므로
  // 이것이 없으면 워커가 저마다 다른 뿌리를 만든다 (FR-EPL-1).
  process.env[E2E_RUN_ENV] = E2E_HOME;
}

export default globalSetup;
