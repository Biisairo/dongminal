/**
 * Otterminal — 문구 카탈로그 조각 `remote`·`ko` (PERF_OPTIMIZATION_SRS D-46). `[remote]` 묶음에서만 쓰는 키다.
 *
 * `Screens.load('remote')` 가 묶음 JS 앞에 싣는다. 키 규약·목소리·조사 마커는 `ko.js` 머리말과 같다.
 * 키의 소속과 ko·en 일치는 `scripts/check-i18n.mjs` 가 지킨다.
 */
I18N.register('ko', {
  // ── openurl ──
  'openurl.lead': '이 기기의 브라우저로 엽니다.',
  'openurl.open': '열기',
  'openurl.title': '여기서 열기',
});
