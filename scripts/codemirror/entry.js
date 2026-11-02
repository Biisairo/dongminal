// CODEMIRROR_MIGRATION_SRS FR-CMR-1·6 — web/vendor/codemirror/cm.js 의 진입점.
// 앱은 이 모듈을 전역 `CM` 하나로 받는다. 패키지를 더하면 여기에 한 줄을 더한다.
export * from '@codemirror/state';
export * from '@codemirror/view';
export * from '@codemirror/commands';
export * from '@codemirror/language';
export * from '@codemirror/search';
export * from '@codemirror/autocomplete';
export * from '@codemirror/lint';
export * from '@codemirror/merge';
export * from '@codemirror/lsp-client';
export { tags } from '@lezer/highlight';
export { languages } from '@codemirror/language-data';
export { indentationMarkers } from '@replit/codemirror-indentation-markers';
export { showMinimap, minimapDrawn } from './minimap/index.js';
