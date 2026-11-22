/**
 * Dongminal — 툴팁 문구 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * `constants.js` 의 툴팁 절(UX_BATCH5_SRS 묶음 C)을 그대로 옮겼다 — 값과 이름은 그대로다.
 * `constants-sandbox.js` 뒤에 로드된다.
 */
// ── 툴팁 (UX_BATCH5_SRS 묶음 C / FR-TIP-1·2·4) ──
//
// 라벨이 한두 낱말인 버튼들이다 — `예`·`아니오`·`확인`·`복사` 는 **무엇을** 하는지
// 말하지 않는다. 문자열은 상수 표에 산다 (FR-TIP-4).
const TIP_NOTIFY_OK='Dismiss this message';
/** UX_AUDIT_FIX_SRS FR-UXF-76: 상단바 칸 수의 툴팁 머리. 뒤에 수가 붙는다. */
const TIP_SLOT_COUNT='Window slots: ';
const TIP_CLOSE_TOOL='Close this tool and end its session';
const TIP_CLOSE_CANCEL='Keep this tool open';
const TIP_CLOSE_SAVE='Save the file, then close';
const TIP_CLOSE_BG='Keep it running in the background instead of closing';
const TIP_SBX_CANCEL='Close without creating a sandbox window';
const TIP_SBX_SETTINGS='Open settings to define more sandbox profiles';
const TIP_COPY_DO='Copy the selected text to the clipboard';
const TIP_COPY_CLOSE='Close without copying';
const TIP_DEL_OK='Delete permanently — this cannot be undone';
const TIP_DEL_CANCEL='Keep it and close';
const TIP_BG_KILL_YES='Terminate this background tool';
const TIP_BG_KILL_NO='Leave it running';
const TIP_RUNS_DEL='Remove this run from the list and its history';
const TIP_RUNS_YES='Delete this run permanently';
const TIP_RUNS_NO='Keep this run';
const TIP_CHAT_CREATE='Create the room and join it'; // PEER_CHAT_SRS §3.11
const TIP_CHAT_CANCEL='Close without creating';
const TIP_CHAT_CMD_RUN='Ask the helper to sign and run the command'; // PEER_CHAT_SRS §3.12
const TIP_CHAT_CMD_CANCEL='Close without running';
// FR-TIP-2: Activity 탭 줄. 라벨은 카탈로그 말이고 툴팁은 영어다 (PEER_CHAT_SRS §3.11).
const TIP_ACT_AGENTS='Show running agents';
const TIP_ACT_BG='Show background tools';
const TIP_ACT_RUNS='Show runs';
/**
 * `12-func-ui.md FUI-04`: **Run 을 UI 에서 멈출 길이 없었다.**
 *
 * 유일한 출구가 `삭제` 였고 그것은 **기록까지 지운다** — 진행 중인 Run 을
 * 멈추려면 무엇이 있었는지도 함께 잃어야 했다. 서버는 `close`·`detach` 를
 * 이미 노출하고 있었으므로 없던 것은 화면뿐이다.
 */
const TIP_RUNS_CLOSE='Stop this run and clean up — the record stays';
const TIP_RUNS_CLOSE_YES='Stop this run now';
const TIP_RUNS_DETACH='Detach this member — the tab closes, the tool keeps running';
const TIP_RUNS_RECOVER_ONE='Resume this agent by its session id in its empty shell';
const TIP_RUNS_RECOVER_ALL='Resume every agent of this Run whose shell is empty';
const TIP_RUNS_RECOVER_FORCE='Resume anyway — you checked that the shell is empty';
// FR-TIP-1: 단축키 설정의 두 버튼. 키 조합과 `↺` 가 라벨이라 무엇을 하는지는
// 툴팁만 말할 수 있다.
const SHORTCUT_REBIND_TITLE='Click, then press the keys you want for this action';
const SHORTCUT_RESET_TITLE='Reset this shortcut to its default';
// FR-TIP-4 (OPTIMIZE_REFACTOR_SRS FR-OPT-14-3): 요소를 만드는 자리에 적혀 있던 것들.
const TIP_BACKUP_REVERT='Revert the window layout to this generation';
const TIP_ATTN_CLEAR_ALL='Clear every attention alert';
const TIP_ATTN_DISMISS='Dismiss this alert';
const TIP_PRESET_DEFAULT='Make this the default preset';
const TIP_PRESET_LOAD='Load this preset';
const TIP_PRESET_DEL='Delete this preset';
const TIP_PRESET_KEEP='Keep this preset';
const TIP_ACCESS_DEL='Remove this entry';
const TIP_SBX_MOUNT_DEL='Remove this mount';
const TIP_THEME_LIST='Theme';
const TIP_THEME_PREVIEW='Theme preview: ';
const TIP_SIDEBAR_CLOSE='Close the sidebar';
const TIP_MOBILE_ACTIVITY='Work — everything that is running';
// MOBILE_UX_OVERHAUL_SRS FR-MUX-75: 작업 중인 에이전트가 있으면 단추의 이름이 그 수를 말한다.
const TIP_MOBILE_ACTIVITY_WORKING='Work — {n} working';
// REFACTOR3_FE_FIX_SRS FR-FFX-1·4 (P8-2): 작업 중 점은 `aria-hidden` 이다 — 툴팁과 접근 이름이 대신 말한다.
const TIP_WORKING_SUFFIX=' — working';
const TIP_WORKING_COUNT=' — {n} working';
// FR-MUX-72: 모바일 사용량 요약 줄. 펼침·접힘에 따라 이름이 바뀐다.
const TIP_USAGE_SUM_OPEN='Show usage of every account';
const TIP_USAGE_SUM_CLOSE='Hide usage details';
const TIP_SETTINGS_BACK='Back to settings sections';
// REFACTOR3_FE_REST2_SRS FR-FR2-15 (FC-22): 코드에 박혀 있던 툴팁.
const TIP_EDGE_INVITE_SEND='Send an edge invite to this node';
const TIP_EDGE_NOTIFY='Send my name, node port and address to this edge';
const TIP_EDGE_INVITE_ACCEPT='Make an edge with this node';
const TIP_EDGE_INVITE_REJECT='Discard this invite';
const TIP_LIMIT_STATUSLINE='Rate limits reported by the Claude Code statusLine';
const TIP_CHAT_NEW_GROUP='Create a group chat';
const TIP_CHAT_ROOM_MORE='More actions for this room';
const TIP_CHAT_ROOM_ACTIONS='Room actions';
const TIP_PANEL_COLLAPSE='Collapse the panel';
const TIP_PANEL_EXPAND='Expand the panel';
const TIP_PANEL_CLOSE='Close the panel';
const TIP_AG_GROUP_EXPAND='Expand this window group';
const TIP_AG_GROUP_COLLAPSE='Collapse this window group';
const TIP_KEYBAR_UP='Move up';
const TIP_KEYBAR_DOWN='Move down';
const TIP_KEYBAR_DEL='Delete macro';
const TIP_THEME_HUE='Hue ';
