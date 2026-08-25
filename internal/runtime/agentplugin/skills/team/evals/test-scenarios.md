# team 스킬 테스트 시나리오

사용자가 직접 돌려보고 실제 동작 여부를 검증하기 위한 프롬프트 모음. 각 시나리오는 **팀장 CC 가 돌고 있는 도구에서 사용자가 치는 메시지**다.

대전제:
- dongminal 서버 실행 중, 브라우저 열림, SSE 연결됨
- 조정자 CC 는 **한 도구** 에서만 동작. 팀원 도구는 스킬이 **전용 창에** 새로 생성한다
- 기존에 열린 다른 도구의 CC 는 절대 팀원으로 쓰지 않는다
- 검증의 1차 근거는 **`dmctl run status --run <uuid>` 와 `dmctl status --at <uuid>`** 다. 화면은 "왜 막혔는가"를 볼 때만 읽는다

---

## 시나리오 1 — 4명 팀 · 2라운드 통합 비평 · 수평 토론 · 최종 1회 보고

이 스킬의 핵심 능력을 한꺼번에 검증하는 메인 시나리오. 다음 요소를 전부 포함:
- **전용 창 + 균등 4분할** (`dmctl new-window -n` → `dmctl split-* 4 --at <시드> -n`)
- **역할별 모델 분기** (작가·수석비평가 Opus, 일반 비평가 Sonnet)
- **동시 기동** — 한 `Bash` 호출에서 `&`+`wait` 로 병렬 `dmctl run launch | dmctl send-input`
- **수평 협업** — 비평가끼리 A 를 허브로 간접 협업 (B, C 가 A 에게 각자 송신)
- **2라운드 파이프라인** — 초안 → 1차 통합 비평 → 개정판 → 2차 통합 비평
- **보고 계약** — 멤버 전원이 `dmctl run report` 로 정확히 한 번 보고하고, 최종 산출물 본문은 수석비평가 A 만 `dmctl msg` 로 조정자에게 송신

### 프롬프트
> 팀원 4명 만들어서 시 비평 파이프라인 돌려줘.
> - 1명은 작가: 공백 포함 100자 이내 한국어 공포 시 초안 작성
> - 3명은 비평가(A=수석 lead, B, C)
> - 작가가 초안을 A/B/C 전원에게 송신 → 각자 독립 비평 → B,C 가 A 에게 송신 → A 가 자기것+B+C 종합 → 1차 통합 비평을 작가에게 돌려줌
> - 작가가 개정판 작성 → A/B/C 전원에게 송신 → 2차 라운드 동일하게
> - 최종적으로 A 가 **원본 + 1차 통합 비평 + 개정판 + 2차 통합 비평** 을 모두 포함한 최종 보고를 나에게 1회만 전달
>
> 작가와 수석비평가 A 는 Opus, 나머지 비평가는 Sonnet 으로 돌려줘.

### 검증 포인트 — 공간 (TC-SKL-1)

- [ ] `dmctl new-window --name <이름> -n` 으로 **전용 창** 생성. 응답의 `newWindows[0]`·`newTabs[0].uuid` 를 그대로 쓴다 (`list-workspace` 재조회 없음)
- [ ] 전용 창 안에서 `dmctl split-* 4 --at <시드> -n` **단일 호출**로 균등 4분할. 셀 비율 계산 없음
- [ ] **사용자의 창·탭이 전혀 바뀌지 않는다** — 팀 구성 전후로 `dmctl list-workspace` 를 비교해 전용 창 외 차이 0
- [ ] **포커스가 움직이지 않는다.** `focus` 액션 0회 호출
- [ ] 팀원 탭을 모두 닫으면 전용 창이 스스로 사라진다 (`close-window` 호출 0회)

### 검증 포인트 — Run 기록과 기동

- [ ] `dmctl run start --objective <목적> --window <창 uuid>` 로 Run 을 연다
- [ ] 팀원마다 `dmctl run member ... --brief -` (여러 줄이면 heredoc). 응답의 `member=<uuid>` 를 쓴다
- [ ] 4개 기동이 **한 `Bash` 호출 안에서 `&` + `wait`** 로 병렬 실행
- [ ] 기동줄을 **손으로 조립하지 않는다** — `dmctl run launch --member <m> --model <model>` 의 출력을 그대로 `dmctl send-input --execute -` 에 파이프. 손으로 `claude ...` 를 쓰면 가변 인자 플래그가 프리앰블을 삼켜 빈 프롬프트로 뜬다
- [ ] 모든 `--at` 값이 **uuid** (라벨 사용 시 즉시 NG)
- [ ] 프리앰블에 Run·Member uuid 와 조정자 uuid 가 박혀 있어 팀원이 `who-am-i` 를 부를 필요가 없다 (`dmctl run launch --member <m> --text` 로 확인 가능)

