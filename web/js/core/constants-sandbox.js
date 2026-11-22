/**
 * Dongminal — 샌드박스 창 상수 (REFACTOR3_FE_REST5_SRS FR-FR5-20).
 *
 * 작업 방식(마운트·복사) 문구와 컨테이너 런타임의 상태. `constants.js` 에서 절째로 옮겼다 — 값과 이름은 그대로다.
 * `constants-term.js` 뒤에 로드된다.
 */
// ── 샌드박스 창의 작업 방식 (SANDBOX_PICK_COPY_SRS FR-SPK-10·23) ──
//
// 고를 수 있는 방식과 그 사실(`copies`)은 서버가 프로파일마다 싣는다
// (`/api/sandbox/profiles` 의 `workPicks`, SERVER_DRIVEN_ACTIONS_SRS K-i).
// **뜻이 다른 것은 표기가 아니라 결과다** — 마운트는 컨테이너 안 변경이 호스트에
// 남고, 복사는 남지 않는다. 그 차이를 화면 세 자리에서 같은 말로 알린다
// (FR-SPK-21): 선택창의 버튼, 입력란 도움말, 사이드바 창 배지.
// FR-SBM-5: 마운트에 폴더를 함께 고르면 그 창은 격리 경계가 아니다. 등급 배지는
// 프로파일의 것이므로(FR-SBM-4) 그 사실은 이 줄이 따로 말한다.
const SANDBOX_MOUNT_WARN=t('core.sandbox_mount_warn');
const SANDBOX_WORK_PICK_LABEL=t('core.sandbox_work_pick_label');
// FR-SPK-3·4: 입력란은 언제나 보이고 비어 있다. 지금 있는 자리는 버튼으로만 넣는다.
const SANDBOX_WORKDIR_LABEL=t('core.sandbox_workdir_label');
const SANDBOX_WORKDIR_PLACEHOLDER=t('core.sandbox_workdir_placeholder');
// FR-SPK-7: 프로파일이 scratch 하나뿐일 때. 이 안내가 없으면 사용자는 프로파일을
// 늘리는 길이 있다는 것 자체를 알 수 없다.
// UX_BATCH6_SRS FR-SBM-1: 마운트는 이제 여기서 고른다 — 안내가 가리키던 것이
// 사라졌다. 남은 것은 **이미지**다: scratch 는 debian 한 벌이고, 다른 도구가
// 필요하면 dev 프로파일에 그 이미지를 적어야 한다.
const SANDBOX_DEV_HINT=t('core.sandbox_dev_hint');
const SANDBOX_DEV_SETTINGS=t('core.sandbox_dev_settings');
// FR-SPK-22: 복사본으로 연 창의 사이드바 배지.
const SANDBOX_COPY_PROGRESS=t('core.sandbox_copy_progress');
const SANDBOX_COPY_BADGE=t('core.sandbox_copy_badge');
const SANDBOX_COPY_BADGE_TITLE=t('core.sandbox_copy_badge_title');

// ── 컨테이너 런타임의 상태 (UX_BATCH5_SRS 묶음 B / FR-SRT-1~8) ──
//
// 종전에는 프로파일이 비었다는 것 하나로 "설치 안 됨" 과 "실행 안 됨" 을 한꺼번에
// 알렸다. 그 둘은 **사용자가 할 일이 다르다** — 하나는 설치이고 하나는 실행이다.
// 그리고 데몬이 죽어도 프로파일 목록은 정상으로 오므로(§2.3 실측), 그 안내는
// 실제로 닿지도 않았다.
// FR-SRT-7: 기동 뒤 데몬이 뜨기를 기다리는 주기와 상한 (NFR-SRT-2). Docker Desktop
// 의 기동은 수십 초가 걸리므로 상한을 넉넉히 둔다.
const SBX_RT_POLL_MS=2000;
const SBX_RT_POLL_MAX_MS=60000;
// FR-SRT-6: 이 문장이 없으면 사용자는 설치하고도 같은 모달을 다시 본다 — 런타임을
// 찾는 일은 서버가 뜰 때 한 번뿐이다 (`sandboxplace.Wire`).
const SBX_RT_MSG_RESTART=t('core.sbx_rt_msg_restart');
// D-5: linux 의 기동은 권한을 요구한다. 서버가 sudo 를 부르면 비밀번호를 받을 길이
// 없어 무응답으로 멈추므로, 사용자가 자기 셸에서 치는 것이 유일하게 끝나는 길이다.
const SBX_RT_MSG_MANUAL=t('core.sbx_rt_msg_manual');
const SBX_RT_START=t('core.sbx_rt_start');
const SBX_RT_COPY=t('core.sbx_rt_copy');
const SBX_RT_COPIED=t('core.sbx_rt_copied');
const SBX_RT_CLOSE=t('core.sbx_rt_close');
const SBX_RT_STARTING=t('core.sbx_rt_starting');
const SBX_RT_START_FAIL=t('core.sbx_rt_start_fail');
// 상한을 넘긴 것은 실패와 다르다 — 명령은 돌았고 데몬이 아직 안 떴을 뿐이다.
const SBX_RT_TIMEOUT=t('core.sbx_rt_timeout');
const SBX_RT_NO_CMD=t('core.sbx_rt_no_cmd');
const SBX_RT_DOCS='https://docs.docker.com/get-started/get-docker/';
