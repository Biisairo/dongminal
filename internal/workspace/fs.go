package workspace

import "os"

// FilePersister는 Persister 의 파일시스템 구현체다. workspace.json 같은 단일 파일
// 영속화에 사용한다. 파일이 없으면 Read 는 os.IsNotExist 가 참이 되는 에러를 반환하고,
// Manager.New 는 이를 "빈 상태"로 처리한다.
type FilePersister struct{ Path string }

func (p FilePersister) Read() ([]byte, error) { return os.ReadFile(p.Path) }
func (p FilePersister) Write(b []byte) error  { return os.WriteFile(p.Path, b, 0o644) }
