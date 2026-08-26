# 실패 모드 진단

## 먼저 볼 것 — 상태와 기록

화면을 긁기 전에 두 가지를 본다. 화면은 마지막 수단이다.

```bash
dmctl run status --run "$RUN"     # 누가 무엇을 하고 있나, 누가 보고했나
dmctl status --at "$MEMBER_TAB"   # 그 팀원의 에이전트 상태
```

`dmctl status` 의 `state` 가 진단의 출발점이다:

| state | 뜻 |
|-------|-----|
| `idle` | 지시를 받을 수 있다 |
| `working` | 처리 중 (`tool`·`detail` 에 무엇을 하는지) |
| `waiting` | **막혀 있다** — 권한 확인 등 사람/조정자의 개입이 필요하다 |
| `done` | 턴을 마쳤다 |
| `ended` | 세션이 끝났다 |
| `unknown` | 훅이 한 번도 보고하지 않았다. 아직 기동 중이거나 시작 모달에 막혔을 수 있다 |

## 진단 표

| 증상 | 원인 | 대응 |
|------|------|------|
| `new-window`/`split` 응답 `delivered=0` | 브라우저가 SSE 구독 안 함 | 사용자에게 브라우저 새로고침 요청 |
| 응답에 `newTabs` 없음 / `timedOut: true` | 브라우저 echo 지연 | `dmctl list-workspace` 로 실제 상태 확인 후 재시도 |
| `wait` 가 rc=5 (**blocked**) | 팀원이 `waiting` — 권한 확인 프롬프트 등 | `dmctl read-screen --at <uuid>` 로 무엇을 묻는지 보고 처리한다. **시간이 지난다고 풀리지 않으므로 다시 기다리지 마라** |
| `wait` 가 rc=4 (타임아웃) | 아직 준비되지 않았거나 시작 모달에 막힘 | **실패가 아니라 체크포인트다.** 마지막 관측 상태를 보고 판단한다. 타임아웃만을 근거로 팀원을 죽이거나 재기동하지 않는다 |
| 기동했는데 `state=unknown` 이 계속됨 | **폴더 신뢰 확인 모달** — 신뢰하지 않는 디렉터리에서 claude 를 띄웠다 | `dmctl read-screen` 으로 확인. 기동 전에 `dmctl send-input --at <uuid> --execute 'cd <신뢰된 절대경로>'` 를 먼저 보낸다. 도구의 셸은 `~` 에서 시작한다 |
| 팀원이 반응 없음 | `claude` 실행 실패 (PATH, 권한) | `dmctl read-screen --at <uuid>`. `command not found` 면 환경 점검 |
| 팀원이 `dmctl` 을 못 찾거나 `run report` 를 모른다 함 | 같은 머신에 dongminal 인스턴스가 둘이라 `PATH` 가 다른 `dmctl` 을 잡음 | 팀원 셸에서 `which dmctl` 확인. `$DONGMINAL_HOME/bin` 이 앞서야 한다 |
| 팀원이 보고 명령마다 승인을 물음 | 기동줄에 권한 사전 허용이 빠졌다 | `dmctl run launch` 가 만든 줄을 **그대로** 쓴다. 손으로 `claude ...` 를 조립하지 마라 — 어댑터가 `--allowedTools`·구분자를 붙인다 |
| 팀원이 빈 프롬프트로 떴다 (지시를 못 받음) | 손으로 조립한 기동줄에서 가변 인자 플래그가 프롬프트를 삼켰다 | 같은 이유. `dmctl run launch` 를 쓴다 |
| 팀원끼리 서로를 못 찾음 | 순차 기동으로 먼저 뜬 팀원이 아직 없는 동료에게 송신 | 한 `Bash` 호출에서 `&` + `wait` 로 병렬 기동. 이미 발생 시 `dmctl msg` 로 재지시 |
| 데드락 (송신자는 "완료" · 수신자는 영원히 대기) | Barrier 없이 Kickoff 를 보내 엔벨로프가 쉘에 텍스트로 찍히고 증발 | `dmctl wait --at <uuid> --for ready` 가 rc=0 을 낸 **뒤에만** Kickoff |
| 팀원이 "메시지 보냄" 인데 수신 안 됨 | 내장 `SendMessage`/`SendUserMessage` 오용 — 자기 화면엔 "전송 완료" 로 보임 | 프리앰블이 `dmctl msg` 실행 명령과 금지 경고를 이미 담고 있다. 발생 시 "방금 경로가 틀렸다, 반드시 Bash 로 `dmctl msg --to <uuid>`" 재지시 |
| 팀원이 보고했다는데 기록에 없음 | 보고 권한은 **발신 도구의 정체**다. 남의 id 로는 보고할 수 없다 | `dmctl run status` 로 확인. 거부 사유가 타입으로 나온다 — `sender_not_member`·`run_member_mismatch`·`member_already_reported`·`run_closed` |
| `run close` 가 거부됨 | 미보고 멤버가 있다 (`unreported_members` + 목록) | 그 팀원을 진단하거나, 정말 접을 거면 `--force` |
| 정리 중 브라우저에 "프로세스 종료?" 확인창 | 실행 중인 CC 의 탭을 바로 닫았다 | `/exit` 먼저 → 쉘 복귀 확인 → `close-tab` |
| `dmctl: command not found` | dongminal 밖 터미널에서 실행 중 | dongminal 도구 안에서만 유효하다. `$DONGMINAL_HOME/bin` 에 있다 |
| 여러 줄 본문이 잘림 / 셸이 멈춤 | 위치 인자로 넘기며 인용 실패, 또는 heredoc 종료자를 들여씀 | `- <<'MSG'` 로 stdin 사용. **종료자는 반드시 열 0** |
| `dmctl msg` submit 안 됨 (드묾) | 수신측 TUI reconciliation 지연 | `dmctl send-input --at <uuid> --execute ""` 로 엔터 보강 |
| 팀원 CC 죽음 | claude 프로세스/쉘 종료 | `dmctl run status` 에서 그 멤버가 `lost`. 중간 결과는 `dmctl read-output --at <uuid>` 로 구출 |
| 격리 Run 시작이 `not_a_git_repo` 로 거부됨 | 조정자 셸의 cwd 가 git 저장소가 아니다 | `cd <저장소>` 후 다시 시작한다. **비격리로 낮추어 진행하지 마라** — 격리를 요청했다는 사실이 그대로 사라진다 |
| 격리 팀원이 조정자의 트리를 고쳤다 | 기동 전에 `cd <worktree>` 를 보내지 않았다 | 도구의 셸은 `~` 에서 시작한다. 등록 출력의 `worktree=<경로>` 로 먼저 보낸다 |
| `run close` 출력에 "잔여물" 이 있다 | 그 worktree 에 고친 파일이 남아 있어 지우지 않았다 (`dirty`) | **정상 동작이다.** 경로를 사용자에게 그대로 전달한다. 사용자가 커밋·병합하거나 직접 지운다. 조정자가 대신 지우지 마라 |
| 잔여물 사유가 `branch-retained` | 트리는 지웠지만 머지되지 않은 커밋이 있어 브랜치를 남겼다 | 브랜치 이름을 사용자에게 전달한다. `-D` 로 지우면 그 커밋이 사라진다 |
| 컨텍스트 압축 후 팀원이 누군지 모르겠음 | 매핑을 대화 기록에 보관했다 | 보관하지 마라. `dmctl run status --run <uuid>` 가 진실이다. Run id 만 있으면 전원을 되찾는다 |

## 화면을 읽어야 할 때

`dmctl read-screen --at <uuid>` 은 **진단 도구**다. 준비완료·완료 판정에 쓰지 않는다 — 그 판정은 `dmctl wait`/`dmctl run status` 의 몫이고, 화면 모양은 에이전트 버전이나 사용자의 스테이터스라인 하나로 깨진다. 화면은 "왜 막혔는가"를 사람이 읽을 때만 본다.

## 로그

`/tmp/dongminal.log` 에 아래가 찍힌다.

- `[cmd] action=... delivered=N` — 레이아웃 명령의 SSE 브로드캐스트 여부
- `[toolio] input tool=... textLen=N` — `dmctl send-input` 도달
- `[toolio] message from=... to=... msgLen=N` — `dmctl msg` 도달
- `[run] start|member|report|close ...` — Run 기록의 변경 전부
- `[run] worktree 잔여물 ...` — 정리하지 못한 작업 트리와 그 사유
