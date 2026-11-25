/**
 * Otterminal — 문구 카탈로그 조각 `docrender`·`ko` (PERF_OPTIMIZATION_SRS D-46). `[docrender]` 묶음에서만 쓰는 키다.
 *
 * `Screens.load('docrender')` 가 묶음 JS 앞에 싣는다. 키 규약·목소리·조사 마커는 `ko.js` 머리말과 같다.
 * 키의 소속과 ko·en 일치는 `scripts/check-i18n.mjs` 가 지킨다.
 */
I18N.register('ko', {
  // ── docrender ──
  'docrender.fail': '문서를 그리지 못했습니다',
  'docrender.html_note': '미리보기입니다 — 이 문서의 스크립트는 실행되지 않습니다',
  'docrender.loading': '그리는 중…',
  'docrender.no_lib': '렌더러를 불러오지 못했습니다',
  'docrender.outside': '이 창의 폴더 밖은 열지 않습니다',
  'docrender.source': '소스',
  'docrender.source_title': '이 문서의 소스로 돌아가기',
  'docrender.svg_fail': '이 SVG 를 그리지 못했습니다 — 문서가 올바르지 않을 수 있습니다',
  'docrender.table_cut': '큰 표라서 앞부분만 보입니다 — %r행 중 %n행',
  'docrender.table_empty': '표에 담을 내용이 없습니다',
  'docrender.too_big': '문서가 너무 커서 그리지 않았습니다',
});
