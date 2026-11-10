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

// skillDocs 는 금지 검사가 도는 플러그인 문서다. ISSUE_AGENT_TREE_SRS FR-SKX-1 로 스킬이
// 모두 지워졌으므로 **명령** 트리가 그 대상이다 — 금지(fingerprint · sleep 폴링 · 손으로
// 조립한 기동줄)는 문서의 종류와 무관하다.
func skillDocs(t *testing.T) map[string]string {
	t.Helper()
	return pluginDocs(t, "commands")
}

// commandDocs 는 임베드된 **명령** 트리다 (M10_SRS FR-M10-6).
//
// `migration` 은 스킬이 아니라 명령이다 — 되돌릴 수 없는 절차이므로 모델이 스스로
// 발동해서는 안 된다 (D-M10-8). 트리가 갈렸으므로 읽는 자리도 갈린다.
func commandDocs(t *testing.T) map[string]string {
	t.Helper()
	return pluginDocs(t, "commands")
}

// pluginDocs 는 플러그인 트리 하나를 통째로 읽는다.
func pluginDocs(t *testing.T, sub string) map[string]string {
	t.Helper()
	out := map[string]string{}
	// embed.FS 의 경로는 **언제나 슬래시**다 (io/fs 규약). filepath.Join 은
	// Windows 에서 `agentplugin\skills` 를 만들어 트리를 찾지 못한다.
	root := path.Join("agentplugin", sub)
	err := fs.WalkDir(agentPluginFS, root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		blob, rerr := agentPluginFS.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		// **줄바꿈은 재는 대상이 아니다** (WINDOWS_TEST_PARITY_SRS 의 부류).
		// Windows 체크아웃은 `core.autocrlf` 로 텍스트를 CRLF 로 받고 `go:embed` 는
		// 그 바이트를 그대로 담는다 — 그래서 `"---\n"` 로 여는 frontmatter 판정이
		// 그 판에서만 거짓이 됐다. 아는 것은 문서의 **내용**이므로 여기서 한 번
		// 고르고, 읽는 검사들은 줄바꿈을 모른다.
		out[p] = strings.ReplaceAll(string(blob), "\r\n", "\n")
		return nil
	})
	if err != nil {
		t.Fatalf("%s 트리 순회 실패: %v", sub, err)
	}
	if len(out) == 0 {
		t.Fatalf("임베드된 %s 문서가 0건이다 — embed 경로가 깨졌다", sub)
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

// V-M9-6 · V-M10-10 (M9_SRS FR-M9-6 · M10_SRS FR-M10-6): `migration` **명령**이
// 인수인계 절차를 실제로 담고 있는지.
//
// 이 스킬이 자동화하는 것은 M8·M9 의 **단계 종료 절차 3·4** 이고, 그 절차는
// 순서가 곧 규약이다 — 준비완료를 확인하기 전에 보낸 엔벨로프는 셸의 입력줄에
// 문자열로 남는다. 되돌아가면 여기서 걸린다.
func TestMigrationCommand_CarriesTheHandoffProcedure(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "migration.md")]
	if body == "" {
		t.Fatal("commands/migration.md 를 찾지 못했다")
	}
	required := []struct{ name, needle string }{
		{"지금 pane 에 새 탭 (D-M9-6)", "dmctl new-tab -n"},
		// TAB_NAME_DELIVERY_SRS FR-TND-20·21: 이름은 생성과 함께 준다.
		{"탭 이름", "--name"},
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
			t.Errorf("commands/migration.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	// D-M9-6: 인계는 문서와 엔벨로프 **두 벌**이다. 한 벌로 줄면 메시지 길이에
	// 매이고 인계 기록이 남지 않는다.
	for _, needle := range []string{"두 벌", "문서의 경로는 이 명령이 정하지 않는다"} {
		if !strings.Contains(body, needle) {
			t.Errorf("commands/migration.md 에 D-M9-6 의 조항이 없다 (%q)", needle)
		}
	}
}

// V-M10-11 (M10_SRS FR-M10-6): **`commands/` 에는 명령만 있다.**
//
// 그 디렉터리의 `.md` 는 **전부 슬래시 명령이 된다.** 참조 문서나 eval 을 곁에 두면
// `/dongminal:test-scenarios` 같은 것이 생기고, 사용자는 그것이 명령인 줄 알고 부른다.
// `migration` 의 eval 이 `docs/internal/migration-eval.md` 로 간 이유가 그것이다.
//
// 명령의 표식은 **frontmatter 의 `description`** 이다 — 그것이 없으면 목록에 이름만
// 뜨고 무엇을 하는 것인지 아무도 모른다.
func TestCommandsTree_HoldsOnlyCommands(t *testing.T) {
	docs := commandDocs(t)
	for p, body := range docs {
		if !strings.HasSuffix(p, ".md") {
			t.Errorf("commands/ 에 `.md` 아닌 파일이 있다: %s", p)
			continue
		}
		if path.Dir(p) != path.Join("agentplugin", "commands") {
			t.Errorf("commands/ 아래에 하위 디렉터리가 있다: %s — 그 안의 .md 도 명령이 된다", p)
		}
		if !strings.HasPrefix(body, "---\n") {
			t.Errorf("%s 에 frontmatter 가 없다 — 명령이 아니라면 이 트리에 두지 않는다", p)
			continue
		}
		head := body[:strings.Index(body[4:], "---")+4]
		if !strings.Contains(head, "description:") {
			t.Errorf("%s 의 frontmatter 에 description 이 없다 — 목록에서 무엇인지 알 수 없다", p)
		}
	}
}

// V-M9-42 (M9_SRS FR-M9-42 / M9-B24): **사용자가 실물에서 만난 증상 넷을 막는가.**
//
// 위 테스트는 절차의 **명령**이 있는지를 센다. 이것은 그 명령들이 **옳은 순서로,
// 옳은 값으로** 불리도록 문서가 말하는지를 센다 — 증상 넷은 전부 "명령은 있었는데
// 어떻게 쓰는지가 없거나 틀렸다" 였다.
func TestMigrationCommand_GuardsTheFourSymptoms(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "migration.md")]
	if body == "" {
		t.Fatal("commands/migration.md 를 찾지 못했다")
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
			t.Errorf("commands/migration.md 가 증상을 막지 못한다 — %s (%q)", sx.name, sx.needle)
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

// V-M9-43 (M9_SRS FR-M9-43 / M9-B24, AGENT_GUI_REMOVAL_SRS FR-AGR-2 로 좁힘):
// **에이전트가 옵션이다.**
//
// 기본값은 `claude` 다 — 아무 말 없이 부르면 지금과 같은 동작이며, 그 사실이
// 문서에 있어야 스킬이 사용자에게 되묻지 않는다. 표면(`cli`·`gui`)은 갈래가
// 하나뿐이라 사라졌다 — 에이전트 GUI 가 없다.
func TestMigrationCommand_CarriesAgentOption(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "migration.md")]
	if body == "" {
		t.Fatal("commands/migration.md 를 찾지 못했다")
	}
	if !strings.Contains(body, "claude") {
		t.Error("commands/migration.md 에 기본 에이전트가 없다")
	}
	// 없어진 표면이 되살아나지 않는지도 함께 잰다 — 문서가 없는 종단을 안내하면
	// 읽는 쪽이 404 를 받는다.
	for _, gone := range []string{"--agent", "/api/agent/"} {
		if strings.Contains(body, gone) {
			t.Errorf("commands/migration.md 에 제거된 표면이 남았다 (%q)", gone)
		}
	}
}

