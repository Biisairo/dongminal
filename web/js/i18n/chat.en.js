/**
 * Otterminal — 문구 카탈로그 조각 `chat`·`en` (PERF_OPTIMIZATION_SRS D-46). `[chat]` 묶음에서만 쓰는 키다.
 *
 * `ko` 조각과 키 집합이 같다(`scripts/check-i18n.mjs`).
 */
I18N.register('en', {
  // ── panel (UIUX_OVERHAUL_SRS FR-ACT-1) ──
  'edge.pending': 'Not notified',
  'edge.outdated': 'Outdated — needs update',
  'chat.window_name': 'Chat',
  'chat.group': 'Group chat',
  'chat.leave': 'Leave room',
  'chat.input_ph': 'Enter sends, Shift+Enter adds a line.',
  'chat.not_joined': 'You are not in this room.',
  'chat.gone': 'This room is gone.',
  'chat.agent': 'agent',
  'chat.notify_all': 'All messages',
  'chat.notify_called': 'Mentions',
  'chat.notify_off': 'Off',
  'chat.notify_is': 'Notify: {level}',
  'chat.made_by': 'Created by {name}',
  'chat.err_notify': 'Change notification level',
  'chat.people': 'People',
  'chat.kill': 'Force delete',
  'chat.kick': 'Kick',
  'chat.kill_what': 'Force delete {n} room(s): {list}',
  'chat.kick_what': 'Kick {n} participant(s): {list}',
  'chat.cmd_title': 'Confirm human command',
  'chat.cmd_code': 'OTP code',
  'chat.cmd_hint': 'Enter the 6-digit code from your OTP app or a recovery code.',
  'chat.cmd_run': 'Run',
  'chat.cmd_bad_code': 'The code is wrong or already used. Enter a new code.',
  'chat.cmd_locked': 'Locked after 5 wrong codes. Unlocks at {time}.',
  'chat.err_cmd': 'Running the human command',
});
