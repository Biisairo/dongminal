/**
 * Run 시각화의 소유자 (APP_STATE_EXTRACT_SRS 묶음 A).
 *
 * `app-runs.js` 에 있던 상태 열하나와 메서드 서른셋이 여기로 왔다. 그 상태는
 * **전부 이 주제 안에서만** 쓰이는데 `App` 의 필드로 살고 있었고, 그래서 누가
 * 그것을 소유하는지 코드가 말하지 않았다.
 *
 * `GitObserver`(앱에 하나인 git 관측)·`FileTreeStore`(루트마다 하나인 탐색기 관측)
 * 와 같은 형태다 — `constructor(app)` 으로 앱을 받고, 앱으로 나가는 길은 여덟 곳
 * 뿐이다 (`ws`·`focused`·`addTab`·`_slotKey`·`_slotBase`·`_jumpToTool`·
 * `_findToolLocation`).
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
const RUN_GONE_TEXT = '이 Run 은 더 이상 없다';
const RUN_EMPTY_TEXT = '진행 중인 Run 이 없다';
const RUN_EMPTY_HINT = '/dongminal:team 으로 팀을 연다';
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

  // ── 진입점과 목록 모달 (FR-RVZ-1~4) ──

  // FR-RVZ-1: 상단바 [Runs]. 배경 클릭·Escape 로 닫히고 오버레이 자신이 대상일
  // 때만 닫는다 — 백그라운드 도구 모달(FR-BGU-7)과 **같은 상호작용 규약**이다.
  _runsModalToggle(open) {
    this._runsModalOpen = (open === undefined) ? !this._runsModalOpen : !!open;
    if (this._runsModalOpen) { this._runsRefresh(); this._runsModalRender(); return }
    // FR-DEL-4: 모달이 닫히면 확인도 취소된다 (FR-BGK-5 와 같은 규약). 진행 중인
    // 삭제는 남는다 — 요청은 이미 떠났고, 응답이 목록을 정리한다.
    this._runsErr = null; this._runsConfirm = null; this._runsDelErr = null;
    const el = document.getElementById('runs-modal'); if (el) el.remove();
    if (this._runsModalKey) { document.removeEventListener('keydown', this._runsModalKey); this._runsModalKey = null }
  },

  // FR-RVZ-3: 목록은 GET /api/runs 다. 대시보드가 쓰는 /graph 와 다른 종단이며,
  // 목록에 필요한 것은 레코드 요약뿐이다.
  async _runsRefresh() {
    let list = null, err = null;
    try {
      const r = await fetch('/api/runs');
      if (r.ok) list = (await r.json()).runs || [];
      else err = (await r.text()).trim() || `목록을 받지 못했다 (${r.status})`;
    } catch { err = '목록을 받지 못했다 — 서버에 닿지 못했다' }
    this._runsList = list || [];
    this._runsErr = err;
    if (this._runsModalOpen) this._runsModalRender();
  },

  _runsModalRender() {
    let ov = document.getElementById('runs-modal');
    if (!ov) {
      ov = runDiv('runs-modal'); ov.id = 'runs-modal';
      document.body.appendChild(ov);
      // FR-RVZ-2: 배경 클릭 — 오버레이 자신이 대상일 때만 닫는다.
      ov.addEventListener('click', e => { if (e.target === ov) this._runsModalToggle(false) });
      this._runsModalKey = e => { if (e.key === 'Escape') { e.preventDefault(); this._runsModalToggle(false) } };
      document.addEventListener('keydown', this._runsModalKey);
    }
    ov.innerHTML = '';
    const box = runDiv('runs-box');
    // 최근순. 서버 순서에 기대지 않는다 — 정렬은 이 화면의 약속이다.
    const rows = (this._runsList || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    box.appendChild(runDiv('runs-head', `Run ${rows.length}개`));
    if (this._runsErr) {
      box.appendChild(runDiv('runs-err', this._runsErr));
    } else if (!rows.length) {
      // FR-RVZ-4: 빈 목록은 안내다. 빈 상자를 보여 주지 않는다.
      const empty = runDiv('runs-empty');
      empty.appendChild(runDiv('runs-empty-t', RUN_EMPTY_TEXT));
      empty.appendChild(runDiv('runs-empty-h', RUN_EMPTY_HINT));
      box.appendChild(empty);
    }
    for (const rv of rows) box.appendChild(this._runsRow(rv));
    ov.appendChild(box);
  },

  _runsRow(rv) {
    const members = rv.members || [];
    const headless = members.filter(m => m.headless).length;
    const row = runDiv('runs-row');
    row.dataset.runid = rv.id;
    row.title = '클릭하면 현재 분할 칸의 새 탭에 대시보드가 열린다';

    row.appendChild(runDiv('runs-short', rv.short || String(rv.id || '').slice(0, 8)));
    row.appendChild(runDiv('runs-obj', rv.objective || ''));

    const st = runDiv('runs-state st-' + (rv.state || ''), rv.state || '');
    row.appendChild(st);

    row.appendChild(runDiv('runs-members',
      headless ? `${members.length}명(${headless} 헤드리스)` : `${members.length}명`));

    // FR-RVZ-3: 격리가 none 이면 표시하지 않는다 — 없는 것이 기본값이므로
    // 적어 두면 목록에서 눈에 띄는 것이 전부 같아진다.
    if (rv.isolation && rv.isolation !== 'none') row.appendChild(runDiv('runs-iso', rv.isolation));

    // FR-RVZ-3 / V-RVZ-6: 컨텍스트 경고. critical 이 하나라도 있으면 그것이 이긴다.
    // 빈 contextLevel 은 "모른다" 이므로 배지를 달지 않는다 (FR-CBG-5).
    const lv = members.some(m => m.contextLevel === 'critical') ? 'critical'
      : members.some(m => m.contextLevel === 'warn') ? 'warn' : '';
    if (lv) row.appendChild(runDiv('runs-ctx lv-' + lv, '⚠ ' + lv));

    const ago = this._runAgo(rv.createdAt);
    row.appendChild(runDiv('runs-ago', ago ? ago + ' 전' : ''));

    // FR-DEL-6: 실패는 그 행에 남는다. 삭제 목표보다 앞에 두어 오른쪽 끝이
    // 흔들리지 않는다 (FR-BGK-10 과 같은 자리).
    if (this._runsDelErr && this._runsDelErr.runId === rv.id) {
      row.appendChild(runDiv('runs-err-inline', this._runsDelErr.msg));
    }
    const pending = this._runsPending === rv.id;
    const confirming = this._runsConfirm === rv.id;
    if (pending) row.appendChild(runDiv('runs-deleting', '삭제 중…'));
    else if (confirming) row.appendChild(this._runsConfirmEl(rv));
    else row.appendChild(this._runsDelBtn(rv));

    // FR-RVZ-5: 모달이 닫히고, 현재 포커스 분할 칸에 새 탭이 생긴다.
    row.addEventListener('click', () => {
      if (this._runsPending) return;
      // FR-DEL-3·4: 확인이 열려 있으면 행을 건드리는 것은 **취소일 뿐**이다.
      if (this._runsConfirm) { this._runsConfirmSet(null); return }
      this._runsModalToggle(false);
      this.app.addTab(this.app.focused, 'run', { runId: rv.id, short: rv.short });
    });
    return row;
  },

  // FR-DEL-1·2: 항상 보인다 (터치에 hover 가 없다). 행 클릭으로 새지 않는다.
  _runsDelBtn(rv) {
    const btn = document.createElement('button');
    btn.className = 'tbtn runs-del'; btn.textContent = '삭제';
    btn.title = `Run ${rv.short || ''} 을 목록과 기록에서 지운다`;
    btn.dataset.runid = rv.id;
    btn.addEventListener('click', e => { e.stopPropagation(); this._runsConfirmSet(rv.id) });
    return btn;
  },

  // FR-DEL-4: 확인은 행 안에서 한다 — 모달 위의 모달은 Escape 처리와 포커스
  // 관리를 복잡하게 만든다 (FR-BGK-4 와 같은 판단).
  _runsConfirmEl(rv) {
    const wrap = runDiv('runs-confirm');
    // 삭제는 되돌릴 수 없다 (FR-DEL-7). 무엇이 함께 사라지는지 적는다.
    const open = rv.state === 'open';
    wrap.appendChild(runDiv('runs-q', open
      ? '삭제? 진행 중인 Run 이며 기록도 함께 사라진다.'
      : '삭제? 기록이 사라진다.'));
    const yes = document.createElement('button');
    yes.className = 'tbtn runs-yes'; yes.textContent = '예';
    yes.addEventListener('click', e => { e.stopPropagation(); this._runsDelete(rv.id) });
    const no = document.createElement('button');
    no.className = 'tbtn runs-no'; no.textContent = '아니오';
    no.addEventListener('click', e => { e.stopPropagation(); this._runsConfirmSet(null) });
    wrap.appendChild(yes); wrap.appendChild(no);
    return wrap;
  },

  // FR-DEL-3: 확인은 한 번에 하나다. 다른 행의 삭제를 누르면 앞의 확인은 취소된다.
  _runsConfirmSet(runId) {
    this._runsConfirm = runId || null;
    this._runsDelErr = null;
    this._runsModalRender();
  },

  // FR-DEL-5: DELETE /api/runs/{id}. 성공하면 목록만 다시 받는다 — 모달은 열린
  // 채로 남고, 빈 목록 안내는 그 갱신이 따라온다.
  async _runsDelete(runId) {
    this._runsConfirm = null; this._runsDelErr = null; this._runsPending = runId;
    this._runsModalRender();
    let ok = false, msg = '';
    try {
      const r = await fetch('/api/runs/' + encodeURIComponent(runId), { method: 'DELETE' });
      ok = r.ok;
      if (!ok) msg = (await r.text()).trim() || `삭제 실패 (${r.status})`;
    } catch { msg = '삭제 실패 — 서버에 닿지 못했다' }
    this._runsPending = null;
    if (!ok) this._runsDelErr = { runId, msg };
    else await this._runsRefresh();
    // 응답을 기다리는 사이에 모달이 닫혔을 수 있다 — 그때 그리면 되살아난다.
    if (this._runsModalOpen) this._runsModalRender();
  },

  // ── 탭 (FR-RVZ-6~9) ──

  // FR-RVZ-7: 같은 Run 의 탭 찾기. app-layout.js 의 _findEditorTab 과 같은 모양이며,
  // addTab 의 run 분기가 이것을 부른다. app-runs.js 는 app-layout.js 뒤에 로드되므로
  // 호출 시점에는 이미 프로토타입에 있다.
  _findRunTab(runId) {
    for (const s of this.app.ws.windows) {
      if (!s || !s.layout) continue;
      let result = null;
      const walk = n => {
        if (!n || result) return;
        if (n.type === 'pane' && n.tabs) {
          for (const t of n.tabs) {
            if (t.type === 'run' && t.runId === runId) { result = { tab: t, pane: n, win: s }; return }
          }
        }
        if (n.type === 'split' && n.children) for (const c of n.children) walk(c);
      };
      walk(s.layout);
      if (result) return result;
    }
    return null;
  },

  // 지금 워크스페이스에 살아 있는 run 탭의 id 집합. 캐시(_runViews)를 이것에
  // 맞춰 걷어낸다 — closeTab 은 이 파일이 소유하지 않으므로 정리를 그쪽에
  // 심지 않고 여기서 스스로 맞춘다.
  _runLiveTabIds() {
    const live = new Set();
    const walk = n => {
      if (!n) return;
      for (const t of n.tabs || []) if (t.type === 'run') live.add(t.id);
      for (const c of n.children || []) walk(c);
    };
    for (const s of this.app.ws.windows) walk(s && s.layout);
    return live;
  },

  // `_slotKey(탭 id, 칸)` → 대시보드 뷰. 뷰는 **탭보다 오래 살지 않는다**.
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
  // FR-SRV-3: 칸 0 의 키는 탭 id **그대로**다 (`_slotKey`, FR-WSL-75) — 단일 슬롯
  // 모드의 동작은 한 글자도 바뀌지 않는다.
  _runViewEl(tab, slot) {
    const m = this._runViewMap();
    const key = this.app._slotKey(tab.id, slot || 0);
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
    requestAnimationFrame(() => this._runFitGraph(v.root));
    return v.root;
  },

  _runBuildRoot() {
    const root = runDiv('run-view');
    root.appendChild(runDiv('run-miss'));
    const body = runDiv('run-body');
    body.appendChild(runDiv('run-summary'));
    const wrap = runDiv('run-graph-wrap');
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
    try {
      const r = await fetch('/api/runs/' + encodeURIComponent(v.runId) + '/graph');
      if (r.status === 404) err = 'gone';
      else if (!r.ok) err = (await r.text()).trim() || `대시보드를 받지 못했다 (${r.status})`;
      else data = await r.json();
    } catch { err = '대시보드를 받지 못했다 — 서버에 닿지 못했다' }
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
    const m = this._runViewMap();
    if (!m.size) return;
    const live = this._runLiveTabIds();
    // FR-SRV-4.2: 키는 복합키다 — 살아 있는 탭 판정은 `_slotBase` 로 한다.
    // 편집기가 이 자리에서 정확히 같은 실수를 냈다 (FR-SVS-60): `@1` 만 잘라
    // 내던 동안 칸 2·3 의 뷰는 살아 있는 탭인데도 매번 파괴됐다.
    // FR-SRV-5: 같은 runId 를 보는 **모든 칸**의 뷰를 갱신한다.
    for (const [key, v] of Array.from(m)) {
      if (!live.has(this.app._slotBase(key))) { this._runDisposeView(v); m.delete(key); continue }
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
    if (v.decay) { clearTimeout(v.decay); v.decay = null }
  },

  // ── 대시보드 (FR-RVZ-10~13) ──

  _runPaint(v) {
    const miss = v.root.querySelector('.run-miss');
    const body = v.root.querySelector('.run-body');
    // FR-RVZ-9: 사라진 Run 은 그렇게 말하고 만다. 탭은 자동으로 닫지 않는다 —
    // 사용자가 만든 것은 사용자가 닫는다.
    const gone = v.err === 'gone';
    const failed = !!v.err && !gone;
    const note = gone ? RUN_GONE_TEXT : failed ? v.err : '';
    paintIfChanged(miss, note, () => { miss.textContent = note });
    miss.classList.toggle('vis', !!note);
    miss.classList.toggle('err', failed);
    body.classList.toggle('vis', !note && !!v.data);
    if (note || !v.data) return;

    const d = v.data;
    const members = d.members || [];
    const pos = this._runLayout(members.length);
    this._runPaintSummary(v.root, d, members);
    this._runPaintGraph(v.root, d, members, pos);
    this._runPaintCards(v.root, d, members);
    this._runPaintTimeline(v.root, d);
    this._runScheduleDecay(v, d);
  },

  // "최근 30초" 는 시각의 함수이므로 마지막 이벤트만으로는 꺼지지 않는다.
  // 만료 시점에 **다시 그리기만** 예약한다 — 요청은 나가지 않으므로 폴링이
  // 아니다 (V-RVZ-4 는 요청 건수를 센다).
  _runScheduleDecay(v, d) {
    if (v.decay) { clearTimeout(v.decay); v.decay = null }
    const now = Date.now() / 1000;
    let soonest = Infinity;
    for (const e of d.edges || []) {
      // 경계가 닫힌 구간(<=)이므로 left === 0 도 아직 강조 중이다 — 여기서
      // 빠뜨리면 그 엣지의 강조를 꺼 줄 사람이 아무도 없다.
      const left = RUN_RECENT_SEC - (now - (e.lastAt || 0));
      if (left >= 0 && left < soonest) soonest = left;
    }
    if (soonest === Infinity) return;
    v.decay = setTimeout(() => {
      v.decay = null;
      if (this._runViewMap().get(v.key) === v) this._runPaint(v);
    }, Math.ceil(soonest * 1000) + 50);
  },

  // FR-RVZ-10: 요약. 도해의 `패턴` 행은 그리지 않는다 — Run 레코드에 패턴 필드가
  // 없고, 시각화에만 있는 정보를 만들지 않는다 (NFR-RVZ-4, SRS §3.5.3 판정).
  _runPaintSummary(root, d, members) {
    const el = root.querySelector('.run-summary');
    const headless = members.filter(m => m.headless).length;
    const parts = [
      ['short', 'Run ' + (d.short || String(d.runId || '').slice(0, 8))],
      ['obj', d.objective ? '목적: ' + d.objective : ''],
      ['state', 'state=' + (d.state || '')],
      ['iso', 'isolation=' + (d.isolation || 'none')],
      ['ago', '경과 ' + this._runAgo(d.createdAt)],
      ['members', headless ? `멤버 ${members.length} (헤드리스 ${headless})` : `멤버 ${members.length}`],
    ].filter(p => p[1]);
    paintIfChanged(el, parts.map(p => p[1]).join('|'), () => {
      el.innerHTML = '';
      for (const [cls, text] of parts) el.appendChild(runDiv('run-sum-' + cls, text));
    });
  },

  // FR-RVZ-11: 계층형 고정 배치. 조정자가 최상단, 멤버는 그 아래 한 줄에 균등.
  // 멤버 수만으로 결정되므로 같은 Run 은 볼 때마다 같은 자리에 온다.
  _runLayout(n) {
    const w = Math.max(RUN_MIN_W, n * (RUN_NODE_W + 30) + 60);
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(Math.round(w * (i + 1) / (n + 1)));
    // 멤버가 없으면 멤버 줄도 그 아래 호 자리도 필요 없다 — 빈 띠를 남기면
    // 대시보드가 덜 그려진 것처럼 보인다.
    const h = n ? RUN_ROW_Y + RUN_NODE_H + 76 : RUN_COORD_Y + RUN_NODE_H + 16;
    return { w, h, cx: Math.round(w / 2), xs };
  },

  _runPaintGraph(root, d, members, pos) {
    const svg = root.querySelector('.run-graph');
    // FR-FIT-5: viewBox 는 배치 좌표 그대로다 — 같은 Run 은 어디서 봐도 같은
    // 모양이며, 맞춤은 **표시 크기**만 건드린다.
    svg.setAttribute('viewBox', `0 0 ${pos.w} ${pos.h}`);
    svg.dataset.w = pos.w;
    svg.dataset.h = pos.h;
    this._runFitGraph(root);
    this._runDefs(svg);

    const at = new Map(); // 노드 id → 중심 x
    at.set(RUN_COORD, pos.cx);
    members.forEach((m, i) => at.set(m.id, pos.xs[i]));

    this._runPaintEdges(root, d, members, at);
    this._runPaintNodes(root, d, members, at);
  },

  /**
   * FR-FIT-1~4: 그래프를 감싼 칸의 폭에 맞춘다.
   *
   * 배율은 [RUN_FIT_MIN, RUN_FIT_MAX] 로 잘린다 — 좁으면 줄이되 읽을 수 있는
   * 데까지만(그 아래는 가로 스크롤), 넓으면 키우되 표지가 되지 않을 만큼만.
   *
   * 폭을 재는 대상은 wrap 이며, 그 값이 0 이면(아직 붙지 않은 DOM) 아무것도
   * 하지 않는다 — 0 으로 나눈 배율은 그래프를 사라지게 한다.
   */
  _runFitGraph(root) {
    const wrap = root.querySelector('.run-graph-wrap');
    const svg = root.querySelector('.run-graph');
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
  },

  // FR-FIT-6: 분할 칸이 바뀌면 다시 맞춘다. 폴링하지 않는다 — 크기 변화는
  // 관측 가능한 사건이며, 대시보드가 그것을 물어볼 이유가 없다.
  _runObserveFit(v) {
    if (v.ro || typeof ResizeObserver === 'undefined') return;
    const wrap = v.root.querySelector('.run-graph-wrap');
    if (!wrap) return;
    v.ro = new ResizeObserver(() => this._runFitGraph(v.root));
    v.ro.observe(wrap);
  },

  // 화살촉. 색은 CSS 가 채운다 — 마커 안에서는 테마 변수를 클래스로만 만난다.
  // id 는 문서 전역이므로 이 svg 에서만 쓰는 접미사를 붙인다 (여러 분할 칸이
  // 각자 Run 탭을 띄울 수 있다).
  _runDefs(svg) {
    const defs = svg.querySelector('defs');
    if (defs.childElementCount) return;
    if (!this._runDefsSeq) this._runDefsSeq = 0;
    const sfx = 'r' + (++this._runDefsSeq);
    svg.dataset.mk = sfx;
    for (const kind of ['msg', 'recent', 'succ']) {
      const mk = runSvg('marker', {
        id: 'rm-' + sfx + '-' + kind, class: 'run-mk run-mk-' + kind,
        viewBox: '0 0 8 8', refX: '7', refY: '4',
        markerWidth: '6', markerHeight: '6', orient: 'auto',
      });
      mk.appendChild(runSvg('path', { d: 'M0,0 L8,4 L0,8 z' }));
      defs.appendChild(mk);
    }
  },

  // FR-RVZ-12: 메시지 흐름 = 굵기(로그 스케일) + 방향 화살표 + 최근 30초 강조.
  // 승계는 그와 별개의 굵은 화살표다 (V-RVZ-7).
  _runPaintEdges(root, d, members, at) {
    const g = root.querySelector('.run-edges');
    const sfx = root.querySelector('.run-graph').dataset.mk;
    const now = Date.now() / 1000;
    const rowIdx = new Map(); members.forEach((m, i) => rowIdx.set(m.id, i));
    const items = [];

    for (const e of d.edges || []) {
      // 끝점이 이 Run 의 멤버가 아닐 수 있다 — 팀 간 통신이면 다른 Run 의 멤버
      // uuid 가 온다. 무명 노드를 세우지 않고 건너뛴다: 이 화면은 **이 Run 의**
      // 관계도이며, 이름도 상태도 모르는 상자를 세우면 그것이 더 큰 거짓이다.
      if (!at.has(e.from) || !at.has(e.to)) continue;
      const recent = (now - (e.lastAt || 0)) <= RUN_RECENT_SEC;
      items.push({ kind: 'msg', from: e.from, to: e.to, count: e.count || 0, recent });
    }
    // 승계 관계는 멤버 레코드에서 온다 — 메시지가 아니므로 엣지 목록에 없다.
    for (const m of members) {
      if (m.succeededFrom && at.has(m.succeededFrom)) items.push({ kind: 'succ', from: m.succeededFrom, to: m.id });
    }

    reconcileList(g, items, {
      key: it => it.kind + ':' + it.from + '>' + it.to,
      sig: it => it.kind + ':' + it.count + ':' + (it.recent ? 1 : 0) + ':' + at.get(it.from) + ':' + at.get(it.to),
      build: it => this._runEdgeEl(it, at, rowIdx, sfx),
    });
  },

  _runEdgeEl(it, at, rowIdx, sfx) {
    const x1 = at.get(it.from), x2 = at.get(it.to);
    const cls = ['run-edge', 'run-edge-' + it.kind];
    if (it.recent) cls.push('recent');
    let d, mk;
    if (it.kind === 'succ') {
      // 승계는 멤버 줄 **위쪽** 호다. 메시지 호(아래쪽)와 자리가 겹치지 않아야
      // 굵기만으로 구분하지 않아도 읽힌다.
      d = `M${x1},${RUN_ROW_Y} Q${(x1 + x2) / 2},${RUN_ROW_Y - 46} ${x2},${RUN_ROW_Y}`;
      mk = 'succ';
    } else if (it.from === RUN_COORD || it.to === RUN_COORD) {
      // 조정자와의 통신은 직선이다. 두 방향이 같은 선 위에 겹치지 않도록
      // 방향마다 조금 어긋나게 둔다.
      const off = it.from === RUN_COORD ? -5 : 5;
      const mx = it.from === RUN_COORD ? x2 : x1;
      d = it.from === RUN_COORD
        ? `M${at.get(RUN_COORD) + off},${RUN_COORD_Y + RUN_NODE_H} L${mx + off},${RUN_ROW_Y}`
        : `M${mx + off},${RUN_ROW_Y} L${at.get(RUN_COORD) + off},${RUN_COORD_Y + RUN_NODE_H}`;
      mk = it.recent ? 'recent' : 'msg';
    } else {
      // 멤버끼리는 호다. 떨어진 만큼 더 깊게 내려 서로 포개지지 않게 한다.
      const gap = Math.abs((rowIdx.get(it.from) || 0) - (rowIdx.get(it.to) || 0));
      const dip = RUN_ROW_Y + RUN_NODE_H + 24 + gap * 14;
      d = `M${x1},${RUN_ROW_Y + RUN_NODE_H} Q${(x1 + x2) / 2},${dip} ${x2},${RUN_ROW_Y + RUN_NODE_H}`;
      mk = it.recent ? 'recent' : 'msg';
    }
    const p = runSvg('path', { class: cls.join(' '), d, 'marker-end': `url(#rm-${sfx}-${mk})` });
    if (it.kind !== 'succ') {
      // 굵기 = 건수의 로그 스케일. 선형이면 한 쌍이 나머지를 전부 눌러 버린다.
      // 상한은 승계 화살표(CSS 5)보다 낮게 둔다 — 겹치면 "굵은 화살표"가
      // 승계를 가리키는지 수다스러운 한 쌍을 가리키는지 알 수 없게 된다.
      p.setAttribute('stroke-width', String(Math.min(4, 1 + 0.6 * Math.log2(1 + it.count))));
      // count 는 **보관된 메시지** 기준이다 — Run 당 최근 500건 상한(FR-RVZ-14)에
      // 걸려 잘려 나간 건은 빠진다. "총 통신 횟수" 로 읽히면 안 된다.
      const t = runSvg('title');
      t.textContent = `보관된 메시지 ${it.count}건`;
      p.appendChild(t);
    }
    return p;
  },

  // FR-RVZ-12: 상태=테두리 색, 헤드리스=점선, 컨텍스트=하단 게이지.
  _runPaintNodes(root, d, members, at) {
    const g = root.querySelector('.run-nodes');
    const items = [{ id: RUN_COORD, role: '조정자', agent: '', state: '', coord: true }];
    for (const m of members) items.push(m);
    reconcileList(g, items, {
      key: it => it.id,
      sig: it => [it.coord ? 'c' : 'm', it.role, it.agent, it.state, it.headless ? 1 : 0,
        it.contextLevel || '', Math.round((it.contextRatio || 0) * 100), at.get(it.id)].join(':'),
      build: it => this._runNodeEl(it, at.get(it.id)),
    });
  },

  _runNodeEl(m, cx) {
    const y = m.coord ? RUN_COORD_Y : RUN_ROW_Y;
    const x = cx - RUN_NODE_W / 2;
    const cls = ['run-node'];
    if (m.coord) cls.push('coord'); else cls.push('state-' + (m.state || 'starting'));
    // V-RVZ-5: 헤드리스는 점선 테두리다. 상태가 succeeded 일 때도 점선이지만
    // 클래스가 다르므로 둘을 섞어 세지 않는다.
    if (m.headless) cls.push('headless');
    const g = runSvg('g', { class: cls.join(' ') });
    g.dataset.node = m.id;

    const t = runSvg('title');
    t.textContent = m.coord ? '조정자'
      : [m.role, m.agent, m.state, m.headless ? '헤드리스' : ''].filter(Boolean).join(' · ');
    g.appendChild(t);

    g.appendChild(runSvg('rect', {
      class: 'run-node-box', x, y, width: RUN_NODE_W, height: RUN_NODE_H, rx: 5,
    }));
    const role = runSvg('text', { class: 'run-node-role', x: cx, y: y + 21, 'text-anchor': 'middle' });
    role.textContent = m.role || (m.coord ? '조정자' : '(역할 없음)');
    g.appendChild(role);
    const sub = runSvg('text', { class: 'run-node-sub', x: cx, y: y + 36, 'text-anchor': 'middle' });
    sub.textContent = m.coord ? '' : [m.agent, m.state].filter(Boolean).join(' · ');
    g.appendChild(sub);

    // V-RVZ-6: 컨텍스트 게이지. contextLevel 이 비면 "모른다" 이므로 그리지
    // 않는다 — ok 로 칠하면 없는 관측을 있다고 말하는 것이 된다 (FR-CBG-5).
    if (!m.coord && m.contextLevel) {
      const gw = RUN_NODE_W - 16;
      g.appendChild(runSvg('rect', {
        class: 'run-gauge-bg', x: x + 8, y: y + RUN_NODE_H - 9, width: gw, height: 4, rx: 2,
      }));
      g.appendChild(runSvg('rect', {
        class: 'run-gauge lv-' + m.contextLevel, x: x + 8, y: y + RUN_NODE_H - 9,
        width: Math.max(2, Math.round(gw * Math.min(1, m.contextRatio || 0))), height: 4, rx: 2,
      }));
    }
    return g;
  },

  // FR-RVZ-10: 멤버 카드. FR-RVZ-13: 클릭하면 그 멤버의 도구로 포커스가 점프한다.
  _runPaintCards(root, d, members) {
    const el = root.querySelector('.run-cards');
    reconcileList(el, members, {
      key: m => m.id,
      sig: m => [m.role, m.agent, m.state, m.headless ? 1 : 0, m.contextLevel || '',
        Math.round((m.contextRatio || 0) * 100), m.compactCount || 0,
        (m.worktree && m.worktree.branch) || '', m.succeededBy || ''].join(':'),
      build: m => this._runCardEl(m),
    });
  },

  _runCardEl(m) {
    const card = runDiv('run-card state-' + (m.state || 'starting'));
    card.dataset.member = m.id;
    if (m.headless) card.classList.add('headless');
    card.appendChild(runDiv('run-card-role', '[' + (m.role || '역할 없음') + ']'));
    if (m.agent) card.appendChild(runDiv('run-card-agent', m.agent));
    card.appendChild(runDiv('run-card-state', m.state || ''));
    if (m.contextLevel) {
      const pct = Math.round((m.contextRatio || 0) * 100);
      const warn = m.contextLevel === 'ok' ? '' : ' ⚠';
      card.appendChild(runDiv('run-card-ctx lv-' + m.contextLevel, `ctx ~${pct}%${warn}`));
    }
    if (m.compactCount) card.appendChild(runDiv('run-card-compact', `compact ${m.compactCount}회`));
    if (m.worktree && m.worktree.branch) card.appendChild(runDiv('run-card-wt', 'wt: ' + m.worktree.branch));
    if (m.headless) card.appendChild(runDiv('run-card-headless', '(헤드리스)'));
    card.title = m.headless
      ? '클릭하면 현재 분할 칸의 새 탭으로 부착한다'
      : '클릭하면 이 멤버의 도구로 이동한다';
    card.addEventListener('click', () => this._runJumpToMember(m));
    return card;
  },

  // FR-RVZ-13: 이미 탭이 있으면 그리로 간다. 없으면(헤드리스) 부착이며,
  // 그 결과는 `run attach` 와 같다 — 서버가 restoreTool 을 방송하고 브라우저가
  // 현재 포커스 분할 칸에 새 탭을 만든다 (FR-HLM-6).
  async _runJumpToMember(m) {
    if (!m || !m.id) return;
    if (m.toolId && this.app._findToolLocation(m.toolId)) { this.app._jumpToTool(m.toolId); return }
    try {
      // location 을 비워 둔다 — 그래야 지금 포커스된 분할 칸이 대상이 된다.
      const r = await fetch('/api/runs/attach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: m.id }),
      });
      if (!r.ok) console.warn('[run] attach 실패', r.status, (await r.text()).trim());
    } catch (e) { console.warn('[run] attach 실패', e) }
  },

  // FR-RVZ-10: 타임라인. 서버가 준 순서를 그대로 쓴다 — 사건의 순서는 서버의 사실이다.
  _runPaintTimeline(root, d) {
    const el = root.querySelector('.run-timeline');
    const items = d.timeline || [];
    reconcileList(el, items, {
      key: it => (it.at || 0) + ':' + (it.kind || '') + ':' + (it.memberId || ''),
      sig: it => (it.kind || '') + ':' + (it.text || ''),
      build: it => {
        const row = runDiv('run-tl-row');
        row.appendChild(runDiv('run-tl-at', this._runClock(it.at)));
        row.appendChild(runDiv('run-tl-kind k-' + (it.kind || ''), it.kind || ''));
        row.appendChild(runDiv('run-tl-text', it.text || ''));
        return row;
      },
    });
  },

  // ── 표기 ──

  // 서버 시각은 Unix **초**다 (run/store.go 의 now()).
  _runAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return s + '초';
    if (s < 3600) return Math.floor(s / 60) + '분';
    if (s < 86400) return Math.floor(s / 3600) + '시간';
    return Math.floor(s / 86400) + '일';
  },

  _runClock(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  },
});

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 (repaint.js 와 같은 규약).
window.RunsPanel = RunsPanel;
