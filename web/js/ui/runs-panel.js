/**
 * Run 시각화의 소유자 (APP_STATE_EXTRACT_SRS 묶음 A).
 *
 * `app-runs.js` 에 있던 상태 열하나와 메서드 서른셋이 여기로 왔다. 그 상태는
 * **전부 이 주제 안에서만** 쓰이는데 `App` 의 필드로 살고 있었고, 그래서 누가
 * 그것을 소유하는지 코드가 말하지 않았다.
 *
 * `GitObserver`(앱에 하나인 git 관측)·`FileTreeStore`(루트마다 하나인 탐색기 관측)
 * 와 같은 형태다 — `constructor(app)` 으로 앱을 받고, 앱으로 나가는 길은 여덟 곳
 * 뿐이다 (`ws`·`focused`·`addTab`·`slotKey`·`slotBase`·`jumpToTool`·
 * `findToolLocation`).
 *
 * **본문을 `Object.assign` 으로 얹는 이유**는 원본이 이미 객체 리터럴이기
 * 때문이다. 클래스 본문으로 옮기면 메서드 서른셋에서 끝의 쉼표를 떼야 하고, 그
 * 편집이 diff 를 덮어 "옮기기만 했다" 를 증명할 수 없게 된다.
 *
 * 바깥이 부르는 이름 여섯은 `app-runs.js` 에 위임 껍데기로 남아 있다 — 호출부를
 * 한 글자도 바꾸지 않기 위해서다.
 *
 * 로드 순서 계약: `app-runs.js` **앞**. (`js/ui/` 는 `js/core/app*.js` 보다 먼저 실린다)
 */

// 대시보드가 다루는 문자열. 한 자리에 모아 둔다 — e2e 가 같은 값을 본다.
const RUN_GONE_TEXT = t('runs.gone');
// 빈 목록의 두 줄은 이제 구역이 갖는다 (`app-activity.js` 의 `ACTIVITY_SECTIONS`) —
// 모달의 머리·빈 안내가 사라지면서 이 자리도 함께 나갔다 (FR-ACT-1).
// 조정자는 멤버가 아니므로 uuid 가 없다. 서버가 쓰는 것과 같은 문자열이다.
const RUN_COORD = 'coordinator';
// FR-RVZ-12: "최근 통신" 의 경계. 서버 시각은 Unix **초**다 (run/store.go 의 now()).
//
// 경계를 닫힌 구간(<=)으로 두는 이유는 브라우저 시계와 서버 시계를 비교하기
// 때문이다 — 해상도가 1초라 열린 구간이면 경계에서 강조가 깜빡인다.
const RUN_RECENT_SEC = 30;

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

