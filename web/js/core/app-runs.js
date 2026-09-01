// Run 시각화의 진입점 — 본체는 `js/ui/runs-panel.js` 의 `RunsPanel` 이다
// (APP_STATE_EXTRACT_SRS 묶음 A).
//
// 여기 남은 것은 **바깥이 부르는 이름 여섯**뿐이다. 이름을 지키는 이유는 호출부를
// 바꾸지 않기 위해서다 — `app.js`·`app-layout.js`·`renderer.js`·`app-cmd.js`·
// `app-slots.js` 와 e2e 셋이 이 이름들을 쓴다.
//
// 로드 순서 계약: app.js **뒤**, `runs-panel.js` 뒤.

Object.assign(App.prototype, {

  // Run 을 한 번도 열지 않은 브라우저는 만들지 않는다 (`_gitObs` 와 같은 규약).
  _runsPanel() {
    if (!this._runs) this._runs = new RunsPanel(this);
    return this._runs;
  },

  _runsModalToggle(open) { return this._runsPanel()._runsModalToggle(open) },
  _findRunTab(runId) { return this._runsPanel()._findRunTab(runId) },
  _runViewEl(tab, slot) { return this._runsPanel()._runViewEl(tab, slot) },
  _runDisposeView(v) { return this._runsPanel()._runDisposeView(v) },
  _onRunChanged(args) { return this._runsPanel()._onRunChanged(args) },
  _runPaint(v) { return this._runsPanel()._runPaint(v) },

});


// FR-RVZ-1: 진입점은 정적 요소다 — index.html 의 <script> 는 본문 뒤에 오므로
// 이 스크립트가 평가되는 시점에 이미 DOM 에 있다. 리스너를 여기서 한 번만
// 붙이고, App 인스턴스(main.js 가 만든다)는 핸들러 안에서 본다.
(function () {
  const btn = document.getElementById('runs-btn');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (window.app) window.app._runsModalToggle();
  });
})();
