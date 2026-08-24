# 실패 모드 진단

| 증상 | 원인 | 대응 |
|------|------|------|
| 분할 명령 응답 `delivered=0` | 브라우저가 SSE 구독 안 함 | 사용자에게 브라우저 새로고침 요청 |
| 분할 응답에 `newTabs` 없음 / `timedOut: true` | 브라우저 echo 지연 또는 분할 미반영 | `dmctl list-workspace` 로 실제 상태 확인, 필요 시 재시도 |
| 팀원이 반응 없음 | `claude` 실행 실패 (PATH, 권한) 또는 따옴표 이스케이프 실패로 쉘 파싱 에러 | `dmctl read-screen --at <uuid>` 로 상태 확인. 쉘 에러면 이스케이프 재검토. `command not found` 면 환경 점검 |
| 팀원끼리 서로를 못 찾음 (`not found: <uuid>`) | 팀원을 **순차** 기동해 먼저 뜬 팀원이 아직 존재하지 않는 동료에게 메시지 시도 | 한 `Bash` 호출에서 `&` + `wait` 로 병렬 기동. 이미 발생 시 `dmctl msg` 로 재지시 |
| 정리 단계에서 엉뚱한 탭이 닫힘 | 라벨을 식별자로 보관 → 다른 창 닫힘으로 reflow → 보관 라벨이 다른 탭 가리킴 | uuid 를 식별자로 보관. `dmctl list-workspace` 의 `uuid=` 필드 사용. 라벨은 사람 가독성 디버그용 |
| 데드락 (송신자는 "완료" · 수신자는 영원히 대기) | inline 프롬프트에 첫 작업 지시를 넣어, 먼저 부팅된 팀원이 쉘 상태 동료에게 엔벨로프 송신 → 쉘에 텍스트로 찍혀 증발 | 초기 프롬프트엔 `[대기]` 만. Barrier 로 전원 CC 상태 확인 후 Kickoff (`dmctl msg`). `scripts/build_prompt.py` 는 이를 강제함 |
| 팀원이 "메시지 보냄" 인데 수신 안 됨 | 내장 `SendMessage` / `SendUserMessage` 오용 — 자기 화면엔 "전송 완료" 로 보임 | 초기 프롬프트에 `dmctl msg` 실행 명령 + 내장 tool 금지 경고 포함. 이미 발생 시 팀원에게 "방금 경로가 틀렸다, 반드시 Bash 로 `dmctl msg --to <uuid>` 를 호출" 재지시 |
| `dmctl: command not found` | 사용자가 dongminal 밖 터미널에서 실행 중 | dongminal 도구 안에서만 유효하다. `dmctl` 은 `$DONGMINAL_HOME/bin` 에 있다 |
| 여러 줄 본문이 잘림 / 셸이 멈춤 | 위치 인자로 넘기며 인용 실패, 또는 heredoc 종료자를 들여씀 | `- <<'MSG'` 로 stdin 사용. **종료자는 반드시 열 0** |
| 답장 포맷 엉뚱 | 지시 메시지의 답장 블록 누락/모호 | 포맷 예시 포함해 재지시 |
| 답장 혼동 | task-id 관리 실패 | 송신자 uuid + 엔벨로프 내부 `task-id` 를 함께 키로 매칭 (엔벨로프 헤더의 `from=` 표시값은 라벨로 정규화되니 보조 정보로만) |
| 팀원 CC 죽음 | claude 프로세스/쉘 종료 | `dmctl list-workspace` 재확인. 팀원 재생성. 중간 결과는 `dmctl read-output --at <uuid>` 로 구출 |
| `dmctl msg` submit 안 됨 (드묾) | 수신측 TUI reconciliation 지연 | `dmctl send-input --at <uuid> --execute ""` 로 엔터 보강 |

## 로그

`/tmp/dongminal.log` 에 아래가 찍혀 경로별로 확인 가능하다.

- `[cmd] action=... delivered=N` — 레이아웃 명령의 SSE 브로드캐스트 여부
- `[toolio] input tool=... textLen=N` — `dmctl send-input` 도달
- `[toolio] message from=... to=... msgLen=N` — `dmctl msg` 도달 (정규화된 라벨과 입력값을 함께 기록)
