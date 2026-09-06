import { readdirSync, rmSync, statSync } from 'fs';

import { stopDaemon, stopDaemonsUnder } from './daemon-cleanup';
import { TMP, tmpPath } from './osenv';

// 임시 홈을 지우기 전에 데몬을 먼저 종료한다. 순서가 뒤바뀌면 paned.pid 가
// 사라져 데몬을 찾을 수 없고, 그 데몬이 셸 PTY 를 계속 점유한다.
//
// 실행마다 인스턴스가 여럿이므로(E2E_PARALLEL_SRS FR-EPL-1) 뿌리와 그 아래
// 워커 홈을 둘 다 본다 — 워커 픽스처가 이미 세웠더라도 한 번 더 두드리는 값이
// 남은 데몬 하나보다 싸다 (V-EPL-4).
async function globalTeardown() {
  let entries: string[] = [];
  try {
    entries = readdirSync(TMP);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('dongminal-e2e-')) continue;
    const fullPath = tmpPath(entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    stopDaemon(fullPath);
    stopDaemonsUnder(fullPath);
    try {
      rmSync(fullPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // 지울 수 없는 항목은 건너뛴다
    }
  }
}

export default globalTeardown;
