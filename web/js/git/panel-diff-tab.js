/**
 * GitPanel — **Diff 탭 전용 패널**의 몫 (UX_BATCH12_SRS §3.5f FR-RTB-7·9·13).
 *
 * Diff 탭은 탭마다 패널을 하나 갖는다(`app.gitDiffPanelFor`). 그 패널은 `diffTabId`
 * 를 들고, 대상은 탭 레코드(`tab.diffTarget`)가 정한다 — 이 파일은 그 대상을 패널의
 * 자리(`previewFile`·`commitFile`)로 옮기는 일과 편집 계기를 탭에 알리는 일이다.
 */
Object.assign(GitPanel.prototype, {
  // 탭의 대상을 패널에 싣는다. 같은 대상이면 아무것도 하지 않는다 — 렌더마다 불린다.
  diffTabApply(dt){
    const key=dt?this.app.diffTabKey(dt):'';
    if(this._dtKey===key) return;
    this._dtKey=key;
    const f=dt?{...dt,repo:this.repo}:null;
    this.commitFile=(f&&f.commit)?f:null;
    this.previewFile=(f&&!f.commit)?f:null;
    const i=this._diffIndex(this._fileList());
    if(i>=0) this._diffPos=i;
    if(this._els.get('diff')) this._paint();
  },

  // FR-RTB-6 ④: 이 Diff 에서 친 수정이면 탭을 고정한다. 문서의 dirty 는 같은 파일의
  // 편집기 탭에서 쳐도 오므로, 포커스가 이 Diff 안에 있을 때만 이 탭의 계기로 센다.
  _diffTabEdited(v){
    const el=this._diffView&&this._diffView.el;
    if(v&&el&&el.contains(document.activeElement)) this.app.gitDiffTabPin(this.diffTabId);
  },
});