### 검증 포인트 — 2라운드 파이프라인

- [ ] 작가가 초안을 A/B/C 세 명에게 **각각** `dmctl msg` 3번 호출
- [ ] B, C 가 독립적으로 비평 작성 후 A 에게 `[FROM-CRITIC from=B|C round=1]` 송신
- [ ] A 가 자기 비평 + B + C 통합 후 작가에게 `[FROM-LEAD task-id=T-CRITIQUE-1]` 송신
- [ ] 작가가 개정판 작성 후 다시 A/B/C 세 명에게 `[FROM-WRITER task-id=T-REVISE-1]` 송신
- [ ] round=2 동일 사이클
- [ ] 최종 산출물 본문은 **A 만** 조정자에게 `dmctl msg` 로 송신 (B, C, 작가는 본문 송신 없음)
- [ ] 그 본문에 `draft_original`, `joint_critique_1`, `draft_revised`, `joint_critique_2` 4개 필드 전부 포함
- [ ] 멤버 4명 전원이 `dmctl run report` 로 **각자 한 번** 보고 → `dmctl run status` 에서 4명 모두 `outcome` 을 갖는다
- [ ] 같은 멤버의 두 번째 보고는 `member_already_reported` 로 거부된다

### 검증 포인트 — Barrier (TC-SKL-2)

- [ ] 준비완료 확인이 **`dmctl wait --at <uuid> --for ready`** 다. `sleep` + 재확인 루프 0회
- [ ] 화면 fingerprint(프롬프트 박스·스피너 부재·특정 텍스트)로 판정하지 않는다
- [ ] `wait` 가 rc=5(blocked)면 **다시 기다리지 않고** 화면을 읽어 원인을 처리한다
- [ ] `wait` 가 rc=4(타임아웃)면 체크포인트로 취급 — 그것만으로 팀원을 죽이거나 재기동하지 않는다
- [ ] Kickoff 는 rc=0 이후에만 나간다
- [ ] 4단계(기동)~6단계(Kickoff)가 **한 어시스턴트 턴** 안에서 끝난다

### 검증 포인트 — 수평 협업의 건강성

- [ ] B 와 C 가 **독립적인** 관점 제시 (한쪽이 다른 쪽 복붙 아니고, 실제로 각도가 다름)
- [ ] A 가 B/C 의견을 **무시하거나 그대로 복붙** 이 아니라 **통합/재정리** 흔적 (중복 병합, 상충 명시)
- [ ] task-id 혼동 없음: `T-DRAFT-1` ↔ `T-REVISE-1` ↔ `T-CRITIQUE-1` ↔ `T-FINAL` 분리 유지

### 실측된 실패 패턴 (이 시나리오로 검증 가능)

1. **답장 경로 오용**: 비평가 C 가 `dmctl msg` 대신 Claude Code 내장 `SendMessage` 를 호출해 A 가 영원히 대기. 프리앰블이 실행 명령 + 금지 경고를 담고 있는지 확인.
2. **순차 기동 레이스**: 먼저 뜬 팀원이 아직 존재하지 않는 동료에게 메시지 시도. 병렬 기동으로 해결됐는지 확인.
3. **라벨 드리프트**: 라벨로 `close-tab` 호출 시 앞선 탭이 닫혀 후속 라벨이 reflow → 엉뚱한 탭 닫힘. uuid 사용 시 면역.
4. **시작 모달에 막힌 기동**: 신뢰하지 않는 디렉터리에서 claude 를 띄우면 폴더 신뢰 확인 모달이 뜬다. 이때 훅은 아무것도 보고하지 않고 화면은 조용하다 — `dmctl status` 가 `state=unknown` 으로 계속 남는지 확인. 기동 전에 신뢰된 경로로 `cd` 했는지 본다.
5. **승인 프롬프트에 막힌 보고**: 멤버가 `dmctl run report` 를 실행하려다 승인 대기(`state=waiting`)에 걸린다. 기동줄을 손으로 조립해 권한 사전 허용이 빠졌을 때 발생. `dmctl run launch` 출력을 그대로 썼는지 확인.