// ISSUE_AGENT_TREE_SRS NFR-IAT-1 / TC-IAT-1: issue-tree 명령이 트리 절차를 담고,
// 스킬과 같은 금지(화면 fingerprint · sleep 폴링 · 손으로 조립한 기동줄)를 지킨다.
func TestIssueTreeCommand_CarriesTheTreeProcedure(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "issue-tree.md")]
	if body == "" {
		t.Fatal("commands/issue-tree.md 를 찾지 못했다")
	}
	required := []struct{ name, needle string }{
		{"부모 거슬러 오르기 (FR-IAT-10·16)", "parent"},
		{"하위 이슈 순서 (FR-IAT-20)", "subIssues"},
		{"의존 표기 (FR-IAT-21)", "의존: 없음"},
		{"트리 그룹 (FR-IAT-47)", "dmctl new-group"},
		{"트리 표지 (FR-WGR-8)", "--tree"},
		{"병렬 window (FR-IAT-45·48)", "dmctl new-window -n --group"},
		{"사슬 탭 (FR-IAT-44·46)", "dmctl new-tab -n --at"},
		{"부모 바로 뒤 (FR-IAT-46)", "--after"},
		{"Run 격리 (FR-IAT-30·32)", "--isolation per-run"},
		{"병렬 base (FR-IAT-32)", "--base"},
		{"멤버 등록", "dmctl run member"},
		{"기동줄", "dmctl run launch"},
		{"준비 확인", "--for ready"},
		{"신뢰 채널 (FR-IAT-50)", "dmctl msg --to"},
		{"맥락 사용률 (FR-IAT-62)", "dmctl status --json"},
		{"migration (FR-IAT-62)", "/dongminal:migration"},
		{"탭 이름 (FR-IAT-42)", "dmctl rename-tab"},
		{"사슬 탭은 이름과 함께 (FR-TND-22)", "--after <자기 탭 uuid> --name"},
		{"정리 (FR-IAT-73)", "--force"},
		{"Run 닫기 (FR-IAT-74)", "dmctl run close"},
		{"그룹 지우기 (FR-IAT-74)", "dmctl delete-group"},
		{"트리 중복 방지 (FR-ITU-1·6)", "tree_open"},
		{"가지 Run (FR-ITU-3)", "--branch"},
		{"같은 이슈 (FR-ITU-4·6)", "node_taken"},
		{"트리 조회 (FR-ITD-5)", "dmctl run tree"},
	}
	for _, r := range required {
		if !strings.Contains(body, r.needle) {
			t.Errorf("issue-tree.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	for _, ln := range strings.Split(body, "\n") {
		if strings.Contains(ln, "sleep ") && !strings.Contains(ln, "sleep 루프") {
			t.Errorf("issue-tree.md: 수동 대기가 남아 있다: %q", strings.TrimSpace(ln))
		}
		trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(ln), "$ "))
		if strings.HasPrefix(trimmed, "claude ") || strings.Contains(ln, "`claude --model") {
			t.Errorf("issue-tree.md: 기동줄을 손으로 조립한다: %q", strings.TrimSpace(ln))
		}
	}
	for _, b := range []string{"Thinking...", "╭─", "[대기]"} {
		if strings.Contains(body, b) {
			t.Errorf("issue-tree.md: 화면 fingerprint %q", b)
		}
	}
}

