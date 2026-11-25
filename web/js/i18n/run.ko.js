/**
 * Otterminal — 문구 카탈로그 조각 `run`·`ko` (PERF_OPTIMIZATION_SRS D-46). `[run]` 묶음에서만 쓰는 키다.
 *
 * `Screens.load('run')` 가 묶음 JS 앞에 싣는다. 키 규약·목소리·조사 마커는 `ko.js` 머리말과 같다.
 * 키의 소속과 ko·en 일치는 `scripts/check-i18n.mjs` 가 지킨다.
 */
I18N.register('ko', {
  // ── html ──
  'runs.card_lost_title': '이 멤버의 세션을 찾을 수 없습니다. 다시 잡히면 활성으로 돌아옵니다',

  // ── runs ──
  'runs.archived_msgs.other': '보관된 메시지 {n}건',
  'runs.attach_fail': '부착 실패',
  'runs.card_attach_title': '클릭하면 현재 분할 칸의 새 탭으로 부착합니다',
  'runs.card_jump_title': '클릭하면 이 멤버의 도구로 이동합니다',
  'runs.compact_count.other': 'compact {n}회',
  'runs.coordinator': '조정자',
  'runs.detach': '분리',
  'runs.detach_fail': '분리 실패',
  'runs.elapsed': '경과 {ago}',
  'runs.graph_fail': '대시보드를 받지 못했습니다',
  'runs.headless': '헤드리스',
  'runs.headless_paren': '(헤드리스)',
  'runs.member_count': '멤버 {n}',
  'runs.member_count_headless': '멤버 {n} (헤드리스 {h})',
  'runs.no_role': '역할 없음',
  'runs.tree_title': '이슈 트리 {ref}',
  'runs.tree_empty': '열린 노드가 없습니다',
  'runs.tree_leaf': '작업 중',
  'runs.tree_zoom': '배율 — ⌘/Ctrl+휠로도 바꿉니다',
  'runs.tree_fit': '맞춤',
  'runs.tree_fit_title': '트리 전체가 보이게 맞춥니다',
  'runs.tree_jump': '누르면 이 에이전트의 탭으로 갑니다',
  'runs.no_role_paren': '(역할 없음)',
  'runs.objective': '목적: {v}',
  'runs.recover': '복구',
  'runs.recover_all': '빈 셸 복구',
  'runs.recover_done': '복구: 재개 {ok} · 건너뜀 {skip} · 실패 {fail}',
  'runs.recover_fail': '복구 실패',
  'runs.recover_force': '계속',
  'runs.recover_q_force': '이 셸에 에이전트가 없는지 확인할 수 없습니다. 화면을 확인했으면 계속하세요.',
  'runs.recover_r_bad_session': '세션 id 형식이 맞지 않음',
  'runs.recover_r_busy': '셸에서 다른 프로그램이 도는 중',
  'runs.recover_r_ended': '이미 끝남',
  'runs.recover_r_no_agent': '에이전트를 모름',
  'runs.recover_r_no_resume': '재개 방법이 없는 에이전트',
  'runs.recover_r_no_session': '세션 id 가 없음',
  'runs.recover_r_no_tool': '도구가 없음',
  'runs.recover_r_failed': '셸에 넣지 못함',
  'runs.recover_r_other': '그 밖의 사유',
  'runs.recover_r_recovering': '방금 재개함',
  'runs.recover_r_running_elsewhere': '다른 곳에서 이미 도는 중',
  'runs.recover_r_running_here': '이미 도는 중',
  'runs.recover_r_unknown': '판정할 수 없음',
});
