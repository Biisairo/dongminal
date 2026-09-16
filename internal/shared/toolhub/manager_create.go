package toolhub

import (
	"errors"
	"fmt"

	"dongminal/internal/shared/dmlog"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/uuid"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `manager.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **도구를 세우는 일**이다 — 자리(`Placement`)를 프로세스 규격으로
// 옮기고, 띄우고, 되살린다. `manager.go` 에 남은 것은 세워진 뒤의 일(목록·조회·
// 종료·저장)이며, 둘은 서로 다른 시각에 산다.

type Placement struct {
	// WindowUUID 는 대응 컨테이너의 키다.
	WindowUUID string
	// Profile 이 비어 있으면 일반 창이며, 도구는 호스트에서 돈다.
	Profile string

	// Work 는 이 창이 고른 **작업 방식**이다 — "mount" · "copy" · "none"
	// (UX_BATCH6_SRS FR-SBM-3). 비거나 모르는 값이면 프로파일의 것을 쓴다.
	//
	// 프로파일이 아니라 여기 있는 이유는 그것이 **이번 창의 선택**이기
	// 때문이다. 같은 프로파일로 어떤 창은 마운트하고 어떤 창은 복사한다.
	Work string

	// Command 는 **로그인 셸 대신 띄울 명령**이다 (UX_BATCH6_SRS FR-BGP-3).
	//
	// 비면 종전대로 대화형 셸이며, 그때의 동작은 이 필드가 없던 때와 완전히
	// 같다. 명령이 있으면 그 프로세스가 곧 이 도구의 수명이다 — 끝나면 도구가
	// 죽고, 죽으면 백그라운드 목록에서 사라진다 (FR-BGP-4). "명령이 끝났다" 를
	// 따로 감지하는 자리는 없다.
	//
	// 샌드박스 프로파일과 함께 쓰지 않는다. 컨테이너 안에서 무엇을 띄울지는
	// 그쪽 명세가 정하며, 둘이 동시에 참이면 어느 쪽이 이기는지 말할 수 없다.
	Command string

	// 아래 둘은 **ToolManager 가 채운다.** 호출자는 건드리지 않는다 — 도구
	// 식별자는 여기서 만들어지고, 작업 디렉터리는 Create 의 인자이므로 바깥에서
	// 다시 실어 보낼 이유가 없다.
	HostDir string
	ToolID  string
}

// Create spawns a new tool.
// ToolCap 은 동시에 살아 있는 도구 수의 상한이다 (04-secops P1-4).
//
// 도구 하나는 PTY 와 로그인 셸 프로세스다. 상한이 없으면 요청 수천 개가 프로세스
// 테이블과 메모리를 소진한다. 진입점이 셋이라(`POST /api/tools`·`GET /ws`(tool
// 생략)·`POST /api/tools/headless`) 어느 하나만 막아서는 뜻이 없고, 그래서
// **만드는 자리 한 곳**에서 센다.
//
// 256 은 사람이 여는 수보다 한참 크고 자원을 소진하는 수보다 한참 작다. 에이전트가
// 도구를 여는 배치를 감안해도 그 사이가 넓다.
const ToolCap = 256

// ErrToolCap 은 상한 초과다. 핸들러는 이것을 429 로 옮긴다 — 500 이면 클라이언트가
// 서버 결함으로 읽고 재시도하며, 재시도가 곧 이 상황을 만든 것이다.
var ErrToolCap = errors.New("도구 수가 상한에 이르렀다")

// ErrToolExists 는 `Placement.ReuseID` 가 살아 있는 도구를 가리킨다 — 재개할 것이 없다.
var ErrToolExists = errors.New("tool_exists")

func (m *ToolManager) Create(cwd string, cols, rows uint16, place Placement) (*Tool, error) {
	// FR-UNI-7: toolId 는 uuid 다. 카운터는 영속되지 않아 모든 도구가 닫힌 상태로
	// 재기동하면 "1" 부터 재사용됐다 (SRS §2.7 (3)).
	// FR-UNI-8: 표시명은 id 와 분리한다 — 구분은 좌표와 cwd 가 담당한다.
	//
	// 배치보다 **먼저** 만든다. 컨테이너 안 도구도 자기 식별자를 환경으로 받아야
	// dmctl 이 자신을 서버에 알릴 수 있다 (FR-SBX-16).
	id := uuid.NewString()
	// 작업 디렉터리는 **그대로** 넘긴다. 실재 여부의 판정과 사유 보고는 배치기가
	// 한다 (FR-SBX-41) — 여기서 조용히 걸러 내면 사용자가 고른 폴더가 왜 안
	// 붙었는지 알 수 없다.
	place.HostDir, place.ToolID = cwd, id

	// 배치는 레지스트리 잠금 **밖에서** 정한다. 컨테이너를 만들고 시작하는 데
	// 수 초가 걸릴 수 있고, 그동안 도구 목록 조회까지 막을 이유가 없다.
	spec, err := m.placement(place)
	if err != nil {
		return nil, err
	}

	// **잠금 안에서, 그리고 기동 전에** 센다 (04-secops P1-4) — 그리고 자리를
	// **예약**한다 (M8 `GO-29`).
	//
	// 잠금 밖에서 세면 동시 요청 여럿이 같은 값을 보고 함께 통과한다 — 상한이
	// 있는데 넘는 상태가 정확히 그렇게 생긴다. 기동 뒤에 세면 이미 뜬 PTY 와
	// 셸이 등록되지 못한 채 남는다. 종전에는 그래서 잠금을 쥔 채 띄웠고, 그동안
	// Get/List/IsLive 가 전부 대기했다 — fork/exec + PTY open 은 잠금 밖의 일이다.
	// 예약(pending)이 그 둘을 같이 만족시킨다.
	m.mu.Lock()
	if len(m.tools)+m.pending >= ToolCap {
		m.mu.Unlock()
		dmlog.Infof(nil, "[tool] 상한 초과로 생성을 거절한다 (cap=%d)", ToolCap)
		return nil, ErrToolCap
	}
	if _, live := m.tools[id]; live {
		m.mu.Unlock()
		return nil, ErrToolExists
	}
	m.pending++
	hooks := m.attnHooks()
	start := m.startTool
	m.mu.Unlock()

	p, err := start(id, defaultToolName, cwd, cols, rows, m.toolExited, hooks, spec)

	m.mu.Lock()
	defer m.mu.Unlock()
	m.pending--
	if err != nil {
		dmlog.Errorf(nil, "[tool %s] create error: %v", id, err)
		return nil, err
	}
	// FR-BGP-3 / FR-SBX-27: `sandboxed` 는 "컨테이너 안에서 돈다" 이지 "명세를
	// 받았다" 가 아니다. `StartTool` 은 명세 유무만 보므로, 명령으로 띄운 도구가
	// 샌드박스로 오인되어 백그라운드로 갈 수 없게 된다 — 그 도구는 백그라운드에
	// 살라고 만든 것이다.
	p.sandboxed = place.Profile != ""
	m.tools[id] = p
	dmlog.Infof(nil, "[tool %s] registered total=%d", id, len(m.tools))
	m.mutated.Store(true)
	m.saveAsync()
	return p, nil
}

// toolExited 는 도구 프로세스가 끝났을 때의 콜백이다 (readPTY 의 onExit).
// 레지스트리에서 지우고 위층(workspace)에 알린다. invalidator 는 SetInvalidator
// 가 잠금으로 쓰므로 **잠금으로 읽는다** (M8 `GO-30`) — 종전의 클로저는 맨 읽기였다.
func (m *ToolManager) toolExited(toolID string) {
	// 종료 사유는 지우기 전에 집는다 (D-C-15) — 지운 뒤에는 Tool 이 없다.
	var info ExitInfo
	if p := m.Get(toolID); p != nil {
		info = p.ExitInfo()
	}
	m.Delete(toolID)
	m.mu.RLock()
	f := m.invalidator
	ex := m.exitObserver
	m.mu.RUnlock()
	if ex != nil {
		ex(toolID, info)
	}
	if f != nil {
		f(toolID)
	}
}

// SetPlacer 는 배치 결정자를 꽂는다. 배선에서 한 번 불린다.
func (m *ToolManager) SetPlacer(f func(Placement) (*platform.ProcSpec, error)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.placer = f
}

// placement 는 이 Window 의 도구를 띄울 명세다. nil 이면 호스트 셸이다.
//
// Window 가 지정되지 않았으면 결정자를 묻지도 않는다 — 샌드박스가 아닌 창의
// 경로가 이 기능 도입 전과 완전히 같아야 한다 (NFR-SBX-2).
func (m *ToolManager) placement(place Placement) (*platform.ProcSpec, error) {
	if place.Profile == "" {
		// FR-BGP-3: 셸 대신 명령. 셸을 띄우고 그 안에 타이핑하는 대신 명령
		// 자체를 도구의 프로세스로 세운다 — 그래야 그 명령의 끝이 도구의 끝이다.
		if place.Command == "" {
			return nil, nil
		}
		argv := platform.Current().Shell.RunCommand(place.Command)
		if len(argv) == 0 {
			return nil, fmt.Errorf("이 호스트의 셸에서 명령을 실행할 방법을 알지 못합니다")
		}
		return &platform.ProcSpec{Path: argv[0], Args: argv}, nil
	}
	m.mu.RLock()
	f := m.placer
	m.mu.RUnlock()
	// 프로파일이 있는데 배치기가 없으면 **실패한다.** 여기서 호스트 셸로
	// 내려가면 사용자는 격리된 줄 알고 호스트에서 일하게 된다 (FR-SBX-21).
	if f == nil {
		return nil, fmt.Errorf("샌드박스 창(%s)이지만 컨테이너 배치가 구성되지 않았습니다", place.Profile)
	}
	return f(place)
}

func (m *ToolManager) Restore(id, name, cwd string, cols, rows uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := m.startTool(id, name, cwd, cols, rows, m.toolExited, m.attnHooks(), nil)
	if err != nil {
		return err
	}
	m.tools[id] = p
	dmlog.Infof(nil, "[tool %s] restored total=%d", id, len(m.tools))
	return nil
}

// Adopt은 이미 만들어진 Tool 을 자기 ID 로 레지스트리에 등록한다. PTY 를 띄우지
// 않으므로 Create/Restore 와 달리 프로세스를 만들지 않는다 — 데몬 모드의 합성
// Tool 과 핸들러 테스트 픽스처가 쓰는 경로다.
func (m *ToolManager) Adopt(p *Tool) {
	if p == nil || p.ID == "" {
		return
	}
	m.mu.Lock()
	m.tools[p.ID] = p
	m.mu.Unlock()
}
