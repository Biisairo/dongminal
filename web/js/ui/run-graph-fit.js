/**
 * Run 그래프의 배치 치수와 칸 폭 맞춤 (FR-RVZ-11 · FR-FIT-1~4 · FR-OPT-12-4).
 * `runs-panel.js` 에서 내용 그대로 옮겼다 — 그 파일이 500줄 경계를 넘지 않게 갈랐다(FR-STR-40).
 * 쓰는 곳은 `run-dashboard.js` 다.
 */

// 계층형 고정 배치의 치수. 전부 viewBox 좌표다 — 뷰포트 크기와 무관하므로
// 같은 Run 은 어떤 창에서도 같은 모양으로 그려진다 (FR-RVZ-11).
const RUN_NODE_W = 112;
const RUN_NODE_H = 52;
const RUN_COORD_Y = 24;
const RUN_ROW_Y = 168;
const RUN_MIN_W = 720;
// FR-OPT-12-4 (FEU-23): 배치의 여백. 멤버 사이 가로 간격 · 좌우 합 · 멤버 줄 아래(호 자리) ·
// 멤버가 없을 때 조정자 아래.
const RUN_NODE_GAP_X = 30;
const RUN_GRAPH_PAD_X = 60;
const RUN_GRAPH_PAD_BOTTOM = 76;
const RUN_GRAPH_PAD_COORD = 16;
// FR-FIT-2·3·4: 그래프를 분할 칸 폭에 맞춘다.
//
// 하한 0.5 는 노드 부제(10px)가 5px 가 되는 지점이며 그 아래는 글자가 아니다 —
// 더 줄이는 대신 가로 스크롤로 돌아간다. 읽을 수 없게 만드는 fit 은 fit 이 아니다.
//
// 상한 1.5 는 "꽉 차게" 와 "포스터가 되지 않게" 의 경계다. 상한이 1 이면 멤버가
// 적은 Run 이 넓은 화면 한가운데 작게 떠 접수한 말("화면 크기에 맞게 꽉 차도록")을
// 어긴다. 2 를 넘기면 노드 제목이 24px 가 되어 대시보드가 아니라 표지가 된다.
const RUN_FIT_MIN = 0.5;
const RUN_FIT_MAX = 1.5;

/**
 * FR-FIT-1~4: svg 를 감싼 칸의 폭에 맞춘다.
 *
 * 배율은 [RUN_FIT_MIN, RUN_FIT_MAX] 로 잘린다 — 좁으면 줄이되 읽을 수 있는
 * 데까지만(그 아래는 가로 스크롤), 넓으면 키우되 표지가 되지 않을 만큼만.
 *
 * 폭을 재는 대상은 wrap 이며, 그 값이 0 이면(아직 붙지 않은 DOM) 아무것도
 * 하지 않는다 — 0 으로 나눈 배율은 그래프를 사라지게 한다.
 */
function runFitSvg(wrap, svg) {
  if (!wrap || !svg) return;
  const w = Number(svg.dataset.w || 0), h = Number(svg.dataset.h || 0);
  if (!w || !h) return;
  // 좌우 여백은 wrap 의 padding 이다. clientWidth 는 그것을 포함하므로 뺀다.
  const cs = getComputedStyle(wrap);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const avail = wrap.clientWidth - pad;
  if (avail <= 0) return;
  const scale = Math.min(RUN_FIT_MAX, Math.max(RUN_FIT_MIN, avail / w));
  svg.setAttribute('width', Math.round(w * scale));
  svg.setAttribute('height', Math.round(h * scale));
}
