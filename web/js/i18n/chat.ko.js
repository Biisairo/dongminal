/**
 * Otterminal — 문구 카탈로그 조각 `chat`·`ko` (PERF_OPTIMIZATION_SRS D-46). `[chat]` 묶음에서만 쓰는 키다.
 *
 * `Screens.load('chat')` 가 묶음 JS 앞에 싣는다. 키 규약·목소리·조사 마커는 `ko.js` 머리말과 같다.
 * 키의 소속과 ko·en 일치는 `scripts/check-i18n.mjs` 가 지킨다.
 */
I18N.register('ko', {
  // ── panel (UIUX_OVERHAUL_SRS FR-ACT-1) ──
  'edge.pending': '알림 대기',
  'edge.outdated': '옛 판 — 업데이트 필요',
  'chat.window_name': '채팅',
  'chat.group': '단체채팅',
  'chat.leave': '방에서 나가기',
  'chat.input_ph': 'Enter 로 보내고 Shift+Enter 로 줄을 바꿉니다.',
  'chat.not_joined': '이 방에 들어가 있지 않습니다.',
  'chat.gone': '방이 사라졌습니다.',
  'chat.agent': '에이전트',
  'chat.notify_all': '모든 글',
  'chat.notify_called': '부른 글',
  'chat.notify_off': '끔',
  'chat.notify_is': '알림: {level}',
  'chat.made_by': '만든 이 {name}',
  'chat.err_notify': '알림 단계 바꾸기',
  'chat.people': '참가자',
  'chat.kill': '강제 삭제',
  'chat.kick': '강퇴',
  'chat.kill_what': '방 {n}개 강제 삭제: {list}',
  'chat.kick_what': '참가자 {n}명 강퇴: {list}',
  'chat.cmd_title': '사람 명령 확인',
  'chat.cmd_code': 'OTP 코드',
  'chat.cmd_hint': 'OTP 앱의 6자리 코드나 복구 코드를 넣습니다.',
  'chat.cmd_run': '실행',
  'chat.cmd_bad_code': '코드가 틀렸거나 이미 쓴 코드입니다. 새 코드를 넣으세요.',
  'chat.cmd_locked': '5번 틀려 잠겼습니다. {time}에 풀립니다.',
  'chat.err_cmd': '사람 명령',
});