function runSvg(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function runDiv(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

class RunsPanel {
  constructor(app) { this.app = app; }
}

Object.assign(RunsPanel.prototype, {

  // ── 진입점과 목록 (FR-RVZ-1~4 · UIUX_OVERHAUL_SRS FR-ACT-1~2 로 개정) ──

  /**
   * FR-RVZ-1 (개정): 진입점은 **패널의 Run 구역**을 연다.
   *
   * 중앙 차단 모달이 사라졌다 (FR-ACT-2) — 되돌릴 것이 없는 조회가 백드롭으로
   * 앱 전체를 막을 이유가 없다 (§3.3 원칙 4). 목록이 그리던 행은 그대로다:
   * 합친 것은 표면이고 정보가 아니다 (FR-ACT-1).
   *
   * 이름은 그대로 둔다 — 부르는 자리가 다섯이고(`app.js` 의 `runsToggle` ·
   * 상단바 · 모바일 드로어 · 행 클릭 · e2e) 이름을 바꾸는 것은 이 변경이 아니다.
   */
  _runsModalToggle(open) {
    if (open === false) return;              // 조회는 남의 동작에 닫히지 않는다
    this._runsErr = null; this._runsConfirm = null; this._runsDelErr = null;
    this.app.actPanelOpen('runs');
  },

  // FR-RVZ-3: 목록은 GET /api/runs 다. 대시보드가 쓰는 /graph 와 다른 종단이며,
  // 목록에 필요한 것은 레코드 요약뿐이다.
  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-4-10 (FEU-8): 겹친 재조회는 합친다 — 받는 중에 온 부름은
   * 끝난 뒤 한 번 더 받는다(`_runFetch` 의 busy/pending 과 같은 규약). 돌려주는 약속은
   * 그 뒤따르는 조회까지 끝나야 풀리므로, 삭제 뒤에 기다린 쪽은 삭제 뒤의 목록을 본다.
   */
  _runsRefresh() {
    if (this._runsRefP) { this._runsRefAgain = true; return this._runsRefP }
    this._runsRefP = (async () => {
      try {
        do { this._runsRefAgain = false; await this._runsFetchList() } while (this._runsRefAgain);
      } finally { this._runsRefP = null }
    })();
    return this._runsRefP;
  },

  // SSE 계기는 창 하나로 모은다 — 창이 열려 있는 동안 온 것은 그 창의 조회가 받는다.
  _runsRefreshSoon() {
    if (this._runsSoonT) return;
    this._runsSoonT = TIMERS.after(RUN_LIST_COALESCE_MS, () => { this._runsSoonT = null; this._runsRefresh() },
      { owner: this, label: 'runs-list' });
  },

  async _runsFetchList() {
    let list = null, err = null;
    const r = await apiGet(RUNS_API);
    if (r.ok) list = (r.data && r.data.runs) || [];
    else err = apiErrText(r, t('runs.list_fail'));
    this._runsList = list || [];
    this._runsErr = err;
    this._runsPanelPaint();
  },

  /** 패널이 열려 있으면 다시 그린다. 모달 시절 `_runsModalRender` 가 하던 일이다. */
  _runsPanelPaint() {
    this.app.agentsRender();
  },

  _runsRow(rv) {
    const members = rv.members || [];
    const headless = members.filter(m => m.headless).length;
    const row = runDiv('runs-row');
    row.dataset.runid = rv.id;
    row.title = t('runs.row_title');

    row.appendChild(runDiv('runs-short', rv.short || runShortId(rv.id || '')));
    row.appendChild(runDiv('runs-obj', rv.objective || ''));

    const st = runDiv('runs-state st-' + (rv.state || ''), rv.state || '');
    row.appendChild(st);

    row.appendChild(runDiv('runs-members',
      headless ? t('runs.members_headless', { n: members.length, h: headless }) : tn('runs.members', members.length)));

    // FR-RVZ-3: 격리가 none 이면 표시하지 않는다 — 없는 것이 기본값이므로
    // 적어 두면 목록에서 눈에 띄는 것이 전부 같아진다.
    if (rv.isolation && rv.isolation !== 'none') row.appendChild(runDiv('runs-iso', rv.isolation));

    // FR-RVZ-3 / V-RVZ-6: 컨텍스트 경고. critical 이 하나라도 있으면 그것이 이긴다.
    // 빈 contextLevel 은 "모른다" 이므로 배지를 달지 않는다 (FR-CBG-5).
    const lv = members.some(m => m.contextLevel === 'critical') ? 'critical'
      : members.some(m => m.contextLevel === 'warn') ? 'warn' : '';
    if (lv) row.appendChild(runDiv('runs-ctx lv-' + lv, '⚠ ' + lv));

    const ago = this._runAgo(rv.createdAt);
    row.appendChild(runDiv('runs-ago', ago ? t('runs.ago', { ago }) : ''));

    // FR-DEL-6: 실패는 그 행에 남는다. 삭제 목표보다 앞에 두어 오른쪽 끝이
    // 흔들리지 않는다 (FR-BGK-10 과 같은 자리).
    if (this._runsDelErr && this._runsDelErr.runId === rv.id) {
      row.appendChild(runDiv('runs-err-inline', this._runsDelErr.msg));
    }
    const pending = this._runsPending === rv.id;
    const confirming = this._runsConfirm === rv.id;
    if (pending) row.appendChild(runDiv('runs-deleting',
      this._runsPendingKind === 'close' ? t('runs.closing') : t('runs.deleting')));
    else if (confirming) row.appendChild(this._runsConfirmEl(rv));
    else {
      /**
       * FUI-04: **진행 중인 Run 을 기록을 잃지 않고 멈춘다.**
       *
       *   이전 동작: 유일한 출구가 `삭제` 였고 그것은 기록까지 지운다 —
       *             "이 Run 을 멈추고 싶다" 와 "이 Run 을 잊고 싶다" 가
       *             한 버튼이었다
       *   새  동작: 열린 Run 에는 `종료` 가 함께 선다 (`POST /api/runs/close`)
       *   이유:     서버는 `close` 를 이미 노출한다 — 없던 것은 화면뿐이었다.
       *             종료는 정리까지 한다 (FR-RUN-6~9): 에이전트를 끝내고 탭을
       *             닫고 worktree 를 거둔다
       *
       * 닫힌 Run 에는 두지 않는다 — 끝난 것을 또 끝내는 버튼은 뜻이 없다.
       */
      if (rv.state === 'open') row.appendChild(this._runsCloseBtn(rv));
      row.appendChild(this._runsDelBtn(rv));
    }

    // FR-RVZ-5: 모달이 닫히고, 현재 포커스 분할 칸에 새 탭이 생긴다.
    row.addEventListener('click', () => {
      if (this._runsPending) return;
      // FR-DEL-3·4: 확인이 열려 있으면 행을 건드리는 것은 **취소일 뿐**이다.
      if (this._runsConfirm) { this._runsConfirmSet(null); return }
      this.app.addTab(this.app.focused, 'run', { runId: rv.id, short: rv.short });
    });
    return row;
  },

  // FR-DEL-1·2: 항상 보인다 (터치에 hover 가 없다). 행 클릭으로 새지 않는다.
  _runsDelBtn(rv) {
    const btn = document.createElement('button');
    btn.className = 'ui-btn ui-btn-sm runs-del'; btn.textContent = t('runs.delete');
    // FR-TIP-2: 툴팁은 영어다. 어느 Run 인지는 라벨 옆의 행이 이미 말한다.
    btn.title = TIP_RUNS_DEL;
    btn.dataset.runid = rv.id;
    btn.addEventListener('click', e => { e.stopPropagation(); this._runsConfirmSet(rv.id) });
    return btn;
  },

  // FUI-04: 종료. **삭제와 나란히 서고 확인도 같은 규약이다** — 두 출구가
  // 다른 모양이면 사용자가 어느 쪽이 무엇을 지우는지 배워야 한다.
  _runsCloseBtn(rv) {
    const btn = document.createElement('button');
    btn.className = 'ui-btn ui-btn-sm runs-close'; btn.textContent = t('runs.close');
    btn.title = TIP_RUNS_CLOSE;
    btn.dataset.runid = rv.id;
    btn.addEventListener('click', e => { e.stopPropagation(); this._runsConfirmSet(rv.id, 'close') });
    return btn;
  },

  // FR-DEL-4: 확인은 행 안에서 한다 — 모달 위의 모달은 Escape 처리와 포커스
  // 관리를 복잡하게 만든다 (FR-BGK-4 와 같은 판단).
  _runsConfirmEl(rv) {
    const wrap = runDiv('runs-confirm');
    const closing = this._runsConfirmKind === 'close';
    wrap.dataset.kind = closing ? 'close' : 'delete';
    // 삭제는 되돌릴 수 없다 (FR-DEL-7). 무엇이 함께 사라지는지 적는다.
    //
    // FUI-04: 종료는 **기록을 남긴다** — 그 차이가 두 출구의 전부이므로 확인
    // 문구가 그것을 말한다. 말하지 않으면 사용자는 안전한 쪽을 고를 수 없다.
    const open = rv.state === 'open';
    wrap.appendChild(runDiv('runs-q', closing
      ? t('runs.q_close')
      : (open ? t('runs.q_delete_open') : t('runs.q_delete'))));
    const yes = document.createElement('button');
    yes.className = 'ui-btn ui-btn-sm ui-btn-danger runs-yes'; yes.textContent = t('core.yes');
    yes.title = closing ? TIP_RUNS_CLOSE_YES : TIP_RUNS_YES;
    yes.addEventListener('click', e => {
      e.stopPropagation();
      if (closing) this._runsClose(rv.id); else this._runsDelete(rv.id);
    });
    const no = document.createElement('button');
    no.className = 'ui-btn ui-btn-sm runs-no'; no.textContent = t('core.no'); no.title = TIP_RUNS_NO;
    no.addEventListener('click', e => { e.stopPropagation(); this._runsConfirmSet(null) });
    wrap.appendChild(yes); wrap.appendChild(no);
    return wrap;
  },

  // FR-DEL-3: 확인은 한 번에 하나다. 다른 행의 삭제를 누르면 앞의 확인은 취소된다.
  // FUI-04: **종류도 함께 기억한다** — 같은 행에서 종료와 삭제가 갈리므로,
  // 무엇을 물었는지 모르면 "예" 가 무엇을 하는지 말할 수 없다.
  _runsConfirmSet(runId, kind) {
    this._runsConfirm = runId || null;
    this._runsConfirmKind = runId ? (kind || 'delete') : null;
    this._runsDelErr = null;
    this._runsPanelPaint();
  },

  /**
   * FUI-04: `POST /api/runs/close`.
   *
   * **`force` 를 준다.** 그것이 없으면 아직 보고하지 않은 멤버가 있을 때 서버가
   * 거부하고(`unreported`), 사용자는 그 목록을 화면에서 해소할 길이 없다 —
   * 여기서 누른 것은 "지금 멈춘다" 이고, 그 뜻을 반만 전하면 버튼이 듣지 않는
   * 것으로 보인다.
   *
   * 실패·성공 처리는 삭제와 **같은 자리**를 쓴다 (`_runsDelErr`·`_runsRefresh`)
   * — 두 출구의 오류 표시가 갈리면 한쪽만 고쳐진다.
   */
  async _runsClose(runId) {
    this._runsConfirm = null; this._runsConfirmKind = null; this._runsDelErr = null;
    this._runsPending = runId; this._runsPendingKind = 'close';
    this._runsPanelPaint();
    const r = await apiPost(RUNS_CLOSE_API, { runId, force: true });
    let msg = '';
    if (!r.ok) {
      msg = apiErrText(r, t('runs.close_fail'));
    }
    this._runsPending = null; this._runsPendingKind = null;
    if (msg) this._runsDelErr = { runId, msg };
    else await this._runsRefresh();
    // 응답을 기다리는 사이에 모달이 닫혔을 수 있다 — 그때 그리면 되살아난다.
    this._runsPanelPaint();
  },

  // FR-DEL-5: DELETE /api/runs/{id}. 성공하면 목록만 다시 받는다 — 모달은 열린
  // 채로 남고, 빈 목록 안내는 그 갱신이 따라온다.
  async _runsDelete(runId) {
    this._runsConfirm = null; this._runsConfirmKind = null; this._runsDelErr = null;
    this._runsPending = runId; this._runsPendingKind = 'delete';
    this._runsPanelPaint();
    let ok = false, msg = '';
    const r = await apiDel(RUNS_API + '/' + encodeURIComponent(runId));
    ok = r.ok;
    if (!ok) msg = apiErrText(r, t('runs.delete_fail'));
    this._runsPending = null; this._runsPendingKind = null;
    if (!ok) this._runsDelErr = { runId, msg };
    else await this._runsRefresh();
    // 응답을 기다리는 사이에 모달이 닫혔을 수 있다 — 그때 그리면 되살아난다.
    this._runsPanelPaint();
  },

  // ── 탭 (FR-RVZ-6~9) ──

  // FR-RVZ-7: 같은 Run 의 탭 찾기. app-layout.js 의 _findEditorTab 과 같은 모양이며,
  // addTab 의 run 분기가 이것을 부른다. app-runs.js 는 app-layout.js 뒤에 로드되므로
  // 호출 시점에는 이미 프로토타입에 있다.
  _findRunTab(runId) {
    return findTabWhere(this.app.ws.windows, t => t.type === 'run' && t.runId === runId);
  },

  // 지금 워크스페이스에 살아 있는 run 탭의 id 집합. 캐시(_runViews)를 이것에
  // 맞춰 걷어낸다 — closeTab 은 이 파일이 소유하지 않으므로 정리를 그쪽에
  // 심지 않고 여기서 스스로 맞춘다.
  _runLiveTabIds() {
    const live = new Set();
    for (const s of this.app.ws.windows)
      for (const pn of panesOf(s && s.layout)) for (const t of pn.tabs || []) if (t.type === 'run') live.add(t.id);
    return live;
  },

  // `slotKey(탭 id, 칸)` → 대시보드 뷰. 뷰는 **탭보다 오래 살지 않는다**.
  //
  // SLOT_RUN_VIEW_SRS FR-SRV-1: 키가 탭 id 하나였을 때, 같은 Run 탭을 두 칸에서
  // 보면 뒤에 그린 칸의 `appendChild` 가 앞 칸에서 노드를 떼어 가 앞 칸이 비었다.
  // DOM 노드는 한 부모에만 붙는다 — 칸마다 뷰가 있어야 한다 (FR-SVS-40 과 같은 결론).
  _runViewMap() {
    if (!this._runViews) this._runViews = new Map();
    return this._runViews;
  },

  // renderer._mountTabBody 가 부른다. 루트 DOM 은 **탭과 칸의 쌍마다** 하나이며
  // 재사용된다 — pane 을 다시 그려도 SVG 가 새로 만들어지지 않는다 (NFR-RVZ-2).
  //
  // FR-SRV-3: 칸 0 의 키는 탭 id **그대로**다 (`slotKey`, FR-WSL-75) — 단일 슬롯
  // 모드의 동작은 한 글자도 바뀌지 않는다.
  runViewEl(tab, slot) {
    const m = this._runViewMap();
    const key = this.app.slotKey(tab.id, slot || 0);
    let v = m.get(key);
    if (!v) { v = { key, tabId: tab.id, slot: slot || 0, runId: tab.runId, root: this._runBuildRoot(), data: null, err: null, busy: false, pending: false }; m.set(key, v) }
    // 워크스페이스 복원이 같은 탭 id 에 다른 runId 를 실어 올 수 있다.
    if (v.runId !== tab.runId) { v.runId = tab.runId; v.data = null; v.err = null }
    // FR-RVZ-16: 첫 마운트에서만 부른다. 다시 그리기는 요청을 만들지 않는다.
    if (!v.data && !v.err && !v.busy) this._runFetch(v);
    this._runPaint(v);
    this._runObserveFit(v);
    // 마운트 직후에는 wrap 이 아직 배치되지 않아 폭이 0 일 수 있다. 다음 프레임에
    // 한 번 더 맞춘다 — ResizeObserver 가 첫 배치를 알려 주지만, 그 사이 한 프레임
    // 동안 기본 크기로 보이는 것을 없앤다.
    TIMERS.frame(() => this._runFitGraph(v.root),{owner:this,label:'run-fit'});
    return v.root;
  },

  _runBuildRoot() {
    const root = runDiv('run-view ui-scroll');
    root.appendChild(runDiv('run-miss'));
    const body = runDiv('run-body');
    body.appendChild(runDiv('run-summary'));
    const wrap = runDiv('run-graph-wrap ui-scroll');
    const svg = runSvg('svg', { class: 'run-graph' });
    svg.appendChild(runSvg('defs'));
    svg.appendChild(runSvg('g', { class: 'run-edges' }));
    svg.appendChild(runSvg('g', { class: 'run-nodes' }));
    wrap.appendChild(svg);
    body.appendChild(wrap);
    body.appendChild(runDiv('run-cards'));
    body.appendChild(runDiv('run-timeline'));
    root.appendChild(body);
    return root;
  },

  // FR-RVZ-15: 대시보드는 이 응답 하나로 완전히 렌더된다.
  // FR-RVZ-9: 404 는 "사라진 Run" 이다 — 오류가 아니라 상태이므로 따로 가른다.
  async _runFetch(v) {
    if (v.busy) { v.pending = true; return }
    v.busy = true; v.pending = false;
    let data = null, err = null;
    const r = await apiGet(RUNS_API + '/' + encodeURIComponent(v.runId) + '/graph');
    if (r.status === 404) err = 'gone';
    else if (!r.ok) err = apiErrText(r, t('runs.graph_fail'));
    else data = r.data;
    v.busy = false;
    if (err) v.err = err; else { v.data = data; v.err = null }
    this._runPaint(v);
    // 응답을 기다리는 사이에 도착한 SSE 는 버리지 않는다 — 버리면 화면이
    // 한 세대 뒤에서 멈추고, 폴링이 없으므로 아무도 고치지 않는다.
    if (v.pending && this._runViewMap().has(v.key)) this._runFetch(v);
  },

  // FR-RVZ-16: SSE `run_changed`. 열려 있는 그 Run 의 탭만 /graph 를 다시 부른다.
  // 열린 Run 탭이 없으면 아무 요청도 나가지 않는다 (V-RVZ-4).
  _onRunChanged(args) {
    const runId = args && args.runId;
    if (!runId) return;
    // FR-ACT-3: 상태바의 `⚡ n` 이 Run 을 세므로 목록이 최신이어야 한다 — 종전에는
    // 모달을 열 때만 받았고, 열지 않으면 수가 틀린 채로 있었다.
    this._runsRefreshSoon();
    const m = this._runViewMap();
    if (!m.size) return;
    const live = this._runLiveTabIds();
    // FR-SRV-4.2: 키는 복합키다 — 살아 있는 탭 판정은 `slotBase` 로 한다.
    // 편집기가 이 자리에서 정확히 같은 실수를 냈다 (FR-SVS-60): `@1` 만 잘라
    // 내던 동안 칸 2·3 의 뷰는 살아 있는 탭인데도 매번 파괴됐다.
    // FR-SRV-5: 같은 runId 를 보는 **모든 칸**의 뷰를 갱신한다.
    for (const [key, v] of Array.from(m)) {
      if (!live.has(this.app.slotBase(key))) { this._runDisposeView(v); m.delete(key); continue }
      if (v.runId !== runId) continue;
      v.err = null;
      this._runFetch(v);
    }
  },

  // 탭이 사라진 뷰의 뒷정리. 관측자와 예약된 다시 그리기를 함께 끊는다 —
  // 둘 다 탭보다 오래 살면 안 된다.
  _runDisposeView(v) {
    if (!v) return;
    if (v.ro) { try { v.ro.disconnect() } catch {} v.ro = null }
    if (v.decay) { TIMERS.cancel(v.decay); v.decay = null }
  },
});
