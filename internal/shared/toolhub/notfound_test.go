package toolhub

import (
	"errors"
	"testing"
)

// `GO-8`(PRODUCTION_ROADMAP §M3) — **없는 도구에 대고 성공이라 답하지 않는다.**
//
// `Write`·`Resize` 는 도구가 없으면 `nil` 을 돌려줬다. 그 `nil` 이 데몬 IPC 를
// 지나 클라이언트에게 **성공**으로 전달되고, 브라우저는 자기가 보낸 키가 들어간
// 줄 안다. "모른다" 를 "괜찮다" 로 바꿔 읽는 자리다 (FR-CBG-5).

func TestWriteToMissingToolIsNotFound(t *testing.T) {
	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	if err := m.Write("nope", []byte("x")); !errors.Is(err, ErrToolNotFound) {
		t.Fatalf("err=%v want ErrToolNotFound — 없는 도구에 성공이라 답했다", err)
	}
}

func TestResizeMissingToolIsNotFound(t *testing.T) {
	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	if err := m.Resize("nope", 80, 24); !errors.Is(err, ErrToolNotFound) {
		t.Fatalf("err=%v want ErrToolNotFound", err)
	}
}

// 삭제도 같다. 다만 **이미 없는 것을 지우는 일**은 호출자에 따라 정상일 수 있어,
// 판단을 호출자에게 넘긴다 — 사실만 돌려준다.
func TestDeleteMissingToolIsNotFound(t *testing.T) {
	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	if err := m.Delete("nope"); !errors.Is(err, ErrToolNotFound) {
		t.Fatalf("err=%v want ErrToolNotFound", err)
	}
}

// 있는 도구에는 사실대로 nil 이다 (회귀).
func TestDeleteExistingToolIsNil(t *testing.T) {
	m := NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	m.Adopt(&Tool{ID: "1"})
	if err := m.Delete("1"); err != nil {
		t.Fatalf("err=%v want nil", err)
	}
}
