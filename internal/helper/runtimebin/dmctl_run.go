// 묶음 R 의 CLI 절반이다 (RUN_ORCHESTRATION_SRS FR-RUN-8).
//
// 팀원 uuid 매핑표가 조정자의 대화 기록에만 있으면 컨텍스트 압축 한 번에 팀을
// 정리할 주체가 사라진다. `dmctl run` 은 그 기록을 서버로 옮긴다.
package runtimebin

import (
	"fmt"
	"io"
	"os"
	"strings"
)

const dmctlRunHelp = `dmctl run — 오케스트레이션 실행(Run) 기록

사용법:
  dmctl run start  --objective <목적> [--projection <p>] [--isolation <i>] [--base <ref>] [--window <uuid>]
  dmctl run member --run <uuid> --role <이름> --agent <id> (--at <탭 uuid> | --headless)
                   [--brief <할 일>|-]
  dmctl run launch --member <uuid> [--model <m>] [--text] [--json]
  dmctl run report --outcome succeeded|failed --summary <3문장> [--files a,b] [--run <uuid>] [--member <uuid>]
  dmctl run status [--run <uuid>]
  dmctl run close  --run <uuid> [--force] [--keep-worktrees] [--keep-tools]
  dmctl run delete --run <uuid>
  dmctl run graph  --run <uuid> [--json]
  dmctl run list
  dmctl run attach --member <uuid> [--at <탭 uuid>]
  dmctl run detach --member <uuid>
  dmctl run peers
  dmctl run succeed --member <uuid> (--at <탭 uuid> | --headless) [--model <m>] [--timeout-ms N]
  dmctl run handoff [--member <uuid>] --summary <본문>|-

  --projection   dedicated-window(기본) | background | inline
                 전용 창이 기본이다 — 사용자 작업 공간을 침범하지 않는다.
  --isolation    none(기본) | per-run | per-member
                 격리는 명시적 선택이다. 병렬·편의는 격리 사유가 아니다.
                 per-run 은 Run 전체가 트리 하나를 공유하고, per-member 는
                 멤버마다 하나다. 격리 Run 은 **이 셸의 cwd 가 git 저장소일 때만**
                 시작된다 — 아니면 none 으로 낮추지 않고 그 자리에서 실패한다.
  --base         worktree 가 갈라져 나올 ref. 기본은 이 셸 cwd 의 HEAD 다.
  --headless     탭을 점유하지 않는 멤버. --at 과 배타이며 **정확히 하나**여야 한다.
                 서버가 도구를 만들어 백그라운드(⏻)에 올린다. cwd 는 서버가
                 정한다 — 격리 Run 이면 그 멤버의 worktree, 아니면 이 셸의 cwd.
                 관측·제어는 탭 부착 멤버와 동등하다: toolId 로 read-screen·msg·
                 status 가 그대로 되고, 대기는 wait --member 를 쓴다.
  --keep-tools   close 가 헤드리스 멤버의 도구를 종료하지 않는다. 남긴 것은
                 이후 run status 의 고아 목록에 계속 나온다.
  --brief        이 멤버가 할 일의 본문. 프리앰블에 실리고 기록에 남는다.
                 값이 - 이면 stdin 에서 읽는다. 여러 줄이면 heredoc 을 써라.
  --model        기동할 모델. 그 에이전트의 모델 플래그가 확인된 경우에만 붙는다 —
                 없으면 생략하고 stderr 로 알린다.
  --text         기동줄 대신 프리앰블 본문만 낸다.
  --json         서버 응답을 그대로 낸다 (launch 는 조립 결과를 낸다).

멤버를 띄우는 순서는 셋이다 — 지키지 않으면 첫 지시가 유실된다:

  1) dmctl run launch --member <uuid> | dmctl send-input --at <탭 uuid> --execute -
  2) dmctl wait --at <탭 uuid> --for ready          # 준비완료 확인 (FR-PRE-8)
  3) dmctl msg --to <탭 uuid> ...                   # Kickoff

2 를 건너뛰고 3 을 보내면 에이전트가 아직 뜨지 않아 셸에 텍스트가 찍히고 증발한다.
화면 모양으로 준비완료를 판정하지 마라 — wait 가 훅 상태를 근거로 판정한다.

프롬프트를 기동줄에 싣지 못하는 에이전트(--json 의 promptInjection=stdin-after-start)는
launch 가 stderr 로 그 사실을 알린다. 그때는 2 뒤에 한 단계가 더 있다:
  2b) dmctl run launch --member <uuid> --text | dmctl send-input --at <탭 uuid> --execute -
등록된 에이전트 셋(claude·codex·omp)은 모두 argv 로 받으므로 이 분기를 타지 않는다.

보고(report)의 권한은 **발신 도구의 정체**다. --run/--member 는 대조용이며
생략이 정상이다 — 남의 id 를 알아도 남의 몫을 보고할 수 없다.

close 는 미보고 멤버가 있으면 거부하고 목록을 낸다. --force 로만 넘어간다.
이미 끝난 Run(closed·aborted)에 --force 를 주면 **정리 전용**으로 동작한다 — 남은
worktree 만 거두고 state·중단 사유는 그대로 둔다. 서버 재기동으로 aborted 된 Run 의
트리는 이 경로로 지운다.

격리 Run 의 정리 규칙: 작업 트리가 clean 이면 worktree 를 지우고 브랜치는 머지된
경우에만 지운다. **dirty 면 지우지 않고 잔여물로 보고한다** — 사용자 작업을 조용히
삭제하지 않는다. 전부 남기려면 --keep-worktrees. 정리하지 못한 것은 close 출력과
이후의 run status 양쪽에 남는다.
컨텍스트가 찬 멤버는 **승계**한다 (succeed). 같은 역할·brief·작업 트리를 새 멤버에게
그대로 물려주며, 격리 Run 이어도 worktree 를 새로 만들지 않는다 — 진행 중인 작업이
거기 있다. 승계는 이전 멤버에게 인수인계 요약을 청하고 기다렸다가(상한 --timeout-ms)
새 멤버를 만들며, 무응답이면 요약 없이 진행하고 그 사실을 프리앰블에 적는다.
이전 멤버는 succeeded 가 되고 close 의 미보고 검사에서 면제되지만, 그 **도구는 살아
있다** — 인수인계를 다 읽었으면 /exit → close-tab 으로 조정자가 정리한다.

handoff 는 승계당하는 멤버가 자기 요약을 남기는 명령이다. 권한은 발신 도구의
정체이며 --member 는 대조용이라 생략이 정상이다 — 남의 몫을 대신 남길 수 없다.

status 의 ctx= 는 전부 **추정**이다 (~ 표기). transcript 크기에서 환산한 값이고,
신호를 주지 않는 에이전트는 ctx=— (unknown) 으로 남는다. 모른다와 괜찮다는 다르다.

close 는 도구를 닫지 않는다 — 정리 대상을 돌려주므로, 조정자가 에이전트를
종료(예: /exit)시킨 뒤 dmctl close-tab --at <탭 uuid> 로 마무리한다. 실행 중인
도구의 탭을 서버가 바로 닫으면 브라우저가 확인창을 띄워 무인 정리가 막힌다.

delete 는 close 와 다르다 — 미보고 검사 없이 **레코드를 지운다** (표식 해제 → 헤드리스
도구 종료 → worktree 정리 → 삭제). 웹 UI 의 삭제와 같은 뜻이며, 잔여물이 있으면 보고한다.
graph 는 멤버·메시지 간선·타임라인을 낸다 — 대시보드가 그리는 그것이다.
`

