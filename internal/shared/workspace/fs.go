package workspace

import (
	"os"

	"dongminal/internal/shared/platform"
)

// FilePersister는 Persister 의 파일시스템 구현체다. workspace.json 같은 단일 파일
// 영속화에 사용한다. 파일이 없으면 Read 는 os.IsNotExist 가 참이 되는 에러를 반환하고,
// Manager.New 는 이를 "빈 상태"로 처리한다.
type FilePersister struct{ Path string }

func (p FilePersister) Read() ([]byte, error) { return os.ReadFile(p.Path) }

// Write 는 원자적이다 (FR-CAF-11). `os.WriteFile` 이면 부분 쓰기가 살아 있는
// 파일이 되고, 그때 잃는 것은 **창·분할 칸·탭 배치 전체**다.
//
// 이 패키지는 파싱할 수 없는 workspace.json 을 이미 치명적으로 다룬다
// (manager.go 의 ErrSchemaTooOld — "브라우저가 빈 상태를 저장해 덮어쓴다").
// 그러면서 그런 파일을 만들 수 있는 쓰기 방식을 쓰고 있었다.
func (p FilePersister) Write(b []byte) error { return platform.WriteFileAtomic(p.Path, b, 0o644) }
