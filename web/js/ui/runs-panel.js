/**
 * Run 시각화의 소유자 (APP_STATE_EXTRACT_SRS 묶음 A).
 *
 * 옛 `app-runs.js` 에 있던 상태 열하나와 메서드 서른셋이 여기로 왔다. 그 상태는
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
 * 바깥이 부르는 이름 여섯은 `app.js` 에 위임자로 남아 있다(REFACTOR3_FE_APPCTL_SRS 9a, 옛 `app-runs.js`) — 호출부를
 * 한 글자도 바꾸지 않기 위해서다.
 *
 * PERF 3.4.9 (D-30): 이 파일은 부팅에 남는 껍데기다 — 목록·확인·탭 찾기·뷰 레지스트리와 SSE 계기. Run 탭의 뷰
 * (`runViewEl`·그리기·`run:<id>` 구독)는 `run` 화면 묶음(`run-view.js` 와 증강 파일들)에 있다. 뷰는 그 묶음이 실린 뒤에만
 * 생기므로, 뷰를 도는 메서드(`_runViewsRefresh`)가 묶음의 메서드를 불러도 묶음보다 먼저 닿지 않는다.
 *
 * 로드 순서 계약: `core/screens.js` **뒤**(끝에서 화면을 등록한다), `app.js` **앞**.
 */

// 대시보드가 다루는 문자열. 한 자리에 모아 둔다 — e2e 가 같은 값을 본다.
const RUN_GONE_TEXT = t('runs.gone');
// 빈 목록의 두 줄은 이제 구역이 갖는다 (`activity-list.js` 의 `ACTIVITY_SECTIONS`) —
// 모달의 머리·빈 안내가 사라지면서 이 자리도 함께 나갔다 (FR-ACT-1).
// 조정자는 멤버가 아니므로 uuid 가 없다. 서버가 쓰는 것과 같은 문자열이다.
const RUN_COORD = 'coordinator';
/** 흔적으로만 남는 노드의 상태 (FR-ITC-3·7). */
const RUN_TREE_ENDED = new Set(['done', 'failed', 'released', 'succeeded']);

/**
 * RUN_INACTIVE_NODE_SRS: 노드·카드의 종류. `ended`(끝남)·`lost`(잃음)는 비활성이다. 상태는
 * 서버의 것이므로, 잃은 멤버의 도구가 다시 잡히면 다음 응답에서 `active` 로 돌아온다 (FR-RIN-20).
 */
function runNodeKind(state) {
  if (RUN_TREE_ENDED.has(state)) return 'ended';
  return state === 'lost' ? 'lost' : 'active';
}

/**
 * FR-RVZ-3 (개정 2026-11-12): 카드의 멤버 수. 활성은 끝남·잃음이 아닌 멤버이고(`runNodeKind`),
 * 헤드리스도 활성만 센다 — 사라진 헤드리스가 계속 세어지면 카드가 지금 상태를 말하지 못한다.
 */
function runMemberCounts(members) {
  const all = members || [];
  const live = all.filter(m => runNodeKind(m.state) === 'active');
  return { active: live.length, total: all.length, headless: live.filter(m => m.headless).length };
}

