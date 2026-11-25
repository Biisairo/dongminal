# M2 문서 정합 목록 (이슈 2.10)

- 기준: 통합 worktree `perf-m1` 의 `4f41422b` 커밋(2026-11-25). 코드가 기준이다(사용자 지시).
- 범위: M1·M2 이슈(0·1.*·2.*) 진행 기록의 "코드와 어긋난 문서", STATUS 「문서 정합 대기 목록」의 M1·M2 몫, 조사 중 새로 찾은 것.
- 제외: `docs/internal/archive/` 아래 문서(사용자 결정 1.12). M3 이슈(3.*)의 항목(새 세션에서 M3 와 함께 처리). M2 문서와 겹치는 M3 항목은 맨 아래 「M3 와 겹침」에 표시만 했다.
- 2026-11-25 사용자 결정(조정자 전달): 61건 전부를 코드 기준으로 고치고, Q1~Q6 은 아래 「처리 결과」 대로 한다. 동작(코드 로직)은 바꾸지 않았다 — 주석·문서·화면 문구·시험 이름만. 커밋: 외부 `cee4b45c`, 내부 `c7824299`, 주석·문구는 그 뒤 커밋.

## 1. 고칠 목록

분류: **외** = 외부 사용자 문서(`docs/external`, CHANGELOG, 화면 문구) · **내** = 내부 SRS·설계 · **주** = 주석·시험 이름·스크립트 머리말.

### 1.1 외부 사용자 문서

