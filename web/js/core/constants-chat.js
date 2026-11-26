/**
 * 채팅 화면의 상수 (ISSUE_TREE_CHAT_SRS §3.2). `[chat]` 지연 묶음의 맨 앞이다.
 */

/** 같은 보낸 이의 글을 한 묶음에 잇는 최대 간격 (§10 A-4). */
const CHAT_GROUP_GAP_MS=5*60*MS_PER_SEC;

/** 에이전트 색의 칸 수 — `deriveChatColors` 가 세우는 `--chat-a0`~`--chat-a4` 다 (FR-CUX-10). */
const CHAT_AGENT_COLORS=5;

/** 알림 단계 off (데몬 `NOTIFY_OFF`). all·called 는 부팅의 chat-controller.js 에 있다. */
const CHAT_NOTIFY_OFF='off';

const TIP_CHAT_REPLY='Reply — mention the sender';
const TIP_CHAT_NOTIFY='My notification level in this room';
