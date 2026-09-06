import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// dongminal 은 웹서버와 별도로 detached dongminald(PTY 데몬)를 띄운다.
// playwright 는 webServer 프로세스만 정리하므로 데몬은 살아남아 자기 도구
// 셸들의 PTY 를 계속 붙들고 있다. 실행마다 ~70개가 누수되어 반복 실행이
// kern.tty.ptmx_max(기본 511) 를 소진하고, 그 뒤로는 PTY 생성이
// "device not configured" 로 실패해 대부분의 테스트가 무너진다.
export function stopDaemon(home: string): void {
  let pid = 0;
  try {
    pid = parseInt(readFileSync(join(home, 'paned.pid'), 'utf8').trim(), 10);
  } catch {
    return; // pid 파일 없음 — 데몬 미기동
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 이미 종료
  }
}

/**
 * 그 뿌리 **바로 아래**의 워커 홈들(`w0`, `w1` …)의 데몬을 세운다.
 *
 * 실행마다 인스턴스가 여럿이 되었으므로(E2E_PARALLEL_SRS FR-EPL-1) `paned.pid`
 * 도 여럿이다. 뿌리 하나만 보면 워커의 데몬이 통째로 남는다.
 */
export function stopDaemonsUnder(root: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    stopDaemon(p);
  }
}
