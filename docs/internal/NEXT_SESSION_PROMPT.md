# 다음 세션 프롬프트

트랙 1~4 가 전부 닫혔다. 다음 세션의 후보는 아래 "별건" 표뿐이며, 새 세션 첫
메시지로 붙여넣을 지시 블록은 지금 없다 — 무엇을 집을지는 사용자가 고른다.

| 트랙 | 상태 |
|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| ~~2. MCP 폐지 → 세션 스코프 스킬 주입~~ | **완료** — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| ~~3. 상태바 지표 재설계~~ | **완료** — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| ~~4-a. 오케스트레이터 — 결함·식별자 통일~~ | **완료** — `0ec8e02`, `835a662`, `f7580a7` ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| ~~4-b. 오케스트레이터 — 조사·설계~~ | **완료** — `901bd7c` ([RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md), [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md)) |
| ~~4-c. 오케스트레이터 — 구현~~ | **완료** — 묶음 **S**(`228c464`)·**R**(`a958797`)·**P+A**(`c37fa48`)·**K**(`b3dc910`)·**W** ([RUN_ORCHESTRATION_SRS](./RUN_ORCHESTRATION_SRS.md)) |

---

## 트랙 4-c 종료 — 묶음 W(worktree 격리) 요약

- `internal/worktree` 신설 — 생성(`--no-track` + `branch.<name>.base` 기록) · 정리 ·
  안전 가드 · 직렬화. **저장소에서 파일을 지울 수 있는 유일한 경로**이며, 지우는
  판단은 전부 이 패키지의 가드를 거친다
- 서버 접합 — `provisionRun` / `provisionMember` / `cleanupWorktrees`.
  격리 준비는 **레코드보다 먼저**다(경로가 uuid 파생이라 id 를 먼저 정한다). 실패하면
  레코드가 남지 않고, 만들어 둔 트리는 롤백된다
- CLI — `dmctl run start --isolation per-run|per-member [--base <ref>]`(조정자 cwd 를
  실어 보낸다) · `run close [--keep-worktrees]` · `status`/`close` 가 잔여물을 낸다
- 스킬 — `team` §3.5(격리는 선택, 기동 전 `cd`, 해체 시 잔여물) + `workflow` 의 짧은
  참조 + 진단 표 4행. 계약 테스트가 이 절의 존재를 지킨다
- **구현 중 스펙을 하나 고쳤다** — FR-WKT-3 의 경로 조각이 `short`(uuid 앞 8자)였는데,
  uuid v7 의 앞 48비트가 밀리초 타임스탬프라 **같은 기간의 Run·Member 가 전부 같은
  short 를 갖는다.** `PathSlug`(앞 8 + 뒤 8)로 개정하고 회귀 테스트를 붙였다
- 검증 — Go 전량 통과(`build`·`vet`·`test`·`gofmt`), Playwright **187 통과**(기준선
  184 + 신규 3), 기준선·이후 각각 2회 재현. 파괴적 동작의 검출기 3건은 **반증**으로
  물리는지 확인했다(dirty 보존을 `--force` 로 바꾸면 실패 / 직렬화 잠금을 빼면 실패 /
  스킬의 "격리 사유가 아니다"를 뒤집으면 실패)
- 남은 확인: **실제 격리 팀으로 한 바퀴**는 아직 돌지 않았다(비격리 팀은 묶음 K 에서
  돌았다). 첫 격리 Run 은 새 worktree 경로가 신뢰 목록에 없어 **폴더 신뢰 모달**에
  걸릴 수 있다 — 스킬 §3.5 와 진단 표가 이 경로를 다룬다

## 별건 — 아직 남은 것

