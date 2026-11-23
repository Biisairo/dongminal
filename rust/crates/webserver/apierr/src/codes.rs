//! 오류 코드 (Go `apierr/codes*.go` 에서 기계적으로 옮겼다). 값이 곧 와이어 계약이다.

pub const CODE_BAD_REQUEST: &str = "bad_request";
pub const CODE_NOT_FOUND: &str = "not_found";
pub const CODE_NOT_REPO: &str = "not_a_git_repo";
pub const CODE_REPO_MISSING: &str = "repo_missing";
pub const CODE_GIT_MISSING: &str = "git_missing";
pub const CODE_TIMEOUT: &str = "git_timeout";
pub const CODE_CANCELED: &str = "git_canceled";
pub const CODE_UNAVAILABLE: &str = "git_unavailable";
pub const CODE_FAILED: &str = "git_failed";
pub const CODE_REF_NAME: &str = "ref_name_invalid";
pub const CODE_BRANCH_EXISTS: &str = "branch_exists";
pub const CODE_BRANCH_NOT_MERGED: &str = "branch_not_merged";
pub const CODE_BRANCH_CURRENT: &str = "branch_is_current";
pub const CODE_TAG_EXISTS: &str = "tag_exists";
pub const CODE_MERGE_PARENT: &str = "merge_parent_required";
pub const CODE_RESET_MODE: &str = "reset_mode_invalid";
pub const CODE_NO_REMOTE: &str = "no_remote";
pub const CODE_REMOTE_EXISTS: &str = "remote_exists";
pub const CODE_REMOTE_MISSING: &str = "remote_missing";
pub const CODE_PUBLISH_REQUIRED: &str = "publish_required";
pub const CODE_SYNC_NOT_FOUND: &str = "sync_not_found";
pub const CODE_JOB_BUSY: &str = "job_busy";
pub const CODE_JOB_NOT_FOUND: &str = "job_not_found";
pub const CODE_REPO_BUSY: &str = "repo_busy";
pub const CODE_INDEX_LOCKED: &str = "index_locked";
pub const CODE_SERVER_SHUTDOWN: &str = "server_shutdown";
pub const CODE_NOTHING_TO_STASH: &str = "nothing_to_stash";
pub const CODE_UNTRACKED_ONLY: &str = "untracked_only";
pub const CODE_STASH_KEPT: &str = "stash_kept";
pub const CODE_SUBMODULE_INNER_ONLY: &str = "submodule_inner_only";
pub const CODE_STASH_MOVED: &str = "stash_moved";
pub const CODE_STALE_OBSERVATION: &str = "stale_observation";
pub const CODE_PATCH_EMPTY: &str = "patch_empty";
pub const CODE_OPERATION_MISMATCH: &str = "operation_mismatch";
pub const CODE_NO_OPERATION: &str = "no_operation";
pub const CODE_OPERATION_IN_PROGRESS: &str = "operation_in_progress";
pub const CODE_TARGET_IS_HEAD: &str = "target_is_head";
pub const CODE_ROOT_COMMIT: &str = "root_commit";
pub const CODE_MERGE_COMMIT: &str = "merge_commit";
pub const CODE_NOT_LOCAL_BRANCH: &str = "not_local_branch";
pub const CODE_NOT_REMOTE_BRANCH: &str = "not_remote_branch";
pub const CODE_NO_UPSTREAM: &str = "no_upstream";
pub const CODE_NO_TRACKING_BRANCH: &str = "no_tracking_branch";
pub const CODE_MANY_TRACKING_BRANCH: &str = "many_tracking_branches";
pub const CODE_RESOLVE_PARTIAL: &str = "resolve_partial";
pub const CODE_TAG_KIND_INVALID: &str = "tag_kind_invalid";
pub const CODE_TAG_MESSAGE_REQUIRED: &str = "tag_message_required";
pub const CODE_UPSTREAM_UNKNOWN: &str = "upstream_unknown";
pub const CODE_EMPTY_NAME: &str = "empty_name";
pub const CODE_EMPTY_REF: &str = "empty_ref";
pub const CODE_EMPTY_URL: &str = "empty_url";
pub const CODE_EMPTY_PATH: &str = "empty_path";
pub const CODE_EMPTY_REV: &str = "empty_rev";
pub const CODE_REMOTE_NAME_INVALID: &str = "remote_name_invalid";
pub const CODE_REMOTE_URL_INVALID: &str = "remote_url_invalid";
pub const CODE_NO_HEAD: &str = "no_head";
pub const CODE_NOTHING_TO_CLEAN: &str = "nothing_to_clean";
pub const CODE_CONFIRM_REQUIRED: &str = "confirmation_required";
pub const CODE_PREFLIGHT_BLOCKED: &str = "preflight_blocked";
pub const CODE_UNDO_EXPIRED: &str = "undo_expired";
pub const CODE_EMPTY_MESSAGE: &str = "empty_message";
pub const CODE_NOTHING_STAGED: &str = "nothing_staged";
pub const CODE_RECORD_MISSING: &str = "record_missing";
pub const CODE_NOT_TEXT: &str = "not_text";
pub const CODE_IGNORE_PATH: &str = "unsafe_ignore_path";
pub const CODE_WORKTREE_EXISTS: &str = "worktree_exists";
pub const CODE_EXISTS: &str = "exists";
pub const CODE_OUTSIDE_ROOT: &str = "outside_root";
pub const CODE_PERMISSION: &str = "permission_denied";
pub const CODE_IO: &str = "io_failed";
pub const CODE_TOO_LARGE: &str = "too_large";
pub const CODE_BUSY: &str = "busy";
pub const CODE_FS_NOT_REPO: &str = "not_repo";
pub const CODE_EDITOR_ROOT_PROTECTED: &str = "editor_root_protected";
pub const CODE_HOME_PROTECTED: &str = "home_protected";
pub const CODE_FILESYSTEM_ROOT_PROTECTED: &str = "filesystem_root_protected";
pub const CODE_TOO_MANY_ENTRIES: &str = "too_many_entries";
pub const CODE_INTO_SELF: &str = "into_self";
pub const CODE_NAME_HAS_SEPARATOR: &str = "name_has_separator";
pub const CODE_NAME_RESERVED: &str = "name_reserved";
pub const CODE_NOT_A_DIRECTORY: &str = "not_a_directory";
pub const CODE_NAME_TOO_LONG: &str = "name_too_long";
pub const CODE_FORBIDDEN: &str = "forbidden";
pub const CODE_INTERNAL: &str = "internal_error";
pub const CODE_CONFLICT: &str = "conflict";
pub const CODE_NOT_ALLOWED: &str = "method_not_allowed";
pub const CODE_INVALID_JSON: &str = "invalid_json";
pub const CODE_MISSING_ARG: &str = "missing_argument";
pub const CODE_BODY_TOO_BIG: &str = "body_too_large";
pub const CODE_TOOL_NOT_FOUND: &str = "tool_not_found";
pub const CODE_TOOLS_UNREADY: &str = "tools_unavailable";
pub const CODE_TOOL_CWD_MISSING: &str = "tool_cwd_missing";
pub const CODE_SANDBOX_UNREADY: &str = "sandbox_unavailable";
pub const CODE_STREAM_UNSUPPORT: &str = "streaming_unsupported";
pub const CODE_RUNTIME_MISSING: &str = "runtime_missing";
pub const CODE_RUNTIME_START_MANUAL: &str = "runtime_start_manual";
pub const CODE_UPLOAD_NO_TOOL_CWD: &str = "upload_no_tool_cwd";
pub const CODE_WORK_UNREADY: &str = "workspace_unavailable";
pub const CODE_STALE_REV: &str = "stale_revision";
pub const CODE_IF_MATCH_REQUIRED: &str = "if_match_required";
pub const CODE_SAVE_FAILED: &str = "save_failed";
pub const CODE_NOT_A_FILE: &str = "not_a_file";
pub const CODE_NOT_AN_IMAGE: &str = "not_an_image";
pub const CODE_ABS_PATH_NEEDED: &str = "path_must_be_absolute";
pub const CODE_FILE_CHANGED: &str = "file_changed_on_disk";
pub const CODE_ENCODING_UNMAPPABLE: &str = "encoding_unmappable";
pub const CODE_ENCODING_UNDECODABLE: &str = "encoding_undecodable";
pub const CODE_ALREADY_UTF8: &str = "already_utf8";
pub const CODE_ACCESS_UNREADY: &str = "access_store_unavailable";
pub const CODE_HOST_REJECTED: &str = "host_rejected";
pub const CODE_LOCKS_YOU_OUT: &str = "locks_you_out";
pub const CODE_UNKNOWN_ACTION: &str = "unknown_action";
pub const CODE_CORRUPT_ASSET: &str = "corrupt_asset";
pub const CODE_UPDATE_UNREADY: &str = "update_unavailable";
pub const CODE_BIND_PORT_INVALID: &str = "bind_port_invalid";
pub const CODE_BIND_PORT_IN_USE: &str = "bind_port_in_use";
pub const CODE_BIND_REBIND_FAILED: &str = "bind_rebind_failed";
pub const CODE_BIND_BUSY: &str = "bind_busy";
pub const CODE_BIND_LOCAL_ONLY: &str = "bind_local_only";
pub const CODE_BIND_UNAVAILABLE: &str = "bind_unavailable";
pub const CODE_CHAT_BAD_REQUEST: &str = "chat_bad_request";
pub const CODE_CHAT_TOO_LARGE: &str = "chat_too_large";
pub const CODE_CHAT_RATE_LIMITED: &str = "chat_rate_limited";
pub const CODE_CHAT_NOT_IN_ROOM: &str = "chat_not_in_room";
pub const CODE_CHAT_NO_SUCH_ROOM: &str = "chat_no_such_room";
pub const CODE_CHAT_NO_SUCH_PARTICIPANT: &str = "chat_no_such_participant";
pub const CODE_CHAT_UNAVAILABLE: &str = "chat_unavailable";
pub const CODE_CHAT_DAEMON_RESTART: &str = "chat_daemon_restart";
pub const CODE_CHAT_UNREACHABLE: &str = "chat_unreachable";
pub const CODE_CHAT_BAD_CODE: &str = "chat_bad_code";
pub const CODE_CHAT_LOCKED: &str = "chat_locked";
pub const CODE_CHAT_NO_HELPER: &str = "chat_no_helper";
pub const CODE_CLAUDE_ACCOUNTS_UNAVAILABLE: &str = "claude_accounts_unavailable";
pub const CODE_CLAUDE_ACCOUNT_NOT_FOUND: &str = "claude_account_not_found";
pub const CODE_CLAUDE_ACCOUNT_INVALID: &str = "claude_account_invalid";
pub const CODE_CLAUDE_NOT_LOGGED_IN: &str = "claude_not_logged_in";
pub const CODE_CLAUDE_BACKUP_EMPTY: &str = "claude_backup_empty";
pub const CODE_CLAUDE_LOCKED: &str = "claude_locked";
pub const CODE_CLAUDE_LIVE_CHANGED: &str = "claude_live_changed";
pub const CODE_CLAUDE_NO_CANDIDATE: &str = "claude_no_candidate";
pub const CODE_CLAUDE_KEYCHAIN: &str = "claude_keychain_unavailable";
pub const CODE_CLAUDE_TOO_SOON: &str = "claude_too_soon";
pub const CODE_CLAUDE_CSWAP_RUNNING: &str = "claude_cswap_running";
pub const CODE_EDGE_UNAVAILABLE: &str = dm_shared_edge::CODE_UNAVAILABLE;
pub const CODE_EDGE_CONFIG_INVALID: &str = dm_shared_edge::CODE_CONFIG_INVALID;
pub const CODE_EDGE_PORT_CLOSED: &str = dm_shared_edge::CODE_PORT_CLOSED;
pub const CODE_EDGE_ADDR_REQUIRED: &str = dm_shared_edge::CODE_ADDR_REQUIRED;
pub const CODE_EDGE_INVITE_INVALID: &str = dm_shared_edge::CODE_INVITE_INVALID;
pub const CODE_EDGE_NO_INVITE: &str = dm_shared_edge::CODE_NO_INVITE;
pub const CODE_EDGE_TOKEN_INVALID: &str = dm_shared_edge::CODE_TOKEN_INVALID;
pub const CODE_EDGE_FP_MISMATCH: &str = dm_shared_edge::CODE_FP_MISMATCH;
pub const CODE_EDGE_UNREACHABLE: &str = dm_shared_edge::CODE_UNREACHABLE;
pub const CODE_EDGE_REJECTED: &str = dm_shared_edge::CODE_REJECTED;
pub const CODE_EDGE_NOT_FOUND: &str = dm_shared_edge::CODE_NOT_FOUND;
pub const CODE_EDGE_NOT_EDGE: &str = dm_shared_edge::CODE_NOT_EDGE;
pub const CODE_EDGE_AMBIGUOUS: &str = dm_shared_edge::CODE_AMBIGUOUS;
pub const CODE_EDGE_RATE_LIMITED: &str = dm_shared_edge::CODE_RATE_LIMITED;
pub const CODE_EDGE_DAEMON_RESTART: &str = dm_shared_edge::CODE_DAEMON_RESTART;
pub const CODE_EDGE_ADDR_UNKNOWN: &str = dm_shared_edge::CODE_ADDR_UNKNOWN;
pub const CODE_EDGE_PEER_OUTDATED: &str = dm_shared_edge::CODE_PEER_OUTDATED;
pub const CODE_EDGE_ALREADY_EDGE: &str = dm_shared_edge::CODE_ALREADY_EDGE;
pub const CODE_TELEGRAM_UNAVAILABLE: &str = "telegram_unavailable";
pub const CODE_TELEGRAM_TOKEN_INVALID: &str = "telegram_token_invalid";
pub const CODE_TELEGRAM_UNREACHABLE: &str = "telegram_unreachable";
pub const CODE_TELEGRAM_CONFIG_INVALID: &str = "telegram_config_invalid";
pub const CODE_TELEGRAM_NO_TOKEN: &str = "telegram_no_token";
pub const CODE_RUN_CLOSED: &str = "run_closed";
pub const CODE_MEMBER_NOT_ATTACHED: &str = "member_not_attached";

