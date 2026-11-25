/**
 * Run 탭의 뷰 — 세우기·받기·구독·거두기 (`RunsPanel.prototype` 증강, FR-RVZ-6~16).
 *
 * `run` 화면 묶음의 맨 앞이다 (PERF M3 §3.4, D-30). 목록·뷰 레지스트리·SSE 계기는 부팅의 `runs-panel.js` 에 남고,
 * 뷰가 있어야 도는 것은 여기와 뒤의 증강 파일에 있다. 뷰는 묶음이 실린 뒤에만 생긴다 — 렌더러가
 * `Screens.forTab` 으로 기다린 뒤 `runViewEl` 을 부른다.
 *
 * 로드 순서: `runs-panel.js` **뒤**.
 */

Object.assign(RunsPanel.prototype, {
  // renderer._mountTabBody 가 부른다. 루트 DOM 은 **탭과 칸의 쌍마다** 하나이며
  // 재사용된다 — pane 을 다시 그려도 SVG 가 새로 만들어지지 않는다 (NFR-RVZ-2).
  //
  // FR-SRV-3: 칸 0 의 키는 탭 id **그대로**다 (`slotKey`, FR-WSL-75) — 단일 슬롯
  // 모드의 동작은 한 글자도 바뀌지 않는다.
  runViewEl(tab, slot) {
    const m = this._runViewMap();
    const key = this.app.slot.slotKey(tab.id, slot || 0);
    let v = m.get(key);
    if (!v) { v = { key, tabId: tab.id, slot: slot || 0, runId: tab.runId, root: this._runBuildRoot(), data: null, err: null, busy: false, pending: false }; this._runLifeArm(v); m.set(key, v) }
    // 워크스페이스 복원이 같은 탭 id 에 다른 runId 를 실어 올 수 있다.
    if (v.runId !== tab.runId) { v.runId = tab.runId; v.data = null; v.err = null }
    this._runSubscribe(v);
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
    const root = domEl('div', 'run-view ui-scroll');
    root.appendChild(domEl('div', 'run-miss'));
    const body = domEl('div', 'run-body');
    body.appendChild(domEl('div', 'run-summary'));
    // ISSUE_AGENT_TREE_SRS FR-ITD-1: 트리 표지가 있는 Run 이면 「이슈 트리」 가 여기 선다.
    body.appendChild(domEl('div', 'run-tree'));
    const wrap = domEl('div', 'run-graph-wrap ui-scroll');
    const svg = svgEl('svg', { class: 'run-graph' });
    svg.appendChild(svgEl('defs'));
    svg.appendChild(svgEl('g', { class: 'run-edges' }));
    svg.appendChild(svgEl('g', { class: 'run-nodes' }));
    wrap.appendChild(svg);
    body.appendChild(wrap);
    body.appendChild(domEl('div', 'run-cards'));
    body.appendChild(domEl('div', 'run-timeline'));
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
    // FR-ITD-5: 트리 Run 이면 같은 트리의 열린 노드를 함께 받는다. 실패해도 대시보드는 그린다.
    let tree = null;
    if (data && data.tree) {
      const tr = await apiGet(RUNS_TREE_API + '?ref=' + encodeURIComponent(data.tree));
      if (tr.ok) tree = tr.data;
    }
    v.busy = false;
    if (err) v.err = err; else { v.data = data; v.tree = tree; v.err = null }
    this._runPaint(v);
    // 응답을 기다리는 사이에 도착한 SSE 는 버리지 않는다 — 버리면 화면이
    // 한 세대 뒤에서 멈추고, 폴링이 없으므로 아무도 고치지 않는다.
    if (v.pending && this._runViewMap().has(v.key)) this._runFetch(v);
  },


  /**
   * PERF M1 C3 TC-CH3-11: 열린 화면은 `run:<id>` 를 구독한다. 서버가 그 Run 이 바뀔 수 있는
   * 계기(사용률·멤버 생존 포함)마다 그래프를 다시 민다 — 안전망 주기가 없다.
   */
  _runSubscribe(v) {
    const ch = this.app && this.app.channel;
    if (!ch || v.subRun === v.runId) return;
    if (v.sub) v.sub.stop();
    v.subRun = v.runId;
    v.sub = ch.sub('run:' + v.runId, (m) => this._runOnGraph(v, m), { owner: this });
  },

  async _runOnGraph(v, m) {
    if (!m || m.kind !== 'full' || !this._runViewMap().has(v.key)) return;
    if (m.data === null) { v.err = 'gone'; this._runPaint(v); return }
    let tree = null;
    if (m.data.tree) {
      const tr = await apiGet(RUNS_TREE_API + '?ref=' + encodeURIComponent(m.data.tree));
      if (tr.ok) tree = tr.data;
    }
    v.data = m.data; v.tree = tree; v.err = null;
    this._runPaint(v);
  },

  // 탭이 사라진 뷰의 뒷정리. 관측자와 예약된 다시 그리기를 함께 끊는다 —
  // 둘 다 탭보다 오래 살면 안 된다.
  _runDisposeView(v) {
    if (!v) return;
    this.app.renderer.life.unmount(v);
    if (v.sub) { v.sub.stop(); v.sub = null; v.subRun = null }
    if (v.ro) { try { v.ro.disconnect() } catch {} v.ro = null }
    if (v.decay) { TIMERS.cancel(v.decay); v.decay = null }
  },
});
