/**
 * CodeMirror 벤더 묶음을 싣는 자리 (CODEMIRROR_MIGRATION_SRS 묶음 V · FR-CMR-6).
 *
 * 편집기 칸(`editor` 화면 묶음)과 Git Diff 가 함께 부른다. 그래서 부팅 묶음에 둔다 (PERF 3.4.7).
 */

// CODEMIRROR_MIGRATION_SRS 묶음 V. 출력은 `scripts/build-codemirror.mjs` 가 만든다.
const CM_ENTRY = '/vendor/codemirror/cm.js';

let cmLoading = null;
// 브라우저는 실패한 모듈 URL 을 기억하고 다시 받지 않는다 — 다시 시도할 때마다
// 쿼리를 바꿔 새 URL 로 받는다.
let cmAttempt = 0;

/**
 * FR-CMR-6: 진입 모듈을 전역 `CM` 하나로 세운다. 대기 중인 호출자는 같은 Promise 를
 * 공유하고, 실패는 기억하지 않는다 — 네트워크가 돌아오면 다시 시도할 수 있어야 한다.
 */
function loadCodeMirror() {
  if (window.CM) return Promise.resolve();
  if (cmLoading) return cmLoading;
  const url = cmAttempt ? `${CM_ENTRY}?r=${cmAttempt}` : CM_ENTRY;
  cmAttempt++;
  cmLoading = import(url).then((m) => { window.CM = m });
  cmLoading.catch(() => { cmLoading = null });
  return cmLoading;
}