### 검증 포인트 — 식별자 안정성 (UUID)

- [ ] 모든 레이아웃 명령의 `--at` 값이 **uuid** (라벨 시 NG)
- [ ] 모든 `dmctl msg` 의 `--to` 가 **uuid**, `--from` 은 생략 (자동 채움)
- [ ] 모든 `dmctl send-input` / `dmctl read-screen` 의 `--at` 가 **uuid**
- [ ] 정리 중 한 탭 닫은 직후 `dmctl list-workspace` 재호출 없이 보관된 uuid 로 다음 탭 정리 가능 (라벨 reflow 무관)

### 검증 포인트 — 정리 (TC-SKL-3)

- [ ] `dmctl run close --run <uuid>` — 미보고 멤버가 있으면 **거부되고 목록이 나온다**
- [ ] close 응답의 정리 대상(`tabId`)으로 `/exit` → `dmctl close-tab` 순서 진행
- [ ] 팀원 탭이 모두 닫히면 전용 창 자동 소멸. `close-window` 호출 0회
- [ ] **사용자의 창·탭 무변경**, `focus` 액션 0회 호출
- [ ] **새 세션에서 `dmctl run status --run <uuid>` 만으로 멤버 전원과 보고 내용을 조회할 수 있다** — 매핑표를 대화 기록에 두지 않았다는 증거

---

## 시나리오 2 — CC 기동 실패 복구

**프롬프트**:
> 팀원 1명 만들어서 `현재 디렉토리의 .go 파일 목록` 을 뽑아달라고 해.

CC 기동 단계에서 지연/실패가 날 때 대응을 보는 용도. 단일 팀원이므로 레이아웃은 간단.

**검증 포인트**:
- [ ] 전용 창 1개 → 팀원 탭 1개 → `dmctl run launch | dmctl send-input` 로 기동
- [ ] `dmctl wait --for ready` 의 종료 코드로 분기한다 (0/4/5 를 구분해 대응)
- [ ] 보고가 `dmctl run status --run <uuid>` 에 `outcome` 과 함께 나타나면 정상 종료
- [ ] 막히면 `dmctl status --at <uuid>` 로 `state` 를 먼저 보고, 그 다음에야 `dmctl read-screen` 으로 원인을 읽는다
- [ ] 실패 지속 시 사용자에게 "기동 실패. state=<상태>, 화면: <일부>. 수동 확인 바람" 보고

---

## 시나리오 3 — 트리거 테스트 (양성/음성)

스킬이 **트리거되어야/되지 않아야** 하는지만 확인. 실제 팀 구성까지 가지 않아도 됨.

### 트리거되어야 함
- "팀 두 명 만들어서 서로 다른 답 비교하게"
- "네가 팀 구성해서 알아서 처리"
- "agent team 써서 병렬로 풀어"
- "GAN 스타일로 두 CC 붙여서 생성-비판 돌려"
- "리서치 fan-out 으로 관점 4개 내봐"

### 트리거되지 말아야 함 (단일 CC 로 충분)
- "이 파일 읽어줘"
- "현재 탭 이름 뭐야?" → `dmctl who-am-i` 정도만 필요
- "`dmctl list-workspace` 실행해줘" → 단순 명령 실행
- "dmctl 명령 설명해줘" → 문서성 질문

---

## 빠른 검증 팁

**공간 확인**: 브라우저에서 팀 구성 직후 **새 창**이 생기고 그 안이 균등 분할됐는지, 그리고 **원래 보던 창이 그대로인지** 확인. 후자가 TC-SKL-1 의 핵심이다.

**진행 시각화**: 각 팀원 도구가 브라우저에서 실시간으로 보이므로 엔벨로프 주고받는 순간, CC 가 생각하는 순간, 답장하는 순간이 모두 관찰 가능. tmux team agents 대비 가장 큰 UX 이점.

**멈춘 CC 진단**: `dmctl run status --run <uuid>` 로 누가 어떤 state 인지 먼저 본다. `waiting` 이면 막힌 것이고, `working` 이면 진행 중이다. 그 다음에 해당 도구를 `dmctl read-screen` 해서 원인을 읽는다 — `dmctl msg` 가 아니라 `SendMessage` 호출이 보이면 경로 오용.

**로그**: `/tmp/dongminal.log` 에 `[cmd] action=... delivered=N` (SSE 브로드캐스트)과 `[run] start|member|report|close ...` (Run 기록 변경 전부)가 찍힌다.
