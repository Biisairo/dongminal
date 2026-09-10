// Package httpreq 는 요청 본문을 읽는 한 자리다 (REQUEST_GATE_SRS 묶음 J).
package httpreq

import (
	"errors"
	"io"
	"net/http"
)

// 요청 본문에는 상한이 없었다.
//
// `io.ReadAll(r.Body)` 가 10곳이었고 `json.NewDecoder(r.Body).Decode` 가 둘이었다.
// 그중 `PUT /api/settings` 는 받은 바이트를 **JSON 인지도 보지 않고** 그대로
// `settings.json` 에 썼다. 상한이 있던 곳은 업로드(512MiB)·LSP·WS 프레임(1MiB)
// 뿐이고, **그 셋은 실제 사고에서 배운 방어라 이 패키지가 우회하지 않는다** —
// 그 경로들은 여기를 지나지 않는다.
//
// ── 왜 오류를 렌더하지 않는가 ──
//
// 이 저장소의 오류 본문은 방언이 넷이고 그것이 **공개 계약**이다
// (`docs/internal/architecture.md:141-176` — git `{error,message}` · fs
// `{code,message}` · runs `{error,detail}` · 단문 `{error}`). "통일하지 않는다"
// 가 그 문서의 결정이다. 그래서 여기는 바이트와 오류만 돌려주고, 무엇을 어떻게
// 답할지는 호출자가 자기 방언으로 정한다.

// DefaultLimit 은 JSON 본문의 기본 상한이다 (FR-RQG-15).
//
// 1MiB 는 이 앱의 JSON 종단이 다루는 것보다 한참 크다 — 설정·워크스페이스·명령이
// 전부 킬로바이트 단위다. 넉넉하되 "메모리를 요청이 정한다" 는 상태는 아니다.
const DefaultLimit int64 = 1 << 20

// WorkspaceLimit 은 워크스페이스처럼 커질 수 있는 종단의 상한이다.
// 창·탭·핀이 수백 개인 배치를 견딘다.
const WorkspaceLimit int64 = 8 << 20

// ErrTooLarge 는 본문이 상한을 넘었다는 뜻이다. 호출자는 이것을 413 으로 옮긴다.
var ErrTooLarge = errors.New("본문이 상한을 넘었다")

// Read 는 본문을 상한 안에서 읽는다.
//
// `w` 를 받는 이유는 `http.MaxBytesReader` 가 그것을 요구하기 때문이다 — 상한을
// 넘으면 연결을 정리해 클라이언트가 나머지를 계속 보내지 않게 한다.
//
// `limit` 이 0 이하면 `DefaultLimit`.
func Read(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = DefaultLimit
	}
	if r.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		// **`errors.As` 로 가른다.** `strings.Contains(err.Error(), …)` 로 오류를
		// 분류하면 문구가 바뀌는 날 조용히 다른 갈래로 간다 (04-secops SEC-17).
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, ErrTooLarge
		}
		return nil, err
	}
	return body, nil
}

// Status 는 오류 하나를 상태 코드로 옮긴다. 호출자가 자기 방언으로 답할 때
// 상태 코드만 여기서 받아 간다.
func Status(err error) int {
	if errors.Is(err, ErrTooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}
