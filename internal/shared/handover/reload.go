// Package handover 는 데몬 교체(세션 유지 재시작)의 와이어다 (DAEMON_SESSION_KEEP_SRS).
//
// `start`(제어 CLI)가 보고 소켓으로 교체를 요청하고, 데몬이 그 요청을 받는다. 둘이 같은
// 이름·판·사유 코드를 보도록 한 자리에 둔다.
package handover

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/platform"
)

// Version 은 인계 상태의 모양을 세는 판이다 (FR-DSK-18·D-DSK-11). 모양을 바꾸면 올린다.
const Version = 1

// 보고 소켓의 교체 메서드 (FR-DSK-10·17).
const (
	MethodReload = "daemon.reload"
	MethodHello  = "daemon.hello"
)

// 거절 사유 코드 (FR-DSK-11·12·13).
const (
	ReasonExe         = "reload_exe"
	ReasonVersion     = "reload_version"
	ReasonBusy        = "reload_busy"
	ReasonUnsupported = "reload_unsupported"
	ReasonPreflight   = "reload_preflight"
	ReasonState       = "reload_state"
	// ReasonNoReply 는 데몬이 답하지 않은 경우다. 데몬이 내는 코드가 아니다.
	ReasonNoReply = "reload_no_reply"
)

// MaxRequestBytes 는 교체 요청 본문의 상한이다 (FR-DSK-19).
const MaxRequestBytes = 64 << 10

// OldDaemonUnknownMethod 는 보고 소켓이 모르는 메서드에 답하는 문구다. 교체를 모르는 옛
// 데몬이 이 문구로 답하므로, 문구를 바꾸면 옛 데몬을 알아보지 못한다 (FR-DSK-3).
const OldDaemonUnknownMethod = "보고 소켓이 받지 않는 메서드다"

// ReloadRequest 는 교체 요청의 본문이다 (FR-DSK-10).
type ReloadRequest struct {
	Exe      string `json:"exe"`
	Handover int    `json:"handover"`
}

// Kind 는 교체 요청의 결말이다.
type Kind int

const (
	// Swapped 는 데몬이 교체를 받아들였다는 뜻이다. 새 데몬이 떴는지는 따로 확인한다 (FR-DSK-17).
	Swapped Kind = iota
	// Unsupported 는 데몬이 교체를 모른다는 뜻이다 (FR-DSK-3).
	Unsupported
	// Refused 는 데몬이 거절했거나 답하지 않았다는 뜻이다. 아무것도 바뀌지 않았다 (FR-DSK-2).
	Refused
)

// Outcome 은 교체 요청 하나의 결과다.
type Outcome struct {
	Kind   Kind
	Reason string
	Detail string
}

// Classify 는 데몬의 답을 결말로 가른다. readErr 는 답을 읽지 못한 오류다.
func Classify(reply agentrec.Reply, readErr error) Outcome {
	switch {
	case readErr != nil:
		return Outcome{Kind: Refused, Reason: ReasonNoReply, Detail: readErr.Error()}
	case reply.OK:
		return Outcome{Kind: Swapped}
	case strings.HasPrefix(reply.Error, OldDaemonUnknownMethod):
		return Outcome{Kind: Unsupported, Detail: reply.Error}
	case reply.Error == "":
		return Outcome{Kind: Refused, Reason: ReasonNoReply, Detail: "빈 답"}
	}
	reason, detail, _ := strings.Cut(reply.Error, ": ")
	return Outcome{Kind: Refused, Reason: reason, Detail: detail}
}

// Reload 는 home 의 데몬에 exe 로 교체하라고 요청한다.
//
// 보고 소켓에 붙지 못하면 Unsupported 다 — 보고 소켓 이전의 데몬은 물을 길이 없고, 그때는
// 아무것도 바뀌지 않는다 (FR-DSK-3).
func Reload(home, exe string, within time.Duration) Outcome {
	body, err := json.Marshal(ReloadRequest{Exe: exe, Handover: Version})
	if err != nil {
		return Outcome{Kind: Refused, Reason: ReasonExe, Detail: err.Error()}
	}
	c, err := platform.Current().IPC.Dial(agentrec.SocketPath(home), within)
	if err != nil {
		return Outcome{Kind: Unsupported, Detail: err.Error()}
	}
	defer c.Close()
	if err := c.SetDeadline(time.Now().Add(within)); err != nil {
		return Classify(agentrec.Reply{}, err)
	}
	if err := json.NewEncoder(c).Encode(agentrec.Request{Method: MethodReload, Body: body}); err != nil {
		return Classify(agentrec.Reply{}, err)
	}
	var reply agentrec.Reply
	readErr := json.NewDecoder(c).Decode(&reply)
	return Classify(reply, readErr)
}

// Hello 는 home 의 데몬이 보고 소켓에서 교체를 아는 판으로 답하는가다 (FR-DSK-17).
func Hello(home string, within time.Duration) bool {
	c, err := platform.Current().IPC.Dial(agentrec.SocketPath(home), within)
	if err != nil {
		return false
	}
	defer c.Close()
	if c.SetDeadline(time.Now().Add(within)) != nil {
		return false
	}
	if json.NewEncoder(c).Encode(agentrec.Request{Method: MethodHello, Body: json.RawMessage("{}")}) != nil {
		return false
	}
	var reply agentrec.Reply
	return json.NewDecoder(c).Decode(&reply) == nil && reply.OK
}

// 데몬 진입 인자 (`dongminal d …`, FR-DSK-12·20).
const (
	ArgVersion = "--handover-version"
	ArgFD      = "--handover-fd"
)

// DaemonArgs 는 `dongminal d` 뒤의 인자다.
type DaemonArgs struct {
	// VersionQuery 는 인계 판만 말하고 끝내라는 뜻이다 (사전 확인).
	VersionQuery bool
	// HandoverFD 는 인계 상태를 담은 fd 다. 0 이면 일반 기동이다.
	HandoverFD int
}

// ParseDaemonArgs 는 `dongminal d` 뒤의 인자를 해석한다. fd 는 표준 입출력(0~2)일 수 없다.
func ParseDaemonArgs(args []string) (DaemonArgs, error) {
	var a DaemonArgs
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case ArgVersion:
			a.VersionQuery = true
		case ArgFD:
			if i+1 >= len(args) {
				return DaemonArgs{}, fmt.Errorf("%s 뒤에 fd 가 없습니다", ArgFD)
			}
			i++
			fd, err := strconv.Atoi(args[i])
			if err != nil || fd <= 2 {
				return DaemonArgs{}, fmt.Errorf("%s 의 값이 fd 가 아닙니다: %q", ArgFD, args[i])
			}
			a.HandoverFD = fd
		default:
			return DaemonArgs{}, fmt.Errorf("알 수 없는 데몬 인자: %s", args[i])
		}
	}
	return a, nil
}
