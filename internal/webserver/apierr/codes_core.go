package apierr

// 핵심 표면의 와이어 코드 (ERROR_CONTRACT_SRS 묶음 C).
//
// git·fs·runs 표면은 이미 `apierr` 를 지나고 있었다. 남아 있던 것은 **핵심
// 표면**(`/api/tools`·`/api/files`·`/api/settings`·`/api/commands` …)이고,
// 거기서는 오류가 `http.Error(w, "bad request", 400)` 으로 나갔다 — 사람이 읽는
// 말이지 클라이언트가 분기할 수 있는 것이 아니다. 같은 400 이 열 가지 이유로
// 났고 브라우저는 그중 어느 것인지 알 길이 없었다.
//
// **본문은 바뀌지 않는다** (D-ERR-2). 코드는 `X-Error-Code` 헤더로 간다 — 본문이
// 공개 계약이고 헤더는 그 밖이라, 방언을 통일하지 않으면서 코드를 얻는 유일한
// 길이다 (`architecture.md` 의 결정).

// CodeHeader 는 오류 코드를 싣는 응답 헤더다.
const CodeHeader = "X-Error-Code"

const (
	// ── 상태에서 파생되는 기본값 ──
	// 옮기다 코드를 빠뜨린 자리가 **코드 없는 응답**이 되지 않게 한다.
	// 빈 헤더는 "코드가 없다" 가 아니라 "옮기다 잊었다" 로 읽힌다.
	CodeForbidden  = "forbidden"
	CodeInternal   = "internal_error"
	CodeConflict   = "conflict"
	CodeNotAllowed = "method_not_allowed"

	// ── 요청 해석 ──
	CodeInvalidJSON = "invalid_json"
	CodeMissingArg  = "missing_argument"
	CodeBodyTooBig  = "body_too_large"

	// ── 도구 ──
	CodeToolNotFound    = "tool_not_found"
	CodeToolsUnready    = "tools_unavailable"
	CodeSandboxUnready  = "sandbox_unavailable"
	CodeStreamUnsupport = "streaming_unsupported"

	// ── 워크스페이스·설정 ──
	CodeWorkUnready     = "workspace_unavailable"
	CodeStaleRev        = "stale_revision"
	CodeIfMatchRequired = "if_match_required"
	CodeSaveFailed      = "save_failed"

	// ── 파일 ──
	CodeNotAFile      = "not_a_file"
	CodeNotAnImage    = "not_an_image"
	CodeAbsPathNeeded = "path_must_be_absolute"
	CodeFileChanged   = "file_changed_on_disk"

	// ── 접근 ──
	CodeAccessUnready = "access_store_unavailable"
	CodeHostRejected  = "host_rejected"

	// ── 명령 ──
	CodeUnknownAction = "unknown_action"

	// ── 자산 ──
	CodeCorruptAsset = "corrupt_asset"
)

// coreCodes 는 이 파일이 선언한 코드 전부다. 손으로 적는 자리가 여기 하나뿐이고,
// 빠뜨리면 `TestEveryCodeIsDocumented` 가 아니라 **문서가 조용히 좁아진다** —
// 그래서 `AllCodes` 가 git 표면의 것과 함께 이 목록을 돈다.
var coreCodes = []string{
	CodeBadRequest, CodeNotFound, CodeForbidden, CodeInternal, CodeConflict, CodeNotAllowed,
	CodeInvalidJSON, CodeMissingArg, CodeBodyTooBig,
	CodeToolNotFound, CodeToolsUnready, CodeSandboxUnready, CodeStreamUnsupport,
	CodeWorkUnready, CodeStaleRev, CodeIfMatchRequired, CodeSaveFailed,
	CodeNotAFile, CodeNotAnImage, CodeAbsPathNeeded, CodeFileChanged,
	CodeAccessUnready, CodeHostRejected,
	CodeUnknownAction, CodeCorruptAsset,
}

// gitCodes 는 종전부터 있던 표면들의 코드다. `codes.go` 의 선언과 **한 벌**이어야
// 하며, 갈리면 `TestAllCodesDeclared` 가 잡는다.
var gitCodes = []string{
	CodeNotRepo, CodeRepoMissing, CodeGitMissing, CodeTimeout, CodeCanceled,
	CodeUnavailable, CodeFailed,
	CodeRefName, CodeBranchExists, CodeBranchNotMerged, CodeBranchCurrent, CodeTagExists,
	CodeMergeParent, CodeResetMode,
	CodeNoRemote, CodeRemoteExists, CodeRemoteMissing, CodePublishRequired,
	CodeSyncNotFound, CodeJobBusy, CodeJobNotFound,
	CodeNothingToStash, CodeStashKept,
	CodeStaleObservation, CodePatchEmpty,
	CodeOperationMismatch, CodeNoOperation,
	CodeNoHead, CodeNothingToClean,
	CodeConfirmRequired, CodePreflightBlocked, CodeUndoExpired, CodeEmptyMessage,
	CodeNothingStaged, CodeRecordMissing, CodeNotText, CodeIgnorePath, CodeWorktreeExists,
	CodeExists, CodeOutsideRoot, CodePermission, CodeIO, CodeTooLarge, CodeBusy, CodeFSNotRepo,
}

// AllCodes 는 이 서버가 낼 수 있는 코드 전부다. 카탈로그 생성과 전수성 검사가
// 함께 읽는 **단일 목록**이다.
func AllCodes() []string {
	out := make([]string, 0, len(gitCodes)+len(coreCodes))
	out = append(out, gitCodes...)
	out = append(out, coreCodes...)
	return out
}

// CodeForStatus 는 코드를 주지 않은 자리의 기본값이다.
func CodeForStatus(status int) string {
	switch status {
	case 400:
		return CodeBadRequest
	case 403:
		return CodeForbidden
	case 404:
		return CodeNotFound
	case 405:
		return CodeNotAllowed
	case 409:
		return CodeConflict
	case 413:
		return CodeTooLarge
	case 428:
		return CodeIfMatchRequired
	case 421:
		return CodeHostRejected
	case 503:
		return CodeUnavailable
	default:
		if status >= 500 {
			return CodeInternal
		}
		return CodeBadRequest
	}
}