| 번호 | 문서·위치 | 지금 문서가 말하는 것 | 코드의 실제(근거) | 고칠 방향 | 출처 | 분류 | 처리 결과 |
|---|---|---|---|---|---|---|---|
| E1 | `docs/external/api.md` (도구 표, 54행 앞) | `/api/tools/search` 행이 없다. `check-api-docs.sh` 가 실패한다 | `routes.rs:42` `get("/api/tools/search")`, `tools_api.rs:334~363` (`id`·`q`·`before`(필수, 숫자 아니면 400)·`regex`·`case`·`word`=`1`, 결과 `{hits}`, 없는 도구 404, 데몬이 찾지 못하면 422) | 에이전트 접합면 또는 도구 표에 행 하나를 더한다 | 2.8.2, 2.8.4 | 외 | 고침 — 에이전트 접합면 표에 행 추가, `check-api-docs.sh` 통과(cee4b45c) |
| E2 | `docs/external/api.md:43` | `/api/tools/output` 의 `strip=1` 이면 ANSI 를 제거한다 | `strip=1` 이면 데몬 화면 상태의 글자(화면 + 기록)다. 아니면 링 바이트다 (`httpapi/src/toolio.rs:109~110`, `:137~140`) | "`strip=1`(read-screen)은 데몬이 그린 화면 글자 + 기록" 으로 고친다 | 2.8.1 | 외 | 고침 — `strip=1` = 화면 글자(cee4b45c) |
| E3 | `docs/external/commands.md:50` | read-screen 은 "ANSI 를 제거한 텍스트" | 위와 같다. 도움말은 이미 "화면 글자 + 기록" 이다 (`helptext.rs:439`, `:446`) | 도움말과 같은 문구로 맞춘다 | 2.8.1 | 외 | 고침(cee4b45c) |
| E4 | `docs/external/agent-orchestration.md:84` | "ANSI 제거 텍스트로 읽기" | 위와 같다 | "화면 글자로 읽기" 로 고친다 | 2.8.1 | 외 | 고침(cee4b45c) |
| E5 | `docs/external/api.md:340` | `/api/git/repos` 에 `clientId` 를 주면 핀 감시를 임대하고, `?observe=0&clientId=` 로 놓는다. 바뀌면 `git_changed` 가 온다 | `clientId`·`observe=0` 를 읽지 않는다. `observe=1` 만 본다 (`gitapi/src/handlers_git.rs:33~45`). 임대는 채널의 `git:<repo>` 토픽 구독이 쥔다 (`hub/src/gitwatch/lease.rs:28` `hold_topic`) | `clientId`·`observe=0` 문장을 지우고 "변화는 채널 `git:<root>` 토픽" 으로 바꾼다 | 1.18 | 외 | 고침 — `clientId`·`observe=0` 삭제, `git:<root>` 토픽(cee4b45c) |
| E6 | `docs/external/api.md:434` (`term.open`) | 필드는 `sid`·`tool`·`cols`·`rows`·`since` | `snap` 필드가 있다. `snap:true` 면 `since` 를 보지 않고 화면 상태 스냅숏을 보낸다 (`channel/term.rs:145~175`) | `snap` 필드를 더한다 | 2.5 | 외 | 고침 — `snap` 필드(cee4b45c) |
| E7 | `docs/external/api.md` (채널 터미널 절) | `term.history` 가 없다 | 브라우저 → 서버 `term.history{sid,before,count}`, 서버 → 브라우저 `term.history{sid,from,top,lines}` (`channel/term.rs:136~137`, `:206~236`) | 위로 받기 프레임 두 줄을 더한다 | 2.7 | 외 | 고침 — 위로 받기 두 프레임(cee4b45c) |
| E8 | `docs/external/api.md` opcode 표 `0x04` | `offset uint64 BE + full uint8` | 깃발 바이트의 비트: FULL=1·ALT=2·SNAP=4. SNAP 이면 뒤에 첫 기록 줄 번호(u64 BE)와 cwd(UTF-8)가 붙는다 (`httpapi/src/ws.rs:27~30`, `:141~147`) | 깃발 비트와 SNAP 꼬리를 적는다 | 2.5 | 외 | 고침 — 깃발 비트·SNAP 꼬리(cee4b45c) |
| E9 | `docs/external/api.md:452~469` 「재접속」 | `since` 없음·창 밖 = 전량 재생(초기화·클리어·보유 스크롤백). `full=1` 이면 클라이언트가 리사이즈를 한 행 줄였다 되돌린다(넛지) | `since` 가 링 안이면 델타, 아니면(없음·창 밖·`snap`) 화면 상태 스냅숏 + `SEQ(FULL·SNAP)` 이다 (`channel/term.rs:405~425`). 넛지는 없다 (`web/js/ui/term-pane.js:246~249`) | 표의 "전량 재생" 두 줄을 "스냅숏" 으로, 넛지 문단을 지운다 | 2.5 | 외 | 고침 — 스냅숏 표, 넛지 문단 삭제(cee4b45c) |
| E10 | `docs/external/api.md:450` (흐름 제어 문장) | 밀린 출력이 1 MB 를 넘으면 브라우저가 가진 좌표부터 다시 재생한다 | 밀린 출력만 버리고 스냅숏으로 다시 맞춘다 (`channel/term.rs:560~570`, `:468~479`) | "스냅숏으로 다시 맞춘다" 로 고친다 | 2.6 | 외 | 고침 — 스냅숏 맞춤, 쓰기 순서에 위로 받기(cee4b45c) |
| E11 | `docs/external/api.md:471~490` 「응답 좌석」 | 주인 연결이 답한다. 연결이 없을 때의 동작이 없다 | 붙은 연결이 하나도 없으면(좌석 0) 데몬 에뮬레이터가 DA·DSR·커서 위치 질의에 답한다. 색 질의는 답하지 않는다 (`toolhub/src/tool.rs:406~430`, SRS D-23) | "아무도 붙지 않으면 데몬이 답한다" 한 줄을 더한다 | 2.8.2 | 외 | 고침 — 좌석 0 이면 데몬이 답함(cee4b45c) |
| E12 | `docs/external/features.md:509` · 화면 문구 `web/js/i18n/ko.js:1047`·`en.js:1023` (`html.term_scrollback_hint`) | 화면 기록 줄 수는 "새로 여는 터미널부터 적용" | 다시 보여 깨어나는 터미널도 지금 설정으로 맞춘다 (`term-pane.js:269~272` `wake()`). 서버도 같은 값으로 스냅숏의 기록 행 수를 정한다 (`httpapi/src/screen_config.rs:66~69`) | "다음에 터미널이 보일(깨어날) 때부터 적용" 으로 고친다(세 곳) | 2.5.1 | 외 | 고침 — features.md(cee4b45c), ko·en 문구(주석·문구 커밋) |
| E13 | `docs/external/features.md:89` (터미널 검색), 터미널 절 | 브라우저 검색만 적는다. 위로 스크롤해 더 옛 기록을 보는 기능이 없다 | 검색 상자에 "이전 기록에서 찾기"(`ko.js:1012`)가 서버 기록을 찾는다. 맨 위에서 더 올리면(휠·터치·Shift+PageUp) 기록 보기가 열리고 Esc·맨 아래·입력 키로 닫힌다 (`ko.js:1655`, 2.7 사용자 결정) | 기능 설명 두 항목(이전 기록 찾기·기록 보기)을 더한다 | 2.7, 2.8.2 | 외 | 고침 — 이전 기록 찾기·기록 보기·잠듦 행(cee4b45c) |
| E14 | `docs/external/features.md:216` | 다시 불러오기 때 "터미널은 전부 다시 붙어 서버의 스크롤백을 받아온다" | 보이는 터미널만 붙고 스냅숏을 받는다. 숨은 터미널은 처음 보일 때 붙는다 (`web/js/core/app.js:206~207`, `term-pane.js:264~272`) | "보이는 터미널이 다시 붙어 화면 상태를 받는다" 로 고친다 | 2.5(조사 중 발견) | 외 | 고침(cee4b45c) |
| E15 | `docs/external/features.md:688` 상한 표 | "도구별 스크롤백 버퍼 1 MiB" | 1 MiB 는 출력 바이트 링이다(read-output·재접속 이어 붙이기). 서버 화면 기록은 설정 `termHistoryLines`(기본 50,000줄)다 (`linestore/src/lib.rs:17`, `settings-schema.js:41`) | 행 이름을 "도구별 출력 바이트 링" 으로 바꾸고 서버 기록 줄 수 행을 더한다 | 2.3·2.9(조사 중 발견) | 외 | 고침 — 링 행 이름, 서버 기록 행 추가, :665 새로고침 복원 문장도(cee4b45c) |
| E16 | `docs/external/commands.md:227` (`download`) | 출력하면 브라우저가 내려받는다 | 보이는(깬) 터미널에서만 동작한다. 잠든 동안 온 요청은 버린다 (SRS D-24) | "보이는 터미널에서 친 경우만" 한 줄을 더한다 | 2.8.2(조사 중 발견) | 외 | 고침(cee4b45c) |
| E17 | `docs/external/getting-started.md:170~180` (데몬 교체) | 교체를 아는 데몬이면 `start` 가 세션을 유지하며 교체한다. 옛 판 예외는 "교체를 모르는 데몬" 하나다 | 인계 판이 1 → 2 로 올랐다. M2 이전 데몬은 새 바이너리의 판이 달라 교체를 거절한다 (`daemon/swap/src/validate.rs:136~143`). 한 번 `--refresh-daemon`(세션 잃음)이 필요하다 | "M2 이전 판에서 올릴 때는 한 번 `--refresh-daemon`" 을 더한다 | 2.9(조사 중 발견) | 외 | 고침 — 판 2 안내, `--server-only` 로 옛 데몬에 붙이면 터미널이 열리지 않음(cee4b45c, Q1) |
| E18 | `CHANGELOG.md` [Unreleased] | M2 항목이 없다 | 사용자에게 보이는 변화: read-screen 이 화면 글자로 답함, 숨은 터미널은 출력을 받지 않음(잠듦), 설정 `termHistoryLines`·`termScrollback` 추가(브라우저 기본 50,000 → 5,000줄), 이전 기록 찾기·기록 보기, 잠든 터미널의 `download` 무시, 데몬 교체 판 2(M2 이전 데몬은 한 번 전체 재시작) | [Unreleased] 바뀜·더함에 M2 항목을 더한다 | 2.10(조사 중 발견) | 외 | 고침 — 바뀜 넷·더함 셋(cee4b45c) |

