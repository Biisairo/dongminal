package editorlimit

import "testing"

// OPTIMIZE_REFACTOR_SRS FR-OPT-15-1 · D-OPT-9: 값 자체를 지킨다. 경로마다 이 상수를
// 참조하므로, 여기서 어긋나면 모든 경로가 함께 어긋난다.
func TestFileMaxBytes(t *testing.T) {
	if FileMaxBytes != 32<<20 {
		t.Fatalf("FileMaxBytes=%d want %d (D-OPT-9)", FileMaxBytes, 32<<20)
	}
}

// FR-OPT-15-2 · FR-OPT-16-4: 본문 상한은 파일 상한의 JSON 이스케이프 최악(`\u00XX` =
// 6바이트)에 봉투 여유를 더한 값이다.
func TestBodyMaxBytes(t *testing.T) {
	if got, want := BodyMaxBytes(FileMaxBytes), int64(6*FileMaxBytes+BodyEnvelope); got != want {
		t.Fatalf("BodyMaxBytes=%d want %d", got, want)
	}
	if got := BodyMaxBytes(16); got != 96+BodyEnvelope {
		t.Fatalf("BodyMaxBytes(16)=%d want %d", got, 96+BodyEnvelope)
	}
}

// FR-OPT-16-4: 부분 스테이징 diff 상한은 두 판 전체가 각각 줄마다 접두어 한 바이트를 달고
// 나오는 경우(전면 재작성)를 싣는다. 줄은 최소 한 바이트(개행)이므로 한 판은 최대 두 배다.
func TestPatchDiffMaxBytes(t *testing.T) {
	if got, want := PatchDiffMaxBytes(FileMaxBytes), int64(4*FileMaxBytes+BodyEnvelope); got != want {
		t.Fatalf("PatchDiffMaxBytes=%d want %d", got, want)
	}
}