// ISSUE_TREE_OPS_SRS TC-ITA-3: 배정은 등록 플래그이고, 질문은 노드가 직접 묻고 결정은
// 이슈 코멘트로 남기며, 형제 이동과 탭 닫기는 부모가 한다.
func TestIssueTreeCommand_CarriesOpsProcedure(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "issue-tree.md")]
	required := []struct{ name, needle string }{
		{"배정 플래그 (FR-ITA-1)", "--issue <owner/repo#번호>"},
		{"부모 member (FR-ITA-1)", "--parent <내 member uuid>"},
		{"배정 고치기 (FR-ITA-4)", "dmctl run assign"},
		{"프리앰블의 배정 (FR-ITA-11)", "[ISSUE-TREE 배정]"},
		{"기존 결정 찾기 (FR-ITA-30)", "기존 결정을 찾는다"},
		{"결정 코멘트 (FR-ITA-31)", "첫 줄은 `결정:`"},
		{"부모가 결정 코멘트를 본다 (FR-ITA-33)", "결정 코멘트"},
		{"부모가 탭을 닫는다 (FR-ITA-41)", "닫는 것은 나다"},
		{"선행 이슈 (FR-ITA-42)", "보고: 선행"},
		{"WIP 커밋 (FR-ITA-42)", "wip(#"},
		{"순서 다시 놓기 (FR-ITA-45)", "reprioritizeSubIssue"},
		{"보드 진행 중 (FR-ITA-18)", "진행 중으로 옮긴다"},
		{"세션 시작 점검 (FR-ITA-20)", "필수 필드가 모두 채워졌는지"},
		{"보드 완료 (FR-ITA-18)", "완료로 옮긴다"},
		{"스스로 넘어가지 않음 (FR-ITA-40)", "스스로 넘어가지 않는다"},
		{"설정 기준 (FR-ITM-5)", "issueTreeCtxPct"},
		{"잎의 안전 지점 (FR-ITM-21)", "잎의 안전 지점"},
		{"맥락 판단 (FR-ITM-23)", "### 맥락 판단"},
		{"판단 시작점 (FR-ITM-23)", "기준 × 0.8"},
		{"상한 (FR-ITM-16)", "85% 이상이면 판단하지 않고"},
	}
	for _, r := range required {
		if !strings.Contains(body, r.needle) {
			t.Errorf("issue-tree.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	for _, banned := range []string{"### 배정 (Kickoff)", "사용자에게 물어라", "ISSUE_AGENT_TREE_SRS.md", "[--ctx 60]", "맥락 기준과 견준다. 기준 이상이면"} {
		if strings.Contains(body, banned) {
			t.Errorf("issue-tree.md 에 지운 절차 %q 가 남아 있다", banned)
		}
	}
}

// ISSUE_TREE_OPS_SRS TC-ITA-3 (FR-ITB-5·7): migration 은 Run 멤버이면 자기 승계로 넘기고,
// 같은 일을 이을 때만 쓴다.
func TestMigrationCommand_MemberBranch(t *testing.T) {
	docs := commandDocs(t)
	mig := docs[path.Join("agentplugin", "commands", "migration.md")]
	for _, needle := range []string{"## 멤버 갈래", "member=", "dmctl run succeed --self --at", "dmctl run launch --member <새 member>", "다른 이슈로 넘어가는 수단이 아니다", "--after <자기 탭 uuid>"} {
		if !strings.Contains(mig, needle) {
			t.Errorf("migration.md 에 %q 가 없다", needle)
		}
	}
	tree := docs[path.Join("agentplugin", "commands", "issue-tree.md")]
	for _, needle := range []string{"멤버 갈래", "dmctl run succeed --member <그 member>", "다른 이슈로 넘어가는 수단이 아니다"} {
		if !strings.Contains(tree, needle) {
			t.Errorf("issue-tree.md 에 %q 가 없다", needle)
		}
	}
}

// ISSUE_AGENT_TREE_SRS TC-SKX-1 / FR-SKX-1·3: team · workflow 스킬은 지워졌다. 임베드 트리에
// 남지 않고, 플러그인 문서가 그 호출명을 안내하지 않는다.
func TestPlugin_TeamAndWorkflowRemoved(t *testing.T) {
	for _, dir := range []string{"agentplugin/skills/team", "agentplugin/skills/workflow"} {
		if _, err := fs.Stat(agentPluginFS, dir); err == nil {
			t.Errorf("%s 가 임베드 트리에 남아 있다", dir)
		}
	}
	for p, body := range commandDocs(t) {
		for _, name := range []string{"/dongminal:team", "/dongminal:workflow"} {
			if strings.Contains(body, name) {
				t.Errorf("%s 가 지워진 스킬 %s 를 안내한다", p, name)
			}
		}
	}
}

// ISSUE_TREE_CLOSE_SRS TC-ITX-3: 트리 종료는 조율 에이전트가 하고, 종료 의사는 한
// 단계씩 올라가며, 각 노드가 자기 범위를 정리한 뒤에만 닫는다.
func TestIssueTreeCommand_CarriesCloseProcedure(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "issue-tree.md")]
	required := []struct{ name, needle string }{
		{"조율로 남는다 (FR-ITX-1)", "조율 에이전트로 남는다"},
		{"종료 요청 (FR-ITX-10·11)", "종료 요청"},
		{"종료 취소 (FR-ITX-13)", "종료 취소"},
		{"종료 준비 (FR-ITX-14)", "종료 준비"},
		{"준비됨 (FR-ITX-17)", "준비됨"},
		{"막힘 (FR-ITX-18)", "막힘"},
		{"미완료 노드 선택 (FR-ITX-12)", "보존"},
		{"중단 보고 (FR-ITX-15)", "트리 종료로 중단"},
		{"worktree 가 깨끗할 때만 (FR-ITX-17)", "git status --porcelain"},
		{"가지 Run 부터 (FR-ITX-32)", "가지 Run 부터"},
		{"window 닫기 (FR-ITX-33)", "dmctl close-window"},
		{"잔여물 보고 (FR-ITX-34)", "unmerged"},
		{"대신 조율 (FR-ITX-36)", "대신 조율"},
		{"대신 조율의 루트 Run (FR-ITX-37)", "--keep-tools"},
	}
	for _, r := range required {
		if !strings.Contains(body, r.needle) {
			t.Errorf("issue-tree.md 에 %s 가 없다 (%q)", r.name, r.needle)
		}
	}
	for _, banned := range []string{"### 6. 보고하고 빠진다", "## 루트 노드의 끝"} {
		if strings.Contains(body, banned) {
			t.Errorf("issue-tree.md 에 지운 절차 %q 가 남아 있다", banned)
		}
	}
}

// ISSUE_TREE_CLOSE_SRS TC-ITX-8 (FR-ITX-9): 조율 세션의 migration 은 닫기 전에 조율 자리를 넘긴다.
func TestMigrationCommand_HandsOverCoordination(t *testing.T) {
	body := commandDocs(t)[path.Join("agentplugin", "commands", "migration.md")]
	if !strings.Contains(body, "dmctl run coordinate --to <새 탭 toolId>") {
		t.Error("migration.md 에 조율 승계(dmctl run coordinate --to) 가 없다")
	}
	if strings.Index(body, "dmctl run coordinate --to") > strings.Index(body, "### 9. 자기 탭을 닫는다") {
		t.Error("조율 승계가 자기 탭 닫기 뒤에 있다")
	}
}