### 1.2 내부 SRS·설계

| 번호 | 문서·위치 | 지금 문서가 말하는 것 | 코드의 실제(근거) | 고칠 방향 | 출처 | 분류 | 처리 결과 |
|---|---|---|---|---|---|---|---|
| I1 | `perf/CHANNEL_PROTOCOL.md:49` §4.1 `term.open` | 필드 `sid`·`tool`·`cols`·`rows`·`since?` | `snap` 필드가 있다 (`channel/term.rs:145~175`) | `snap?` 을 더한다 | 2.5 | 내 | 고침(c7824299) |
| I2 | `perf/CHANNEL_PROTOCOL.md` §4.1 두 표 | `term.history` 가 없다 | 양방향 `term.history` (`channel/term.rs:136~137`, `:206~236`, `channel/mod.rs:194`) | 두 표에 한 줄씩 더한다 | 2.7 | 내 | 고침 — 두 표 + `term.lost` 행(c7824299) |
| I3 | `perf/CHANNEL_PROTOCOL.md:73` §4.2 | "M2 가 스냅숏을 더할 때 op 를 새로 더한다" | 새 op 는 없다. `SEQ` 깃발 SNAP(비트 2)과 꼬리(첫 기록 줄 번호·cwd)다 (`ws.rs:27~30`, `:141~147`, SRS D-19) | 그 줄을 SNAP 깃발·꼬리 설명으로 바꾼다 | 2.5, M2_DESIGN §6 | 내 | 고침(c7824299) |
| I4 | `perf/CHANNEL_PROTOCOL.md:116` §6 차선 | 제어 > 터미널 출력 > 상태 | 제어 > 터미널 > 위로 받기(`term.history`) > 상태 (`channel/outbox.rs:44`, `:219~236`) | 위로 받기 차선을 더한다 | 2.7 | 내 | 고침 — 차선 넷, §11.1 도(c7824299) |
| I5 | `perf/CHANNEL_PROTOCOL.md:118` §6 터미널 출력 | 상한을 넘으면 밀린 것을 버리고 `snapshot_tool_since(보낸 끝)` 으로 다시 보낸다. "M2 가 이 자리를 스냅숏으로 바꾼다" | 출력만 버리고 화면 상태 스냅숏으로 맞춘다 (`channel/term.rs:560~570`, `:468~479`) | 스냅숏으로 고치고 "M2 가 바꾼다" 를 지운다 | 2.6 | 내 | 고침(c7824299) |
| I6 | `perf/CHANNEL_PROTOCOL.md` §6·§10.2 TC-CH2A 표(`:213` 근처) | 명령 구독이 넘쳐 닫힐 때의 동작이 없다 | 허브가 명령 구독을 닫으면(큐 넘침) 채널을 닫는다. 브라우저는 다시 연결한다 (`channel/cmd.rs:123~130`) | §6 에 한 줄, TC-CH2A 에 시험 행 하나를 더한다 | 1.17 | 내 | 고침 — §6 한 줄, TC-CH2A-14(시험 `overflowed_command_sub_closes_channel`)(c7824299) |
| I7 | `perf/CHANNEL_PROTOCOL.md:265` TC-CH5-2 | 있는 도구: 재생 `OUTPUT`(전량이면 초기화·클리어, 첫 줄까지 버림) → `SEQ(full)` | 델타가 아니면 스냅숏 `OUTPUT` → `SEQ(FULL·SNAP)` 이다 (`channel/term.rs:405~460`) | 스냅숏 순서로 고친다 | 2.5 | 내 | 고침(c7824299) |
| I8 | `perf/CHANNEL_PROTOCOL.md:270` TC-CH5-7 | 틈이 생기면 `since=보낸 끝` 재생 + `SEQ` | 틈이 생기면 스냅숏으로 맞춘다 (`channel/term.rs:527`) | 스냅숏으로 고친다 | 2.5, 2.6 | 내 | 고침(c7824299) |
| I9 | `perf/CHANNEL_PROTOCOL.md:274` TC-CH5-11 | Outbox 가 sid 마다 브라우저 좌표를 따라가고, 넘치면 그 좌표부터 다시 재생 | 좌표 추적은 없다. 밀린 양만 센다(`TermMirror{pending, session}`, `outbox.rs:30~37`). 넘치면 출력을 버리고 스냅숏 (`term.rs:560~570`) | 좌표 문장을 지우고 스냅숏으로 고친다 | 2.6 | 내 | 고침(c7824299) |
| I10 | `perf/CHANNEL_PROTOCOL.md:313` §11.1 터미널 차선 | `term_state(sid) -> (밀린 바이트, 브라우저 좌표)`, `drop_term(sid)` | `term_pending(sid)`·`drop_term_output(sid)` 이다 (`outbox.rs:257`, `:263`). `term_current`·`push_history` 도 있다 | 함수 이름을 코드에 맞춘다 | 2.6 | 내 | 고침(c7824299) |
| I11 | `perf/M2_DESIGN.md` §1 「지금 구조」 전체(§1.1 `tool.rs` 줄 번호, §1.3 붙기·모드 복원·흐름 제어, §1.4 연결 시점·스크롤백 상수, §1.5 read-screen) | M2 착수 전 조사를 "지금" 으로 적었다 | 줄 번호가 밀렸고 동작이 모두 바뀌었다. §1.4 "모든 터미널이 만들어지자마자 connect()" 는 조사 때도 틀렸다(2.5 기록 — `mkTool` 은 처음 그릴 때 불림, `app.js:206~207`) | 줄마다 고치지 않고 §1 머리에 "2026-11-24 착수 전 조사, 지금 동작은 §2·CHANNEL_PROTOCOL" 을 적는다. §1.4 연결 시점 한 줄만 정정 | 2.2, 2.4, 2.5, 2.6, 2.8.1 | 내 | 고침 — §1 머리 주석, §1.4 정정(c7824299) |
| I12 | `perf/M2_DESIGN.md:108` §2.2 | 바깥에는 feed·resize·화면 셀 읽기·모드 읽기만 낸다 | `history_len`·`row`·`snapshot`·`handover`·`take_replies`·`store` 등도 공개다. `drop_oldest` 는 비공개 (`termstate/src/emu.rs:153~388`, `:361`) | "바깥 표면" 줄을 지금 공개 함수로 고친다 | 2.2, 2.4 | 내 | 고침(c7824299) |
| I13 | `perf/M2_DESIGN.md:111` §2.2 | 에뮬레이터의 답장(`PtyWrite`)은 PTY 에 쓰지 않는다 | 좌석이 비면(붙은 연결 0) 데몬이 쓴다 (`toolhub/src/tool.rs:406~430`, D-23) | "좌석이 비면 쓴다(2.8.2)" 로 고친다 | 2.8.2 | 내 | 고침(c7824299) |
| I14 | `perf/M2_DESIGN.md:112` §2.2 | 에뮬레이터 기록 상한 1,000줄 | 1,000 은 남기는 줄 수(`EMU_KEEP`)다. 상한은 keep + 2×256 + 화면 행 수다 (`termstate/src/emu.rs:100~121`) | 두 값을 나눠 적는다 | 2.4 | 내 | 고침(c7824299) |
| I15 | `perf/M2_DESIGN.md:131` 근처 §2.3 | 넣기 전에 줄바꿈 수로 나눠 넣는다 | 줄바꿈(LF·VT·FF) 수 + 바이트 수/열 수로 나눈다 (`linestore/src/split.rs:1~10` `split_for_rows`) | 나누는 기준을 고친다 | 2.4 | 내 | 고침(c7824299) |
| I16 | `perf/M2_DESIGN.md:152` §2.4 「주의」 | 분할점이 시퀀스 한가운데면 "스냅숏 시점을 시퀀스 경계까지 미루기 등" | 미루지 않고 **물린다**: 끝나지 않은 시퀀스 바이트 수 `back` 을 알리고 이어 보낼 오프셋을 `end - back` 으로 당긴다 (`termstate/src/lib.rs:21~33`, `emu.rs:292`) | 정한 대응(물리기)을 적는다 | 2.4 | 내 | 고침(c7824299) |
| I17 | `perf/M2_DESIGN.md:142`·`:164`·`:368`·`:408` (§2.4·§2.5·D-M2-12·결정 요약), `PERF_OPTIMIZATION_SRS.md:62` D-26 | 스냅숏 기록은 "최근 5천 줄"(고정) | 설정 `termScrollback` 값이다(기본 5,000) (`screen_config.rs:66~69`) | "설정 `termScrollback`(기본 5,000)" 으로 고친다. D-26 은 개정 줄(이전/새/이유)로 | 2.5.1 | 내 | 고침 — M2_DESIGN 네 자리, D-26 개정 줄, decisions 재생성(c7824299) |
| I18 | `perf/M2_DESIGN.md` §2.7(`:182` 근처) | 서버 → 브라우저 `term.history{sid, from, lines}` | `top` 필드가 더 있다 (`channel/term.rs:136~137`) | `top` 을 더한다 | 2.7 | 내 | 고침(c7824299) |
| I19 | `perf/M2_DESIGN.md:198` §2.8.2 | 서버가 좌석이 비고 차는 순간을 데몬에 알린다 | 전이가 아니라 연결마다 `seat` 를 쥐고 놓으며 데몬이 센다 (`toolhub/src/tool.rs:422~430` `hold_seat`, IPC `seat` `toolipc/src/protocol.rs:28`) | "연결마다 쥐고 놓고 데몬이 센다" 로 고친다 | 2.8.2 | 내 | 고침(c7824299) |
| I20 | `perf/M2_DESIGN.md:441` §6 넷째 줄 | "2.8.1 이 도움말과 MCP 설명을 함께 고친다" | 도움말은 고쳐졌다 (`helptext.rs:439`, `:446`). MCP 는 폐지돼 없다(SKILL_INJECTION_SRS 제목) | "MCP 설명" 을 지우고 해소 표시를 단다 | 2.8.1 | 내 | 고침 — §6 넷째 줄 해소 표시, :334 MCP 주(c7824299) |
| I21 | `perf/EMULATOR_2026-11-24.md` §6 셋째 줄 | 줄바꿈 수로 나눠 넣는다 | I15 와 같다 | I15 와 같게 고친다 | 2.4 | 내 | 고침(c7824299) |
| I22 | `perf/EMULATOR_2026-11-24.md` §8 첫 행 | 이모지 폭 차이 "이번 자료에서는 차이 0" | Unicode 12 이후 이모지는 alacritty 폭 2, xterm unicode11 폭 1 이다 (`termstate/src/tests.rs:284~288`). 스냅숏은 그 글자 뒤에 열을 다시 찍어 맞춘다 (`snap.rs:14`) | 차이와 대응을 적는다 | 2.2 | 내 | 고침(c7824299) |
| I23 | `TERMINAL_RESUME_SRS.md:254` FR-TRS-10·`:276` 10a, `:345~380` FR-TRS-18~21, `:401` D-4, V-TRS-6·17a 등 | 전량 재생(초기화·클리어·대체 화면 다시 켜기)과 전량 재생 뒤 넛지 | 전량 재생과 넛지는 없다. 창 밖·`since` 없음은 스냅숏이다 (`channel/term.rs:405~425`, `term-pane.js:246~249`). FR-TRS-18b 의 깃발에 SNAP(비트 2)이 더해졌다 (`ws.rs:30`) | 머리에 개정 줄(PERF M2, D-19)을 달고 해당 FR 을 "대체" 로 표시한다 | 2.5 | 내 | 고침 — 머리 개정 줄, FR·D-4·V-TRS 대체 표시(c7824299) |
| I24 | `TERMINAL_MODE_RESTORE_SRS.md:164~186` FR-TMR-20~24, V-TMR-7·8 | 재접속하면 서버가 켜진 모드를 다시 세우는 바이트를 재생 뒤에 보낸다 | `restore_bytes` 는 없다. 모드는 스냅숏이 싣는다 (`termstate/src/snap.rs:1~5`, `:344`) | 머리 개정 줄 + FR-TMR-20~24 "대체(스냅숏)" 표시 | 2.5 | 내 | 고침(c7824299) |
| I25 | `OWNER_TRANSFER_REPLAY_SRS.md:31~34`·FR-OTR-1 등 | 폭의 빚을 전량 재생으로 갚는다 | 스냅숏(`SEQ` FULL)으로 갚는다 (`term-pane.js:256` `if(flag&SEQ_FLAG_FULL) this._widthDebt=false`) | 머리 개정 줄: "전량 재생" → "스냅숏" | 2.5 | 내 | 고침(c7824299) |
| I26 | `TERM_REPLY_SEAT_SRS.md` | 브라우저끼리의 좌석만 다룬다 | 좌석이 비면 데몬이 답한다 (D-23, `tool.rs:406~430`) | 머리 개정 줄로 데몬 갈래(PERF D-23)를 가리킨다 | 2.8.2 | 내 | 고침(c7824299) |
| I27 | `SKILL_INJECTION_SRS.md:265` FR-API-1 | `strip=1` 이면 ANSI 를 제거한다 | 화면 상태 글자다 (`toolio.rs:109~110`) | FR-API-1 에 개정 줄(PERF D-22) | 2.8.1 | 내 | 고침(c7824299) |
| I28 | `ACCESS_ALLOWLIST_SRS.md:168` FR-ACL-11·`:170` 12·`:371~372` 시험 표, `REQUEST_GATE_SRS.md:204~213` FR-RQG-11~13 | 본문이 `/ws` 를 적는다(머리 개정 줄만 있다) | 같은 자리는 `/channel` 이다. 게이트가 `/channel` 에도 걸린다 (1.19 확인: `serve.rs` gated, `reqgate.rs` gate_exempt) | 본문의 `/ws` 를 `/channel` 로 바꾸거나 행마다 "대체" 표시 | 1.19 | 내 | 고침(c7824299) |
| I29 | `GIT_WATCH_LEASE_SRS.md:214` FR-GWL-3, FR-GWL-4·8(`:220`, `:235`), `:242` FR-GWL-9, `:296~303` TC-GWL-9·10·11 | FR-GWL-3 "attach·detach 는 제품 경로에서 불리지 않는다", FR-GWL-9 "브라우저는 지금도 `clientId` 를 싣는다(git-poll.js)", TC-GWL-9~11 은 SSE·지운 e2e | `attach`·`detach` 는 지워졌다(1.18, `gitwatch/` 에 없음). git 요청에 `clientId` 가 없다(`web/js/git/` 에 없음). TC-GWL-11 e2e 는 1.21 이 지웠다 | FR-GWL-3·9 문구를 "지웠다" 로, TC-GWL-9~11 에 폐기 표시 | 1.18, 1.21 | 내 | 고침 — `NoteFor` 삭제도 반영(FR-GWL-5·7·8), TC-GWL-9~13 폐기(c7824299) |
| I30 | `architecture.md:1007` IPC 기능 표 `screen` 행 | 옛 데몬 강등 = 링 바이트 재생(`snapshot`) | 옛 데몬용 대체는 지웠다(2.9). 서버는 기능 확인 없이 `screen` 을 부른다 (`toolclient/src/hub.rs:369~378`) | 강등 칸을 "없음(판 2 데몬만, D-27)" 으로. `screentext`·`history`·`seat`·`search` 메서드를 같은 표나 근처에 더한다 | 2.9, 2.8.1, 2.8.2(조사 중 발견) | 내 | 고침 — 메서드 여섯을 `screen` 행에 적음(Q2)(c7824299) |
| I31 | `architecture.md:1118~1145` (재접속 두 갈래) | 델타 재개 / 전량 재생(클리어 + 스냅샷 + 넛지) | 델타 / 화면 상태 스냅숏(넛지 없음) (`channel/term.rs:405~425`) | 전량 재생 갈래와 넛지 문단을 스냅숏으로 바꾼다 | 2.5(조사 중 발견) | 내 | 고침(c7824299) |
| I32 | `production/00-INDEX.md:220` FE-28 | xterm scrollback 50000, 메모리 상한 없음 — "미표기" | 상수는 지워졌고 설정 `termScrollback`(기본 5,000, 500~50,000)이다 (`settings-schema.js:42`) | FE-28 상태를 "해소(PERF D-25)" 로 | 2.9 | 내 | 고침(c7824299) |
| I33 | `perf/STATUS.md` 「지금 상태」 M2 줄 | 2.8.1·2.6·2.5.1·2.8.3 이 남았다 | 모두 done·병합됐다(이슈 머리말, 병합 `c71c302b`·`f4f6fea2`·`a6d536e0`·`53613310`) | 2.10 진행에 맞춰 갱신 | 조정 문서 | 내 | 고침(c7824299) |
| I34 | `PERF_OPTIMIZATION_SRS.md:53` D-17 (고치는 중 발견) | 1 MB 링을 "옛 판 인계" 에 쓴다 | 판 1 인계는 받지 않는다. 판 2 인계도 링 바이트(`screen`)를 함께 넘긴다 (`toolhub/src/manager.rs:118~120`) | 개정 줄(이전/새/이유) | 2.9 | 내 | 고침 — decisions 재생성(c7824299) |

