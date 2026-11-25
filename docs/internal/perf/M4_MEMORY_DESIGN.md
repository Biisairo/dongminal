# 데몬 메모리 상한 설계 (이슈 4.1)

- 상태: **사용자 승인 2026-11-25**(Q1~Q11 권장안 전부). 4.1.1~4.1.3 의 설계 원본. 근거: NFR-PRF-10, SRS D-49~D-51·D-52~D-55, 이슈 4.1 배경(분석·측정).
- 기준: perf-m1 `6471c95b`.

## 0. 확인된 사실

1. alacritty 0.26 저장 공간(`grid/storage.rs`): 늘 때 `len + add > inner.len()` 이면 `inner.len() + max(add, 1000)` 행(`:126-137`), 줄 때 `inner.len() > len + 1000` 일 때만 truncate(`:107-113`). 지금 keep 1,000 이라 늘 화면 + 2,000행(설계 당시, 4.1.2 뒤로는 화면 + 1,000행).
2. `update_history(0)` 만으로는 줄지 않는다. 실제로 줄이는 API 는 `Grid::truncate()`(`grid/mod.rs:406`). 다시 출력이 오면 1,000행을 다시 잡는다.
3. 열·행 크기를 바꾸면 `replace_inner` 로 `inner = len` 이 되고, 다음 출력에서 "화면 + 그때 기록 + 1,000행" 이 된다 → A 만으로는 크기 바꾸기 뒤 절감이 사라진다. 좁힐 때 오래된 기록을 조용히 버리는 손실도 있다(`resize.rs`).
4. `termScrollback` 이 에뮬레이터 기록보다 작으면 그 위 에뮬레이터 행을 위로 받기로 받을 수 없는 틈(`emu.rs:312-317`) — B·R 이 조용한 도구에서 메운다.
5. 데몬에는 1초 `spawn_attention_sweeper`(`daemon/boot/src/lib.rs:185`)가 이미 돈다(M4 FR-SRV-2 정리 대상). B 는 여기에 얹지 않는다.
6. 스키마↔Rust 기본값 게이트: `httpapi/src/tests/settings.rs:327` `history_lines_schema_matches_daemon_range`.

## 1. 상수 (사용자 요구: 하드코딩 금지, 한곳에 모음)

새 leaf crate `rust/crates/shared/termlimit`(의존성 없음). **메모리 예산 값만**(Q7) 모은다:
- `ALAC_STORAGE_UNIT = 1_000`(alacritty `MAX_CACHE_SIZE` 비춤, 시험으로 고정), `FEED_SLACK = 256`, `EMU_KEEP_MIN = 64`, `const fn emu_keep(rows) = max(EMU_KEEP_MIN, UNIT − 2·SLACK − rows)`, `emu_cap`.
- `SCREEN_IDLE_COMPACT = 5분`.
- `HISTORY_LINES_DEFAULT = 20_000`, `HISTORY_LINES_MIN/MAX`(toolipc 에서 옮겨 re-export).
- `STORE_BLOCK_LINES = 256`, `OUTPUT_RING_BYTES = 1 MiB`(toolhub `BUF_MAX`).
- 모듈 문서에 NFR-PRF-10 8 MB 예산 계산.
- 기존 이름(`EMU_KEEP`·`HISTORY_CAP`·`BLOCK_LINES`·`BUF_MAX`)은 이 crate 를 가리키게 한다(4.1.2 정정: `EMU_KEEP` 은 가리키지 않고 지웠다 — keep 은 `emu_keep(rows)` 로 계산한다). 동작 내부값(`READ_BUF`·`STORE_CHUNK`·`SEARCH_LIMIT_MAX` 등)은 제자리.
- 시험용 유휴 시간 덮어쓰기 환경변수(Q9)는 이름을 `otterenv/src/names.rs` 에 둔다.
- 프론트↔Rust 단일 출처는 기존 게이트(0-6)로 지킨다.

## 2. A — 기록 상한 (Q1: rows 로 계산)

`emu_cap = max(UNIT, keep + 2·SLACK + rows)`. keep: 80×24 → 464, 120×40 → 448, 200×50 → 438. rows > 424 만 두 단위(시험에 명시). 크기를 바꾸면 `reload_options` 자리에서 다시 계산. 시험용 `with_keep` 은 `Option<usize>` 덮어쓰기. SLACK 그대로(넓은 줄 걸침 동작 동일). 판 2 인계(keep 1,000 옛 데몬)는 `restore_with_keep` 로 받는다 — 시험으로 확인.

## 3. compact() — 옮겨 비우기 (termstate `Screen::compact`)

