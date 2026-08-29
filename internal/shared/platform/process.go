package platform

import (
	"os"
	"os/exec"
)

// Process 는 pid 로 지목한 프로세스의 생명주기 제어다 (FR-XPR-1).
//
// POSIX 의 신호와 Windows 의 종료 API 는 의미론이 정확히 겹치지 않는다. 그
// 차이를 이 인터페이스가 흡수하며, 호출부는 "정중히 요청한다(Terminate)" 와
// "즉시 끝낸다(Kill)" 두 가지만 안다.
type Process interface {
	// Alive 는 pid 가 살아 있는지다. **확인할 수 없으면 살아 있는 것으로 본다** —
	// 없는 것으로 오판하면 낡은 pidfile 로 알고 살아 있는 데몬을 잃는다.
	Alive(pid int) bool

	// Terminate 는 정중한 종료를 요청한다. 대상이 정리할 기회를 갖는다.
	Terminate(pid int) error

	// Kill 은 즉시 종료다. 대상에 정리 기회가 없다.
	Kill(pid int) error

	// Detach 는 부모와 수명·제어 터미널을 분리해 띄우도록 cmd 를 준비한다.
	// cmd.Start() **전에** 부른다. 이미 채워진 SysProcAttr 는 보존한다.
	Detach(cmd *exec.Cmd)

	// ShutdownSignals 는 "정중히 종료하라" 는 요청으로 받아들일 신호들이다.
	// signal.NotifyContext 에 그대로 넘긴다.
	//
	// 목록을 OS 가 정하는 이유는, 어떤 신호가 **실제로 전달되는지**가 OS 마다
	// 다르기 때문이다. 전달되지 않는 신호를 나열하면 그 코드는 지키지 못할
	// 약속을 하는 것이 된다.
	ShutdownSignals() []os.Signal

	// NewGroup 은 cmd 와 그 **자손 전체**를 하나로 묶어 통째로 종료할 수 있게
	// cmd 를 준비하고 그 묶음의 핸들을 낸다. cmd.Start() **전에** 부른다.
	NewGroup(cmd *exec.Cmd) Group
}

// Group 은 프로세스 묶음이다. POSIX 프로세스 그룹 / Windows Job Object.
//
// 자손까지 닿는 것이 존재 이유다. 리더만 죽이고 손자가 남으면 취소가 취소가
// 아니다 (git/jobs/job.go 의 기존 규약).
type Group interface {
	// Bind 는 cmd.Start() **직후에 반드시** 불러야 한다. POSIX 는 할 일이
	// 없지만(SysProcAttr 로 이미 끝났다) Windows 는 여기서 Job 에 배정하고
	// 중단된 채로 만든 자식을 재개한다 — 부르지 않으면 자식이 영영 시작되지
	// 않는다 (FR-XPR-5).
	Bind() error

	Terminate() error
	Kill() error

	// Close 는 묶음의 자원을 놓는다. POSIX 는 할 일이 없다. Windows 는 Job
	// 핸들을 닫으며, 그 시점에 남아 있는 구성원은 함께 끝난다 — 핸들을 놓지
	// 않으면 누수이고, 놓으면서 살려 두면 고아가 된다. 둘 중 고아를 막는 쪽을
	// 택한다.
	//
	// 여러 번 불려도 안전하다.
	Close() error
}
