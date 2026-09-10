/**
 * e2e 가 브라우저 안에서 보는 전역들 (CI_GATES_SRS B1).
 *
 * 앱은 클래식 `<script>` 85개로 실리고 모듈이 전역 `class`/`function`/`const` 로
 * 노출된다 (`web/index.html`). 그래서 `page.evaluate` 안의 코드가 그 이름들을
 * 그대로 부르는 것이 옳은 형태인데, 타입 검사기에게는 없는 이름이다.
 *
 * **스펙을 고치는 대신 여기에 적는다.** 스펙마다 `declare const` 를 흩으면 같은
 * 이름이 여러 벌이 되고(이미 `repo-tab.spec.ts:99` 에 하나 있다), 그 벌들이
 * 어긋나도 아무도 모른다.
 *
 * 타입이 `any` 인 것은 의도다. 여기서 잡으려는 것은 **없는 이름과 오타**이지 앱
 * 내부의 형태가 아니다 — 그것을 적으려면 앱에 타입이 먼저 있어야 하고, 그것은
 * `jsconfig.json` + `// @ts-check` 가 파일 단위로 해 나가는 일이다 (B2).
 */

interface Window {
  /** `web/js/core/main.js:5` 가 세운다. */
  app: any;
}

// 앱 전역 상수·변수. `page.evaluate(() => …)` 안에서 그대로 읽는 자리들이다.
declare const currentThemeName: string;
declare const UFE_ALPHA_PER_LEVEL: number;
declare const UFE_LEVEL_DEFAULT: number;
declare const GIT_REPOS_POLL_MS: number;
