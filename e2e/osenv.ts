/**
 * 스펙의 OS 의존을 이 한 자리에 모은다 (CI_E2E_MATRIX_SRS D-4 · NFR-CEM-2).
 *
 * 브라우저 종단간은 세 OS 에서 돈다. 분기를 스펙마다 두면 1,257항목에 흩어지고,
 * 흩어지면 한쪽만 고쳐진다 — 스펙은 여기 있는 이름을 부르고, 무엇이 OS 마다
 * 다른가는 이 파일만 안다.
 */
import { realpathSync } from 'fs';
import { tmpdir } from 'os';

export const isWin = process.platform === 'win32';

/**
 * FR-CEM-8: `bash`(git bash)와 `git` 은 `C:/…` 를 받지만 `C:\…` 는 이스케이프로
 * 읽는다. 경로가 이 두 소비자에게 닿기 전에 한 번 정규화한다.
 */
export function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 임시 디렉터리의 뿌리 (FR-CEM-7).
 *
 * POSIX 는 `/tmp` 를 그대로 쓴다. `os.tmpdir()` 로 통일하고 싶은 유혹이 있으나
 * macOS 의 그 값은 `/var/folders/…/T`(48자)이고, 인스턴스 홈 아래에는 **유닉스
 * 도메인 소켓**(`paned.sock`)이 산다 — macOS 의 소켓 경로 상한은 104바이트다.
 * 홈 이름과 소켓 이름을 더하면 그 상한에 붙으므로, 통일의 대가가 데몬의 기동
 * 실패다. Windows 에는 `/tmp` 가 없으니 그쪽만 `os.tmpdir()` 이다.
 */
export const TMP = isWin ? slash(tmpdir()) : '/tmp';

/** 임시 디렉터리 아래의 한 자리. 구분자는 언제나 슬래시다 (FR-CEM-8). */
export function tmpPath(name: string): string {
  return TMP + '/' + name;
}

/**
 * 서버가 내는 모양의 **실제 경로** (FR-CEM-11).
 *
 * 경로를 값으로 견주는 자리가 많다 — 창의 `data-git-repo`, 헤더의 `title`, 활성
 * 리포. 그 값을 만드는 것은 서버이고 서버는 `git rev-parse --show-toplevel` 을
 * 쓰는데, git 은 Windows 에서도 **슬래시**로 답한다. 검사가 `path.join` 이 준
 * 역슬래시 경로를 그대로 견주면 그 자리는 어느 것도 맞지 않는다.
 *
 * `realpathSync` 를 함께 지나는 이유는 종전과 같다 — macOS 의 `/tmp` 는
 * `/private/tmp` 의 심링크이고, Windows 의 `RUNNER~1` 은 `runneradmin` 의 짧은
 * 이름이다. 서버가 보는 것은 풀린 쪽이다.
 */
export function realPath(p: string): string {
  return slash(realpathSync(p));
}