type runFlags struct {
	run        string
	member     string
	role       string
	agent      string
	brief      string
	model      string
	at         string
	objective  string
	projection string
	isolation  string
	window     string
	outcome    string
	summary    string
	files      string
	base       string
	force      bool
	keepTrees  bool
	keepTools  bool // --keep-tools  묶음 H (FR-HLM-4)
	textOut    bool
	jsonOut    bool

	// ORCHESTRATION_V2 선등록 (PARALLEL_DELIVERY_PLAN Step 0-14). 플래그 파싱이
	// 서브커맨드와 무관한 단일 맵이라 이 구조체가 세 워크스트림의 공통 파일이다 —
	// 한 번에 열어 두면 이후 아무도 이 파일을 만지지 않는다.
	headless  bool   // --headless  묶음 H (FR-HLM-1)
	timeoutMs string // --timeout-ms 묶음 C (FR-CBG-9 의 인수인계 대기 상한)
}

// runDmctlRun implements FR-RUN-8. stdin 은 --brief - 만 소비한다.
func runDmctlRun(args []string, stdout, stderr io.Writer) int {
	return runDmctlRunStdin(os.Stdin, args, stdout, stderr)
}

func runDmctlRunStdin(stdin io.Reader, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, dmctlRunHelp)
		return 2
	}
	if args[0] == "-h" || args[0] == "--help" {
		fmt.Fprint(stdout, dmctlRunHelp)
		return 0
	}
	sub := args[0]
	f, code, ok := parseRunFlags(sub, args[1:], stdout, stderr)
	if !ok {
		return code
	}
	switch sub {
	case "start":
		return runSubStart(f, stdout, stderr)
	case "member":
		return runSubMember(f, stdin, stdout, stderr)
	case "launch":
		return runSubLaunch(f, stdout, stderr)
	case "report":
		return runSubReport(f, stdout, stderr)
	case "status", "list":
		return runSubStatus(sub, f, stdout, stderr)
	case "close":
		return runSubClose(f, stdout, stderr)
	case "delete":
		return runSubDelete(f, stdout, stderr)
	case "graph":
		return runSubGraph(f, stdout, stderr)
	// ── ORCHESTRATION_V2 선등록 (PARALLEL_DELIVERY_PLAN Step 0-14) ──
	// 구현은 각 워크스트림의 전용 파일에 있다. 여기서 case 를 열어 두면 이후
	// 아무도 이 디스패치를 만지지 않는다.
	case "attach":
		return runSubAttach(f, stdout, stderr)
	case "detach":
		return runSubDetach(f, stdout, stderr)
	case "succeed":
		return runSubSucceed(f, stdout, stderr)
	case "handoff":
		return runSubHandoff(f, stdin, stdout, stderr)
	case "peers":
		return runSubPeers(f, stdout, stderr)
	}
	fmt.Fprintf(stderr, "run: 알 수 없는 서브커맨드: %s\n", sub)
	fmt.Fprint(stderr, dmctlRunHelp)
	return 2
}

