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
 * 임시 디렉터리의 뿌리 (FR-CEM-7 · FR-CEM-22).
 *
 * POSIX 는 `/tmp` 를 그대로 쓴다. `os.tmpdir()` 로 통일하고 싶은 유혹이 있으나
 * macOS 의 그 값은 `/var/folders/…/T`(48자)이고, 인스턴스 홈 아래에는 **유닉스
 * 도메인 소켓**(`paned.sock`)이 산다 — macOS 의 소켓 경로 상한은 104바이트다.
 * 홈 이름과 소켓 이름을 더하면 그 상한에 붙으므로, 통일의 대가가 데몬의 기동
 * 실패다.
 *
 * **Windows 는 `RUNNER_TEMP` 를 먼저 본다.** 그 OS 의 `os.tmpdir()` 은
 * `C:\Users\<사용자>\AppData\Local\Temp` 이고, 그것은 **사용자의 홈 안**이다 —
 * 앱은 홈을 뿌리로 하는 편집기를 늘 하나 세우므로(FR-EDT-13) 검사가 만든 모든
 * 임시 뿌리가 그 창에 **중첩**된다. POSIX 의 `/tmp` 에서는 한 번도 없던 겹침이고,
 * 그래서 여러 스펙이 "내 뿌리를 품는 창은 내 것뿐" 을 조용히 전제하고 있다
 * (러너 실측: 화면에 뜬 트리가 검사의 뿌리가 아니라 홈이었다).
 *
 * 러너의 `RUNNER_TEMP`(`D:\a\_temp`)는 홈 밖이다. 없으면 `os.tmpdir()` 로
 * 물러선다 — 그 처지에서는 중첩이 그대로이지만, 그것은 **앱이 다뤄야 할 실제
 * 상황**이지 검사가 만든 것이 아니다.
 */
export const TMP = isWin ? slash(process.env.RUNNER_TEMP || tmpdir()) : '/tmp';

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
 * 앱이 절대경로를 만드는 **그 규약**으로 잇는다 (`web/js/core/helpers.js` 의
 * `pathJoin`).
 *
 * 검사가 `repo + '/' + rel` 로 지어내면 Windows 에서 구분자가 섞인 문자열이 되고
 * (`D:\…\copy-v161/디렉터리 한글/…`), 그것은 앱이 든 값과 다르다. 짐작하지 말고
 * 같은 규칙을 쓴다 (FR-CEM-11).
 */
