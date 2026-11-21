package humancmd

import (
	"bufio"
	"encoding/json"
	"time"

	"dongminal/internal/shared/platform"
)

// DefaultTimeout 은 도우미 소켓 왕복 한 번(연결·쓰기·읽기)의 상한이다. 도우미는 로컬
// 프로세스라 답은 즉시 오거나 오지 않는다. 데몬의 주기 확인과 `dongminal otp status` 가
// 같은 값을 쓴다 — 종전에는 3초와 2초 두 벌이었다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-41).
const DefaultTimeout = 3 * time.Second

// Client 는 데몬 쪽의 도우미 클라이언트다. 연결 하나에 요청 하나다. Timeout 이 0 이면
// DefaultTimeout 이다.
type Client struct {
	Path    string
	Timeout time.Duration
}

// Info 는 도우미 공개키와 잠금 시각이다.
type Info struct {
	Key         string
	LockedUntil int64
}

// Info 는 도우미에게 공개키를 묻는다. 닿지 않으면 CodeNoHelper 오류다.
func (c Client) Info() (Info, error) {
	f, err := c.roundTrip(Frame{T: TypeInfo})
	if err != nil {
		return Info{}, err
	}
	if f.T != TypeInfo || f.Key == "" {
		return Info{}, &Error{Code: CodeNoHelper}
	}
	return Info{Key: f.Key, LockedUntil: f.LockedUntil}, nil
}

// Sign 은 코드와 묶음을 보내 서명을 받는다. 도우미가 거절하면 *Error 다.
func (c Client) Sign(code string, r Request) (Signed, error) {
	f, err := c.roundTrip(Frame{T: TypeSign, Code: code, Req: &r})
	if err != nil {
		return Signed{}, err
	}
	switch f.T {
	case TypeSigned:
		return Signed{B: f.B, S: f.S}, nil
	case TypeError:
		return Signed{}, &Error{Code: f.Code, Until: f.Until}
	}
	return Signed{}, &Error{Code: CodeNoHelper}
}

func (c Client) roundTrip(req Frame) (Frame, error) {
	wait := c.Timeout
	if wait <= 0 {
		wait = DefaultTimeout
	}
	conn, err := platform.Current().IPC.Dial(c.Path, wait)
	if err != nil {
		return Frame{}, &Error{Code: CodeNoHelper}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(wait))
	line, err := json.Marshal(req)
	if err != nil {
		return Frame{}, err
	}
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return Frame{}, &Error{Code: CodeNoHelper}
	}
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 4096), MaxLine)
	if !sc.Scan() {
		return Frame{}, &Error{Code: CodeNoHelper}
	}
	var f Frame
	if json.Unmarshal(sc.Bytes(), &f) != nil {
		return Frame{}, &Error{Code: CodeNoHelper}
	}
	return f, nil
}
