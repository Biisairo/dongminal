/**
 * Otterminal — 문구 카탈로그 조각 `editor`·`ko` (PERF_OPTIMIZATION_SRS D-46). `[editor]` 묶음에서만 쓰는 키다.
 *
 * `Screens.load('editor')` 가 묶음 JS 앞에 싣는다. 키 규약·목소리·조사 마커는 `ko.js` 머리말과 같다.
 * 키의 소속과 ko·en 일치는 `scripts/check-i18n.mjs` 가 지킨다.
 */
I18N.register('ko', {
  // ── editor ──
  'editor.dd_peek_added': '이 줄들은 새로 더해졌습니다 — 이전에는 없던 자리입니다',
  'editor.dd_peek_close_title': '닫기',
  'editor.dd_revert': '되돌리기',
  'editor.dd_revert_title': '이 조각을 index 의 내용으로 되돌립니다 (되돌리기는 Cmd+Z 로 취소됩니다)',
  'editor.dd_stage': '스테이지',
  'editor.dd_stage_title': '이 조각을 스테이지합니다 — 저장하지 않은 편집이 있으면 먼저 저장합니다',
  'editor.dd_stage_wide': '조각의 경계를 좁히지 못해 덩어리 전체를 스테이지했습니다',
  'editor.dd_staging': '스테이지하는 중…',
  'editor.del_recover_hint': 'git checkout -- %s {으로로} 되돌릴 수 있습니다',
  'editor.download_link_no': '링크는 내려받을 수 없습니다',
  'editor.rename_many_no': '이름 바꾸기는 한 항목만 할 수 있습니다',
  'editor.menu_copy': '복사',
  'editor.menu_copy_abs_path': '절대 경로 복사',
  'editor.menu_copy_rel_path': '상대 경로 복사',
  'editor.path_copied': '경로를 복사했습니다',
  'editor.menu_cut': '잘라내기',
  'editor.menu_delete': '삭제',
  'editor.menu_download': '다운로드',
  'editor.menu_duplicate': '복제',
  'editor.menu_new_dir': '새 폴더',
  'editor.menu_new_file': '새 파일',
  'editor.menu_paste': '붙여넣기',
  'editor.menu_rename': '이름 변경',
  'editor.menu_upload': '업로드',
  'editor.menu_upload_dir': '폴더 업로드',
  'editor.tree_stale': '갱신 실패 — 마지막 목록을 보이고 있습니다',
  'editor.tree_err_close': '닫기',
  'editor.move_tab_conflict': '편집기에 같은 경로의 문서가 열려 있어 탭을 옮기지 못했습니다',
  'editor.tree_fail_more': '{msg} (외 {n}건)',
  'editor.paste_none': '복사한 것이 없습니다',
  'editor.size_with_limit': '{size} · 상한 {max}',
  'editor.tree_err': '읽지 못했습니다',
  'editor.tree_more_busy': '%s / %t — 받는 중…',
  'editor.tree_more_fail': '%s / %t — 더 받지 못했습니다. 눌러 다시 시도',
  'editor.tree_truncated': '%s / %t — 더 보기',
  'editor.upload_abort': '중단',
  'editor.upload_aborted': '%n개를 남기고 중단했습니다',
  'editor.upload_fail': '%s {을를} 올리지 못했습니다',
  'editor.upload_fail_body': '%s {을를} 올리지 못했습니다 — %r',
  'editor.upload_fail_title': '업로드 실패',
  'editor.upload_retry': '재시도',
  'editor.upload_skip': '건너뛰기',
  'editor.upload_skip_all': '이후 모두 건너뛰기',
  'editor.upload_skipped': '%n개를 건너뛰었습니다',

  // ── panel (UIUX_OVERHAUL_SRS FR-ACT-1) ──
  'cacct.map.folder_menu': 'Claude 계정 연결…',
  'cacct.map.folder_clear': '연결 해제',
});