/** FR-RVZ-3 (개정 2026-11-12): 마지막 활동 시각(초). 알려진 시각 가운데 가장 늦은 것이다. */
function runLastActivity(rv) {
  let at = rv.createdAt || 0;
  const see = v => { if (v > at) at = v; };
  see(rv.coordinator && rv.coordinator.contextAt);
  for (const m of rv.messages || []) see(m.at);
  for (const m of rv.members || []) { see(m.createdAt); see(m.reportedAt); see(m.contextAt); }
  return at;
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
    this.app.agents.list.actPanelOpen('runs');
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
    this._runsApplyList(list, err);
  },

  /** 목록을 얹는다. 채널의 `runs` 토픽(PERF M1 C3)과 GET 이 함께 쓴다. */
  _runsApplyList(list, err = null) {
    this._runsList = list || [];
    this._runsErr = err;
    this._runsPanelPaint();
  },

  /** 패널이 열려 있으면 다시 그린다. 모달 시절 `_runsModalRender` 가 하던 일이다. */
  _runsPanelPaint() {
    this.app.agents.agentsRender();
  },

  // 서버 시각은 Unix **초**다 (Go 기준선 run/store.go 의 now()).
  _runAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor(Date.now() / MS_PER_SEC - ts));
    if (s < 60) return tn('core.dur_sec', s);
    if (s < 3600) return tn('core.dur_min', Math.floor(s / 60));
    if (s < 86400) return tn('core.dur_hour', Math.floor(s / 3600));
    return tn('core.dur_day', Math.floor(s / 86400));
  },

  _runsRow(rv) {
    const members = rv.members || [];
    const cnt = runMemberCounts(members);
    const row = domEl('div', 'runs-row');
    row.dataset.runid = rv.id;
    row.title = t('runs.row_title');

    row.appendChild(domEl('div', 'runs-short', rv.short || ''));
    row.appendChild(domEl('div', 'runs-obj', rv.objective || ''));

    const st = domEl('div', 'runs-state st-' + (rv.state || ''), rv.state || '');
    row.appendChild(st);

    row.appendChild(domEl('div', 'runs-members', cnt.headless
      ? t('runs.members_active_headless', { a: cnt.active, n: cnt.total, h: cnt.headless })
      : t('runs.members_active', { a: cnt.active, n: cnt.total })));

    // FR-RVZ-3: 격리가 none 이면 표시하지 않는다 — 없는 것이 기본값이므로
    // 적어 두면 목록에서 눈에 띄는 것이 전부 같아진다.
    if (rv.isolation && rv.isolation !== 'none') row.appendChild(domEl('div', 'runs-iso', rv.isolation));

    // FR-RVZ-3 / V-RVZ-6: 컨텍스트 경고. critical 이 하나라도 있으면 그것이 이긴다.
    // 빈 contextLevel 은 "모른다" 이므로 배지를 달지 않는다 (FR-CBG-5).
    const lv = members.some(m => m.contextLevel === 'critical') ? 'critical'
      : members.some(m => m.contextLevel === 'warn') ? 'warn' : '';
    // UX_AUDIT_FIX_SRS FR-UXF-100: 경고 표식은 아이콘이다(이전 글자 `⚠`).
    if (lv) row.appendChild(domEl('div', 'runs-ctx lv-' + lv, ' ' + lv)).prepend(UIKit.icon('triangle-alert', { size: 'sm' }));

    const ago = this._runAgo(runLastActivity(rv));
    row.appendChild(domEl('div', 'runs-ago', ago ? t('runs.ago', { ago }) : ''));

    // FR-DEL-6: 실패는 그 행에 남는다. 삭제 목표보다 앞에 두어 오른쪽 끝이
    // 흔들리지 않는다 (FR-BGK-10 과 같은 자리).
    if (this._runsDelErr && this._runsDelErr.runId === rv.id) {
      row.appendChild(domEl('div', 'runs-err-inline', this._runsDelErr.msg));
    }
    const pending = this._runsPending === rv.id;
    const confirming = this._runsConfirm === rv.id;
    if (pending) row.appendChild(domEl('div', 'runs-deleting', this._runsPendingKind === 'close' ? t('runs.closing') : t('runs.deleting')));
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
       * 닫힌 Run 에는 두지 않는다 — 끝난 것을 또 끝내는 버튼은 뜻이 없다. 그 판정은
       * 서버의 답이다 (SERVER_DRIVEN_ACTIONS_SRS R-g · FR-SDA-61).
       *	이전 동작: 화면이 `rv.state==='open'` 으로 스스로 골랐다
       */
      if (actionOk(rv, RUN_ACTION_CLOSE)) row.appendChild(this._runsCloseBtn(rv));
      if (actionOk(rv, RUN_ACTION_DELETE)) row.appendChild(this._runsDelBtn(rv));
    }

    // FR-RVZ-5: 모달이 닫히고, 현재 포커스 분할 칸에 새 탭이 생긴다.
    row.addEventListener('click', () => {
      if (this._runsPending) return;
      // FR-DEL-3·4: 확인이 열려 있으면 행을 건드리는 것은 **취소일 뿐**이다.
      if (this._runsConfirm) { this._runsConfirmSet(null); return }
      this.app.layout.tabAdd.addTab(this.app.focused, 'run', { runId: rv.id, short: rv.short });
      if (this.app.mobile.nav.actSheetLeave) this.app.mobile.nav.actSheetLeave();   // PANEL_TEMPLATE_SRS FR-PNT-15
    });
    return row;
  },

  // FR-DEL-1·2: 항상 보인다 (터치에 hover 가 없다). 행 클릭으로 새지 않는다.
  _runsDelBtn(rv) {
    // FR-TIP-2: 툴팁은 영어다. 어느 Run 인지는 라벨 옆의 행이 이미 말한다.
    return UIKit.button({ label: t('runs.delete'), title: TIP_RUNS_DEL, size: 'sm', cls: 'runs-del',
      dataset: { runid: rv.id }, onClick: e => { e.stopPropagation(); this._runsConfirmSet(rv.id) } });
  },

  // FUI-04: 종료. **삭제와 나란히 서고 확인도 같은 규약이다** — 두 출구가
  // 다른 모양이면 사용자가 어느 쪽이 무엇을 지우는지 배워야 한다.
  _runsCloseBtn(rv) {
    return UIKit.button({ label: t('runs.close'), title: TIP_RUNS_CLOSE, size: 'sm', cls: 'runs-close',
      dataset: { runid: rv.id }, onClick: e => { e.stopPropagation(); this._runsConfirmSet(rv.id, 'close') } });
  },

  // FR-DEL-4: 확인은 행 안에서 한다 — 모달 위의 모달은 Escape 처리와 포커스
  // 관리를 복잡하게 만든다 (FR-BGK-4 와 같은 판단).
  _runsConfirmEl(rv) {
    const wrap = domEl('div', 'runs-confirm');
    const closing = this._runsConfirmKind === 'close';
    wrap.dataset.kind = closing ? 'close' : 'delete';
    // 삭제는 되돌릴 수 없다 (FR-DEL-7). 무엇이 함께 사라지는지 적는다.
    //
    // FUI-04: 종료는 **기록을 남긴다** — 그 차이가 두 출구의 전부이므로 확인
    // 문구가 그것을 말한다. 말하지 않으면 사용자는 안전한 쪽을 고를 수 없다.
    const open = rv.state === 'open';
    // R-d: 아직 보고하지 않은 멤버가 있으면 그 수를 밝힌다 — 종료는 그들을 기다리지 않는다.
    wrap.appendChild(domEl('div', 'runs-q', closing
      ? (rv.unreported ? t('runs.q_close_unreported', { n: rv.unreported }) : t('runs.q_close'))
      : (open ? t('runs.q_delete_open') : t('runs.q_delete'))));
    const yes = UIKit.button({ label: t('core.yes'), title: closing ? TIP_RUNS_CLOSE_YES : TIP_RUNS_YES,
      kind: 'danger', size: 'sm', cls: 'runs-yes', onClick: e => {
        e.stopPropagation();
        if (closing) this._runsClose(rv.id); else this._runsDelete(rv.id);
      } });
    const no = UIKit.button({ label: t('core.no'), title: TIP_RUNS_NO, size: 'sm', cls: 'runs-no',
      onClick: e => { e.stopPropagation(); this._runsConfirmSet(null) } });
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

  // FR-RVZ-7: 같은 Run 의 탭 찾기. `layout-tab-add.js` 의 `_findEditorTab` 과 같은 모양이며,
  // addTab 의 run 분기가 App 의 위임자(`app.js`)로 이것을 부른다.
  _findRunTab(runId) {
    return findTabWhere(this.app.ws.windows, tab => tab.type === 'run' && tab.runId === runId);
  },

  // 지금 워크스페이스에 살아 있는 run 탭의 id 집합. 캐시(_runViews)를 이것에
  // 맞춰 걷어낸다 — closeTab 은 이 파일이 소유하지 않으므로 정리를 그쪽에
  // 심지 않고 여기서 스스로 맞춘다.
  _runLiveTabIds() {
    const live = new Set();
    for (const s of this.app.ws.windows)
      for (const pn of panesOf(s && s.layout)) for (const tab of pn.tabs || []) if (tab.type === 'run') live.add(tab.id);
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

  // FR-RVZ-16: SSE `run_changed`. 열려 있는 그 Run 의 탭만 /graph 를 다시 부른다.
  // 열린 Run 탭이 없으면 아무 요청도 나가지 않는다 (V-RVZ-4).
  _onRunChanged(args) {
    const runId = args && args.runId;
    if (!runId) return;
    // FR-ACT-3: 상태바의 `⚡ n` 이 Run 을 세므로 목록이 최신이어야 한다 — 종전에는
    // 모달을 열 때만 받았고, 열지 않으면 수가 틀린 채로 있었다.
    this._runsRefreshSoon();
    // FR-SRV-5: 같은 runId 를 보는 **모든 칸**의 뷰를 갱신한다.
    // FR-ITD-1·7: 트리 뷰는 같은 트리의 **다른** Run 이 바뀌어도 다시 받는다 — 가지 Run 이
    // 따로다. 다른 트리·트리 아닌 Run 의 변경은 payload 의 `tree` 로 가려 건너뛴다.
    this._runViewsRefresh(v => v.runId === runId || (!!(v.data && v.data.tree) && args.tree === v.data.tree));
  },

  /**
   * 살아 있는 뷰 가운데 `pick` 이 고른 것을 다시 받는다. 고르지 않으면 전부다 — 상태
   * 등록부 `run.views` 의 주기가 그 길이다 (RUN_VIEW_LIVE_SRS FR-RLV-7·8).
   */
  _runViewsRefresh(pick) {
    const m = this._runViewMap();
    if (!m.size) return;
    const live = this._runLiveTabIds();
    // FR-SRV-4.2: 키는 복합키다 — 살아 있는 탭 판정은 `slotBase` 로 한다.
    // 편집기가 이 자리에서 정확히 같은 실수를 냈다 (FR-SVS-60): `@1` 만 잘라
    // 내던 동안 칸 2·3 의 뷰는 살아 있는 탭인데도 매번 파괴됐다.
    for (const [key, v] of Array.from(m)) {
      if (!live.has(this.app.slot.slotBase(key))) { this._runDisposeView(v); m.delete(key); continue }
      if (pick && !pick(v)) continue;
      if (v.asleep) { v.stale = true; continue }
      v.err = null;
      this._runFetch(v);
    }
  },

  /**
   * FR-RLV-5·6: SSE `tool_activity`. 멤버의 상태는 서버가 물을 때 계산하므로 서버는 그
   * 변화를 `run_changed` 로 알리지 못한다 (D-RLV-2) — 같은 사실을 여기서 받는다.
   * 상태가 그대로면(도구 이름·detail 만 바뀜) 화면의 노드는 같으므로 받지 않는다.
   */
  _onMemberActivity(args) {
    const toolId = args && args.toolId;
    if (!toolId) return;
    if (!this._memberStates) this._memberStates = new Map();
    if (this._memberStates.get(toolId) === args.state) return;
    this._memberStates.set(toolId, args.state);
    const has = members => (members || []).some(mb => mb.toolId === toolId);
    if ((this._runsList || []).some(rv => has(rv.members))) this._runsRefreshSoon();
    this._runViewsRefresh(v => !!v.data && has(v.data.members));
  },
});

// PERF 3.4.9 (D-30): Run 탭의 본문은 `run` 묶음이 그린다. 렌더러는 묶음이 실릴 때까지 자리표시를 둔다.
Screens.register('run', { css: true, tab: (at) => at.type === 'run' });
