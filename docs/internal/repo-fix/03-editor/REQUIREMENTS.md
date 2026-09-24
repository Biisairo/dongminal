# 요구조건: 에디터(파일 읽기·저장·문서 모델) 근본 수정 — IEEE 29148 (StRS)

> 문서 상태: 승인(사용자 인터뷰 2026-09-24) · 사전 공격 검증(`tmp/preattack-02-05.md`) 반영 — §3A · 입력 → sdd-tdd 워크플로우
> 우선순위: **§3A > §3 본문**. 본문 중 §3A 와 모순되던 문장(E-1.2·E-1.4·E-1.6·E-2.1·E-2.2·E-5.1·E-6.1·E-9.3)은 직접 정정했다.
> 근거: `tmp/REPO_AUDIT_2026-09-24.md`(P0 #3·#5·#7·#8·#9·#10, P1 #45·#46·#47, P2 에디터), `tmp/verify-frontend.md`(판정, 신규 N1·N6), `tmp/verify-backend.md`(#8 probe), `tmp/preattack-02-05.md` §0·§2.
> 선행: 01·02 완료. 02 의 didClose 연결(L-5.1)은 `edDocDrop` 의 "뷰 0" 순간에 붙어 있다 — 03 은 그 자리를 유지하며 진단 지우기도 같은 자리로 옮긴다(§3A-0 X4).

## 1. 목적과 범위
사용자 진술: *"전부 수정. 구조적으로, 근본적으로 수정해서 정상동작하게 해야 한다."*

- 포함: `web/js/ui/file-editor.js`, `file-editor-diff.js`, `file-editor-find.js`, `web/js/core/app-editor*.js`, `app-layout.js`(탭 닫기·편집기 조회), `web/js/ui/renderer-pane.js`(편집기 등록·탭 라벨), `web/js/ui/doc-render.js`(refresh 계약), `web/js/core/api.js`(파일 읽기), `web/js/core/app-statusbar.js`(인코딩 항목), `web/js/git/panel-diff.js:925-933`(`_setDiffDirty` 의 `tab.dirty` 쓰기 제거만), `internal/webserver/httpapi/handlers_files.go`·`handlers_file_probe.go`, `internal/webserver/gitapi` 의 `/api/git/diff-content` 와 `domain/git/query/diff.go` 의 side 디코드(인코딩 파라미터만), `internal/webserver/apierr`(신규 코드 등록), `internal/shared/platform/paths.go`(WriteFileAtomic 호출 규약), `go.mod`(`golang.org/x/text`).
- 비포함: 탐색기(04), git Diff 뷰의 편집 동작(05). 단 05 는 이 문서가 만드는 **문서 레지스트리·문서 저장·인코딩 계약·비동기 적용 장치**를 그대로 쓴다(05 F-2, 사용자 결정 "Diff 뷰가 편집기 문서 모델을 공유"). 그래서 레지스트리는 편집기(FileEditor)가 아닌 뷰(DocRender, git Diff 뷰)도 문서를 획득·해제할 수 있어야 한다(§3A-5).

## 2. 근본 원인
1. **비동기 응답 적용 시 상태 재확인 없음**: 요청 전 가드만 있고 응답 도착 후(dirty·파괴·대상 변경·버전) 확인이 없다(#3, #9).
2. **편집기·문서의 키 체계 불일치**: 편집기 Map 은 `slotKey(id,slot)` 인데 조회는 `tab.id` 로 한다(#5, N6). 문서 모델(`_edDocs`)·모델 URI·dirty-diff 경로가 경로 문자열에 묶였는데 이름변경 시 갱신되지 않는다(#10).
3. **원문 바이트 계약 부재**: 서버가 인코딩·BOM·파일 모드·심링크를 모르고, 클라이언트는 UTF-8 로 풀어 그대로 쓴다(#7, #8). probe 가 NUL 로 판정해 UTF-16 파일은 편집기가 열리지 않는다.
4. **파생 상태가 원천으로 영속**: `tab.dirty` 가 워크스페이스에 저장된다(#45, N1).

## 3. 요구조건 (각 항목 이전/새 동작 기록, TDD)

### E-1 인코딩 왕복 (#8, 사용자 결정: "인코딩 왕복 지원" + "x/text + 자동판별+수동선택" + "다른 인코딩으로 다시 열기 + UTF-8 로 변환해 저장")
- E-1.1 `golang.org/x/text` 를 의존성으로 추가한다(Go 공식 보조 라이브러리, 사용자 승인됨).
- E-1.2 읽기 시 서버가 판별한다: BOM(UTF-8/UTF-16LE/BE) → 유효한 UTF-8 → CP949(EUC-KR 상위집합) 순. 판별 결과(`encoding`, `bom`, 디코드 가능 여부)를 응답에 싣고 본문은 UTF-8 로 변환해 보낸다. 모두 실패하면(디코드 불가) **읽기 전용**으로 열고 사유를 표시한다. 판별 규칙·전송 형식은 §3A-1.
- E-1.3 저장 시 서버는 문서의 인코딩·BOM 으로 되돌려 쓴다. 대상 인코딩으로 표현할 수 없는 문자가 있으면 저장을 거절하고 첫 위치를 반환한다 — 조용한 손실 금지. 거절 안내에서 "UTF-8 로 변환해 저장" 을 제공한다.
- E-1.4 전역 상태바에 포커스된 편집기 문서의 인코딩을 표시하고, 눌러서 ① **UTF-8 / CP949 / Shift_JIS / Latin-1(Windows-1252)** 중 하나로 "다른 인코딩으로 다시 열기"(디스크에서 그 인코딩으로 다시 디코드) ② **"UTF-8 로 변환해 저장"** 을 할 수 있다. dirty 상태에서 다시 열기는 확인을 받는다. 배치·동작 세부는 §3A-2.
- E-1.5 UTF-8 BOM 파일은 BOM 을 보존한다. BOM 없는 UTF-8 은 BOM 을 붙이지 않는다. UTF-16 파일은 같은 바이트 순서와 BOM 으로 되돌려 쓴다.
- E-1.6 probe 는 UTF-16 BOM 이 있는 파일을 텍스트로 판정한다(NUL 판정보다 먼저). 앞 8000B 로 UTF-8 유효성 판정을 하게 되는 경우에만 절단 경계의 불완전 룬(최대 3바이트)을 잘라내고 검사한다 — 현재 probe 는 UTF-8 판정을 하지 않는다(§3A-1).
- E-1.7 인코딩 계약은 편집기 소스 뷰만이 아니라 **DocRender, dirty-diff 기준, git Diff 뷰의 양쪽**에도 적용된다(§3A-3). git Diff 뷰의 작업 트리 쪽은 문서 모델을 공유하므로(05 F-2) 문서의 인코딩으로 저장된다.

### E-2 저장이 파일 속성을 보존 (#7 ✅)
- E-2.1 기존 파일 저장은 원래 권한 비트를 유지한다(실행 비트·0600 등). 새 파일은 0644 다(현행과 같음 — §3A-4).
- E-2.2 경로가 심링크면 링크를 따라가 **대상 파일**에 원자적으로 쓴다(링크 자체는 유지). 파일 API 에는 허용 루트 가드가 없다(`file_boundary.go:48-67` `fileAllow` 는 빈 값·절대경로 여부만 본다). 이 문서는 가드를 새로 만들지 않고 **기존 경계 규칙(절대경로이면 허용)을 링크 대상에도 그대로 적용**한다.

### E-3 비동기 응답 적용 규약 (#3 ✅, #9, 공통 패턴 ①)
- E-3.1 문서의 모든 비동기 완료 콜백(초기 로드, refresh, 저장, 인코딩 다시 열기, dirty-diff 기준 로드)은 적용 전에 **문서 생존·대상 경로·문서 세대·모델 버전** 을 확인한다. 이를 위한 작은 공통 장치를 하나 두고 전부 그것을 쓴다(05 의 git Diff 뷰도 재사용). 규칙은 §3A-5.
- E-3.2 refresh 응답 도착 시 요청 이후 편집이 있었으면 적용하지 않는다(#3). 저장 왕복 중 refresh 가 저장 전 내용으로 되돌리지 않는다.
- E-3.3 로딩 중 파괴된 FileEditor 는 편집기·모델을 만들지 않고, 만들었다면 해제한다. 고아 모델이 다음 열기에 재사용되지 않는다(#9). stamp 와 모델 내용이 항상 같은 디스크 판을 가리킨다.

### E-4 편집기 조회의 단일 경로 (#5 ✅, N6)
- E-4.1 탭 id 로 편집기 인스턴스를 찾는 모든 곳(closeTab 의 dirty 확인, edRetargetTabs, edDirtyUnder, 줄 reveal, 재오픈 refresh 등)은 **칸(slot)을 인식하는 헬퍼 둘**(해당 탭의 모든 칸 인스턴스 / 포커스 칸 우선 인스턴스)을 쓴다. `fileEditors.get(tab.id)` 직접 조회를 없앤다(§3A-6).
- E-4.2 칸 1 이상에만 있는 편집기도 닫기 확인·이름변경 추적·줄 이동이 칸 0 과 같게 동작한다.

### E-5 문서 모델의 경로 이동 (#10, 04 와 공유, 사용자 결정 E-5.1 ①)
- E-5.1 이름변경·이동 시 문서 레지스트리(`_edDocs`) 키, Monaco 모델 URI, dirty-diff 기준 경로, 언어 모드를 새 경로로 옮기는 **단일 API** 를 둔다. 모델은 **새 경로 URI 의 새 모델로 옮기고 undo 이력은 버린다**(동작 기록). 내용·dirty·인코딩·stamp 는 보존한다. 탐색기(04)는 이 API 만 호출한다. 절차는 §3A-5.
- E-5.2 옛 경로에 같은 이름의 파일이 새로 생겨 열어도 옛 모델이 재사용되지 않는다. 이름변경된 문서도 live-reload·dirty-diff 가 계속 동작한다. 닫으면 문서·모델이 해제된다(누수 없음).

### E-6 dirty 는 파생 상태 (#45, N1, P2 undo)
- E-6.1 `tab.dirty` 필드를 폐기한다 — 워크스페이스 저장·동기화에 싣지 않고, 옛 저장본의 값은 무시한다. 새로고침·다른 기기에서 가짜 ● 가 없다. **git 탭의 Diff dirty 표시도 같은 규칙을 따른다**: 지금 `panel-diff.js:925-933` `_setDiffDirty` 가 `found.tab.dirty` 를 쓰고 `renderer-pane.js:34` 가 그것으로 라벨을 그린다 — 03 은 그 쓰기를 없애고 라벨을 파생으로 바꾼다(§3A-7). 05 는 Diff 뷰가 문서를 공유하게 되면서 파생 원천을 문서 dirty 로 바꾼다.
- E-6.2 탭 라벨 갱신은 활성 창만이 아니라 그 탭이 있는 모든 창을 대상으로 한다.
- E-6.3 dirty 판정은 "저장 시점 모델 버전(alternativeVersionId)과 현재 비교"로 한다. undo 로 원복하면 dirty 가 풀린다.

### E-7 뷰 종류별 refresh 계약 (#46)
- E-7.1 문서의 외부 변경 반영은 문서 단위로 한 번 디스크를 읽고 모든 뷰(소스 편집기·DocRender·git Diff 뷰)에 알린다. 첫 뷰가 무엇이든 소스가 갱신된다.

### E-8 dirty-diff 줄 끝 (#47)
- E-8.1 기준(index) 내용과 모델 줄 비교는 줄 끝(CRLF/LF/CR)을 정규화한다. CRLF 파일에서 편집하지 않으면 변경 표시가 없다.

### E-9 자잘한 동작 (P2)
- E-9.1 같은 파일을 보는 칸 하나를 닫아도 다른 칸의 LSP 진단이 유지된다 — 진단 지우기는 문서의 마지막 뷰가 떠날 때(`edDocDrop` 에서 뷰 0)만 한다(§3A-0 X4).
- E-9.2 dirty-diff 팝업이 열린 상태에서 찾기 입력의 Esc 는 찾기 패널만 닫는다(주석 의도대로).
- E-9.3 저장 진행 중 재저장·"저장 후 닫기"는 무음으로 무시하지 않는다: 진행 중 저장 완료를 기다린 뒤 dirty 면 한 번 더 저장하고, 닫기는 저장 성공 후 진행한다(§3A-8).

## 3A. 확정 사항 (사전 공격 검증 `tmp/preattack-02-05.md` 반영, 2026-09-24)

아래는 §3 의 모호점을 확정한다. **충돌 시 이 절이 본문보다 우선한다.** 근거 file:line 은 2026-09-24 작업 트리(`ed2e4e39`) 기준이다.

### §3A-0 문서 간 계약
| # | 계약 | 짝 문서 |
|---|------|---------|
| X1 | `tab.dirty` 폐기는 git Diff 탭에도 적용된다(E-6.1). 03 은 `_setDiffDirty` 의 `tab.dirty` 쓰기를 없애고 라벨을 파생으로 바꾼다. 05 가 파생 원천을 공유 문서 dirty 로 옮긴다 | 05 F-2.5 |
| X2 | 인코딩 필드 없는 쓰기 = UTF-8 원문 그대로(하위호환 — 옛 클라이언트). 05 의 Diff 뷰는 자기 쓰기를 없애고 문서 저장을 쓴다 | 05 F-2.3 |
| X3 | dirty-diff 기준·DocRender·git Diff 뷰 원본 쪽은 §3A-3 의 인코딩 계약을 쓴다 | 05 F-2.3 |
| X4 | "마지막 뷰가 떠날 때" = `edDocDrop`(`app-editor-open.js:98-108`)에서 `d.views.size` 가 0 이 된 순간. 여기서 LSP 진단 표시를 지우고(E-9.1), 02 의 `POST /api/lsp/close` 를 부른다. `destroy()`(`file-editor.js:1145`)에서는 하지 않는다 | 02 L-5.1 |
| — | 문서 레지스트리는 FileEditor·DocRender·git Diff 뷰를 모두 "뷰" 로 받는다(§3A-5). 05 는 새 레지스트리·새 저장 경로를 만들지 않는다 | 05 F-2 |
| — | `edDocMove`(§3A-5)는 04 가 부르는 유일한 문서 이동 API 다 | 04 T-9.1 |

### §3A-1 읽기·판별·probe (E-1.2, E-1.6)
사실: `go.mod` 에 `golang.org/x/text` 없음(`korean.EUCKR` 은 CP949/UHC). `/api/file/read` 는 원문 바이트를 `text/plain; charset=utf-8` 로 낸다(`handlers_files.go:468`, FR-CAPI-11). 소비자: `file-editor.js:388`, `doc-render.js:321`, CLI verify(상태 코드만), e2e 여럿. probe 는 NUL 이 있으면 binary(`handlers_file_probe.go:57`) — UTF-16 은 편집기가 열리지 않는다. 읽기 상한 `fileReadMaxBytes`=10MiB(`file_boundary.go:30`).

| 항목 | 확정 |
|------|------|
| 요청 | `GET /api/file/read?path=…&decode=1` 일 때만 판별·변환한다. `decode` 없는 요청은 현행 원문(FR-CAPI-11 하위호환). 강제 인코딩은 `&encoding=<id>`(다시 열기·live-reload·refresh 가 문서의 인코딩을 유지) |
| 응답 헤더 | `X-File-Encoding`: `utf-8`·`utf-16le`·`utf-16be`·`cp949`·`shift_jis`·`windows-1252` 중 하나 · `X-File-BOM`: `0`·`1` · `X-File-Decodable`: `0`·`1`. 기존 `X-File-Stamp`(`handlers_files.go:357`)는 그대로 |
| 자동 판별 순서 | 파일 전체(≤10MiB)에 대해 ① BOM: `EF BB BF`→utf-8, `FF FE`(뒤가 `00 00` 이 아님)→utf-16le, `FE FF`→utf-16be ② `utf8.Valid` → utf-8 ③ CP949 엄격 디코드 ④ 모두 실패 → `X-File-Decodable: 0`, 본문은 UTF-8 치환 디코드, `X-File-Encoding: utf-8` |
| 엄격 디코드 | 디코드 결과에 U+FFFD 가 없고 **재인코딩이 원문과 바이트 동일**할 때만 성공. 강제 인코딩(`encoding=`)의 성공 판정도 같은 규칙(Windows-1252 의 미정의 5바이트 0x81·0x8D·0x8F·0x90·0x9D 포함). 강제 인코딩이 실패하면 422 `encoding_undecodable` — 파일·문서는 그대로 |
| BOM 처리 | 본문에서 BOM 을 떼고 보낸다. `X-File-BOM:1` 로 알린다 |
| 편집기 요청 | 편집기·DocRender·git Diff 뷰의 문서 로드는 전부 `decode=1` 을 쓴다. `Decodable:0` 문서는 읽기 전용 + 사유 문구 |
| probe | NUL 검사 전에 `FF FE`(뒤가 `00 00` 이 아님) 또는 `FE FF` 로 시작하면 text. UTF-32 BOM·BOM 없는 UTF-16 은 현행대로 binary(비목표). probe 는 인코딩을 확정하지 않는다(판정 주체는 read) |
| E-1.6 | 현재 probe 는 UTF-8 유효성 판정을 하지 않으므로 이번 구현에서 할 일이 없다. probe 에 UTF-8 판정을 넣는 변경이 생기면 절단 끝의 불완전 룬(최대 3바이트)을 잘라낸 뒤 검사한다 — 스펙에 조건부 요구로 싣는다 |

### §3A-2 인코딩 상태바·다시 열기·변환 저장·쓰기 계약 (E-1.3~E-1.5, 사용자 결정)
사실: 편집기 자체에는 상태 표시줄이 없다. 전역 상태바는 포커스 칸 종속 항목을 이미 갖는다 — `termsize` 는 포커스 터미널일 때만 그린다(`app-statusbar.js:152-157`), 항목 켜기·끄기는 `STATUS_ITEMS` 표(`app-statusbar.js:455-470`). 쓰기: `handlers_files.go:524` `WriteFileAtomic(target, …, 0o644)`.

| 항목 | 확정 |
|------|------|
| 자리 | 전역 상태바에 `encoding` 항목을 더한다. 포커스 칸이 텍스트 문서를 연 편집기일 때만 그린다(`termsize` 와 같은 규약). `STATUS_ITEMS` 에 등록해 켜기·끄기 대상이 된다(기본 켬) |
| 라벨 | `UTF-8`, `UTF-8 BOM`, `UTF-16 LE`, `UTF-16 BE`, `CP949`, `Shift_JIS`, `Windows-1252`. `Decodable:0` 이면 라벨 뒤에 "읽기 전용" |
| 메뉴 | 누르면 메뉴: "다른 인코딩으로 다시 열기 ▸ UTF-8 / CP949 / Shift_JIS / Latin-1(Windows-1252)" 4항목 + 구분선 + "UTF-8 로 변환해 저장" 1항목. 현재 인코딩 항목에 표시 |
| 다시 열기 | `decode=1&encoding=<id>` 로 다시 읽는다. dirty 면 먼저 확인(편집 내용을 버린다 — 확인/취소). 성공 시 모델 내용 교체(§3A-5 토큰 규칙), 문서 인코딩·BOM·stamp 갱신, `savedAltVer` 재기준. 422 `encoding_undecodable` 이면 문서 그대로 두고 사유 표시 |
| 변환 저장 | 문서 내용을 `encoding:"utf-8", bom:false` 로 저장한다(stamp 경합 검사·409 흐름은 일반 저장과 같음). 실행 전 확인을 받는다(확인문: 파일을 UTF-8 로 다시 쓴다, 원래 인코딩으로 저장하는 기능은 없다). 성공 시 문서 인코딩 = utf-8·BOM 없음. 문서가 이미 BOM 없는 UTF-8 이거나 `Decodable:0` 이면 항목 비활성 + 사유 |
| 쓰기 요청 | `/api/file/write` 본문에 `encoding`, `bom` 을 더한다. 둘 다 없으면 UTF-8 원문 그대로(하위호환). 편집기 문서 저장은 항상 둘을 싣는다 |
| 표현 불가 | 대상 인코딩으로 표현 못 하는 문자가 있으면 422 `encoding_unmappable` + `{line, col, char}`(첫 위치, 1-기준, col 은 UTF-16 코드 단위 — Monaco 열과 같음)로 거절, 파일은 건드리지 않는다. 편집기는 사유·위치를 알리고 그 위치로 커서를 옮기며 "UTF-8 로 변환해 저장" 버튼을 함께 보인다 |
| UTF-16 쓰기 | 문서 인코딩이 utf-16le/be 면 같은 순서로 인코딩하고 BOM 을 붙인다(UTF-16 은 모든 문자를 표현하므로 422 가 없다) |
| 새 파일 | 인코딩 필드가 있어도 없어도 새 파일의 기본은 UTF-8·BOM 없음 |
| apierr | `encoding_unmappable`(422), `encoding_undecodable`(422)을 codes·사용자 문구·inventory·테스트 목록에 등록한다 |

### §3A-3 DocRender·dirty-diff·git Diff 뷰의 인코딩 (E-1.7, X3)
사실: dirty-diff 기준은 `/api/git/diff-content` 의 `original.content` 를 그대로 `split('\n')`(`file-editor-diff.js:238-247`). DocRender 는 `/api/file/read` 를 따로 읽음(`doc-render.js:321`). git Diff 뷰도 같은 `/api/git/diff-content` 를 쓴다(`diff-view.js:328`). diff side 는 NUL 이 있으면 `binary`(`query/diff.go:237-239`). dirty-diff 되돌리기는 기준 줄을 모델에 넣는 모델 편집(`file-editor-diff.js:325-357`), 스테이지는 git hunk 좌표(`:365-392`).

| 항목 | 확정 |
|------|------|
| diff-content 파라미터 | `/api/git/diff-content` 에 `&encoding=<id>` 를 더한다(문서의 인코딩). 없으면 현행(바이트 그대로, NUL → binary) |
| side 디코드 | 파라미터가 있을 때 각 side(작업 트리·index·HEAD·커밋)마다: ① 그 인코딩으로 §3A-1 엄격 디코드 성공 → 그것 ② 실패 → §3A-1 자동 판별 순서 ③ 모두 실패 → `kind:"text"` + UTF-8 치환 디코드 + `decodable:false`. side 가 UTF-16 BOM 으로 시작하면 NUL 검사 전에 디코드한다. side 응답에 `encoding` 필드를 싣는다 |
| 변환 저장 뒤 | 파일은 UTF-8, index 는 옛 인코딩일 수 있다. side 별 디코드이므로 양쪽 모두 사람이 읽을 수 있는 글자로 비교된다 |
| dirty-diff 기준 | 문서의 인코딩으로 파라미터를 싣는다. 줄 끝 정규화는 §3A-8 |
| dirty-diff 되돌리기 | 디코드된 기준을 모델에 넣으므로 모든 디코드 가능 인코딩에서 동작한다 |
| dirty-diff 스테이지 | utf-16le/be 문서에서는 비활성 + 사유(git 이 그 파일을 바이너리로 보아 hunk 좌표가 없다). 그 밖 인코딩은 현행(줄 구분자가 ASCII 라 좌표가 같다) |
| DocRender | `/api/file/read` 를 직접 부르지 않는다. 문서 단위 로드·refresh(§3A-5)가 준 디코드된 내용을 받는다 |
| git Diff 뷰 | 원본 쪽은 문서 인코딩을 파라미터로 실어 받는다. 작업 트리 쪽은 공유 문서 모델이다(05 F-2) |

### §3A-4 권한·심링크 (E-2)
사실: `WriteFileAtomic`(`platform/paths.go:304-334`)은 임시 파일을 만들고 umask 와 무관하게 perm 으로 chmod 한 뒤 rename — 권한 고정, 심링크는 일반 파일로 대체, 하드링크 끊김. 다른 호출자(상태 파일 등)도 쓴다. 경계: `fileAllow`(`file_boundary.go:48-67`)는 빈 값(400)·비절대경로(400)만 거절한다.

| 항목 | 확정 |
|------|------|
| 쓰기 대상 | `filepath.EvalSymlinks(path)` 결과. 끊어진 링크(대상 부재)는 링크가 가리키는 경로(상대면 링크 디렉터리 기준)에 새 파일을 만든다. 링크 자체는 바꾸지 않는다 |
| 경계 | 링크 대상에도 `fileAllow` 와 같은 규칙(절대경로)만 적용한다. 허용 루트 가드를 새로 만들지 않는다 — 이전 동작 = 새 동작으로 스펙에 기록 |
| 권한 | 기존 파일은 쓰기 직전 대상의 `Mode().Perm()` 을 perm 으로 넘긴다. 새 파일은 0644(현행과 같음). `WriteFileAtomic` 시그니처는 바꾸지 않는다 — 호출자가 perm 을 정한다 |
| stamp | 경합 검사 stamp 는 해소된 대상 기준(`os.Stat`, 현행과 같음) |
| 비목표 | 소유자·xattr·ACL·하드링크 보존(원자적 rename 의 성질 — 스펙에 명시) |

### §3A-5 문서 레지스트리·비동기 적용·경로 이동 (E-3, E-5, E-7)
사실: 레지스트리 `edDoc/edDocDrop`(`app-editor-open.js:78-108`), 키 = 경로 문자열, 문서 = `{model, dirty, saving, stamp, dd, views}`. `_model` 이 `getModel(uri)` 로 고아 모델을 집음(`file-editor.js:400-407`, #9). refresh 는 요청 전 dirty 만 봄(`file-editor.js:944-971`). live-reload 는 `d.views` 의 첫 뷰만 refresh(`app-editor-open.js:219-226`, #46). 이름변경은 `edRetargetTabs`(`app-editor-pane.js:254-268`)가 탭·뷰 경로만 바꾸고 `_edDocs` 키·모델 URI·dd 는 그대로. LSP 는 모델 URI 에서 경로를 되돌리고(`app-lsp.js:448-470`) DocRender 도 URI 로 모델을 찾는다(`doc-render.js:291`) — 모델 URI 가 경로의 진실 공급원이다.

| 항목 | 확정 |
|------|------|
| 문서 필드 추가 | `gen`(정수, 디스크 내용을 모델에 넣을 때마다 +1), `savedAltVer`(§3A-7), `encoding`, `bom`, `decodable` |
| 뷰 종류 | `views` 에는 FileEditor·DocRender·git Diff 뷰가 들어간다. 문서 로드(`decode=1` 읽기 → 모델 생성)는 **문서가 한다** — 첫 뷰가 FileEditor 가 아니어도 모델이 생긴다. 뷰는 모델을 dispose 하지 않는다(문서 해제는 `edDocDrop` 만) |
| 토큰 규칙 | 디스크 내용을 모델에 적용하는 모든 비동기 작업(초기 로드, refresh, 다시 열기, 저장 완료, dd 기준 로드)은 시작 시 `{doc, gen, altVer, path}` 를 잡고, 적용 직전 ① `doc` 이 레지스트리에 그 경로로 살아 있고 ② `gen`·경로가 같고 ③ `model.getAlternativeVersionId()===altVer` 일 때만 적용한다. 하나라도 다르면 버린다(저장 완료는 §3A-7 규칙). 판정은 순수 함수 모듈로 분리해 node:test 로 검사하고 05 가 재사용한다 |
| 고아 모델 | 문서 로드는 `getModel(uri)` 로 찾은 모델이 어떤 문서에도 속하지 않으면 dispose 후 방금 읽은 내용으로 새로 만든다. 로딩 중 파괴된 FileEditor 는 편집기 생성을 건너뛰고, 문서 뷰가 0 이면 `edDocDrop` 이 모델을 해제한다 |
| 문서 refresh | 문서 단위 `refresh`: 디스크를 한 번 읽어(문서 인코딩 강제, 토큰 규칙) 모델을 갱신하고, 모델을 직접 그리지 않는 뷰(DocRender)에 변경을 알린다. live-reload·재오픈·외부 변경은 뷰가 아니라 문서의 refresh 를 부른다 |
| 이동 API | `edDocMove(from, to)` — `from` 이 폴더면 그 접두 아래 모든 문서에 적용. 절차: ① `to`(또는 대응 경로)에 이미 문서가 있으면 그 항목은 옮기지 않고 충돌로 반환 ② 새 URI 로 새 모델 생성(내용 복사, 새 경로로 언어 모드 재판정) ③ 문서의 `model`·`dd`(새 경로로 재생성)·`stamp`·`encoding`·`bom`·`dirty` 이전. `savedAltVer` 는 새 모델 기준으로 다시 잡되, 옮기기 전 dirty 였으면 dirty 를 유지(저장 전까지) ④ `_edDocs` 키 교체 ⑤ 모든 뷰에 모델 교체·경로 갱신 통지(FileEditor `setModel`·`filePath`, git Diff 뷰는 05 가 통지를 받아 자기 diff 모델을 다시 짠다) ⑥ 옛 모델 dispose ⑦ 옛 경로로 `POST /api/lsp/close` |
| undo | 이동 후 undo 이력은 없다(첫 Cmd+Z 는 아무 일 없음). 동작 기록 — 이전: 이름변경 후에도 옛 URI 모델이 남아 undo 가 되지만 LSP·DocRender·재열기가 옛 경로를 가리켰다 / 새: 새 URI 모델, undo 소실, 내용·dirty 보존 / 이유: 모델 URI 가 경로의 유일한 진실 공급원이라는 불변식(사용자 결정 E-5.1 ①) |
| 호출자 | `edRetargetTabs` 는 이 API 를 부른다. 원격 기기의 워크스페이스 동기로 탭 경로가 바뀐 경우도 같은 API 를 탄다 |

### §3A-6 편집기 조회 헬퍼 (E-4)
사실: `slotKey(id,0)===id`(`app-slots.js:40`) — 칸 0 만 `tab.id` 로 잡힌다. 모든 칸 키 `slotKeysOf(id)`(`app-slots.js:50-54`)와 "포커스 칸→칸0→나머지" 조회 선례 `toolAny`(`app.js:315-325`)가 있다. 직접 조회 자리: `app-layout.js:582,667,686`, `app-editor-pane.js:244,262`, `app-editor-file.js:49`.

| 항목 | 확정 |
|------|------|
| 헬퍼 | `editorsOf(tabId)` = `slotKeysOf(tabId)` 로 모은 모든 칸 인스턴스. `editorAny(tabId)` = `toolAny` 와 같은 순서의 첫 인스턴스 |
| 용도 | dirty 확인·줄 reveal·재오픈 refresh 는 `editorAny`(문서 단위이므로 하나면 충분), 경로 갱신·파괴는 `editorsOf` |
| 교체 대상 | 위 6곳 전부 |
| 게이트 | `fileEditors.get(` 호출이 두 헬퍼 밖에서 0건(grep 게이트를 인수 기준에 넣는다) |

### §3A-7 dirty 파생·탭 라벨 (E-6)
사실: dirty 라벨은 `file-editor.js:973-994` 가 `app.aw()`(활성 창)의 탭 레코드에만 `tab.dirty` 를 써서 워크스페이스로 영속된다(#45). git Diff 탭은 `panel-diff.js:925-933` 이 같은 필드를 쓴다. 라벨은 `renderer-pane.js:34`.

| 항목 | 확정 |
|------|------|
| 필드 | `tab.dirty` 를 폐기한다. 워크스페이스 직렬화는 `dirty` 키를 쓰지 않고, 옛 저장본의 `dirty` 는 로드 시 무시한다 |
| 라벨 파생 | 탭 라벨의 ● 는 매 렌더 파생: 편집기 탭 = `edDoc(tab.filePath).dirty`, git Diff 탭 = 그 창 git 패널의 Diff 뷰 dirty(03 단계에서는 Diff 뷰 자신의 `_dirty`, 05 이후 공유 문서 dirty) |
| 갱신 | 문서 dirty 가 바뀌면 `render()` 한 번 — 모든 창이 같은 파생을 쓰므로 E-6.2 가 충족된다. `_setDiffDirty` 는 `tab.dirty` 를 쓰지 않고 `render()` 만 부른다 |
| dirty 판정 | dirty = `model.getAlternativeVersionId() !== savedAltVer`. `savedAltVer` 갱신: 초기 로드·refresh 적용·다시 열기·저장 성공(보낸 altVer 와 응답 시 altVer 가 같을 때). 저장 왕복 중 편집이 있으면 `savedAltVer` = 보낸 시점 altVer(그래서 dirty 유지) |
| 이동 예외 | `edDocMove` 직후 dirty 였던 문서는 저장 성공 전까지 dirty 를 유지한다(§3A-5 ③) |

### §3A-8 그 밖 (E-8, E-9)
| 항목 | 확정 |
|------|------|
| E-8.1 | 기준 내용은 `\r\n`·`\r` 을 `\n` 으로 바꾼 뒤 줄로 나눈다(모델 `getLinesContent` 는 EOL 을 뺀 줄을 준다) |
| E-9.1 | LSP 진단 지우기는 `edDocDrop` 의 뷰 0 순간(§3A-0 X4) |
| E-9.3 | 저장 진행 중의 저장 요청은 진행 중 저장 완료를 기다린 뒤, 그때 dirty 면 한 번 더 저장한다(여러 번 눌러도 대기 1건 — 현행 `saving` 중 `return false` 무음(`file-editor.js:741`) 대체). "저장 후 닫기" 는 저장 성공 후 닫고, 실패·409 흐름에서 취소되면 닫지 않는다. 대기는 문서 단위다(FileEditor·git Diff 뷰의 저장이 같은 대기를 공유) |
| 추적 | 스펙 산출물로 "감사 # ↔ 요구 ID ↔ 테스트 ID" 표를 싣는다(X8) |

## 4. 제약
- 레포 관례(`// @ts-check` 파일은 typecheck 통과, 주석·문서 한국어, FR ID), `make gates lint typecheck unit test` 통과.
- 영향 e2e(`e2e/editor-*.spec.ts`, `repo-tab*` 류, git Diff 편집이 닿는 `e2e/git-diff.spec.ts`) 회귀 없음. 새 동작에는 e2e 또는 node:test 단위 테스트를 추가한다(순수 로직은 모듈로 분리해 node:test).
- 새 외부 의존성은 `golang.org/x/text` 하나다.
- 커밋 메시지·문서에 AI 서명 금지.

## 5. 인수 기준
- E-* 각각의 재현 시나리오(감사 문서)가 테스트로 존재하고 구현 후 통과(§3A-8 추적표로 대응).
- 서버 단위: CP949 파일 열기→편집→저장 후 바이트가 CP949 로 보존됨. UTF-8 BOM 보존. UTF-16LE·BE(BOM) 파일이 probe 에서 text, read 에서 `utf-16le/be`, 저장 후 BOM·바이트 순서 보존. 표현 불가 문자 422 `encoding_unmappable` + 첫 위치, 파일 불변. 강제 인코딩 실패 422 `encoding_undecodable`. 실행 비트·0600 보존. 심링크 유지·대상에 쓰기. `decode` 없는 read 가 원문 바이트(하위호환). diff-content `encoding` 파라미터의 side 별 디코드(변환 저장 뒤 index=CP949·작업 트리=UTF-8 사례 포함).
- 프런트: 상태바 인코딩 항목이 포커스 편집기의 인코딩을 표시, 다시 열기 4종·변환 저장 동작, `fileEditors.get(` grep 게이트 0건, `tab.dirty` 가 워크스페이스 저장본에 없음, 이름변경 후 새 URI 모델·dirty 보존·undo 소실.