export function appJoin(dir: string, rel: string): string {
  const d = String(dir == null ? '' : dir);
  const r = String(rel == null ? '' : rel);
  if (!d) return r;
  if (!r) return d;
  if (d === '/') return '/' + r;
  const sep = d.includes('\\') && !d.includes('/') ? '\\' : '/';
  // 안쪽 구분자까지 맞춘다 — 앱의 `pathJoin` 과 같다. 섞인 경로는 절대경로로
  // 쓰이는 순간 어디와도 견줄 수 없다.
  const tail = sep === '\\' ? r.replace(/\//g, '\\') : r;
  return d.replace(/[\\/]+$/, '') + sep + tail;
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

/**
 * 도구 셸에 타이핑할 명령 (FR-CEM-9).
 *
 * 셸이 OS 마다 다르다 — POSIX 는 zsh·bash, Windows 는 pwsh 다
 * (`platform.Shell`). 세 가지가 특히 다르다.
 *
 *   환경변수  `$NAME` ↔ `$env:NAME`
 *   기다림    `sleep 2` ↔ `Start-Sleep 2`
 *   실행 파일 `dmctl` ↔ `dmctl.exe` (`platform.Paths.ExeSuffix`)
 *
 * 파이프와 `&&` 는 둘 다 받는다 (pwsh 7). 그래서 이 셋만 바꾸면 같은 문장이
 * 양쪽에서 같은 일을 한다.
 */
export function envRef(name: string): string {
  return isWin ? '$env:' + name : '$' + name;
}

/** 그 홈 아래 `bin` 의 헬퍼를 부르는 조각. 절대경로인 이유는 PATH 앞쪽의 낡은
 * dmctl 이 새 하위명령을 모를 수 있기 때문이다. */
export function dmctl(...args: string[]): string {
  const path = isWin
    ? `"${envRef('DONGMINAL_HOME')}\\bin\\dmctl.exe"`
    : `"${envRef('DONGMINAL_HOME')}/bin/dmctl"`;
  return [isWin ? '& ' + path : path, ...args].join(' ');
}

/** 초 단위로 기다리는 조각. */
export function sleepCmd(sec: number): string {
  return isWin ? `Start-Sleep ${sec}` : `sleep ${sec}`;
}

/** 문자열을 그대로 표준 출력으로 내는 조각 — 파이프의 앞머리다. */
export function echoCmd(text: string): string {
  // 두 셸 모두 홑따옴표는 축자 문자열이다. JSON 안의 겹따옴표가 그대로 지나간다.
  return isWin ? `'${text}'` : `echo '${text}'`;
}

/**
 * 전송 계층이 **앱의 원본 출력**을 기록하는가.
 *
 * POSIX PTY 는 앱이 낸 바이트를 그대로 흘린다. 그래서 `ESC[<W>G` 같은 절대 좌표가
 * 기록에 남고, 전량 재생이 그것을 **새 폭에서 다시 파싱**해 줄이 그 폭으로 선다
 * (M10_SRS FR-M10-2 가 기대는 성질이다).
 *
 * ConPTY 는 원본을 주지 않는다 — 우리가 받는 것은 그 시점 폭으로 **이미 그려진
 * 화면**이다. 좌표는 이미 해소돼 있어 재생해도 옛 폭 그대로이고, 다시 그려 달라고
 * 부탁할 상대도 없다: 공개 API 는 `Create`·`Resize`·`Close` 셋뿐이고, 위로 밀려난
 * 줄은 conhost 관점에서 이미 내보낸 뒤라 존재하지 않는다.
 *
 * **OS 가 아니라 능력으로 묻는다** (WINDOWS_TEST_PARITY_SRS FR-WTP-31 의 취지).
 * 언젠가 다른 전송이 붙어도 물음은 그대로다.
 */
export const ptyRecordsRawOutput = !isWin;

/**
 * **번호가 붙은 줄 N 개**를 내는 조각 (`<prefix>1<suffix>` … `<prefix>N<suffix>`).
 *
 * `for i in 1 2 3; do echo …; done` 은 **bash 의 문법**이다. pwsh 에 그대로 치면
 * 아무 줄도 나오지 않고, 그것을 세는 검사는 `0` 을 받는다 — `term-size` 의
 * TC-M9-3b 가 Windows 에서 내내 그렇게 졌다 (2026-09-16 실측: 기대 8, 받은 0).
 *
 * 재려는 것은 *여러 줄이 두 클라이언트에 같게 보이는가* 이지 셸의 반복 문법이
 * 아니다. 그래서 이 파일의 다른 셋과 같은 자리에 둔다.
 */
export function numberedLinesCmd(prefix: string, n: number, suffix: string): string {
  if (isWin) return `1..${n} | ForEach-Object { "${prefix}$_${suffix}" }`;
  const list = Array.from({ length: n }, (_, i) => i + 1).join(' ');
  return `for i in ${list}; do echo "${prefix}$i${suffix}"; done`;
}

/**
 * `text` 를 찍고, **그 터미널의 오른쪽 끝 열**로 커서를 옮겨 `mark` 를 찍는 조각.
 *
 * 줄바꿈이 아니라 **절대 좌표**(`ESC [ <W> G`)이므로 xterm 의 리플로우로는
 * 되돌아가지 않는다 — 다시 그리는 길이 전량 재생뿐이라는 사실을 재는 자리가
 * 이것을 쓴다 (`term-reclaim` TC-M10-2).
 *
 * `printf`·`tput` 은 bash 의 것이다. pwsh 에서는 폭을 호스트에게 묻고 ESC 를
 * `[char]27` 로 만든다 — 그 판에서 이 명령이 다른 글을 찍는 바람에 길이가
 * 어긋났다 (2026-09-16 실측: 기대 164, 받은 18).
 */
export function cursorEndMarkCmd(text: string, mark: string): string {
  if (isWin) {
    return `Write-Host -NoNewline '${text}'; ` +
      `Write-Host ("$([char]27)[" + $Host.UI.RawUI.WindowSize.Width + "G${mark}")`;
  }
  return `printf '${text}'; printf '\\033[%dG${mark}\\n' $(tput cols)`;
}

/**
 * 차례로 잇는다.
 *
 * **`;` 다.** `&&` 는 pwsh 7 도 받지만, 세 조각을 한 줄로 이어 타이핑하면 그 셸이
 * 입력을 미완성으로 보고 계속 프롬프트(`>>>`)를 띄운 채 멈춘 경우가 있었다
 * (러너 실측: 화면에 명령은 그대로 찍혔는데 실행되지 않았다). `;` 는 두 셸 모두
 * **한 줄의 끝**으로 확실히 받는다.
 *
 * "앞이 성공해야 뒤가 돈다" 는 성질은 잃지만, 이 자리가 쓰는 것은 순서뿐이다 —
 * 앞이 실패하면 뒤의 단정이 그것을 잡는다.
 */
export function chain(...parts: string[]): string {
  return parts.join('; ');
}