| 항목 | 상태 |
|---|---|
| ~~사용자 인스턴스 v1 → v2 마이그레이션 / 구 식별자 재작성~~ | **완료** (`f7580a7`). `*.preuuid.bak` 백업. 사용자 홈은 전부 uuid v7 |
| ~~`~/.dongminal/runs.json` 에 소비자가 없음~~ | **해소** — 묶음 R 이 이 파일을 쓴다. 기존 프로토타입 필드는 보존했다 |
| FR-STA-4 **사다리 2단계** (어댑터가 선언한 화면 패턴) | **스펙에 남기고 구현 보류** (사용자 확정, 2026-08-25). `Readiness.ScreenPatterns` 자리는 있으나 소비자가 없다. 화면 패턴은 사용자가 하단 스테이터스라인 하나만 붙여도 깨지며, FR-SKL-2 가 삭제하려는 fingerprint 와 같은 취약성이다. 훅을 주지 않는 에이전트는 3단계(출력 3초 정적)로 판정된다 |
| codex 선언의 미확인 필드 | `modelFlag`·`exitCommand` 는 비어 있고 `promptInjection` 은 보수적으로 `stdin-after-start` 다. 이 머신의 codex 는 PATH 에 잡히지만 실체가 끊긴 심볼릭 링크라 실측이 불가했다. D-D 상 Claude 만 검증 대상이므로 차단 사항은 아니다 |
| `POST /api/tools` 의 `cwd` 가 무시된다 | 실측(2026-08-25). 셸이 항상 `~` 에서 뜬다. 묶음 W 는 이 우회를 **스킬 §3.5 의 절차로 못박아** 넘겼다 — 격리 멤버는 기동 전에 `dmctl send-input --execute "cd '<worktree>'"` 를 받는다. 서버가 `cwd` 를 실제로 반영하면 그 단계가 사라지므로 여전히 후속 후보 |
| epoch 펜싱으로 `aborted` 된 Run 의 worktree 는 정리 경로가 없다 | 묶음 W 에서 확인. `run close` 는 `open` 인 Run 만 받으므로, 서버 재기동으로 펜싱된 Run 의 트리는 `run status` 에 남을 뿐 CLI 로 지울 수 없다. dirty 였다면 어차피 보존이 정답이고 clean 이면 누수다. 빈도가 낮아 이번 범위에 넣지 않았다 — 후속 후보 (`close --force` 를 종료된 Run 의 정리에도 열어 주는 형태) |
| `$DONGMINAL_HOME/worktrees` 에 보존 한도가 없다 | 잔여물(dirty·머지 안 된 브랜치)은 **의도된 보존**이라 자동 삭제 대상이 아니다. 쌓이면 사용자가 직접 정리한다. `runs.json` 보존 한도와 같은 성격의 후속 후보 |
| 같은 머신에 dongminal 인스턴스가 둘이면 `PATH` 가 엉뚱한 `dmctl` 을 잡는다 | 실측(2026-08-25). 사용자 `~/.zshrc` 가 `~/.dongminal/bin` 을 앞세우면 격리 인스턴스의 도구도 그쪽 `dmctl` 을 쓴다. 일상 사용(인스턴스 1개)에는 영향이 없어 진단 표에만 적어 뒀다 |
| 웹 서버 재기동 시 죽은 WS 로의 쓰기 폭주 | 실측(2026-08-25, 묶음 W 재기동 중). 옛 서버가 죽어 브라우저 WS 가 끊기면 새 서버가 그 소켓에 **초당 수십 회** 쓰기를 재시도하고 `broken pipe` 를 로그에 남긴다 — 26초 만에 인지했고(`http GET /ws 200 26.693s`) 그 사이 `/tmp/dongminal.log` 가 7.7MB 로 불었다. 쓰기 실패 시 그 구독자를 즉시 해제하면 끝난다. 기능 영향은 없다(끊긴 클라이언트 한정, 브라우저 새로고침으로 복구) |
| 세션 스코프 스킬은 **에이전트 세션 시작 시점에 고정**된다 | 실측(2026-08-25). 서버를 재기동하면 `~/.dongminal/bin/agent-plugin` 은 새것으로 깔리지만, **이미 떠 있는 CC 는 옛 스킬 본문을 계속 쓴다.** 이번에 옛 본문(삭제된 `build_prompt.py`·화면 fingerprint)을 그대로 로드해 확인했고, CC 를 새로 여니 새 본문이 들어왔다. 문서화로 충분한지, 버전 표식으로 감지할지는 후속 판단 |
| `runtime.Install` 이 **삭제된 자산을 지우지 않는다** | 실측(2026-08-25). `build_prompt.py`·`references/prompt.md` 는 `b3dc910` 에서 삭제됐는데 설치 트리에는 남아 있다. 새 SKILL.md 가 참조하지 않아 무해하지만, 옛 세션이 그 파일을 실행할 수 있다. 설치 시 임베드 트리에 없는 파일을 정리하는 편이 맞다 (계약 테스트는 임베드 트리만 본다) |
| `runs.json` 보존 한도 없음 | 무한 증가. 하루 몇 건 수준이라 당장 문제는 아니지만 후속 후보 |
| 워크스페이스 PUT 의 last-write-wins | 미해소. `Tab.runId` 표식이 동시 편집에 지워질 수 있는 근본 원인이다 (`WORKSPACE_IDENTITY_SRS` §2.4·§5). 소유권의 진실은 `runs.json` 이라 기능 영향은 없다 |
| 도구 표시명이 전부 `Shell` | FR-UNI-8 의 의도된 결과. 불편하면 rename UX 보강이 후속 후보 |
| `~/.dongminal/panels.json` | v1 시절 도구 기록. 소비자 없음. 삭제 여부 미정 |
| iOS 실기기 확인 (트랙 1 묶음 F) | 사용자 수동 확인 대기 (`test-checklist.md` C11.8~C11.10) |
| `SYSTEM_STATS_SRS` V-5·V-9 | 수동 확인 대기 (Activity Monitor 대조 / 브라우저 네트워크 탭) |
| `CLIENT_ATTACH_SRS` | 미착수 (ENTITY_MODEL SRS §7 후속) |
| fan-out 결과 자동 비교·병합 / diff 인라인 주석 리뷰 | **별건으로 확정.** 참조 구현에도 없다 — `RUN_ORCHESTRATION_SRS` §5 |
| 저장소에 `LICENSE` 없음 | orca(MIT) 코드를 실제로 차용한다면 고지 의무가 생긴다. 현재는 차용하지 않는 것으로 정리 (DC-RUN-5) |
