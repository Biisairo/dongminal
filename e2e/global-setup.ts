import { readdirSync, rmSync, statSync } from 'fs';
import { basename, join } from 'path';

import { E2E_HOME } from '../playwright.config';
import { stopDaemon } from './daemon-cleanup';

// 이전 실행이 남긴 /tmp/dongminal-e2e-* 를 정리한다.
//
// 주의: playwright 는 webServer 를 globalSetup 보다 **먼저** 띄운다. 따라서
// 이름 접두사만 보고 지우면 방금 뜬 서버의 홈까지 삭제되어, 테스트 내내
// workspace/tools/settings 쓰기가 "no such file or directory" 로 실패한다.
// 이 실행의 홈(E2E_HOME)은 반드시 건너뛴다.
async function globalSetup() {
  const current = basename(E2E_HOME);
  let entries: string[] = [];
  try {
    entries = readdirSync('/tmp');
  } catch {
    return; // /tmp 읽기 불가 — 정리 생략
  }
  for (const entry of entries) {
    if (!entry.startsWith('dongminal-e2e-')) continue;
    if (entry === current) continue; // 이번 실행의 홈 — 보존
    const fullPath = join('/tmp', entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    stopDaemon(fullPath); // 크래시로 남은 데몬의 PTY 회수
    try {
      rmSync(fullPath, { recursive: true, force: true });
    } catch {
      // 지울 수 없는 항목은 건너뛴다
    }
  }
}

export default globalSetup;
