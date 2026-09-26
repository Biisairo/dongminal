// 코드 탐색의 진입점 — 본체는 `lsp-client.js`·`lsp-paths.js` 의 `LspClient` 다
// (APP_STATE_EXTRACT_SRS FR-ASE-7 · §2.3a).
//
// 여기 남은 것은 **바깥이 부르는 이름**뿐이다: 형제 `app-*.js`(설정·명령·편집기)와
// `ui/file-editor.js`·`ui/diff-view.js`, 그리고 e2e 계약(`app-testing.js`)이 쓴다.
//
// 로드 순서 계약: app.js **뒤**, `lsp-client.js`·`lsp-paths.js` 뒤.

Object.assign(App.prototype, {

  // 코드 탐색을 한 번도 쓰지 않은 브라우저는 만들지 않는다 (`_runsPanel` 과 같은 규약).
  _lspClient() {
    if (!this._lsp) this._lsp = new LspClient(this);
    return this._lsp;
  },

  _initLSP() { return this._lspClient()._initLSP() },
  _lspRefresh() { return this._lspClient()._lspRefresh() },
  _lspGotoDef() { return this._lspClient()._lspGotoDef() },
  _lspFindRefs() { return this._lspClient()._lspFindRefs() },
  _lspNavBack() { return this._lspClient()._lspNavBack() },
  _lspCanBack() { return this._lspClient()._lspCanBack() },
  _lspOnDiagnostics(d) { return this._lspClient()._lspOnDiagnostics(d) },
  _lspRootOfPath(path) { return this._lspClient()._lspRootOfPath(path) },
  lspClickDef(view, position) { return this._lspClient().lspClickDef(view, position) },
  lspDocClosed(path) { return this._lspClient().lspDocClosed(path) },
  lspClearDiagnostics(model) { return this._lspClient().lspClearDiagnostics(model) },
  lspHoverRegister() { return this._lspClient().lspHoverRegister() },
  lspOfferFor(view) { return this._lspClient().lspOfferFor(view) },
  lspOfferInstall(id, view) { return this._lspClient().lspOfferInstall(id, view) },
  lspDismiss(id) { return this._lspClient().lspDismiss(id) },

});

// e2e 계약이 읽는 필드 둘 (§2.3a A-4·A-5). `Object.assign` 에 게터를 넣으면 그 자리에서
// 값으로 복사되므로 `defineProperty` 로 단다. 읽기는 `LspClient` 를 만들지 않는다.
for (const name of ['_lspHoverLangs', '_lspDefLangs']) {
  Object.defineProperty(App.prototype, name, {
    get() { return this._lsp ? this._lsp[name] : undefined },
    set(v) { this._lspClient()[name] = v },
    configurable: true,
  });
}
