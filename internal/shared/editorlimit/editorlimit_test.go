package editorlimit

import "testing"

// OPTIMIZE_REFACTOR_SRS FR-OPT-15-1 · D-OPT-9: 값 자체를 지킨다. 경로마다 이 상수를
// 참조하므로, 여기서 어긋나면 모든 경로가 함께 어긋난다.
func TestFileMaxBytes(t *testing.T) {
	if FileMaxBytes != 32<<20 {
		t.Fatalf("FileMaxBytes=%d want %d (D-OPT-9)", FileMaxBytes, 32<<20)
	}
}

// FR-OPT-15-2: 본문 상한은 파일 상한의 JSON 이스케이프 최악(개행·따옴표·역슬래시·탭
// = 2바이트)에 봉투 여유를 더한 값이다.
func TestBodyMaxBytes(t *testing.T) {
	if got, want := BodyMaxBytes(FileMaxBytes), int64(2*FileMaxBytes+BodyEnvelope); got != want {
		t.Fatalf("BodyMaxBytes=%d want %d", got, want)
	}
	if got := BodyMaxBytes(16); got != 32+BodyEnvelope {
		t.Fatalf("BodyMaxBytes(16)=%d want %d", got, 32+BodyEnvelope)
	}
}
