package runtime

import (
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 K — 스킬이 지켜야 할 계약을 기계로 검사한다 (RUN_ORCHESTRATION_SRS §3.6).
//
// 스킬은 산문이라 컴파일도 테스트도 되지 않는다. 그래서 **되돌아가면 곧바로
// 걸리는 것**만이라도 검출기로 세운다. 실제로 이 계열의 결함은 사람이 팀을
// 띄워보기 전까지 드러나지 않았다.

// skillDocs reads every markdown/script under the embedded skills tree.
func skillDocs(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	root := filepath.Join("agentplugin", "skills")
	err := fs.WalkDir(agentPluginFS, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		blob, rerr := agentPluginFS.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		out[p] = string(blob)
		return nil
	})
	if err != nil {
		t.Fatalf("스킬 트리 순회 실패: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("임베드된 스킬 문서가 0건이다 — embed 경로가 깨졌다")
	}
	return out
}

// TC-SKL-2 / FR-SKL-2: 화면 fingerprint 는 스킬 본문에서 추방됐다.
//
// 이 판정은 에이전트 버전이나 사용자의 스테이터스라인 하나로 깨지고, 무엇보다
// **권한 대기와 준비완료를 구분하지 못한다.** 준비완료는 `dmctl wait` 가
// 훅 상태를 근거로 판정한다.
func TestSkills_NoScreenFingerprints(t *testing.T) {
	banned := []string{"Thinking...", "╭─", "[대기]"}
	for path, body := range skillDocs(t) {
		for _, b := range banned {
			if strings.Contains(body, b) {
				t.Errorf("%s: 화면 fingerprint %q 가 남아 있다 (FR-SKL-2)", path, b)
			}
		}
	}
}

// FR-SKL-2: Barrier 를 손으로 돌리지 않는다. sleep + 재확인 루프는 서버
// long-poll(`dmctl wait`)이 대체했다.
func TestSkills_NoManualSleepLoops(t *testing.T) {
	for path, body := range skillDocs(t) {
		if strings.HasSuffix(path, ".py") {
			continue // 스크립트는 대상이 아니다
		}
		for _, ln := range strings.Split(body, "\n") {
			if strings.Contains(ln, "sleep ") && !strings.Contains(ln, "sleep 루프") {
				t.Errorf("%s: 수동 대기가 남아 있다 — dmctl wait 로 간다: %q", path, strings.TrimSpace(ln))
			}
		}
	}
}

// 삭제된 자산을 가리키는 참조가 남으면 스킬이 없는 파일을 실행하려 든다.
func TestSkills_NoReferencesToRemovedAssets(t *testing.T) {
	removed := []string{"build_prompt", "references/prompt.md"}
	for path, body := range skillDocs(t) {
		for _, r := range removed {
			if strings.Contains(body, r) {
				t.Errorf("%s: 삭제된 자산 %q 를 참조한다", path, r)
			}
		}
	}
}

// FR-SKL-1/2/3: team 스킬이 Run 기반 절차를 실제로 담고 있는지. 재작성이
// 되돌아가면 여기서 걸린다.
func TestTeamSkill_CarriesTheRunProcedure(t *testing.T) {
	body := skillDocs(t)[filepath.Join("agentplugin", "skills", "team", "SKILL.md")]
	if body == "" {
		t.Fatal("team/SKILL.md 를 찾지 못했다")
	}
	required := []struct{ name, needle string }{
		{"전용 창 (FR-SKL-1)", "dmctl new-window"},
		{"Run 개설", "dmctl run start"},
		{"멤버 등록", "dmctl run member"},
		{"기동줄 생성", "dmctl run launch"},
		{"Barrier (FR-SKL-2)", "dmctl wait"},
		{"준비완료 조건", "--for ready"},
		{"매핑표 대체 (FR-SKL-3)", "dmctl run status"},
		{"해체 (FR-SKL-3)", "dmctl run close"},
	}
	for _, r := range required {
		if !strings.Contains(body, r.needle) {
			t.Errorf("team/SKILL.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	// FR-SKL-1 이 없애려던 방어 규칙 — 전용 창이 기본이면 focus 를 되돌릴 일이 없다.
	if strings.Contains(body, "dmctl focus <") {
		t.Error("team/SKILL.md 가 dmctl focus 사용법을 다시 안내한다")
	}
}

// 액션은 전부 dmctl 이다 (FR-SKL-5). 스킬이 에이전트를 직접 조립하기 시작하면
// 어댑터 선언(권한 사전 허용·인자 구분자)이 우회돼 조용히 깨진다 — 실측으로
// 밟은 결함이다.
func TestSkills_DoNotHandAssembleAgentLaunchLines(t *testing.T) {
	for path, body := range skillDocs(t) {
		if !strings.HasSuffix(path, ".md") {
			continue
		}
		for _, ln := range strings.Split(body, "\n") {
			trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ln), "$ "))
			if strings.HasPrefix(trimmed, "claude ") || strings.Contains(ln, "`claude --model") {
				t.Errorf("%s: 기동줄을 손으로 조립한다 — dmctl run launch 를 써야 한다: %q", path, strings.TrimSpace(ln))
			}
		}
	}
}

// FR-WKT-1/8: 격리 절이 스킬에 실재하고, **기본이 아니라는 사실**을 담고 있는지.
//
// 이 검출기의 요점은 "격리를 설명한다"가 아니라 **격리를 남용하지 않게 하는
// 문장이 남아 있는가**다. 참조 구현 둘 다 격리를 명시적 선택으로 두었고, 신뢰
// 채널 협업 토폴로지 일부는 파일 공유를 전제한다 (D-A).
func TestTeamSkill_CarriesIsolationRules(t *testing.T) {
	body := skillDocs(t)[filepath.Join("agentplugin", "skills", "team", "SKILL.md")]
	if body == "" {
		t.Fatal("team/SKILL.md 를 찾지 못했다")
	}
	required := []struct{ name, needle string }{
		{"격리 선택지 (FR-WKT-1)", "--isolation"},
		{"기본은 격리 없음", "기본은 격리 없음"},
		{"격리 사유의 한계 (D-A)", "격리 사유가 아니다"},
		{"작업 트리로 보내기 (셸은 ~ 에서 시작한다)", "cd '$WT'"},
		{"정리 규칙 (FR-WKT-8)", "clean 한 트리만 지운다"},
		{"잔여물 보고 (FR-WKT-12)", "잔여물로 보고"},
		{"전량 보존", "--keep-worktrees"},
	}
	for _, r := range required {
		if !strings.Contains(body, r.needle) {
			t.Errorf("team/SKILL.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	// 격리가 기본인 것처럼 읽히면 팀 대부분이 파일을 나눠 가져 협업이 깨진다.
	for _, banned := range []string{"항상 격리", "격리를 기본으로"} {
		if strings.Contains(body, banned) {
			t.Errorf("team/SKILL.md 가 격리를 기본으로 안내한다: %q", banned)
		}
	}
}