func parseRunFlags(sub string, args []string, stdout, stderr io.Writer) (runFlags, int, bool) {
	f := runFlags{}
	str := map[string]*string{
		"--run": &f.run, "--member": &f.member, "--role": &f.role, "--agent": &f.agent,
		"--brief": &f.brief, "--model": &f.model,
		"--at": &f.at, "-l": &f.at, "--objective": &f.objective, "--projection": &f.projection,
		"--isolation": &f.isolation, "--window": &f.window, "--outcome": &f.outcome,
		"--summary": &f.summary, "--files": &f.files, "--base": &f.base,
		"--timeout-ms": &f.timeoutMs,
	}
	for i := 0; i < len(args); {
		a := args[i]
		if a == "-h" || a == "--help" {
			fmt.Fprint(stdout, dmctlRunHelp)
			return f, 0, false
		}
		if a == "--force" {
			f.force = true
			i++
			continue
		}
		if a == "--headless" {
			f.headless = true
			i++
			continue
		}
		if a == "--keep-worktrees" {
			f.keepTrees = true
			i++
			continue
		}
		if a == "--keep-tools" {
			f.keepTools = true
			i++
			continue
		}
		if a == "--json" {
			f.jsonOut = true
			i++
			continue
		}
		if a == "--text" {
			f.textOut = true
			i++
			continue
		}
		if p, ok := str[a]; ok {
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "run %s: flag %s requires value\n", sub, a)
				return f, 2, false
			}
			*p = args[i+1]
			i += 2
			continue
		}
		if eq := strings.IndexByte(a, '='); eq > 0 {
			if p, ok := str[a[:eq]]; ok {
				*p = a[eq+1:]
				i++
				continue
			}
		}
		fmt.Fprintf(stderr, "run %s: unknown argument: %s\n", sub, a)
		return f, 2, false
	}
	return f, 0, true
}
