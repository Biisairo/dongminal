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
 * 서버가 보는 **실제 경로**.
 *
 * `realpathSync` 를 지나는 이유는 두 OS 의 사정이다 — macOS 의 `/tmp` 는
 * `/private/tmp` 의 심링크이고, Windows 의 `RUNNER~1` 은 `runneradmin` 의 짧은
 * 이름이다. 서버가 저장하고 돌려주는 것은 **풀린 쪽**이므로(`wsentry.NormalizePath`
 * 가 `EvalSymlinks`+`Clean` 한 벌이다) 검사도 같은 것을 들고 있어야 한다.
 *
 * **구분자는 바꾸지 않는다.** 이 제품의 정규형은 그 OS 의 것이다 —
 * `git rev-parse` 가 Windows 에서 슬래시로 답하는 것까지 `filepath.Clean` 으로
 * 되돌려 한 형태로 모은다 (WINDOWS_TEST_PARITY_SRS FR-WTP-3). 검사가 슬래시로
 * 바꿔 들고 있으면 그 값과 어긋난다.
 */
export function realPath(p: string): string {
  // `native` 를 쓰는 이유는 Windows 의 **짧은 이름**이다. 순수 JS 구현은 심링크만
  // 풀고 `RUNNER~1` 을 그대로 두는데, 서버(Go 의 `EvalSymlinks`)는 긴 이름
  // (`runneradmin`)으로 답한다 — 그 둘은 문자열로 같지 않다 (러너 실측).
  // `realpathSync.native` 는 OS 에게 최종 경로를 물으므로 짧은 이름이 풀린다.
  try {
    return realpathSync.native(p);
  } catch {
    return realpathSync(p);
  }
}

/**
 * 경로를 **CSS 속성 선택자**에 넣는 형태로 만든다.
 *
 * CSS 에서 역슬래시는 이스케이프 문자다. `[data-path="C:\\Users\\x"]` 를 그대로
 * 쓰면 파서가 그것을 먹어 `C:Usersx` 를 찾는다 — Windows 에서는 **어떤 경로도
 * 맞지 않는다**(러너 실측: 60초 타임아웃 뒤 "element not found"). POSIX 에서는
 * 바뀌는 것이 없다.
 */
export function cssPath(p: string): string {
  return String(p).replace(/\\/g, '\\\\');
}
