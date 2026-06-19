# dongminal-workflow 테스트 시나리오

대전제: dongminal 서버 실행 중, 브라우저 열림, dongminal-team 스킬 동작 확인된 환경.

## TC-WFS-A — create → list → show

> 2명짜리 GAN 워크플로우 만들어줘. 하나는 카피라이터(생성), 하나는 광고주(비판). 3라운드 돌고 카피라이터가 최종본 보고. 제품명은 실행 때마다 바꿀 수 있게.

검증:
- [ ] 인터뷰가 목적→팀→토폴로지→보고→파라미터 순으로 진행 (이미 답한 건 안 물음)
- [ ] 저장 전 정의서 전문을 보여주고 확인 받음
- [ ] `~/.dongminal/workflows/<name>.md` 생성, frontmatter `name` == 파일명
- [ ] `params` 에 product 류 파라미터 선언, 본문에 `{{...}}` 사용
- [ ] uuid 하드코딩 없음
- [ ] `render_workflow.py <파일> --list-params` rc=0
- [ ] list 요청 시 해당 워크플로우 노출, show 가 전문 표시

## TC-WFS-B — run 해피패스 (poem-critique 템플릿, session: dedicated)

사전: `cp skills/dongminal-workflow/templates/poem-critique.md ~/.dongminal/workflows/`

> poem-critique 워크플로우를 topic=바다 로 실행해줘.

검증:
- [ ] `render_workflow.py --json --param topic=바다` 선행 호출, `{{` 잔존 없음
- [ ] `newSession(name='poem-critique', keepFocus=true)` 로 전용 세션 백그라운드 생성 — 사용자 화면 무변화
- [ ] `list_panes` 의 `session="poem-critique"` 행으로 시드 uuid 식별 (diff 비교 아님)
- [ ] 시드에 균등 분할로 팀원 4 pane (writer/lead/critic_1/critic_2) — 기존 pane 재사용 없음
- [ ] 모든 workspace_command 가 `location=<uuid>` + `keepFocus=true`, 사용자 ▶ 미이동
- [ ] team id ↔ uuid 매핑표 작성됨
- [ ] 병렬 send_input 부팅 → 같은 턴 Barrier → kickoff.to(writer) 에게 kickoff.message 송신
- [ ] lead 의 `[TEAM-REPLY task-id=T-FINAL]` 만 수신, 4개 필드 포함
- [ ] teardown: confirm — 사용자 확인 후 /exit

## TC-WFS-C — 필수 param 누락

> poem-critique 실행해줘.

검증:
- [ ] **pane 생성 전에** topic 누락을 사용자에게 질문 (팀 만들고 나서 묻기 금지)

## TC-WFS-D — delete

> poem-critique 워크플로우 지워줘.

검증:
- [ ] 삭제 확인 질문 (복구 불가 고지) → 파일 제거 → list 에서 사라짐

## TC-WFS-E — 1회성 의도는 양보

> 팀 만들어서 이 코드 리뷰해줘.

검증:
- [ ] dongminal-workflow 가 아닌 dongminal-team 트리거 (저장·재사용 의도 없음)
