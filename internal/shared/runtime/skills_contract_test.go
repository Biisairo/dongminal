package runtime

import (
	"io/fs"
	"path"
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
	// embed.FS 의 경로는 **언제나 슬래시**다 (io/fs 규약). filepath.Join 은
	// Windows 에서 `agentplugin\skills` 를 만들어 트리를 찾지 못한다.
	root := path.Join("agentplugin", "skills")
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
	body := skillDocs(t)[path.Join("agentplugin", "skills", "team", "SKILL.md")]
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
	body := skillDocs(t)[path.Join("agentplugin", "skills", "team", "SKILL.md")]
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

// V-M9-6 (M9_SRS FR-M9-6): `migration` 스킬이 인수인계 절차를 실제로 담고 있는지.
//
// 이 스킬이 자동화하는 것은 M8·M9 의 **단계 종료 절차 3·4** 이고, 그 절차는
// 순서가 곧 규약이다 — 준비완료를 확인하기 전에 보낸 엔벨로프는 셸의 입력줄에
// 문자열로 남는다. 되돌아가면 여기서 걸린다.
func TestMigrationSkill_CarriesTheHandoffProcedure(t *testing.T) {
	body := skillDocs(t)[path.Join("agentplugin", "skills", "migration", "SKILL.md")]
	if body == "" {
		t.Fatal("migration/SKILL.md 를 찾지 못했다")
	}
	required := []struct{ name, needle string }{
		{"지금 pane 에 새 탭 (D-M9-6)", "dmctl new-tab -n"},
		{"탭 이름", "dmctl rename-tab"},
		{"에이전트 기동", "dmctl send-input"},
		{"Barrier (FR-SKL-2)", "dmctl wait"},
		{"준비완료 조건", "--for ready"},
		{"엔벨로프 (인계 두 벌 중 하나)", "dmctl msg --to"},
		{"착수 확인", "dmctl status --at"},
		// **`--force` 까지 센다** (사용자 지시 2026-09-14). 인계의 마지막 명령은
		// 자기 탭을 닫는 것이고, 그 탭에는 방금까지 에이전트가 돌고 있었다 —
		// 확인창이 뜨면 **그 창에 답할 사람이 이미 없다.** 플래그가 조용히
		// 빠지면 인계가 그 자리에서 멎고, 멎었다는 사실조차 아무도 보지 못한다.
		{"자기 탭 닫기", "dmctl close-tab"},
		{"확인창 없이 닫기", "--force"},
		{"wait 실패의 갈래", "dmctl read-screen"},
	}
	for _, r := range required {
		if !strings.Contains(body, r.needle) {
			t.Errorf("migration/SKILL.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	// D-M9-6: 인계는 문서와 엔벨로프 **두 벌**이다. 한 벌로 줄면 메시지 길이에
	// 매이고 인계 기록이 남지 않는다.
	for _, needle := range []string{"두 벌", "문서의 경로는 이 스킬이 정하지 않는다"} {
		if !strings.Contains(body, needle) {
			t.Errorf("migration/SKILL.md 에 D-M9-6 의 조항이 없다 (%q)", needle)
		}
	}
}

// V-M9-42 (M9_SRS FR-M9-42 / M9-B24): **사용자가 실물에서 만난 증상 넷을 막는가.**
//
// 위 테스트는 절차의 **명령**이 있는지를 센다. 이것은 그 명령들이 **옳은 순서로,
// 옳은 값으로** 불리도록 문서가 말하는지를 센다 — 증상 넷은 전부 "명령은 있었는데
// 어떻게 쓰는지가 없거나 틀렸다" 였다.
func TestMigrationSkill_GuardsTheFourSymptoms(t *testing.T) {
	body := skillDocs(t)[path.Join("agentplugin", "skills", "migration", "SKILL.md")]
	if body == "" {
		t.Fatal("migration/SKILL.md 를 찾지 못했다")
	}
	symptoms := []struct{ name, needle string }{
		// ② 포커스 칸에 탭이 섰다. `--at` 없이 부르면 **포커스 칸**이다 —
		// 부르는 쪽의 칸이 아니다 (`app-cmd.js` 의 `rid=this.focused`).
		{"자기 칸에 연다", "dmctl new-tab -n --at"},
		{"--at 없으면 포커스 칸이라는 사실", "포커스 칸"},
		// ④ 엉뚱한 탭이 닫혔다. 식별자가 둘이고 쓰는 자리가 다르다.
		{"식별자 표 — 탭 uuid", "탭 uuid"},
		{"식별자 표 — 도구 id", "toolId"},
		{"칸 uuid 는 --at 이 받지 않는다", "paneUuid"},
		// ③ 엔벨로프가 안 닿았다. `ready` 는 "떴다" 일 뿐이다.
		{"ready 의 한계", "입력을 받을 준비"},
		{"둘째 관문", "read-screen"},
		{"보낸 뒤 검증", "dmctl status --at"},
		// ① 열지도 않고 닫으려 했다.
		{"닫기의 전제", "확인한 뒤에만"},
		{"막히면 닫지 않는다", "닫지 말고 사용자에게"},
	}
	for _, sx := range symptoms {
		if !strings.Contains(body, sx.needle) {
			t.Errorf("migration/SKILL.md 가 증상을 막지 못한다 — %s (%q)", sx.name, sx.needle)
		}
	}
	// **닫기는 확인 뒤에 온다.** 순서가 곧 규약이므로 문서에서의 순서로 잰다 —
	// 닫기 절이 확인 절보다 앞에 오면 읽는 쪽이 그 순서로 실행한다.
	verify := strings.Index(body, "dmctl status --at")
	closeTab := strings.LastIndex(body, "dmctl close-tab")
	if verify < 0 || closeTab < 0 || verify > closeTab {
		t.Errorf("확인이 닫기보다 뒤에 있다 — 순서가 규약이다 (verify=%d close=%d)", verify, closeTab)
	}
}

// V-M9-43 (M9_SRS FR-M9-43 / M9-B24): **에이전트와 표면이 옵션이다.**
//
// 기본값은 `claude` · `cli` 다 — 아무 말 없이 부르면 지금과 같은 동작이며, 그
// 사실이 문서에 있어야 스킬이 사용자에게 되묻지 않는다.
func TestMigrationSkill_CarriesAgentAndSurfaceOptions(t *testing.T) {
	body := skillDocs(t)[path.Join("agentplugin", "skills", "migration", "SKILL.md")]
	if body == "" {
		t.Fatal("migration/SKILL.md 를 찾지 못했다")
	}
	for _, needle := range []string{"claude", "cli", "gui", "--agent"} {
		if !strings.Contains(body, needle) {
			t.Errorf("migration/SKILL.md 에 표면 옵션이 없다 (%q)", needle)
		}
	}
	// gui 갈래는 기동줄을 치지 않는다 — 탭 자체가 그 에이전트다. 그 구분이 없으면
	// 에이전트 도구에 `claude` 를 타이핑하는 길이 열린다.
	if !strings.Contains(body, "gui 로 열었으면 이 단계는 없다") {
		t.Error("migration/SKILL.md 가 gui 갈래에서 기동줄을 건너뛰라고 말하지 않는다")
	}
}

// M9-B6 / FR-M9-6: `team` 은 오케스트레이션 전용이다 — 인수인계를 자기 일로
// 말하지 않는다. 두 스킬의 모양이 닮아 경계가 흐려지면 인계가 팀으로 흘러가고,
// 그러면 넘기는 쪽이 조정자로 살아 있어야 해서 정작 닫지 못한다.
func TestTeamSkill_DefersHandoffToMigration(t *testing.T) {
	body := skillDocs(t)[path.Join("agentplugin", "skills", "team", "SKILL.md")]
	if body == "" {
		t.Fatal("team/SKILL.md 를 찾지 못했다")
	}
	if !strings.Contains(body, "오케스트레이션 전용") {
		t.Error("team/SKILL.md 가 자기를 오케스트레이션 전용으로 못박지 않는다 (M9-B6)")
	}
	if !strings.Contains(body, "migration") {
		t.Error("team/SKILL.md 가 인수인계를 migration 에 넘기지 않는다 (M9-B6)")
	}
}
