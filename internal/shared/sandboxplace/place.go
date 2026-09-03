// Package sandboxplace 는 "이 도구를 어디에 띄우는가" 를 답한다 — Window 의
// 샌드박스 프로파일을 대응 컨테이너 안의 실행 명세로 옮기는 배선 계층이다.
//
// toolhub 와 sandbox 를 잇는 자리가 따로 있는 이유는 방향 때문이다. toolhub 는
// 컨테이너를 알지 않고(완성된 명세만 받는다), sandbox 는 도구를 알지 않는다.
// 둘을 아는 것은 배선뿐이다.
package sandboxplace

import (
	"fmt"
	"log"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/toolhub"
)

type Placer struct {
	mgr      *sandbox.Manager
	docker   string
	profiles map[string]sandbox.Profile
	helper   sandbox.HelperDeps
	port     string
}

// New 는 배치기를 만든다. profiles 는 LoadProfiles 의 결과이며, port 는 컨테이너
// 안 dmctl 이 되붙을 서버 포트다.
func New(mgr *sandbox.Manager, dockerPath string, profiles map[string]sandbox.Profile,
	helper sandbox.HelperDeps, port string) *Placer {
	return &Placer{mgr: mgr, docker: dockerPath, profiles: profiles, helper: helper, port: port}
}

// Place 는 샌드박스 창의 도구를 띄울 명세를 낸다 (FR-SBX-10/12).
//
// **어떤 갈래에서도 nil 명세를 조용히 내지 않는다.** 프로파일이 지정된 요청이
// 여기까지 왔다는 것은 사용자가 격리를 요청했다는 뜻이고, 그때 호스트 셸로
// 내려가는 것이 이 기능이 막으려던 사고다 (FR-SBX-21).
func (p *Placer) Place(pl toolhub.Placement) (*platform.ProcSpec, error) {
	prof, ok := p.profiles[pl.Profile]
	if !ok {
		return nil, fmt.Errorf("샌드박스 프로파일 %q 가 정의되지 않았습니다 — %s 에 이미지를 적어 주세요",
			pl.Profile, sandbox.ProfilesFileName)
	}

	rs := sandbox.RunSpec{HostDir: pl.HostDir}
	if prof.Helper {
		// 헬퍼는 서버와 **같은 판**이어야 한다. 없으면 그때그때 확보한다
		// (FR-SBX-14/15).
		path, err := sandbox.EnsureHelper(p.helper)
		if err != nil {
			return nil, err
		}
		rs.HelperPath = path
	}

	if err := p.mgr.Ensure(pl.WindowUUID, prof, rs); err != nil {
		return nil, err
	}
	spec := p.mgr.ExecSpec(pl.WindowUUID, p.docker, prof,
		sandbox.ExecEnv{ToolID: pl.ToolID, Port: p.port})
	return &spec, nil
}

// Reap 은 살아 있는 Window 에 매이지 않은 대응 컨테이너를 치운다 (FR-SBX-9).
//
// live 가 nil 이면 아무것도 하지 않는다. nil 은 "창이 하나도 없다" 가 아니라
// **"workspace 를 읽지 못해 판단 근거가 없다"** 이며, 그것을 빈 목록으로 다루면
// 파일 하나가 깨졌을 때 사용자의 컨테이너를 전부 지운다.
func (p *Placer) Reap(live []string) {
	if live == nil {
		return
	}
	set := make(map[string]struct{}, len(live))
	for _, w := range live {
		set[w] = struct{}{}
	}
	if err := p.mgr.ReapOrphans(set); err != nil {
		log.Printf("[sandbox] 고아 컨테이너 회수 실패: %v", err)
	}
}

// Profiles 는 지금 쓸 수 있는 프로파일들이다. 화면이 고르게 하고, 각각의 격리
// 등급을 함께 보이기 위한 것이다 (FR-SBX-23/25).
func (p *Placer) Profiles() []sandbox.ProfileInfo {
	out := make([]sandbox.ProfileInfo, 0, len(p.profiles))
	// scratch 를 맨 앞에 둔다 — 유일한 격리 경계이므로 기본으로 눈에 들어와야
	// 한다.
	if s, ok := p.profiles[sandbox.ProfileScratch]; ok {
		out = append(out, s.Info())
	}
	for _, name := range []string{sandbox.ProfileDev, sandbox.ProfileAgent} {
		if pr, ok := p.profiles[name]; ok {
			out = append(out, pr.Info())
		}
	}
	return out
}