pub(crate) const GIT_CODES: &[&str] = &[
    CODE_NOT_REPO,
    CODE_REPO_MISSING,
    CODE_GIT_MISSING,
    CODE_TIMEOUT,
    CODE_CANCELED,
    CODE_UNAVAILABLE,
    CODE_FAILED,
    CODE_REF_NAME,
    CODE_BRANCH_EXISTS,
    CODE_BRANCH_NOT_MERGED,
    CODE_BRANCH_CURRENT,
    CODE_TAG_EXISTS,
    CODE_MERGE_PARENT,
    CODE_RESET_MODE,
    CODE_NO_REMOTE,
    CODE_REMOTE_EXISTS,
    CODE_REMOTE_MISSING,
    CODE_PUBLISH_REQUIRED,
    CODE_SYNC_NOT_FOUND,
    CODE_JOB_BUSY,
    CODE_JOB_NOT_FOUND,
    CODE_REPO_BUSY,
    CODE_INDEX_LOCKED,
    CODE_SERVER_SHUTDOWN,
    CODE_STASH_MOVED,
    CODE_RESOLVE_PARTIAL,
    CODE_NOTHING_TO_STASH,
    CODE_UNTRACKED_ONLY,
    CODE_STASH_KEPT,
    CODE_SUBMODULE_INNER_ONLY,
    CODE_STALE_OBSERVATION,
    CODE_PATCH_EMPTY,
    CODE_OPERATION_MISMATCH,
    CODE_NO_OPERATION,
    CODE_OPERATION_IN_PROGRESS,
    CODE_TARGET_IS_HEAD,
    CODE_ROOT_COMMIT,
    CODE_MERGE_COMMIT,
    CODE_NOT_LOCAL_BRANCH,
    CODE_NOT_REMOTE_BRANCH,
    CODE_NO_UPSTREAM,
    CODE_NO_TRACKING_BRANCH,
    CODE_MANY_TRACKING_BRANCH,
    CODE_TAG_KIND_INVALID,
    CODE_TAG_MESSAGE_REQUIRED,
    CODE_UPSTREAM_UNKNOWN,
    CODE_EMPTY_NAME,
    CODE_EMPTY_REF,
    CODE_EMPTY_URL,
    CODE_EMPTY_PATH,
    CODE_EMPTY_REV,
    CODE_REMOTE_NAME_INVALID,
    CODE_REMOTE_URL_INVALID,
    CODE_NO_HEAD,
    CODE_NOTHING_TO_CLEAN,
    CODE_CONFIRM_REQUIRED,
    CODE_PREFLIGHT_BLOCKED,
    CODE_UNDO_EXPIRED,
    CODE_EMPTY_MESSAGE,
    CODE_NOTHING_STAGED,
    CODE_RECORD_MISSING,
    CODE_NOT_TEXT,
    CODE_IGNORE_PATH,
    CODE_WORKTREE_EXISTS,
    CODE_EXISTS,
    CODE_OUTSIDE_ROOT,
    CODE_PERMISSION,
    CODE_IO,
    CODE_TOO_LARGE,
    CODE_BUSY,
    CODE_FS_NOT_REPO,
    CODE_EDITOR_ROOT_PROTECTED,
    CODE_HOME_PROTECTED,
    CODE_FILESYSTEM_ROOT_PROTECTED,
    CODE_TOO_MANY_ENTRIES,
    CODE_INTO_SELF,
    CODE_NAME_HAS_SEPARATOR,
    CODE_NAME_RESERVED,
    CODE_NOT_A_DIRECTORY,
    CODE_NAME_TOO_LONG,
];
pub(crate) const CORE_CODES: &[&str] = &[
    CODE_BAD_REQUEST,
    CODE_NOT_FOUND,
    CODE_FORBIDDEN,
    CODE_INTERNAL,
    CODE_CONFLICT,
    CODE_NOT_ALLOWED,
    CODE_INVALID_JSON,
    CODE_MISSING_ARG,
    CODE_BODY_TOO_BIG,
    CODE_TOOL_NOT_FOUND,
    CODE_TOOLS_UNREADY,
    CODE_TOOL_CWD_MISSING,
    CODE_SANDBOX_UNREADY,
    CODE_STREAM_UNSUPPORT,
    CODE_RUNTIME_MISSING,
    CODE_RUNTIME_START_MANUAL,
    CODE_UPLOAD_NO_TOOL_CWD,
    CODE_WORK_UNREADY,
    CODE_STALE_REV,
    CODE_IF_MATCH_REQUIRED,
    CODE_SAVE_FAILED,
    CODE_NOT_A_FILE,
    CODE_NOT_AN_IMAGE,
    CODE_ABS_PATH_NEEDED,
    CODE_FILE_CHANGED,
    CODE_ENCODING_UNMAPPABLE,
    CODE_ENCODING_UNDECODABLE,
    CODE_ALREADY_UTF8,
    CODE_ACCESS_UNREADY,
    CODE_HOST_REJECTED,
    CODE_LOCKS_YOU_OUT,
    CODE_UNKNOWN_ACTION,
    CODE_CORRUPT_ASSET,
    CODE_UPDATE_UNREADY,
];
pub(crate) const CHAT_CODES: &[&str] = &[
    CODE_CHAT_BAD_REQUEST,
    CODE_CHAT_TOO_LARGE,
    CODE_CHAT_RATE_LIMITED,
    CODE_CHAT_NOT_IN_ROOM,
    CODE_CHAT_NO_SUCH_ROOM,
    CODE_CHAT_NO_SUCH_PARTICIPANT,
    CODE_CHAT_UNAVAILABLE,
    CODE_CHAT_DAEMON_RESTART,
    CODE_CHAT_UNREACHABLE,
    CODE_CHAT_BAD_CODE,
    CODE_CHAT_LOCKED,
    CODE_CHAT_NO_HELPER,
];
pub(crate) const TELEGRAM_CODES: &[&str] = &[
    CODE_TELEGRAM_UNAVAILABLE,
    CODE_TELEGRAM_TOKEN_INVALID,
    CODE_TELEGRAM_UNREACHABLE,
    CODE_TELEGRAM_CONFIG_INVALID,
    CODE_TELEGRAM_NO_TOKEN,
];
pub(crate) const CLAUDE_CODES: &[&str] = &[
    CODE_CLAUDE_ACCOUNTS_UNAVAILABLE,
    CODE_CLAUDE_ACCOUNT_NOT_FOUND,
    CODE_CLAUDE_ACCOUNT_INVALID,
    CODE_CLAUDE_NOT_LOGGED_IN,
    CODE_CLAUDE_BACKUP_EMPTY,
    CODE_CLAUDE_LOCKED,
    CODE_CLAUDE_LIVE_CHANGED,
    CODE_CLAUDE_NO_CANDIDATE,
    CODE_CLAUDE_KEYCHAIN,
    CODE_CLAUDE_TOO_SOON,
    CODE_CLAUDE_CSWAP_RUNNING,
];
pub(crate) const BIND_CODES: &[&str] = &[
    CODE_BIND_PORT_INVALID,
    CODE_BIND_PORT_IN_USE,
    CODE_BIND_REBIND_FAILED,
    CODE_BIND_BUSY,
    CODE_BIND_LOCAL_ONLY,
    CODE_BIND_UNAVAILABLE,
];

