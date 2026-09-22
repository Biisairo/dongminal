// Run 시각화의 진입점 — 본체는 `js/ui/runs-panel.js` 의 `RunsPanel` 이다
// (APP_STATE_EXTRACT_SRS 묶음 A).
//
// 여기 남은 것은 **바깥이 부르는 이름 여섯**뿐이다. 이름을 지키는 이유는 호출부를
// 바꾸지 않기 위해서다 — `app.js`·`app-layout.js`·`renderer.js`·`app-cmd.js`·
// `app-slots.js` 와 e2e 셋이 이 이름들을 쓴다.
//
// 로드 순서 계약: app.js **뒤**, `runs-panel.js` 뒤.

Object.assign(App.prototype, {

  // Run 을 한 번도 열지 않은 브라우저는 만들지 않는다 (`gitObs` 와 같은 규약).
  _runsPanel() {
    if (!this._runs) this._runs = new RunsPanel(this);
    return this._runs;
  },

  _runsModalToggle(open) { return this._runsPanel()._runsModalToggle(open) },
  _findRunTab(runId) { return this._runsPanel()._findRunTab(runId) },
  runViewEl(tab, slot) { return this._runsPanel().runViewEl(tab, slot) },
  _runDisposeView(v) { return this._runsPanel()._runDisposeView(v) },
  _onRunChanged(args) { return this._runsPanel()._onRunChanged(args) },
  _runPaint(v) { return this._runsPanel()._runPaint(v) },

});


// UIUX_OVERHAUL_SRS FR-CHR-15 (D-7): **`#runs-btn` 이 없어졌다.** 이 진입점은
// `Background`·`Agents` 와 같은 패널을 열고 있었고, 셋은 `Activity` 하나가 됐다.
// Run 구역으로 직행하는 길은 `Ctrl+Shift+O` 가 갖는다 (PANEL_SHORTCUTS_SRS
// FR-PSC-2). `_runsModalToggle` 의 이름과 나머지 호출처 다섯은 그대로다.