1. 대체 화면이면 아무것도 하지 않는다(Q4).
2. 기록 전체를 오래된 것부터 `complete_lines(rows, hl, cut=false)` → `store.push`.
3. `drop_oldest(moved)` → `term.grid_mut().truncate()`.
- `cmu` 잠금 안에서 한다(feed·스냅숏·history·screen_text·인계와 원자적). 화면 첫 행으로 걸친 줄 꼬리는 남긴다(Q5).
- 저장소 번호는 뒤에 붙기만 하므로 이미 깬 브라우저의 기준점·위로 받기·이전 기록 찾기 결과는 같다. "같은 결과" = 온전히 실린 행이 같다.

## 4. R — 크기 바꾸기 정리 (Q2)

> (개정 2026-11-25, 4.1.2·D-56: '앞' 비우기는 하지 않는다 — 넓힐 때 xterm 과 어긋남. 상한 올리기 → resize → compact → 상한 재계산. 아래 원문은 승인 당시 설계.)

`Screen::resize` 에서 `term.resize` 앞뒤로 `compact()`. 앞: reflow 할 기록이 0 → 좁힐 때 기록을 잃지 않는다(저장소 줄은 꺼낼 때 지금 폭으로 다시 감싼다, D-28). 뒤: reflow 가 밀어 올린 행을 옮기고 truncate.

## 5. B — 유휴 5분 비우기 (Q3: 사건 기반 compactor)

`Cmu` 에 `fed_at`·`dirty`. feed·resize·adopt_screen 이 잠금 안에서 `fed_at = now`; dirty 가 거짓→참일 때만 `Notify` 로 compactor(tokio 작업 하나)를 깨운다. compactor 는 dirty 도구 중 가장 이른 `fed_at + 5분` 까지 `sleep_until`, 없으면 무기한 `notified()`. 깨면 재확인 → `spawn_blocking(compact)` → dirty=false. 비운 뒤 깨어남 0회(FR-SRV-2). 인계 받은 도구는 dirty 로 시작. 판정은 live heap·footprint(RSS 는 참고). (4.1.3 정정: 판정 지표는 footprint 하나다(D-57). live heap·RSS 는 참고로 적는다.)

## 6. E — 기본값 20,000

코드 `settings-schema.js:41`, linestore `DEFAULT_CAP`(→ termlimit). 시험 `term-history-settings.test.mjs`, `httpapi/src/tests/settings.rs`(리터럴 대신 상수), `linestore/src/tests.rs`. i18n `ko.js:1045`·`en.js:1021`. 문서 features.md·CHANGELOG·SRS(D-7·D-25·FR-TRM-2·NFR-PRF-10)·M2_DESIGN·EMULATOR·decisions. 저장된 사용자 값 보존 시험(`{"termHistoryLines":50000}` → 50,000).

## 7. 판정 (Q6·Q11)

> (추가 2026-11-25, D-57: 판정 지표는 footprint. 살아 있는 힙에는 vte 2 MiB 미사용 버퍼가 도구마다 잡힌다.)

NFR-PRF-10 은 기본값 2만 줄로 판정, 5만 줄은 참고 기록(SRS 개정). 넓은 터미널(200×50) 출력 중 8 MB 경계는 평균 기준으로 수용하고 측정에 따로 적는다. 풀린 블록 압축은 이번에 하지 않는다(Q10).

## 8. 예상 (120×40, 도구당)

| 출력 | 지금 | 출력 중 | 조용함(B) |
|---|---|---|---|
| 짧은 줄 | 8.6 MB | 약 4.8 | 약 1.7 |
| 코드 120자 | 11.1 | 약 5.8 | 약 2.8 |
| 한글 120자 | 14 | 약 7.0 | 약 3.9 |

## 9. RED 시험 (요약 — 하위 이슈가 따른다)

termstate: `emu_keep` 순수 함수, 계수 `#[global_allocator]` 통합 시험(첫 할당 = UNIT 행, 2만 줄 뒤 살아 있는 바이트 상한 — 크기별·줄 종류별), 크기 바꾸기 뒤 상한·좁히기 기록 보존, compact 뒤 history_len·저장소 순서·할당 감소, compact 앞뒤 스냅숏·text·lines 동일(sim-line·sim-tui·넓은 글자·걸친 줄·링크·색), 모든 분할점 compact 끼우기(check_points 변형), compact 뒤 재출력, 대체 화면 무동작, keep 1,000 인계 수용·compact 뒤 인계 왕복. toolhub(tokio time::pause): 5분 한 번, 4:59 출력 시 미룸, dirty 없으면 1시간 깨어남 0, 비우기 앞뒤 screen·search·history·screen_text 동일, adopt 가 dirty. E: def·게이트·cap·저장값 보존. `--ignored` `measure_daemon_memory_per_terminal`(12대, 120×40, 짧은 줄·코드, 2만·5만), `measure_snapshot_5000_rows` 재측정. e2e: perf-term-wake W2·W4, perf-term-history H1, perf-term-query S1·R1·Q1 + 짧은 유휴 시간으로 "비운 뒤 깨움" 하나.