### 1.3 주석·시험 이름·스크립트 머리말

| 번호 | 문서·위치 | 지금 문서가 말하는 것 | 코드의 실제(근거) | 고칠 방향 | 출처 | 분류 | 처리 결과 |
|---|---|---|---|---|---|---|---|
| C1 | `e2e/fixtures.ts:32~40` 주석 | 다음 페이지 로드에서 서버 도구마다 숨겨진 터미널 + WebSocket 을 미리 만든다 | id 만 적고 처음 그려질 때 만들고 붙는다 (`app.js:206~207`). WebSocket 은 채널 하나다 | 고아 도구가 쌓여도 붙지 않는다는 지금 사실로 고친다(회수 이유가 남는지도 함께 본다) | 2.5 | 주 | 고침(주석·문구 커밋) |
| C2 | `web/js/core/settings-state.js:108`, `settings-table.js:100`, `web/js/test/term-history-settings.test.mjs:11` | `termScrollback` 은 새로 만드는 터미널부터 | 깨어나는 터미널도 맞춘다 (`term-pane.js:269~272`) | "깨어날 때 맞춘다" 로 고친다 | 2.5.1 | 주 | 고침 — 세 곳(주석·문구 커밋) |
| C3 | `e2e/skill-contract.spec.ts:195` 시험 이름 | "read-screen 은 ANSI 를 제거하고 read-output 은 유지한다" | read-screen 은 화면 글자다(시험의 성질은 여전히 맞다) | 이름을 "화면 글자로" 로 바꾼다(`--grep` 쓰는 곳 확인 뒤) | 2.8.1 | 주 | 고침 — `--grep` 쓰는 곳 없음 확인(주석·문구 커밋) |
| C4 | `rust/crates/helper/runtimebin/src/otterctl/toolio.rs:89` | "MCP read_screen/read_output 과 같은 표시 규약" | MCP 는 폐지돼 없다 | MCP 언급을 지운다 | 2.8.1 | 주 | 고침(주석·문구 커밋) |
| C5 | `scripts/check-e2e-private.sh:42` | "계약이 137개 이름 전부를 덮으므로" | 지금 147개다 (`web/js/test/app-state-owners.test.mjs:172`) | 숫자를 빼고 "계약이 이름 전부를 덮으므로" 로 | 1.21 | 주 | 고침(주석·문구 커밋) |
| C6 | `rust/crates/webserver/httpapi/src/commands.rs:202~207` (`attach_sse_leases`, "Go `attachSSELeases`: 이 구독이…"), `fs_watch.rs:4` ("SSE 구독이 쥔다") | SSE 구독이 임대를 쥔다 | 채널 `hello` 의 신원이 쥔다 (`channel/mod.rs:259`) | 주석을 "채널" 로. 이름 바꾸기는 하지 않는다(별도 결정) | 1.12 #3·#5, 1.18 | 주 | 고침 — 이름은 그대로(주석·문구 커밋) |
| C7 | `httpapi/src/serve.rs:39`(`/api/stats?jobs=1`), `gitapi/src/remote.rs:1`(`/api/git/job/events`)·`:126`(`/api/stats?jobs=1`) | 지운 종단을 적는다 | 상태바는 `git.jobs` 토픽, 진행은 `gitjob:<id>` 토픽 (CHANNEL_PROTOCOL §5.2) | 토픽 이름으로 고친다 | 1.12 #5 | 주 | 고침 — remote.rs:126 도(주석·문구 커밋) |
| C8 | 프론트 주석: `core/state-registry.js:169~170`(SSE 구독·편집기 틱 안전망)·`:194`(`edges_changed` 로 민다), `core/settings-polling.js:48`, `core/settings-server.js:8`, `ui/runs-panel.js:20`·`:106`·`:336`·`:371`("SSE"), `core/editor-open.js:306`(안전망 `gitStatusInterval`), `core/agents-controller.js:58`·`:188`·`core/ws-sync-controller.js:30`(`agentsPollMs` 마다), `core/claude-accounts-controller.js:4`(`claude_accounts_changed`), `core/poll-settings.js` 머리, `git/git-poll.js:1~12` 머리("폴링 부품"·`_cadence` 주기) | SSE·주기 폴링·지운 설정을 적는다 | SSE·주기 설정은 없다. 같은 일은 채널 토픽이 한다(`agentsPollMs` 는 정의가 없다 — `settings-backup.js:22` 만 언급) | 한 번에 "채널 토픽" 으로 고친다 | 1.12 #6 | 주 | 고침 — 이 줄의 파일 전부와 `settings-controller.js:79`(주석·문구 커밋) |
| C9 | `e2e/editor-fs-watch.spec.ts:34` 함수 이름 `slowPolling` | 폴링을 늦춘다 | 워크트리 회차만 늦춘다 | 이름을 바꾸거나 그대로 둔다(머리 주석은 1.12 가 고쳤다) | 1.12 #7 | 주 | 고침 — `slowWorktreeRounds`(주석·문구 커밋) |
| C10 | `toolipc/src/protocol.rs:19`, `toolclient/src/hub.rs:369` | `screen` 은 `FEATURE_SCREEN_STATE` 를 말한 데몬에만 보낸다/부른다 | 기능 확인 없이 부른다 (`hub.rs:371~378`, `FEATURE_SCREEN_STATE` 를 읽는 제품 코드 없음) | 주석을 "판 2 데몬만 쓴다(D-27)" 로. 아래 Q1 의 결정에 따른다 | 2.9(조사 중 발견) | 주 | 고침(주석·문구 커밋, Q1) |

