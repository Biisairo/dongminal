import { readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';

import { stopDaemon } from './daemon-cleanup';

// 임시 홈을 지우기 전에 데몬을 먼저 종료한다. 순서가 뒤바뀌면 paned.pid 가
// 사라져 데몬을 찾을 수 없고, 그 데몬이 셸 PTY 를 계속 점유한다.
async function globalTeardown() {
  let entries: string[] = [];
  try {
    entries = readdirSync('/tmp');
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('dongminal-e2e-')) continue;
    const fullPath = join('/tmp', entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    stopDaemon(fullPath);
    try {
      rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // 지울 수 없는 항목은 건너뛴다
    }
  }
}

export default globalTeardown;
