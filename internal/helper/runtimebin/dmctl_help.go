package runtimebin

import (
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/serverconf"
)

// dmctlHelp 는 `dmctl --help` 다. 명령 표(dmctl.go 의 dmctlCommands)와 따로 두는 것은
// 길이 때문이다 — 표의 이름이 여기 있는지는 시험이 본다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-43).
const dmctlHelp = `dmctl — dongminal 워크스페이스 원격 제어 CLI

사용법:
  dmctl new-window [--name <이름>] [-n] [--cwd <경로>] [--sandbox <프로파일>] [--workdir <경로>]
                                         # -n: 백그라운드 생성 (포커스 유지)
                                         # --sandbox: 그 창의 도구를 컨테이너 안에서 실행
                                         # --workdir: 샌드박스 창의 작업 폴더
  dmctl new-tab [--name <이름>] [-n] [--at <uuid>]
                                         # --at: 그 **탭**이 속한 칸에 연다 (칸 uuid 가 아니다).
                                         #       생략하면 포커스 칸이다 — 부르는 쪽이 아니다
  dmctl split-h [N]      # 가로 분할. N 지정 시 N 개로 균등 분할 (기본 2)
  dmctl split-v [N]      # 세로 분할. N 지정 시 N 개로 균등 분할 (기본 2)
  dmctl focus <uuid>     # uuid = list-workspace 의 uuid 컬럼 값 (좌표/라벨/toolId 거부)
  dmctl close-tab [--at <uuid>] [--force | --background]
  dmctl close-window [--at <uuid>] [--force | --background]
                                         # 프로세스가 도는 탭은 브라우저가 확인창을 띄운다.
                                         # --force: 그냥 닫는다 · --background: 도구를 살리고 탭만 지운다
  dmctl window-next / window-prev
  dmctl tab-next / tab-prev
  dmctl tool-up / tool-down / tool-left / tool-right
  dmctl rename-tab --at <uuid> <이름>      # 탭 표시 이름 변경 (역할명 부여 등)
  dmctl rename-tab --at <uuid> --auto      # 탭 이름을 자동(전경 프로세스)으로 되돌린다
  dmctl rename-window --at <uuid> <이름>  # 그 도구가 속한 창 이름 변경
  dmctl new-group --name <이름> [--tree <owner/repo#N>]   # window 그룹 (rename-group · delete-group · list-groups)
  dmctl move-tab|move-window|move-group --at <uuid> (--index N | --prev | --next | --before <uuid> | --after <uuid>) [--to <uuid>]
                                         # 순서 바꾸기. move-window 는 --ungroup 도 받는다
                                         # new-window --group <그룹> · new-tab --after <탭> | --index N
  dmctl open-editor --at <uuid> [--name <이름>] <파일 절대경로>
  dmctl open-url <url>   # 보고 있는 기기의 브라우저로 연다
  dmctl list-workspace [--json]         # 열린 도구 목록 (uuid 포함, ▶=현재 포커스)
  dmctl who-am-i [--json]           # 현재 쉘이 속한 탭의 식별 정보
  dmctl notify [label]              # 현재 도구에 주의 알림 (에이전트 hook 에서 호출)
  dmctl activity <agent>            # 현재 도구의 작업 상태 보고 (stdin hook JSON 파싱)
  dmctl agent-context               # 세션 상시 주입 컨텍스트 (에이전트 hook 에서 호출)
  dmctl ctx-hook <agent>            # 맥락 기준 migration 제안 (에이전트 hook 에서 호출)
  dmctl chat-mcp                    # 노드 망 채팅 MCP 서버 (claude shim 이 주입)
  dmctl send <action> [json-args]   # raw 전송

에이전트 접합면 — 다른 도구의 화면을 읽고 입력을 넣는다:
  dmctl read-screen [--at <uuid>] [--bytes N]   # ANSI 제거 텍스트 (기본 16384)
  dmctl read-output [--at <uuid>] [--bytes N]   # raw 바이트, ANSI 포함 (기본 8192)
  dmctl send-input --at <uuid> [--execute] <텍스트>   # 쉘 대상. - 또는 생략 시 stdin
  dmctl msg --to <uuid> [--from <uuid>] <메시지>      # 에이전트 대상 (신뢰 엔벨로프)
  dmctl status [--at <uuid> | --member <uuid>] [--json]      # 그 도구의 에이전트 상태
  dmctl wait [--at <uuid> | --member <uuid>] --for ready|done [--timeout-ms N]  # 상태 대기 (서버 long-poll)

오케스트레이션 실행 기록 — 누가 어느 Run 의 팀원인가:
  dmctl run start --objective <목적> [--projection <p>] [--isolation <i>]
  dmctl run member --run <uuid> --role <이름> --agent <id> --at <탭 uuid> [--brief -]
  dmctl run launch --member <uuid> [--model <m>]   # 기동줄(프리앰블 포함)을 낸다
  dmctl run report --outcome succeeded|failed --summary <3문장>
  dmctl run status [--run <uuid>] / dmctl run list / dmctl run close --run <uuid>
  dmctl run delete --run <uuid> / dmctl run graph --run <uuid>

노드 간 통신 — 간선을 맺은 다른 dongminal (상세: dmctl edge --help):
  dmctl edges [--json]                       # 노드 포트 상태·간선
  dmctl edge invite [--addr <주소>]          # 초대 코드 (10분, 한 번)
  dmctl edge add <코드>                      # 초대 코드로 간선을 맺는다
  dmctl edge remove <이름#번호|지문 앞자리>  # 간선을 끊는다 (상대 쪽에서도 지워진다)
  dmctl edge notify <이름#번호|지문 앞자리>  # 바뀐 내 이름·포트·주소를 그 간선에 알린다

  레이아웃 명령은 구독 중인 브라우저가 없으면(delivered=0) exit 1 이다 — 아무것도
  만들어지지 않았다. 생성 명령이 결과를 받지 못해도(timedOut) exit 1 이다.

  이슈 트리를 따라 여러 에이전트를 세우는 절차는 /dongminal:issue-tree 명령에 있다.
  각 서브커맨드의 상세는 dmctl <서브커맨드> --help 로 본다.

위치 식별자 — uuid 만 허용:
  --at / -l / --to / --from / focus 의 인자 전부가 여기에 해당한다.
  - tab uuid: list-workspace 의 "uuid=" 컬럼 값 (예: 550e8400-... 또는 짧은 형식 모두 OK).
  - 좌표(4.1.1)·라벨(W4.P1.T1)은 거부 (400 응답).
    이유: 라벨/좌표는 다른 창 닫힘 시 reflow 되어 다른 탭을 가리킨다.

  경로별로 받는 값이 조금 다르다:
    레이아웃 (new-tab/split-*/focus/close-*/rename-*/open-editor)
      탭 uuid 만. 좌표·라벨·toolId 는 거부.
    접합면 (read-screen/read-output/send-input/msg/status/wait/run member)
      탭 uuid 또는 살아있는 toolId. 좌표·라벨은 거부.

  list-workspace 의 "label=" 컬럼은 화면을 읽기 위한 표시 전용이다 — 입력 식별자가
  아니다. 명령에 넣을 값은 언제나 "uuid=" 컬럼에서 가져온다.
  서버는 uuid 를 broadcast 직전 좌표로 번역해 브라우저에 전달한다.

공통 플래그:
  --at <uuid>, -l <uuid>  특정 위치를 대상으로 실행 (기본: 현재 포커스).
                          uuid 만 허용.
  --no-focus, -n          명령 실행 전후로 사용자 포커스를 이동시키지 않는다.
                          new-window/-tab 에선 백그라운드 생성 (활성 탭도 유지).
  --name <이름>           new-window/new-tab 전용. 새 창/탭 이름 (최대 64자).
  --cwd <경로>            new-window 전용. 첫 도구가 뜰 절대경로. 생략하면 홈이다
                          (호출자의 cwd 를 물려받지 않는다).
  --workdir <경로>        new-window 전용. 샌드박스 창의 작업 폴더. 컨테이너 안
                          /work 에 붙는다. 생략하면 부르는 자리를 승계한다.
  --sandbox <프로파일>    new-window 전용. 창을 샌드박스로 연다 (scratch · dev).
                          그 창의 모든 탭이 하나의 컨테이너를 공유하며, 창을
                          닫으면 컨테이너도 사라진다. 컨테이너 런타임(docker)이
                          필요하고, 없으면 도구 생성이 실패한다.

서버 주소:
  $` + dmenv.EnvHome + `/` + serverconf.AddrDir + `/` + serverconf.AddrFileName + ` (지금 리슨하는 주소) → $` + dmenv.EnvHome + `/` + serverconf.FileName + `
  → 기본 ` + dmenv.DefaultHost + `:` + dmenv.DefaultPort + `. 요청마다 다시 읽는다.
  샌드박스 컨테이너 안(` + dmenv.EnvHost + `=` + dmenv.ContainerHost + `)에서는
  ` + dmenv.ContainerAddrDir + `/` + serverconf.AddrFileName + `, 없으면 ` + dmenv.EnvPort + ` 를 쓴다.
`