## 2. 확인 필요 (코드를 고칠 수도 있는 것, 고칠 자리를 정해야 하는 것)

| 번호 | 내용 | 권장 | 처리 결과 |
|---|---|---|---|
| Q1 | 새 웹서버가 M2 이전 데몬(인계 판 1, `screen` 기능 없음)에 붙는 경우(`start --server-only`, 또는 교체가 거절된 뒤). 서버는 기능 확인 없이 `screen` 을 불러 터미널이 붙지 못한다(`channel/term.rs:415~425` → 오류면 `End::Lost`). 주석(C10)은 확인이 있다고 말한다. 2.9 사용자 결정은 "옛 데몬은 쓰지 않는다, 대체 경로를 만들지 않는다" 다 | 코드는 두고 주석(C10)과 getting-started(E17)만 고친다. 옛 데몬이면 데몬을 새로 띄우라는 안내 한 줄을 E17 에 넣는다 | 결정: 코드 그대로, 주석(C10)·getting-started(E17)만 — 고침 |
| Q2 | 데몬 IPC 새 메서드(`screen`·`screentext`·`history`·`screenconfig`·`seat`·`search`)를 어느 문서에 적을지. 2.8.2 기록은 CHANNEL_PROTOCOL 이라 했지만 그 문서는 브라우저↔서버 채널을 다룬다 | `architecture.md` 의 IPC 기능 표(I30)에 적는다. CHANNEL_PROTOCOL 에는 HTTP `/api/tools/search` 가 아니라 채널 프레임(`term.history`·SNAP)만 더한다 | 결정: architecture.md IPC 표(I30) — 고침 |
| Q3 | `API_ANSWER_NOT_ABSENCE_SRS.md:64`·`:113~114` 는 `clientId` 가 실린 요청을 당시 로그의 증거로 적는다(1.18 이 목록에 올림) | 당시 사실의 서술이라 고치지 않는다. 필요하면 머리에 "FR-GWL-9 는 대체됨" 한 줄 | 결정: 원문 두고 "지금은 …(PERF 1.18, 2026-11-25)" 주석 — 고침(c7824299) |
| Q4 | `SKILL_INJECTION_SRS.md:118` 은 폐지된 MCP 도구 `read_screen` 의 당시 구현 표다 | 고치지 않는다(역사 표). FR-API-1(I27)만 고친다 | 결정: 같은 방식 주석 — 고침(c7824299) |
| Q5 | 이슈 진행 기록끼리 어긋난 줄: 2.2 "2.3 은 `drop_oldest` 를 부른다"(지금 비공개), 2.4.2 "인계는 빈 화면·빈 저장소로 시작"(지금 되세움), 2.8.2 "검색 기준점은 마지막 스냅숏의 첫 기록 줄"(2.8.3 이 버퍼 맨 윗줄로 바꿈), 2.9 "새로 여는 터미널부터"(깨는 터미널도) | 시점 기록이라 고치지 않는다(1.12 가 이슈 폴더를 건너뛴 것과 같다). 원하면 각 파일에 정정 한 줄 | 결정: 맞춘다 — 네 파일에 정정 한 줄(c7824299) |
| Q6 | `e2e/fixtures.ts`(C1)의 고아 도구 회수(`RESET_WS_TRIES` 와 그 앞 주석)는 "숨은 터미널마다 WebSocket 이 열려 부팅이 늦어진다" 를 이유로 든다. 지금은 그 이유가 없다 | 주석만 고친다. 회수 동작을 지울지는 e2e 전량 결과를 본 뒤 따로 정한다 | 결정: 주석만 — 고침(C1) |

