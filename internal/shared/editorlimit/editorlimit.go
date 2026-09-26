// Package editorlimit 은 편집기가 여는 한 파일의 상한이다 (OPTIMIZE_REFACTOR_SRS
// FR-OPT-15-1 · D-OPT-9).
//
// 파일 읽기(`/api/file/{read,raw,probe}`) · 저장(`/api/file/write`) · LSP 요청 텍스트와
// 디스크 재동기화 · git diff 본문과 HEAD 판 열기가 전부 이 값에서 나온다. 종전에는
// 10 MiB · 1 MiB(저장 본문) · 8/10 MiB · 1 MiB 로 갈려, 열리는 파일이 저장되지 않거나
// diff 에 나오지 않았다. 브라우저는 따로 값을 들지 않는다 — `/api/file/probe` 가
// `maxBytes` 로 싣는다 (FILE_API_BOUNDARY_SRS FR-FAB-9).
package editorlimit

// FileMaxBytes 는 한 파일의 상한이다 (디스크 바이트).
const FileMaxBytes = 32 << 20

// BodyEnvelope 는 요청 본문에서 텍스트가 아닌 필드(경로·표식·인코딩·위치)의 여유다.
const BodyEnvelope = 64 << 10

// jsonEscapeFactor 는 텍스트 한 바이트가 JSON 문자열에서 차지하는 최악의 바이트 수다
// — 개행·따옴표·역슬래시·탭은 두 바이트(`\n`), 그 밖의 제어 문자는 `\u00XX` 여섯
// 바이트다 (FR-OPT-16-4). 두 배로 잡았을 때는 제어 문자가 많은 파일이 파일 상한 안인데도
// `body_too_large` 였다. 이것은 **받을 수 있는 천장**이고 버퍼는 실제 본문만큼만 자란다
// — 디스크 바이트는 따로 파일 상한으로 판정한다.
const jsonEscapeFactor = 6

// BodyMaxBytes 는 파일 fileMax 바이트를 JSON 문자열로 싣는 요청 본문의 상한이다.
func BodyMaxBytes(fileMax int64) int64 { return fileMax*jsonEscapeFactor + BodyEnvelope }

// PatchDiffMaxBytes 는 파일 fileMax 바이트의 unified diff(부분 스테이징) 출력 상한이다
// (FR-OPT-16-4). 전면 재작성이면 옛 판과 새 판이 모두 나오고 줄마다 접두어 한 바이트가
// 붙는다. 줄은 최소 한 바이트(개행)이므로 한 판은 최대 두 배다 — 두 판이면 네 배이고,
// 머리(`diff --git`·`@@`)는 봉투 여유가 싣는다.
func PatchDiffMaxBytes(fileMax int64) int64 { return 2*2*fileMax + BodyEnvelope }
