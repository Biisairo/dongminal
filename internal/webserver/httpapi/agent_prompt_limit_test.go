package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/httpreq"
)

// V-M11-69 (M11_SRS FR-M11-30 / M11-B28): **프롬프트는 이미지가 들어갈 만큼 받는다.**
//
// 기본 상한(1 MiB)으로는 붙여넣은 이미지가 들어가지 않는다 — base64 는 원본의 약 4/3
// 이라 768 KB 남짓이 한계이고 화면 캡처는 대개 그보다 크다. 그 상태에서 이 기능은
// 413 으로만 끝난다.
//
// **상한 자체는 남는다**: 넘으면 413 이고, 조용히 잘리지 않는다 (FR-RQG-14).
func TestAgentPromptBodyLimit(t *testing.T) {
	if agentPromptMaxBytes <= httpreq.DefaultLimit {
		t.Fatalf("프롬프트 상한이 기본(%d)보다 크지 않다: %d — 이미지가 들어가지 않는다",
			httpreq.DefaultLimit, agentPromptMaxBytes)
	}

	// 기본 상한을 넘지만 프롬프트 상한 안인 본문은 **읽힌다**.
	read := func(size int64, limit int64) error {
		body := `{"toolId":"t","text":"x","attachments":[{"mediaType":"image/png","data":"` +
			strings.Repeat("A", int(size)) + `"}]}`
		r := httptest.NewRequest(http.MethodPost, "/api/agent/prompt", strings.NewReader(body))
		_, err := httpreq.Read(httptest.NewRecorder(), r, limit)
		return err
	}
	if err := read(httpreq.DefaultLimit+1024, agentPromptMaxBytes); err != nil {
		t.Fatalf("기본 상한을 조금 넘는 본문이 거절됐다: %v", err)
	}
	// 그리고 그 본문은 **기본 상한에서는** 거절된다 — 이 검사가 무엇을 재는지의 근거다.
	if err := read(httpreq.DefaultLimit+1024, 0); err != httpreq.ErrTooLarge {
		t.Fatalf("기본 상한이 그 본문을 받아들였다 — 이 검사가 아무것도 재지 않는다: %v", err)
	}
	// 프롬프트 상한을 넘으면 그쪽도 거절한다 — 상한이 사라진 것이 아니다.
	if err := read(agentPromptMaxBytes+1024, agentPromptMaxBytes); err != httpreq.ErrTooLarge {
		t.Fatalf("상한을 넘는 본문이 통과했다: %v", err)
	}
}