## 10. 하위 이슈

- 4.1.1 상수 crate + E (LOW)
- 4.1.2 A + compact() + R + 할당 계수 시험 기반 (MED) ← 4.1.1
- 4.1.3 B compactor(5분, 인계, e2e) + 측정 판정 (MED) ← 4.1.2

## 11. 구현 결과 (2026-11-25)

| 하위 이슈 | 커밋 | 한 일 | 설계와 다른 점 |
|---|---|---|---|
| 4.1.1 | `54b8d934` | `termlimit` crate(§1 상수 전부), `termHistoryLines` 기본 20,000(E) | `EMU_KEEP` 은 termlimit 을 가리키게 하지 않고 4.1.2 에서 지웠다 |
| 4.1.2 | `dcdcaec3` | keep = `emu_keep(rows)`, 상한 = `emu_cap`(A), `Screen::compact`, 크기 바꾸기 정리(R), 할당 계수 시험 | 크기를 바꾸기 **앞**에서는 비우지 않는다. 상한을 올리고 바꾼 뒤 비운다(D-56) |
| 4.1.3 | `pf/4.1.3` | 사건 기반 compactor(B), 인계 연결, 시험용 유휴 시간 환경변수, 측정 판정 | 없음(아래) |

**B — compactor (§5 그대로).**

- `Tool` 의 `Cmu` 에 `fed_at`·`dirty` 를 둔다. 넣기(feed)·크기 바꾸기·인계 되세우기(`adopt_screen`)가 잠금 안에서 `fed_at` 을 지금으로 적는다. `dirty` 가 거짓에서 참이 될 때만 등록부의 `Notify` 를 깨운다(`toolhub/src/tool.rs` `touch`).
- 등록부는 도구를 등록할 때(`create`·`restore`·`adopt`·`adopt_handover`) 깨우개를 건다. 등록 전에 이미 바뀐 화면(인계로 받은 도구, 등록 전에 프롬프트를 낸 도구)은 거는 순간 깨운다. 그래서 인계 받은 도구는 dirty 로 시작한다.
- `ToolManager::spawn_screen_compactor` 는 tokio 작업 하나다. dirty 도구 중 가장 이른 `fed_at + 유휴 시간` 까지 `sleep_until` 로 자고, 없으면 `notified()` 만 기다린다. 깨면 시간이 찬 도구를 골라 `spawn_blocking` 안에서 잠금을 다시 잡고 확인한 뒤 `Screen::compact` 하고 `dirty = false` 로 둔다. 데몬 기동(`daemon/boot`)이 1초 sweeper 와 따로 띄운다. 비운 뒤 출력이 없으면 깨지 않는다.
- 유휴 시간은 `termlimit::SCREEN_IDLE_COMPACT`(5분)이다. 검사는 `OTTERMINAL_SCREEN_IDLE_COMPACT_MS`(이름은 `otterenv/src/names.rs`, 1 ms 이상)로 당긴다. 비울 때 debug 로그 `[tool <id>] 유휴 기록 비움` 을 남긴다(e2e W5 가 이것으로 비움을 확인한다).

**시험.** toolhub `manager/compact_tests.rs`(tokio 가짜 시계) 7건: 5분 뒤 한 번 비우고 그 뒤 1시간 동안 깨지 않음, 4:59 출력이면 미룸, 깨끗한 도구만 있으면 1시간 깨어남 0, 도구마다 따로 정한 시각, 크기 바꾸기도 활동, 인계 받은 도구는 dirty, 비우기 앞뒤 깨움 스냅숏·read-screen·위로 받기·이전 기록 찾기가 같고 옮긴 행이 저장소 옛 끝에서 이어짐. `tests/daemon_memory.rs`(`--ignored`) `measure_daemon_memory_per_terminal`. e2e `perf-term-wake` W5: 유휴 시간을 1.5초로 당긴 인스턴스에서 8,000줄을 찍고 재운 뒤, 데몬이 비운 것을 로그로 확인하고 깨우면 화면·커서가 재우기 전과 같고 기록 보기가 실시간 버퍼 바로 앞 줄에서 이어진다.

**측정.** 판정 표와 비교 표는 SRS §7.4 다. 120×40·2만 줄에서 출력 중 터미널당 물리 사용량은 짧은 줄 5.09 MB, 코드 120자 6.53 MB 로 NFR-PRF-10 을 충족한다. §8 의 어림과 살아 있는 힙은 맞는다(출력 중 4.61·5.35 MB, 비운 뒤 1.52·2.27 MB). 비운 뒤 물리 사용량은 macOS malloc 이 놓은 페이지를 곧바로 돌려주지 않아 1~1.2 MB 만 준다. 넓은 터미널(165×47)의 코드 출력은 malloc 이 잡아 둔 공간 때문에 9.49 MB 까지 간다(판정 밖, D-55).
