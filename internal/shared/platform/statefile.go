package platform

import (
	"fmt"
	"log"
	"os"
)

// STATE_FILE_DURABILITY_SRS 묶음 B — 상태 파일의 세대.
//
// 쓰기는 이미 원자적이다 (`WriteFileAtomic` 이 임시 형제에 쓰고 fsync 후 rename
// 한다). 여기 더하는 것은 **원자성이 아니라 되돌아갈 곳**이다 — 손상된 파일을
// 만났을 때 복원할 대상이 없으면 사용자의 워크스페이스가 그대로 사라진다.

// StateFileGenerations 는 남기는 세대 수다 (FR-SFD-2, 사용자 결정 2026-09-11).
//
// 셋인 이유: 손상은 보통 **마지막 쓰기**에서 오고 그때는 직전 하나면 된다.
// 나머지 둘은 손상된 채로 몇 번 저장된 뒤에 알아채는 경우의 여유다.
//
// const 가 아니라 var 인 것은 이 저장소의 관례다 — 검사가 값을 낮춰 쓸 수 있어야
// 하고, 그 묶음마다 **기본값을 지키는 검사**를 따로 둔다.
var StateFileGenerations = 3

// RetainQuarantined 는 **격리본과 되돌리기 직전 판을 자동으로 지우지 않는다**는
// 결정이다 (`G4-6`, 사용자 2026-09-11).
//
// 홈에 쌓이는 우리 파일은 셋이고 수명이 다르다. 그 차이는 의도된 것이다:
//
//	.bak.1~3               세대. **회전한다** — 매 저장마다 생기므로 상한이 없으면
//	                       무한히 쌓인다
//	.corrupt-<ts>          손상본. **남긴다** — 사건의 증거이고 사건은 드물다.
//	                       `doctor --bundle` 이 그것을 모아 붙인다
//	.before-rollback-<ts>  되돌리기 직전 판. **남긴다** — 사용자가 세대를 잘못
//	                       골랐을 때 돌아올 자리다
//
// 드문 것을 자동으로 지우면 정작 물어볼 때 없다. 지우는 것은 사용자가 판단한다.
//
// 상수인 이유는 값을 쓰기 위해서가 아니라 **결정을 코드에 고정하기 위해서**다 —
// 누군가 "일관성" 을 이유로 격리본에도 회전을 붙이려 하면 여기서 그 결정을 만난다.
const RetainQuarantined = true

// genPath 는 n 번째 세대의 자리다. 1 이 가장 최근이다.
func genPath(path string, n int) string { return fmt.Sprintf("%s.bak.%d", path, n) }

// WriteStateFile 은 상태 파일 하나를 쓰고 **직전 내용을 세대로 남긴다**
// (FR-SFD-1).
//
// **`WriteFileAtomic` 을 바꾸지 않고 곁에 두는 이유**(D-1): 그 함수의 호출부
// 일곱 중 **여섯만** 상태 파일이고, 일곱째는 사용자가 편집기로 저장하는 원본이다
// (FR-SFD-3). 함수 자체에 세대를 넣으면 사용자의 작업 디렉터리에 `.bak.1` 이
// 생긴다 — 그 자리의 보존은 git 과 편집기의 일이다.
func WriteStateFile(path string, data []byte, perm os.FileMode) error {
	rotateGenerations(path, perm)
	return WriteFileAtomic(path, data, perm)
}

// rotateGenerations 는 `3→버림 · 2→3 · 1→2 · 현재→1` 이다.
//
// **실패해도 돌아간다** (FR-SFD-4). 세대는 여유이지 조건이 아니다 — 백업을 만들지
// 못한다고 저장을 막으면 디스크가 찬 순간 제품이 멈춘다. 기록만 남기고 지나간다.
//
// 대상이 **없으면 아무것도 하지 않는다** (FR-SFD-6). 첫 쓰기에 빈 세대를 만들면
// 그것이 나중에 "복원할 것이 있다" 는 거짓 신호가 된다.
func rotateGenerations(path string, perm os.FileMode) {
	if _, err := os.Stat(path); err != nil {
		return
	}
	n := StateFileGenerations
	if n < 1 {
		return
	}
	// 가장 오래된 것부터 밀어 올린다 — 반대 순서로 하면 자기 자신을 덮는다.
	_ = os.Remove(genPath(path, n))
	for i := n - 1; i >= 1; i-- {
		if err := os.Rename(genPath(path, i), genPath(path, i+1)); err != nil && !os.IsNotExist(err) {
			log.Printf("state file: 세대 회전 %s: %v", genPath(path, i), err)
		}
	}
	// 현재 내용을 `.bak.1` 로 **복사**한다. rename 하면 원본이 사라지고, 그 사이에
	// 프로세스가 죽으면 현재 판이 없는 순간이 생긴다.
	blob, err := os.ReadFile(path)
	if err != nil {
		log.Printf("state file: 세대 원본 읽기 %s: %v", path, err)
		return
	}
	if err := WriteFileAtomic(genPath(path, 1), blob, perm); err != nil {
		log.Printf("state file: 세대 쓰기 %s: %v", genPath(path, 1), err)
	}
}