/// 코드 하나의 의미와 복구 안내 (Go `Doc`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Doc {
    pub meaning: &'static str,
    pub recover: &'static str,
}

/// Go `CodeDoc`. 코드 순으로 정렬돼 있다.
pub const CODE_DOC: &[(&str, Doc)] = &[
    (
        "access_store_unavailable",
        Doc {
            meaning: "허용 목록 계층이 아직 서지 않았습니다.",
            recover: "잠시 뒤 다시 시도하세요.",
        },
    ),
    (
        "already_utf8",
        Doc {
            meaning: "이미 BOM 없는 UTF-8 입니다 — 변환할 것이 없습니다.",
            recover: "읽기 응답의 X-File-Actions 로 미리 확인하세요. convertFrom 없이 보내면 일반 저장입니다.",
        },
    ),
    (
        "bad_request",
        Doc {
            meaning: "요청의 모양이 규약과 다릅니다.",
            recover: "보낸 값의 형식과 필수 항목을 확인하세요. 같은 요청을 다시 보내도 같은 답이 옵니다.",
        },
    ),
    (
        "bind_busy",
        Doc {
            meaning: "다른 바인드 변경이 진행 중입니다.",
            recover: "잠시 뒤 다시 시도하세요.",
        },
    ),
    (
        "bind_local_only",
        Doc {
            meaning: "바인드는 이 컴퓨터(루프백)에서만 바꿀 수 있습니다.",
            recover: "서버가 도는 컴퓨터에서 바꾸세요.",
        },
    ),
    (
        "bind_port_in_use",
        Doc {
            meaning: "그 포트를 다른 프로세스가 쓰고 있습니다. 바인드는 그대로입니다.",
            recover: "다른 포트를 고르거나, 그 포트를 쓰는 프로세스를 끄세요.",
        },
    ),
    (
        "bind_port_invalid",
        Doc {
            meaning: "포트가 1024~65535 밖입니다.",
            recover: "1024 이상 65535 이하의 포트를 고르세요.",
        },
    ),
    (
        "bind_rebind_failed",
        Doc {
            meaning: "새 호스트로 다시 리슨하지 못해 옛 호스트로 돌아갔습니다.",
            recover: "로그의 사유를 확인하고 다시 시도하세요.",
        },
    ),
    (
        "bind_unavailable",
        Doc {
            meaning: "이 서버는 실행 중에 리스너를 갈아 끼울 수 없습니다.",
            recover: "`server.json` 을 고친 뒤 서버를 다시 띄우세요.",
        },
    ),
    (
        "body_too_large",
        Doc {
            meaning: "본문이 상한을 넘었습니다.",
            recover: "나눠 보내거나 파일 업로드 표면을 쓰세요. 상한은 features.md 의 용량 표에 있습니다.",
        },
    ),
    (
        "branch_exists",
        Doc {
            meaning: "같은 이름의 브랜치가 이미 있습니다.",
            recover: "다른 이름을 쓰거나 기존 것으로 전환하세요.",
        },
    ),
    (
        "branch_is_current",
        Doc {
            meaning: "지금 올라가 있는 브랜치는 지울 수 없습니다.",
            recover: "다른 브랜치로 옮긴 뒤 지우세요.",
        },
    ),
    (
        "branch_not_merged",
        Doc {
            meaning: "병합되지 않은 브랜치라 그냥 지울 수 없습니다.",
            recover: "정말 버릴 것이면 강제 삭제를 고르세요 — 그 커밋들은 되찾기 어렵습니다.",
        },
    ),
    (
        "busy",
        Doc {
            meaning: "지금은 자리가 없습니다.",
            recover: "**재시도가 유효한 유일한 4xx 입니다.** 잠시 뒤 다시 보내세요.",
        },
    ),
    (
        "chat_bad_code",
        Doc {
            meaning: "사람 명령의 OTP 코드가 틀렸거나 이미 쓴 코드입니다.",
            recover: "OTP 앱의 새 코드를 넣으세요. 5번 틀리면 5분 잠깁니다.",
        },
    ),
    (
        "chat_bad_request",
        Doc {
            meaning: "채팅 요청의 모양이 틀렸습니다.",
            recover: "보낸 값(방 id·이름·목적·본문)의 형식과 필수 항목을 확인하세요.",
        },
    ),
    (
        "chat_daemon_restart",
        Doc {
            meaning: "붙은 데몬이 채팅을 모르는 옛 판입니다.",
            recover: "dongminal start 로 데몬을 세션을 유지하며 교체하세요. 데몬이 교체를 모르는 옛 판이면 dongminal start --refresh-daemon 이 한 번 필요하고, 이때 모든 터미널 세션이 끊깁니다.",
        },
    ),
    (
        "chat_locked",
        Doc {
            meaning: "코드를 5번 틀려 도우미가 잠겼습니다. 메시지는 풀리는 시각(RFC 3339)입니다.",
            recover: "그 시각이 지난 뒤 다시 넣으세요.",
        },
    ),
    (
        "chat_no_helper",
        Doc {
            meaning: "이 노드에 사람 명령의 도우미가 없거나 닿지 않습니다.",
            recover: "OS 기본 터미널에서 sudo dongminal otp install 로 설치하세요. dongminal otp status 로 확인합니다.",
        },
    ),
    (
        "chat_no_such_participant",
        Doc {
            meaning: "그 참가자가 온라인 목록에 없습니다.",
            recover: "온라인 목록을 다시 받아 지금 있는 참가자를 고르세요.",
        },
    ),
    (
        "chat_no_such_room",
        Doc {
            meaning: "그 방이 없습니다 — 참가자가 모두 나가 사라졌습니다.",
            recover: "방 목록을 다시 받아 확인하세요.",
        },
    ),
    (
        "chat_not_in_room",
        Doc {
            meaning: "그 방에 들어가 있지 않습니다.",
            recover: "방에 다시 들어간 뒤 보내세요. 개인채팅은 상대가 나가면 끝나므로 새로 만드세요.",
        },
    ),
    (
        "chat_rate_limited",
        Doc {
            meaning: "참가자 하나가 1분 동안 보낼 수 있는 글 수(30)를 넘었습니다.",
            recover: "잠시 뒤 다시 보내세요.",
        },
    ),
    (
        "chat_too_large",
        Doc {
            meaning: "글 하나가 16 KiB 를 넘었습니다.",
            recover: "글을 나눠 보내세요.",
        },
    ),
    (
        "chat_unavailable",
        Doc {
            meaning: "데몬에 채팅이 서지 않았습니다 — 노드 인증서를 읽지 못했습니다.",
            recover: "daemon.log 의 edge identity 줄을 보세요. 노드 기능이 서야 채팅도 섭니다.",
        },
    ),
    (
        "chat_unreachable",
        Doc {
            meaning: "데몬에 닿지 못했습니다.",
            recover: "dongminal health 로 데몬 연결을 보세요.",
        },
    ),
    (
        "claude_account_invalid",
        Doc {
            meaning: "계정 값이나 요청 값이 허용 범위를 벗어났습니다(별칭 24자, 문턱값 50~100, 우선순위 0~1000, 정해진 색, 자동 전환 설정, 전환의 by·strategy, 기록의 limit).",
            recover: "범위 안의 값으로 다시 보내세요.",
        },
    ),
    (
        "claude_account_not_found",
        Doc {
            meaning: "그런 Claude 계정이 등록되어 있지 않습니다.",
            recover: "`dmctl account list` 로 계정 ID 를 확인하세요.",
        },
    ),
    (
        "claude_accounts_unavailable",
        Doc {
            meaning: "이 서버에는 Claude 계정 기능이 서지 않았습니다 — 데이터 폴더 없이 떴습니다.",
            recover: "dongminal 을 데이터 폴더($DONGMINAL_HOME)와 함께 다시 띄우세요.",
        },
    ),
    (
        "claude_backup_empty",
        Doc {
            meaning: "이 계정의 자격증명 백업이 비었습니다.",
            recover: "그 계정으로 Claude Code 에 로그인한 뒤 '현재 계정 추가'로 다시 추가하세요.",
        },
    ),
    (
        "claude_cswap_running",
        Doc {
            meaning: "cswap 자동 전환(`cswap auto`)이 돌고 있어 자동 전환을 켜지 않았습니다. 둘이 활성 자격증명을 서로 덮어씁니다.",
            recover: "`cswap auto` 를 멈춘 뒤 다시 켜세요.",
        },
    ),
    (
        "claude_keychain_unavailable",
        Doc {
            meaning: "키체인을 읽을 수 없습니다.",
            recover: "키체인 잠금을 풀고 다시 시도하세요.",
        },
    ),
    (
        "claude_live_changed",
        Doc {
            meaning: "전환 도중 활성 자격증명이 바뀌었습니다.",
            recover: "다시 시도하세요.",
        },
    ),
    (
        "claude_locked",
        Doc {
            meaning: "Claude Code 가 자격증명이나 설정을 쓰는 중입니다.",
            recover: "잠시 뒤 다시 시도하세요.",
        },
    ),
    (
        "claude_no_candidate",
        Doc {
            meaning: "전환할 다른 계정이 없습니다.",
            recover: "계정을 더 추가하거나 제외를 푸세요.",
        },
    ),
    (
        "claude_not_logged_in",
        Doc {
            meaning: "Claude Code 에 로그인한 계정이 없거나 자격증명이 비었습니다.",
            recover: "Claude Code 에서 `/login` 으로 추가할 계정에 로그인한 뒤 다시 시도하세요.",
        },
    ),
    (
        "claude_too_soon",
        Doc {
            meaning: "조금 전에 조회했거나, 서버 요청 제한 때문에 물러나는 중입니다.",
            recover: "응답의 `retryAt` 뒤에 다시 시도하세요.",
        },
    ),
    (
        "confirmation_required",
        Doc {
            meaning: "되돌리기 어려운 동작이라 확인이 필요합니다.",
            recover: "화면의 확인을 거치거나 confirm 을 함께 보내세요.",
        },
    ),
    (
        "conflict",
        Doc {
            meaning: "다른 변경이 먼저 반영되어 지금 상태와 어긋납니다.",
            recover: "현재 상태를 다시 받아 확인한 뒤 다시 시도하세요. 덮어쓰지 마세요.",
        },
    ),
    (
        "corrupt_asset",
        Doc {
            meaning: "내장 자산을 읽지 못했습니다.",
            recover: "바이너리가 손상됐을 수 있습니다. 다시 내려받아 설치하세요.",
        },
    ),
    (
        "edge_addr_required",
        Doc {
            meaning: "초대 코드에 담을 이 노드의 주소가 없습니다.",
            recover: "초대를 만들 때 주소(--addr)를 주거나 노드 설정의 알릴 주소(advertise)를 정하세요.",
        },
    ),
    (
        "edge_addr_unknown",
        Doc {
            meaning: "상대 주소를 몰라 이 노드가 걸 수 없습니다. 상대의 노드 포트가 닫혀 있을 때 맺은 간선입니다.",
            recover: "상대에게 노드 포트를 켜 달라고 하거나, Edges 의 주소 고치기로 상대 주소를 넣으세요.",
        },
    ),
    (
        "edge_already_edge",
        Doc {
            meaning: "이미 간선인 노드입니다.",
            recover: "Edges 의 간선 목록을 보세요.",
        },
    ),
    (
        "edge_ambiguous",
        Doc {
            meaning: "지문 앞자리가 간선 둘 이상에 맞습니다.",
            recover: "dmctl edges 로 지문을 보고 더 긴 앞자리를 주세요.",
        },
    ),
    (
        "edge_config_invalid",
        Doc {
            meaning: "노드 설정 값이 규칙에 맞지 않습니다.",
            recover: "이름은 영문·숫자·`.`·`_`·`-` 1~32자, 포트는 1~65535, 듣는 주소는 IP 입니다. 알릴 주소는 IP 주소나 호스트명입니다. 등록 요청이 이 오류로 거절되면 상대가 쓸 수 없는 주소(zone 이 붙은 link-local 등)에서 왔습니다. 요청하는 노드에 알릴 주소를 정하세요.",
        },
    ),
    (
        "edge_daemon_restart",
        Doc {
            meaning: "붙은 데몬이 노드 기능을 모르는 옛 판입니다. 노드 기능을 쓰려면 데몬을 다시 시작해야 합니다.",
            recover: "dongminal start 로 데몬을 세션을 유지하며 교체하세요. 데몬이 교체를 모르는 옛 판이면 dongminal start --refresh-daemon 이 한 번 필요하고, 이때 모든 터미널 세션이 끊깁니다.",
        },
    ),
    (
        "edge_fingerprint_mismatch",
        Doc {
            meaning: "상대 노드의 지문이 초대 코드와 다릅니다. 아무것도 보내지 않았습니다.",
            recover: "주소가 다른 기계를 가리키는지 확인하세요. 같은 기계라면 상대가 신원을 새로 만든 것이니 초대를 다시 받으세요.",
        },
    ),
    (
        "edge_invite_invalid",
        Doc {
            meaning: "초대 코드의 모양이 틀렸습니다.",
            recover: "dmedge1: 로 시작하는 코드를 잘리지 않게 통째로 붙여 넣으세요.",
        },
    ),
    (
        "edge_no_invite",
        Doc {
            meaning: "상대 노드에 살아 있는 초대가 없습니다 — 만료됐거나 이미 쓰였습니다.",
            recover: "상대 노드에서 초대를 새로 만들어 받으세요. 초대는 10분 살고 한 번만 쓸 수 있습니다.",
        },
    ),
    (
        "edge_not_edge",
        Doc {
            meaning: "상대 노드가 이 노드를 간선으로 알지 않습니다 — 상대 쪽에서 간선을 지웠습니다.",
            recover: "필요하면 새 초대로 간선을 다시 맺으세요.",
        },
    ),
    (
        "edge_not_found",
        Doc {
            meaning: "그 지문의 간선이 없습니다.",
            recover: "dmctl edges 로 간선의 지문을 확인하세요. 지문 앞자리는 8자리 이상이어야 합니다.",
        },
    ),
    (
        "edge_peer_outdated",
        Doc {
            meaning: "상대 노드가 간선 연결을 모르는 옛 판입니다.",
            recover: "상대 노드의 dongminal 을 업데이트하세요.",
        },
    ),
    (
        "edge_port_closed",
        Doc {
            meaning: "노드 포트가 열려 있지 않아 초대를 만들 수 없습니다.",
            recover: "노드 포트를 켜고(설정 ▸ 간선 또는 PUT /api/edges/node), 열지 못한 사유가 있으면 먼저 해결하세요.",
        },
    ),
    (
        "edge_rate_limited",
        Doc {
            meaning: "한 출발지 주소가 1분 동안 보낼 수 있는 등록 요청 수(60)를 넘었습니다.",
            recover: "잠시 뒤 다시 보내세요.",
        },
    ),
    (
        "edge_rejected",
        Doc {
            meaning: "상대 노드가 이 노드를 받지 않았습니다.",
            recover: "상대가 옛 판일 수 있습니다. 상대의 dongminal 을 새 판으로 올리세요.",
        },
    ),
    (
        "edge_token_invalid",
        Doc {
            meaning: "초대 토큰이 맞지 않습니다.",
            recover: "가장 최근에 만든 초대 코드인지 확인하세요. 새 초대를 만들면 이전 코드는 쓸 수 없습니다.",
        },
    ),
    (
        "edge_unavailable",
        Doc {
            meaning: "이 서버에는 노드 기능이 서지 않았습니다 — 노드 인증서를 읽지 못했습니다.",
            recover: "daemon.log 의 edge identity 줄을 보세요. edge-cert.pem·edge-key.pem 이 망가졌다면 둘 다 지우고 다시 시작하면 새 신원이 생깁니다(간선은 다시 맺어야 합니다).",
        },
    ),
    (
        "edge_unreachable",
        Doc {
            meaning: "상대 노드에 닿지 못했습니다.",
            recover: "상대의 노드 포트가 켜져 있는지, 주소·포트가 맞는지, 방화벽이 막지 않는지 확인하세요. 큐·재시도는 없습니다.",
        },
    ),
    (
        "editor_root_protected",
        Doc {
            meaning: "Editor 루트는 지우거나 옮길 수 없습니다.",
            recover: "목록에서 빼려면 Editor 목록의 제거를 쓰세요.",
        },
    ),
    (
        "empty_message",
        Doc {
            meaning: "커밋 메시지가 비었습니다.",
            recover: "메시지를 적으세요.",
        },
    ),
    (
        "empty_name",
        Doc {
            meaning: "이름이 비었습니다.",
            recover: "이름을 적어 다시 보내세요.",
        },
    ),
    (
        "empty_path",
        Doc {
            meaning: "경로가 비었습니다.",
            recover: "경로를 적어 다시 보내세요.",
        },
    ),
    (
        "empty_ref",
        Doc {
            meaning: "대상 ref 가 비었습니다.",
            recover: "브랜치·태그·커밋 가운데 하나를 적어 다시 보내세요.",
        },
    ),
    (
        "empty_rev",
        Doc {
            meaning: "비교할 리비전이 비었습니다.",
            recover: "커밋·브랜치·태그나 `A..B` 범위를 적으세요.",
        },
    ),
    (
        "empty_url",
        Doc {
            meaning: "URL 이 비었습니다.",
            recover: "원격 저장소의 URL 을 적어 다시 보내세요.",
        },
    ),
    (
        "encoding_undecodable",
        Doc {
            meaning: "그 인코딩으로 읽을 수 없는 파일입니다.",
            recover: "다른 인코딩으로 다시 열어 보세요. 문서는 그대로입니다.",
        },
    ),
    (
        "encoding_unmappable",
        Doc {
            meaning: "파일의 인코딩으로 표현할 수 없는 글자가 있어 저장하지 않았습니다.",
            recover: "응답의 줄·열에 있는 글자를 고치거나 \"UTF-8 로 변환해 저장\" 을 쓰세요. 파일은 그대로입니다.",
        },
    ),
    (
        "exists",
        Doc {
            meaning: "같은 이름이 이미 있습니다.",
            recover: "다른 이름을 쓰거나 기존 것을 먼저 치우세요.",
        },
    ),
    (
        "file_changed_on_disk",
        Doc {
            meaning: "저장하려는 파일이 그사이 디스크에서 바뀌었습니다.",
            recover: "바뀐 내용을 확인한 뒤 다시 저장하세요. 이 거절이 남의 변경을 덮는 것을 막았습니다.",
        },
    ),
    (
        "filesystem_root_protected",
        Doc {
            meaning: "파일시스템 루트는 대상이 될 수 없습니다.",
            recover: "그 아래의 폴더를 고르세요.",
        },
    ),
    (
        "forbidden",
        Doc {
            meaning: "요청이 게이트에서 막혔습니다 — 허용되지 않은 기기이거나 허용되지 않은 출처입니다.",
            recover: "Settings ▸ Access 의 허용 목록에 이 기기가 있는지 보세요. 다른 사이트에서 부른 요청이라면 그것은 의도된 거절입니다.",
        },
    ),
    (
        "git_canceled",
        Doc {
            meaning: "git 명령이 취소됐습니다.",
            recover: "다시 시도하세요.",
        },
    ),
    (
        "git_failed",
        Doc {
            meaning: "git 이 실패로 끝났습니다.",
            recover: "본문의 message 에 git 의 마지막 출력이 있습니다. Git ▸ 콘솔 탭에서 전문을 보세요.",
        },
    ),
    (
        "git_missing",
        Doc {
            meaning: "git 실행 파일을 찾지 못했습니다.",
            recover: "git 을 설치하고 PATH 에 있는지 확인하세요.",
        },
    ),
    (
        "git_timeout",
        Doc {
            meaning: "git 명령이 시한 안에 끝나지 않았습니다.",
            recover: "큰 저장소라면 다시 시도하세요. 반복되면 네트워크나 잠금을 의심하세요.",
        },
    ),
    (
        "git_unavailable",
        Doc {
            meaning: "git 계층을 지금 쓸 수 없습니다.",
            recover: "잠시 뒤 다시 시도하세요.",
        },
    ),
    (
        "home_protected",
        Doc {
            meaning: "홈 폴더는 지우거나 옮길 수 없습니다.",
            recover: "그 안의 항목을 대상으로 고르세요.",
        },
    ),
    (
        "host_rejected",
        Doc {
            meaning: "이 서버가 그 이름으로 불릴 수 없습니다.",
            recover: "접속에 쓴 호스트 이름을 Settings ▸ Access 의 hosts 에 더하세요.",
        },
    ),
    (
        "if_match_required",
        Doc {
            meaning: "이 쓰기는 어느 판 위에서 고치는지를 함께 보내야 합니다.",
            recover: "먼저 읽어 판을 받고 If-Match 에 실어 보내세요.",
        },
    ),
    (
        "index_locked",
        Doc {
            meaning: "git 이 index.lock 을 만들지 못했습니다 — 다른 git 이 실행 중이거나 남은 lock 입니다.",
            recover: "터미널 등에서 git 이 돌고 있지 않다면 남은 lock 을 지운 뒤 다시 시도하세요.",
        },
    ),
    (
        "internal_error",
        Doc {
            meaning: "서버 안에서 처리하지 못했습니다.",
            recover: "요청을 다시 보내 보고, 그래도 같으면 응답의 X-Request-Id 로 로그를 찾아 신고에 붙여 주세요.",
        },
    ),
    (
        "into_self",
        Doc {
            meaning: "폴더를 자기 자신이나 자기 하위로 옮기거나 복사할 수 없습니다.",
            recover: "심볼릭 링크를 푼 실제 경로로 판정합니다. 다른 대상 폴더를 고르세요.",
        },
    ),
    (
        "invalid_json",
        Doc {
            meaning: "본문이 JSON 이 아닙니다.",
            recover: "직렬화를 확인하세요. 빈 본문도 여기에 걸립니다.",
        },
    ),
    (
        "io_failed",
        Doc {
            meaning: "디스크 입출력이 실패했습니다.",
            recover: "여유 공간과 디스크 상태를 보세요.",
        },
    ),
    (
        "job_busy",
        Doc {
            meaning: "같은 저장소에서 다른 작업이 돌고 있습니다.",
            recover: "끝나기를 기다렸다 다시 시도하세요.",
        },
    ),
    (
        "job_not_found",
        Doc {
            meaning: "그 작업을 찾지 못했습니다.",
            recover: "이미 끝난 작업입니다.",
        },
    ),
    (
        "locks_you_out",
        Doc {
            meaning: "저장하려는 허용 목록이 지금 접속한 주소(args.you)를 들이지 않습니다. 거절이 아니라 경고입니다.",
            recover: "그 주소를 목록에 더하거나, 다른 길로 접속할 수 있을 때만 저장하세요.",
        },
    ),
    (
        "many_tracking_branches",
        Doc {
            meaning: "이 원격 브랜치를 추적하는 로컬 브랜치가 여럿이라 짝을 정할 수 없습니다.",
            recover: "지울 로컬 브랜치를 직접 고르세요 — 서버는 대상을 대신 정하지 않습니다.",
        },
    ),
    (
        "merge_commit",
        Doc {
            meaning: "머지 커밋이라 뺄 수 없습니다 — 첫 부모만 남고 나머지 갈래가 사라집니다.",
            recover: "부모가 하나인 커밋을 고르세요.",
        },
    ),
    (
        "merge_parent_required",
        Doc {
            meaning: "머지 커밋이라 어느 줄기를 따를지 지정해야 합니다.",
            recover: "부모 번호를 함께 보내세요.",
        },
    ),
    (
        "method_not_allowed",
        Doc {
            meaning: "이 경로가 그 메서드를 받지 않습니다.",
            recover: "문서의 메서드를 확인하세요.",
        },
    ),
    (
        "missing_argument",
        Doc {
            meaning: "필수 항목이 빠졌습니다.",
            recover: "본문의 문구가 빠진 항목의 이름을 말합니다.",
        },
    ),
    (
        "name_has_separator",
        Doc {
            meaning: "이름에 경로 구분자(`/`, Windows 의 `\\`)가 있습니다.",
            recover: "이름 하나만 보내세요. 다른 폴더에 만들려면 parent 를 바꾸세요.",
        },
    ),
    (
        "name_reserved",
        Doc {
            meaning: "`.`·`..` 는 이름으로 쓸 수 없습니다.",
            recover: "다른 이름을 쓰세요.",
        },
    ),
    (
        "name_too_long",
        Doc {
            meaning: "창·탭·그룹 이름이 상한보다 깁니다.",
            recover: "args.max(`GET /api/meta` 의 entityNameMax, UTF-16 단위) 안으로 줄이세요.",
        },
    ),
    (
        "no_head",
        Doc {
            meaning: "아직 커밋이 하나도 없습니다.",
            recover: "첫 커밋을 만든 뒤 다시 시도하세요.",
        },
    ),
    (
        "no_operation",
        Doc {
            meaning: "진행 중인 작업이 없습니다.",
            recover: "이미 끝났거나 중단된 상태입니다.",
        },
    ),
    (
        "no_remote",
        Doc {
            meaning: "원격이 없습니다.",
            recover: "Git ▸ 원격에서 먼저 등록하세요.",
        },
    ),
    (
        "no_tracking_branch",
        Doc {
            meaning: "이 원격 브랜치를 추적하는 로컬 브랜치가 없습니다.",
            recover: "원격만 지우려면 원격 삭제를 쓰세요.",
        },
    ),
    (
        "no_upstream",
        Doc {
            meaning: "이 로컬 브랜치에는 추적하는 원격 브랜치(upstream)가 없습니다.",
            recover: "upstream 을 먼저 설정하거나 다른 브랜치를 고르세요.",
        },
    ),
    (
        "not_a_directory",
        Doc {
            meaning: "디렉터리가 아닙니다.",
            recover: "Editor 루트로는 폴더를 고르세요.",
        },
    ),
    (
        "not_a_file",
        Doc {
            meaning: "지목한 자리가 파일이 아닙니다 (디렉터리이거나 특수 파일).",
            recover: "경로를 확인하세요.",
        },
    ),
    (
        "not_a_git_repo",
        Doc {
            meaning: "그 자리가 git 저장소가 아닙니다.",
            recover: "저장소 안의 경로를 지목하세요.",
        },
    ),
    (
        "not_an_image",
        Doc {
            meaning: "이미지로 읽을 수 없는 파일입니다.",
            recover: "다른 표면으로 여세요 — 편집기는 텍스트를, 내려받기는 모든 형식을 받습니다.",
        },
    ),
    (
        "not_found",
        Doc {
            meaning: "지목한 것이 거기 없습니다.",
            recover: "식별자가 맞는지, 그사이 지워지지 않았는지 확인하세요.",
        },
    ),
    (
        "not_local_branch",
        Doc {
            meaning: "로컬 브랜치에만 할 수 있는 동작인데 대상이 로컬 브랜치가 아닙니다.",
            recover: "로컬 브랜치 이름을 보내세요. 원격 ref 를 옮겨 오려면 그것을 추적하는 로컬을 먼저 만드세요.",
        },
    ),
    (
        "not_remote_branch",
        Doc {
            meaning: "원격 브랜치에만 할 수 있는 동작인데 대상이 원격 브랜치가 아닙니다.",
            recover: "원격 ref 이름(예: origin/x)을 보내세요. 목록이 낡았으면 fetch 로 갱신하세요.",
        },
    ),
    (
        "not_repo",
        Doc {
            meaning: "그 자리가 git 저장소가 아닙니다 (파일 표면의 판정).",
            recover: "저장소 안의 경로를 지목하세요.",
        },
    ),
    (
        "not_text",
        Doc {
            meaning: "텍스트로 읽을 수 없는 파일입니다.",
            recover: "이진 파일은 편집기로 열 수 없습니다.",
        },
    ),
    (
        "nothing_staged",
        Doc {
            meaning: "스테이지에 올린 것이 없습니다.",
            recover: "커밋할 변경을 먼저 올리세요.",
        },
    ),
    (
        "nothing_to_clean",
        Doc {
            meaning: "지울 추적되지 않은 파일이 없습니다.",
            recover: "대상이 있는지 먼저 확인하세요.",
        },
    ),
    (
        "nothing_to_stash",
        Doc {
            meaning: "치워 둘 변경이 없습니다.",
            recover: "변경이 있는지 먼저 확인하세요.",
        },
    ),
    (
        "operation_in_progress",
        Doc {
            meaning: "merge·rebase 같은 작업이 멈춘 채 진행 중이라 새 작업을 시작할 수 없습니다.",
            recover: "Git ▸ 상태에서 진행 중인 작업(args.kind)을 계속하거나 중단한 뒤 다시 시도하세요.",
        },
    ),
    (
        "operation_mismatch",
        Doc {
            meaning: "지금 진행 중인 작업이 요청한 것과 다릅니다.",
            recover: "Git ▸ 상태에서 무엇이 진행 중인지 보고 그것을 끝내거나 중단하세요.",
        },
    ),
    (
        "outside_root",
        Doc {
            meaning: "허용된 뿌리 밖의 경로입니다.",
            recover: "작업 폴더 안의 경로를 쓰세요. 이 거절이 경계를 지켰습니다.",
        },
    ),
    (
        "patch_empty",
        Doc {
            meaning: "만들어진 패치가 비었습니다.",
            recover: "고른 범위를 확인하세요.",
        },
    ),
    (
        "path_must_be_absolute",
        Doc {
            meaning: "경로가 절대 경로여야 합니다.",
            recover: "`/` 로 시작하는 경로를 보내세요.",
        },
    ),
    (
        "permission_denied",
        Doc {
            meaning: "파일 권한이 이 동작을 막았습니다.",
            recover: "그 파일과 상위 폴더의 권한을 보세요.",
        },
    ),
    (
        "preflight_blocked",
        Doc {
            meaning: "사전 점검이 이 동작을 막았습니다.",
            recover: "본문의 사유를 읽고 그 조건을 먼저 해소하세요.",
        },
    ),
    (
        "publish_required",
        Doc {
            meaning: "이 브랜치가 아직 원격에 없습니다.",
            recover: "먼저 publish(최초 push) 하세요.",
        },
    ),
    (
        "record_missing",
        Doc {
            meaning: "그 기록을 찾지 못했습니다.",
            recover: "목록을 다시 받으세요.",
        },
    ),
    (
        "ref_name_invalid",
        Doc {
            meaning: "ref 이름이 git 의 규칙에 맞지 않습니다.",
            recover: "공백·연속 점(`..`)·제어문자를 빼고, `-` 로 시작하지 않게 하세요.",
        },
    ),
    (
        "remote_exists",
        Doc {
            meaning: "같은 이름의 원격이 이미 있습니다.",
            recover: "다른 이름을 쓰거나 기존 것의 URL 을 고치세요.",
        },
    ),
    (
        "remote_missing",
        Doc {
            meaning: "그 이름의 원격이 없습니다.",
            recover: "원격 목록을 확인하세요.",
        },
    ),
    (
        "remote_name_invalid",
        Doc {
            meaning: "원격 이름으로 쓸 수 없습니다.",
            recover: "`/`·공백·`~^:?*[\\` 없이, `-` 로 시작하지 않는 이름을 적으세요.",
        },
    ),
    (
        "remote_url_invalid",
        Doc {
            meaning: "git 에 넘길 수 없는 URL 입니다.",
            recover: "`-` 로 시작하거나 공백·NUL 이 든 값은 받지 않습니다.",
        },
    ),
    (
        "repo_busy",
        Doc {
            meaning: "같은 저장소에서 다른 쓰기가 진행 중입니다.",
            recover: "잠시 뒤 다시 시도하세요.",
        },
    ),
    (
        "repo_missing",
        Doc {
            meaning: "등록된 저장소가 디스크에 없습니다.",
            recover: "옮기거나 지웠다면 목록에서 빼세요.",
        },
    ),
    (
        "reset_mode_invalid",
        Doc {
            meaning: "reset 모드가 셋(soft·mixed·hard) 중 하나가 아닙니다.",
            recover: "모드를 확인하세요.",
        },
    ),
    (
        "resolve_partial",
        Doc {
            meaning: "일부 경로의 충돌 해결이 실패했습니다.",
            recover: "실패한 경로와 사유를 확인한 뒤 다시 시도하세요.",
        },
    ),
    (
        "root_commit",
        Doc {
            meaning: "첫 커밋이라 뺄 수 없습니다 — 부모가 없습니다.",
            recover: "다른 커밋을 고르세요.",
        },
    ),
    (
        "runtime_missing",
        Doc {
            meaning: "컨테이너 런타임(docker)이 설치되어 있지 않습니다.",
            recover: "GET /api/sandbox/runtime 의 installCommand 로 설치한 뒤 dongminal 을 다시 시작하세요.",
        },
    ),
    (
        "runtime_start_manual",
        Doc {
            meaning: "이 OS 에서는 서버가 런타임을 시작하지 않습니다.",
            recover: "GET /api/sandbox/runtime 의 startCommand 를 자기 셸에서 실행하세요.",
        },
    ),
    (
        "sandbox_unavailable",
        Doc {
            meaning: "샌드박스 런타임을 쓸 수 없습니다.",
            recover: "컨테이너 런타임(docker)이 설치되어 실행 중인지 확인하세요.",
        },
    ),
    (
        "save_failed",
        Doc {
            meaning: "저장하지 못했습니다.",
            recover: "디스크 여유와 홈의 쓰기 권한을 보세요. 사유는 서버 로그에 있습니다.",
        },
    ),
    (
        "server_shutdown",
        Doc {
            meaning: "서버가 종료되며 작업을 중단했습니다.",
            recover: "일부가 적용됐을 수 있습니다. 서버를 다시 띄운 뒤 상태를 확인하세요.",
        },
    ),
    (
        "stale_observation",
        Doc {
            meaning: "화면이 본 내용과 디스크의 지금이 어긋납니다.",
            recover: "새로고침해 다시 고른 뒤 적용하세요. 이 거절이 엉뚱한 줄에 패치가 붙거나, 다른 곳에서 만든 커밋을 되돌리는 것을 막았습니다.",
        },
    ),
    (
        "stale_revision",
        Doc {
            meaning: "들고 있던 판이 서버의 현재 판보다 뒤졌습니다.",
            recover: "현재 판을 다시 받아 그 위에서 고치세요. 이 거절이 다른 창의 변경을 덮는 것을 막았습니다.",
        },
    ),
    (
        "stash_kept",
        Doc {
            meaning: "적용은 됐지만 stash 를 지우지 못했습니다 — 충돌이 남았습니다.",
            recover: "충돌을 해결한 뒤 stash 를 직접 지우세요. 그때까지 내용은 보존됩니다.",
        },
    ),
    (
        "stash_moved",
        Doc {
            meaning: "고른 stash 가 목록에 없습니다.",
            recover: "stash 목록을 다시 받아 고르세요.",
        },
    ),
    (
        "streaming_unsupported",
        Doc {
            meaning: "이 연결에서 스트리밍을 쓸 수 없습니다.",
            recover: "중간의 프록시가 버퍼링하고 있지 않은지 보세요. 이 제품은 리버스 프록시를 지원하지 않습니다.",
        },
    ),
    (
        "submodule_inner_only",
        Doc {
            meaning: "서브모듈 안에서만 바뀌어 이 저장소가 스테이지할 것이 없습니다.",
            recover: "서브모듈 안에서 먼저 커밋한 뒤 다시 스테이지하세요.",
        },
    ),
    (
        "sync_not_found",
        Doc {
            meaning: "그 동기화 작업을 찾지 못했습니다.",
            recover: "이미 끝났거나 취소된 작업입니다. 목록을 다시 받으세요.",
        },
    ),
    (
        "tag_exists",
        Doc {
            meaning: "같은 이름의 태그가 이미 있습니다.",
            recover: "다른 이름을 쓰세요.",
        },
    ),
    (
        "tag_kind_invalid",
        Doc {
            meaning: "제공하지 않는 태그 종류입니다.",
            recover: "`GET /api/git/policy` 의 tagKinds 가운데 하나를 보내세요.",
        },
    ),
    (
        "tag_message_required",
        Doc {
            meaning: "annotated·signed 태그에는 메시지가 있어야 합니다.",
            recover: "메시지를 적거나 lightweight 태그를 고르세요.",
        },
    ),
    (
        "target_is_head",
        Doc {
            meaning: "대상이 지금 HEAD(또는 현재 브랜치)라 이 동작이 뜻을 갖지 않습니다.",
            recover: "다른 커밋이나 브랜치를 고르세요.",
        },
    ),
    (
        "telegram_config_invalid",
        Doc {
            meaning: "Telegram 설정 값이 규칙에 맞지 않습니다.",
            recover: "무음 시간은 0~1440분입니다.",
        },
    ),
    (
        "telegram_no_token",
        Doc {
            meaning: "봇 token 이 없어 등록 코드를 만들 수 없습니다.",
            recover: "먼저 봇 token 을 저장하세요.",
        },
    ),
    (
        "telegram_token_invalid",
        Doc {
            meaning: "봇 token 의 모양이 틀렸거나 Telegram 이 그 token 을 받지 않았습니다.",
            recover: "BotFather 가 준 token 전체(`숫자:글자`)를 다시 넣으세요. 폐기한 token 은 쓸 수 없습니다.",
        },
    ),
    (
        "telegram_unavailable",
        Doc {
            meaning: "이 서버에는 Telegram 브리지가 서지 않았습니다 — 데이터 폴더 없이 떴습니다.",
            recover: "dongminal 을 데이터 폴더($DONGMINAL_HOME)와 함께 다시 띄우세요.",
        },
    ),
    (
        "telegram_unreachable",
        Doc {
            meaning: "Telegram 에 닿지 못해 token 을 확인하지 못했습니다.",
            recover: "인터넷 연결을 확인하고 다시 시도하세요. 저장은 되지 않았습니다.",
        },
    ),
    (
        "too_large",
        Doc {
            meaning: "상한을 넘었습니다.",
            recover: "같은 요청을 다시 보내도 같은 답이 옵니다. 나누거나 다른 표면을 쓰세요. 상한은 features.md 의 용량 표에 있습니다.",
        },
    ),
    (
        "too_many_entries",
        Doc {
            meaning: "항목 수가 서버 상한을 넘었습니다.",
            recover: "args.max 가 상한입니다. 더 작은 폴더로 나눠 다루거나 터미널을 쓰세요.",
        },
    ),
    (
        "tool_cwd_missing",
        Doc {
            meaning: "지목한 작업 디렉터리가 없거나 디렉터리가 아닙니다.",
            recover: "존재하는 디렉터리의 절대경로를 주세요 — 홈으로 조용히 떨어지지 않습니다.",
        },
    ),
    (
        "tool_not_found",
        Doc {
            meaning: "그 도구가 없습니다 — 이미 닫혔거나 다른 인스턴스의 것입니다.",
            recover: "목록을 다시 받아 확인하세요. 화면에 남은 탭이 실체와 어긋난 것일 수 있습니다.",
        },
    ),
    (
        "tools_unavailable",
        Doc {
            meaning: "도구 계층이 아직 서지 않았습니다.",
            recover: "잠시 뒤 다시 시도하세요. 계속되면 dongminal health 로 데몬 연결을 보세요.",
        },
    ),
    (
        "undo_expired",
        Doc {
            meaning: "되돌리기 창이 지났습니다.",
            recover: "git 의 reflog 로 직접 되찾아야 합니다.",
        },
    ),
    (
        "unknown_action",
        Doc {
            meaning: "모르는 명령입니다.",
            recover: "commands.md 의 목록을 확인하세요. 판이 뒤진 서버일 수도 있습니다.",
        },
    ),
    (
        "unsafe_ignore_path",
        Doc {
            meaning: "그 경로는 .gitignore 에 넣을 수 없습니다.",
            recover: "저장소 안의 상대 경로를 쓰세요.",
        },
    ),
    (
        "untracked_only",
        Doc {
            meaning: "추적되지 않는 파일만 있어 그대로는 치워 둘 것이 없습니다.",
            recover: "`includeUntracked` 를 켜고 다시 보내세요. 본문의 args.count 가 그 파일 수입니다.",
        },
    ),
    (
        "update_unavailable",
        Doc {
            meaning: "판 확인 계층을 쓸 수 없는 서버입니다.",
            recover: "이 서버는 자동 판 확인 없이 돕니다. 직접 확인하려면 dongminal update --check 를 쓰세요.",
        },
    ),
    (
        "upload_no_tool_cwd",
        Doc {
            meaning: "그 도구의 작업 디렉터리를 모릅니다 — 서버의 cwd 로 대신하지 않습니다.",
            recover: "GET /api/cwd?tool= 의 actions[\"term.upload\"] 로 미리 확인하거나, dir 로 폴더를 직접 주세요.",
        },
    ),
    (
        "upstream_unknown",
        Doc {
            meaning: "upstream 이 이 저장소가 아는 원격 브랜치가 아닙니다.",
            recover: "원격 브랜치 이름(예: origin/main)을 적으세요. 원격의 새 브랜치라면 먼저 fetch 하세요.",
        },
    ),
    (
        "workspace_unavailable",
        Doc {
            meaning: "워크스페이스 계층이 아직 서지 않았습니다.",
            recover: "잠시 뒤 다시 시도하세요.",
        },
    ),
    (
        "worktree_exists",
        Doc {
            meaning: "그 자리에 이미 worktree 가 있습니다.",
            recover: "다른 경로를 고르거나 기존 것을 여세요.",
        },
    ),
];
