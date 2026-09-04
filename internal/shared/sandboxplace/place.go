// Package sandboxplace 는 "이 도구를 어디에 띄우는가" 를 답한다 — Window 의
// 샌드박스 프로파일을 대응 컨테이너 안의 실행 명세로 옮기는 배선 계층이다.
//
// toolhub 와 sandbox 를 잇는 자리가 따로 있는 이유는 방향 때문이다. toolhub 는
// 컨테이너를 알지 않고(완성된 명세만 받는다), sandbox 는 도구를 알지 않는다.
// 둘을 아는 것은 배선뿐이다.
package sandboxplace

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"

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
	home     string
	// mu 는 profiles 를 지킨다. 설정 저장이 그것을 갈아 끼우는 동안 도구 기동이
	// 읽을 수 있기 때문이다.
	mu sync.RWMutex
	// stat 은 마운트 원본이 실재하는지 보는 자리다. 주입인 것은 파일시스템 없이
	// 그 판정을 시험하기 위해서다.
	stat func(string) error
}

// New 는 배치기를 만든다. profiles 는 LoadProfiles 의 결과이며, port 는 컨테이너
// 안 dmctl 이 되붙을 서버 포트다.
func New(mgr *sandbox.Manager, dockerPath string, profiles map[string]sandbox.Profile,
	helper sandbox.HelperDeps, port, home string) *Placer {
	return &Placer{mgr: mgr, docker: dockerPath, profiles: profiles, helper: helper,
		port: port, home: home,
		stat: func(p string) error { _, err := os.Stat(p); return err }}
}

// profileByName 은 지금 쓸 수 있는 프로파일을 찾는다.
func (p *Placer) profileByName(name string) (sandbox.Profile, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	pr, ok := p.profiles[name]
	return pr, ok
}

// configPath 는 정의 파일의 자리다.
func (p *Placer) configPath() string {
	return filepath.Join(p.home, sandbox.ProfilesFileName)
}

// Config 는 지금 저장된 정의다. 파일이 없으면 빈 정의이며 오류가 아니다.
func (p *Placer) Config() (sandbox.Config, error) {
	blob, err := os.ReadFile(p.configPath())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return sandbox.ParseConfig(nil, os.UserHomeDir)
		}
		return sandbox.Config{}, err
	}
	return sandbox.ParseConfig(blob, os.UserHomeDir)
}

// SaveConfig 는 정의를 저장하고 곧바로 반영한다 (FR-SBX-43).
//
// **파일에 닿기 전에 검증한다.** 깨진 정의가 저장되면 다음 기동에서 프로파일이
// 통째로 막히고, 사용자는 그것을 고칠 화면조차 열지 못한다.
//
// 반영이 즉시인 것도 요점이다 — 설정을 고친 뒤 서버를 다시 띄우게 하면
// 설정창을 둔 이유가 없다. 다만 **이미 떠 있는 컨테이너는 바뀌지 않는다**
// (FR-SBX-42).
func (p *Placer) SaveConfig(blob []byte) error {
	cfg, err := sandbox.ParseConfig(blob, os.UserHomeDir)
	if err != nil {
		return err
	}
	out, err := cfg.Encode()
	if err != nil {
		return err
	}
	if err := platform.WriteFileAtomic(p.configPath(), out, 0o644); err != nil {
		return err
	}
	p.mu.Lock()
	p.profiles = cfg.Profiles()
	p.mu.Unlock()
	return nil
}

// Place 는 샌드박스 창의 도구를 띄울 명세를 낸다 (FR-SBX-10/12).
//
// **어떤 갈래에서도 nil 명세를 조용히 내지 않는다.** 프로파일이 지정된 요청이
// 여기까지 왔다는 것은 사용자가 격리를 요청했다는 뜻이고, 그때 호스트 셸로
// 내려가는 것이 이 기능이 막으려던 사고다 (FR-SBX-21).
func (p *Placer) Place(pl toolhub.Placement) (*platform.ProcSpec, error) {
	prof, ok := p.profileByName(pl.Profile)
	if !ok {
		return nil, fmt.Errorf("샌드박스 프로파일 %q 가 정의되지 않았습니다 — %s 에 이미지를 적어 주세요",
			pl.Profile, sandbox.ProfilesFileName)
	}

	// 기본 마운트의 원본은 사용자가 적은 것이다. 없으면 여기서 멈춰 오타를
	// 알린다 — 그대로 넘기면 런타임이 호스트에 빈 디렉터리를 만든다 (FR-SBX-39).
	if err := sandbox.VerifyMounts(prof.BaseMounts, p.stat); err != nil {
		return nil, err
	}

	// 작업 폴더도 사용자가 고른 값이다. 없으면 여기서 멈춰 오타를 알린다 —
	// 기본 마운트와 같은 규칙이며 마운트와 복사가 같다 (FR-SBX-41, FR-SPK-19).
	// 비어 있으면 붙일 것도 넣을 것도 없다 (FR-SBX-40, FR-SPK-4).
	if prof.Work != sandbox.WorkNone && pl.HostDir != "" {
		if err := p.stat(pl.HostDir); err != nil {
			return nil, fmt.Errorf("작업 폴더가 없습니다: %s", pl.HostDir)
		}
	}

	// SANDBOX_PICK_COPY_SRS FR-SPK-14: 복사는 상한이 있다. **컨테이너를 만들기
	// 전에** 잰다 — 만든 뒤에 거부하면 되돌리는 일이 따라붙고(FR-SPK-17), 그
	// 되돌림은 실패할 수도 있다. 여기서 멈추면 만들 것도 없다.
	if err := sandbox.VerifyCopySource(prof, pl.HostDir,
		sandbox.CopyMaxBytes, sandbox.CopyMaxFiles); err != nil {
		return nil, err
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
	spec := p.mgr.ExecSpec(pl.WindowUUID, p.docker, prof, rs,
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
	out := make([]sandbox.ProfileInfo, 0, 2)
	// scratch 를 맨 앞에 둔다 — 유일한 격리 경계이므로 기본으로 눈에 들어와야
	// 한다.
	if s, ok := p.profileByName(sandbox.ProfileScratch); ok {
		out = append(out, s.Info())
	}
	if pr, ok := p.profileByName(sandbox.ProfileDev); ok {
		out = append(out, pr.Info())
	}
	return out
}

// Shutdown 은 서버가 내려갈 때 대응 컨테이너를 정지한다 (FR-SBX-44).
//
// 실패는 삼킨다. 종료 절차이므로 여기서 막히면 서버가 내려가지 못한다 —
// 컨테이너가 돌던 채로 남는 편이 낫고, 그래도 다음 기동이 재사용한다.
func (p *Placer) Shutdown() {
	if err := p.mgr.StopOwned(); err != nil {
		log.Printf("[sandbox] 컨테이너 정지 실패: %v", err)
	}
}
