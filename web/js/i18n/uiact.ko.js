/**
 * Otterminal — 문구 카탈로그 조각 `uiact`·`ko` (PERF_OPTIMIZATION_SRS D-46). `[uiact]` 묶음에서만 쓰는 키다.
 *
 * `Screens.load('uiact')` 가 묶음 JS 앞에 싣는다. 키 규약·목소리·조사 마커는 `ko.js` 머리말과 같다.
 * 키의 소속과 ko·en 일치는 `scripts/check-i18n.mjs` 가 지킨다.
 */
I18N.register('ko', {
  // ── attn ──
  'attn.clear_all': '모두 제거',
  'attn.reason_idle': '작업 멈춤',
  'attn.reason_signal': '알림 신호',
  'attn.title': '주의 알림 {n}',
});
