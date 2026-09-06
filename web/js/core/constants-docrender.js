/**
 * 문서 렌더 뷰의 상수 (DOC_RENDER_VIEW_SRS).
 *
 * 별도 파일인 것은 `constants-editor.js` 가 지금 다른 작업의 손에 있기 때문이다 —
 * 상수의 성질이 달라서가 아니다. 자리가 안정되면 그쪽으로 접어도 된다.
 */

// FR-DRV-1: **확장자가 정한다.** 내용 판정으로는 Markdown 과 평문이 갈리지 않는다.
// 표는 여기 한 자리이며, M3·M4 가 svg·html·table 을 이 표에 더한다.
const DOC_RENDER_EXTS = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown',
  '.svg': 'svg',
  '.html': 'html', '.htm': 'html',
  '.csv': 'table', '.tsv': 'table',
};

// FR-DRV-16: 구분자는 확장자가 정한다 — 내용에서 알아맞히지 않는다. 쉼표가 든
// TSV 와 탭이 든 CSV 가 둘 다 흔하고, 추측이 틀리면 표가 통째로 어긋난다.
const DOC_RENDER_DELIM = { '.csv': ',', '.tsv': '\t' };

const DOC_RENDER_BTN = '◈';
const DOC_RENDER_BTN_TITLE = '옆 칸에 렌더된 모습 열기';
const DOC_RENDER_SOURCE = '‹ 소스';
const DOC_RENDER_SOURCE_TITLE = '이 문서의 소스로 돌아가기';
// FR-DRV-11: 렌더 탭임을 알리는 표시. **이름을 늘리지 않는다** — 좁은 탭에서는
// 파일명이 먼저 잘린다 (TAB_WIDTH_SRS).
const DOC_RENDER_TAB_MARK = '◈ ';

// FR-DRV-42: 타이핑마다 큰 문서를 다시 그리면 그 지연이 편집기의 지연으로 느껴진다.
const DOC_RENDER_DEBOUNCE_MS = 180;

// FR-DRV-29: 상한. 넘으면 그리지 않고 사유를 말한다 (FR-DRV-17).
const DOC_RENDER_MAX_BYTES = 2 * 1024 * 1024;
const DOC_RENDER_TOO_BIG = '문서가 너무 커서 그리지 않았습니다';
const DOC_RENDER_FAIL = '문서를 그리지 못했습니다';
const DOC_RENDER_NO_LIB = '렌더러를 불러오지 못했습니다';
const DOC_RENDER_LOADING = '그리는 중…';
// FR-DRV-17: SVG 가 그려지지 않는 흔한 이유는 문서 자신이다 — 그 사실을 말한다.
const DOC_RENDER_SVG_FAIL = '이 SVG 를 그리지 못했습니다 — 문서가 올바르지 않을 수 있습니다';

// FR-DRV-22: **스크립트가 돌지 않는다는 사실을 적는다.** 적지 않으면 "왜 내
// 스크립트가 안 도는가" 가 우리 버그로 읽힌다.
const DOC_RENDER_HTML_NOTE = '미리보기입니다 — 이 문서의 스크립트는 실행되지 않습니다';

// FR-DRV-29: 표의 상한. 넘으면 그 사실을 말한다 — 잘라 놓고 침묵하면 사용자는
// 파일이 그만큼인 줄로 읽는다.
const DOC_RENDER_TABLE_MAX_ROWS = 2000;
const DOC_RENDER_TABLE_MAX_COLS = 200;
const DOC_RENDER_TABLE_CUT = '큰 표라서 앞부분만 보입니다 — %r행 중 %n행';
const DOC_RENDER_TABLE_EMPTY = '표에 담을 내용이 없습니다';
// FR-DRV-26: 루트 밖으로는 가지 않는다. 침묵하면 링크가 죽은 것인지 우리가 막은
// 것인지 갈리지 않는다.
const DOC_RENDER_OUTSIDE = '이 창의 폴더 밖은 열지 않습니다';