## 3. 이미 해결 (고칠 것 없음)

| 항목 | 출처 | 근거 |
|---|---|---|
| SRS D-27 "인계 판 2 …"(판 1 받기) | 2.5, 2.9 | `PERF_OPTIMIZATION_SRS.md:63` 에 2026-11-25 개정(판 2 만)이 있다 |
| DAEMON_SESSION_KEEP FR-DSK-18 | 2.9 | 판 2 만 받으므로 "모양을 바꾸면 판을 올린다" 그대로 맞다(2.9 기록). `validate.rs:136~143` |
| `M2_DESIGN.md` D-M2-13·§2.5·§2.9 의 "옛 데몬엔 지금 경로" | 2.5 | `M2_DESIGN.md:207`, `:376~381` 에 개정이 있다. §2.5 본문에 옛 경로 문장이 없다 |
| `M2_DESIGN.md:143` §2.4 "대체 화면(주 화면 내용도)" — 2.2 는 "공개 API 로 주 화면을 읽을 수 없다" 고 적었다 | 2.2 | 지금 코드는 화면을 바꿔 읽고 되돌려 주 화면도 싣는다 (`termstate/src/emu.rs:293~308`, `snap.rs:3`). 문서가 맞다 |
| `M2_DESIGN.md` §6 "SRS D-7 은 브라우저 기록이 설정이라고 했다(지금은 상수)" | M2_DESIGN §6 | 설정이 됐다 (`settings-schema.js:41~42`). §6 줄에 해소 표시만 달면 된다(I20 과 함께) |
| `M2_DESIGN.md` §6 "SRS FR-TRM-8 의 주의 상태 판정" | M2_DESIGN §6 | 데몬이 바이트로 판정해 요구가 이미 충족된다. SRS 본문은 고칠 것 없음 |
| read-screen 도움말 | 2.8.1 | `helptext.rs:153`, `:439`, `:446` 이 "화면 글자 + 기록" 이다 |
| `check-legacy-names` 가 perf 문서의 `dongminal-perf`·`dongminal-pf` 를 잡음 | 1.9, 1.10.1·1.10.3·1.10.4 | 지금 통과한다(`✓ 옛 이름 없음`) |
| CONFIG_MANAGEMENT_SRS 의 `gitConsoleInterval` | 1.9 | 머리 개정 줄(`:4`)이 있다(1.12) |
| OPTIMIZE_REFACTOR_SRS FR-OPT-4-1·4-3·8-1 | 1.14, 1.15, 1.18 | `:175`, `:177`, `:264` 에 개정이 있다(1.12) |
| OPTIMIZE_REFACTOR_SRS FR-OPT-4-2 | 1.14 | `POST /api/fs/stamps` 하나로 합친 요구는 지금도 맞다 (`routes.rs:140`) |
| GIT_WATCH_LEASE FR-GWL-1·11·12 | 1.15, 1.18 | `:208`, `:249`, `:255` 에 대체·폐기 표시가 있다(1.12). 남은 것은 I29 |
| `e2e/editor-explorer.spec.ts` 의 `gitReposInterval` | 1.14 | 파일에 없다 |
| `editor-watch.js` "폴링은 그대로 돈다", `editor-fs-watch.spec.ts` 머리 주석·V-ELR 제목 | 1.16 | 1.12 가 고쳤다(문자열 없음) |
| `otter-webserver-sse` 의 `start`·`Stream` | 1.12 #4 | crate 에 `payload` 만 남았다 (`sse/src/payload.rs`) |
| `GitWatcher::attach`·`detach`, `git-poll.js` "SSE 구독이 임대를 쥔다" | 1.12 #2 | 함수가 없다. `git-poll.js:205` 는 과거형으로 고쳐졌다 |
| `ws.rs` `MissTracker::size` 의 `#[allow(dead_code)]` 주석 | 1.12 #5 | 주석("`/api/diag` 가 읽는다")이 맞다 — `diag_snapshot.rs:105` 가 부른다 |
| `check-api-docs.sh` 외 문서 게이트 | — | settings-docs·legacy-names·srs-status·srs-progress·decisions·env-docs·error-docs·commands-docs·code-refs·e2e-private 통과. api-docs 만 실패(E1) |
| 1.20·2.3 | 1.20, 2.3 | 어긋난 문서 없음 |
| `repo-fix/02-lsp-gitwatch/REQUIREMENTS.md:92`(1.18), `E2E_PRUNE_REPORT.md` §8.2(1.9) | 1.18, 1.9 | 1.12 가 시점 기록으로 건너뛴 문서다. 같은 기준이면 고치지 않는다 |

## 4. M3 와 겹침 (표시만, M3 세션에서 처리)

- STATUS 대기 목록의 `M3_DESIGN` 3.4.1·§3.6, `SPA_PROFILE` §1·§2, `EDITOR_DIRTY_DIFF` FR-EDD-50·51, `CODEMIRROR_MIGRATION` FR-CMR-53, `EVENT_TIMER_HUB` FR-SCH-15 는 M3 이슈(3.2·3.4.1·3.5.3·3.6.1·3.6.3)의 몫이다. `EDITOR_LIVE_RELOAD` FR-ELR-65 는 archive 문서라 제외다.
- 2.5 기록의 "3.5.1 진행 기록 — 세 자리에서 `life.unmount`"(실제는 `TerminalTool.destroy` 한 자리)는 M3 이슈 기록이다.
- 3.6.2 가 고친 `PERF_OPTIMIZATION_SRS` D-40 은 M2 문서(D-26 등, I17)와 같은 결정 표에 있다. 두 세션이 같은 표를 고치면 `gen-decisions` 를 한 번 더 돌린다.
