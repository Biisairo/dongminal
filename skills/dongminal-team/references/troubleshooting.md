# 실패 모드 진단

| 증상 | 원인 | 대응 |
|------|------|------|
| `workspace_command` 응답 `delivered=0` | 브라우저가 SSE 구독 안 함 | 사용자에게 브라우저 새로고침 요청 |
| 분할 후 `list_panes` 에 새 pane 없음 | 분할 미반영 | `workspace_command` 응답 재확인, 필요 시 재시도 |
| 팀원이 반응 없음 | `claude` 실행 실패 (PATH, 권한) 또는 따옴표 이스케이프 실패로 쉘 파싱 에러 | `read_pane_screen` 으로 상태 확인. 쉘 에러면 이스케이프 재검토. `command not found` 면 환경 점검 |
| 팀원끼리 서로를 못 찾음 (`to unknown label`) | 팀원을 **순차** 기동해 먼저 뜬 팀원이 아직 존재하지 않는 동료에게 메시지 시도 | 단일 메시지 병렬 기동으로 해결. 이미 발생 시 `send_agent_message` 로 재지시 |
| 데드락 (송신자는 "완료" · 수신자는 영원히 대기) | inline 프롬프트에 첫 작업 지시를 넣어, 먼저 부팅된 팀원이 쉘 상태 동료에게 엔벨로프 송신 → 쉘에 텍스트로 찍혀 증발 | 초기 프롬프트엔 `[대기]` 만. Barrier 로 전원 CC 상태 확인 후 Kickoff (`send_agent_message`). `scripts/build_prompt.py` 는 이를 강제함 |
| 팀원이 "메시지 보냄" 인데 수신 안 됨 | 유사 이름 tool 오용 (예: 내장 `SendMessage`) — 자기 화면엔 "전송 완료" 로 보임 | 초기 프롬프트에 `mcp__dongminal__send_agent_message` 풀 네임 + 유사 이름 금지 경고 포함. 이미 발생 시 팀원에게 "방금 tool 이 틀렸다, 반드시 `mcp__dongminal__send_agent_message` 호출" 재지시 |
| 답장 포맷 엉뚱 | 지시 메시지의 답장 블록 누락/모호 | 포맷 예시 포함해 재지시 |
| 답장 혼동 | task-id 관리 실패 | `from=<라벨>` + 엔벨로프 내부 `task-id` 를 함께 키로 매칭 |
| 팀원 CC 죽음 | claude 프로세스/쉘 종료 | `list_panes` 재확인. 팀원 재생성. 중간 결과는 `read_pane_output` 으로 구출 |
| `send_agent_message` submit 안 됨 (드묾) | 수신측 TUI reconciliation 지연 | `send_input(id, text="", execute=true)` 로 엔터 보강 |

## 로그

`/tmp/dongminal.log` 에 `[cmd] action=... delivered=N` 이 찍혀 SSE 브로드캐스트 여부 확인 가능.
