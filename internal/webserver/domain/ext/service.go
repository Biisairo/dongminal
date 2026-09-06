package ext

import (
	"context"
	"fmt"
	"os/exec"
	"sync"
)

// Service 는 HTTP 종단과 세션 계층이 딛는 표면이다.
//
// **선언을 캐시하지 않는다** (FR-EXT-33·9c). 매 조회마다 격리 칸을 다시 읽는 이유는
// 사용자가 선언을 고치거나 지울 수 있기 때문이다 — 고쳐 놓고도 안 바뀌는 것이
// 사용자가 우리를 못 믿게 되는 자리다.
type Service struct {
	// Root 는 격리 칸이다 (`<데이터>/ext`).
	Root string
	// LookPath·Fetch·Exec 는 탐색과 조달의 의존이다. 비면 실제 것을 쓴다.
	LookPath func(string) (string, error)
	Fetch    Fetch
	Exec     ExecFunc

	mu sync.Mutex
	// installing 은 지금 받고 있는 팩들이다 (FR-EXT-32).
	//
	// 판정이 서버에 있는 근거는 화면의 비활성으로는 **다른 탭·다른 기기**에서 누른
	// 두 번째 조달을 막지 못한다는 것이다.
	installing map[string]bool
}

// NewService 는 실제 PATH·네트워크·프로세스를 쓰는 Service 다.
func NewService(root string) *Service {
	return &Service{Root: root, LookPath: exec.LookPath, Fetch: HTTPFetch, Exec: execCombined}
}

func (s *Service) lookPath() func(string) (string, error) {
	if s.LookPath != nil {
		return s.LookPath
	}
	return exec.LookPath
}

// Deploy 는 동봉 선언을 편다 (FR-EXT-34). 기동에서 한 번 부른다.
func (s *Service) Deploy() []error { return Deploy(s.Root) }

// Manifests 는 지금 격리 칸에 있는 선언들이다.
func (s *Service) Manifests() ([]Manifest, []error) { return Load(s.Root) }

// locator 는 지금 선언들로 만든 Locator 다.
func (s *Service) locator(ms []Manifest, overrides map[string]string) *Locator {
	return &Locator{
		Root:      s.Root,
		LookPath:  s.lookPath(),
		Overrides: overrides,
		Runtimes:  Runtimes(ms),
	}
}

// Status 는 서버마다 한 줄의 **관측**이다 (FR-EXT-33).
//
// `overrides` 는 화면이 실어 보낸 절대경로 표다 (FR-LSP-4b) — 설정 블롭은 서버가
// 해석하지 않으므로 서버가 그것을 읽을 자리가 없다.
//
// 깨진 선언의 사유도 함께 낸다 (FR-EXT-8) — 조용히 빠지면 사용자는 자기가 고친
// 파일이 무시된 이유를 알 수 없다.
func (s *Service) Status(overrides map[string]string) ([]Status, []string) {
	ms, loadErrs := s.Manifests()
	loc := s.locator(ms, overrides)

	s.mu.Lock()
	inflight := make(map[string]bool, len(s.installing))
	for k, v := range s.installing {
		inflight[k] = v
	}
	s.mu.Unlock()

	var out []Status
	for _, m := range Packs(ms) {
		for _, srv := range m.Servers {
			st := loc.Locate(m, srv)
			st.Installing = inflight[m.ID]
			st.Note = MissingText(st)
			out = append(out, st)
		}
	}
	problems := make([]string, 0, len(loadErrs))
	for _, e := range loadErrs {
		problems = append(problems, e.Error())
	}
	return out, problems
}

// Resolve 는 확장자를 (팩, 서버, 관측) 으로 푼다. 세션 계층이 이것을 딛는다.
func (s *Service) Resolve(ext string, overrides map[string]string) (Manifest, Server, Status, bool) {
	ms, _ := s.Manifests()
	m, srv, ok := ServerForExt(ms, ext)
	if !ok {
		return Manifest{}, Server{}, Status{}, false
	}
	return m, srv, s.locator(ms, overrides).Locate(m, srv), true
}

// Install 은 팩 하나를 조달한다 (FR-EXT-16·31·32).
//
// 같은 팩의 두 번째 요청은 **거절된다** — 두 개를 함께 돌리면 같은 디렉터리에 두
// 도구가 쓰고, 실패했을 때 어느 쪽의 출력인지 알 수 없다.
func (s *Service) Install(ctx context.Context, packID string) Outcome {
	ms, _ := s.Manifests()
	var m Manifest
	found := false
	for _, c := range Packs(ms) {
		if c.ID == packID {
			m, found = c, true
			break
		}
	}
	if !found {
		return fail("%q 는 아는 플러그인이 아닙니다", packID)
	}

	s.mu.Lock()
	if s.installing[packID] {
		s.mu.Unlock()
		return fail("%s 를 이미 받고 있습니다", packID)
	}
	if s.installing == nil {
		s.installing = map[string]bool{}
	}
	s.installing[packID] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.installing, packID)
		s.mu.Unlock()
	}()

	r := &Installer{Root: s.Root, Fetch: s.Fetch, Exec: s.Exec, LookPath: s.lookPath()}
	return r.Install(ctx, m, Runtimes(ms))
}

// MissingText 는 없는 것을 사람의 말로 옮긴다 (FR-EXT-29).
//
// **옮기는 자리가 여기 하나인 것이 규칙이다.** 화면이 따로 적으면 서버가 아는 사유와
// 사용자가 읽는 문장이 갈린다.
func MissingText(st Status) string {
	if st.Missing == nil {
		return ""
	}
	switch st.Missing.Kind {
	case MissingRuntime:
		return fmt.Sprintf("%s 가 필요합니다", st.Missing.Name)
	case MissingTool:
		return fmt.Sprintf("%s 가 이 기계에 없어 받을 수 없습니다 — %s 를 먼저 설치하세요",
			st.Missing.Name, st.Missing.Name)
	case MissingTarget:
		return fmt.Sprintf("이 플랫폼(%s)의 조달처가 선언에 없습니다", st.Missing.Name)
	}
	return "아직 받지 않았습니다"
}
