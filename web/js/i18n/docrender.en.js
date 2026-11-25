/**
 * Otterminal — 문구 카탈로그 조각 `docrender`·`en` (PERF_OPTIMIZATION_SRS D-46). `[docrender]` 묶음에서만 쓰는 키다.
 *
 * `ko` 조각과 키 집합이 같다(`scripts/check-i18n.mjs`).
 */
I18N.register('en', {
  // ── docrender ──
  'docrender.fail': 'Could not render the document',
  'docrender.html_note': 'Preview — scripts in this document do not run',
  'docrender.loading': 'Rendering…',
  'docrender.no_lib': 'Could not load the renderer',
  'docrender.outside': 'Files outside this window\'s folder are not opened',
  'docrender.source': 'Source',
  'docrender.source_title': 'Back to the source of this document',
  'docrender.svg_fail': 'Could not render this SVG — the document may be malformed',
  'docrender.table_cut': 'Large table — showing the first %n of %r rows',
  'docrender.table_empty': 'The table has no content',
  'docrender.too_big': 'The document is too large to render',
});
