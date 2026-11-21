/**
 * TerminalSection — Settings ▸ Terminal (REFACTOR3_FE_SETTINGS_SRS 8a). 키바 구성(`#ds-keybar`)은 8d 에서 온다.
 *
 * `Claude Code 를 fullscreen 으로`(AGENT_RENDER_ENV_SRS FR-ARE-3)와 스크롤 속도(FR-ARE-10·11)는 **쓰는 주체가
 * 서버**다 — 도구를 띄울 때 환경에 넣는다. 화면은 값을 들고 저장할 뿐이고, 이미 떠 있는 터미널은 바뀌지 않는다.
 * migration 넷(ISSUE_TREE_OPS_SRS FR-ITM-1·2)도 서버가 훅 판정과 트리 프리앰블에 쓴다. 일반 훅과 issue-tree 는 따로다.
 */
class TerminalSection extends SettingsSection {
  constructor(app){ super(app,'terminal') }

  init(){
    this.bindRows([
      {key:'claudeFullscreen',id:'ds-claudefs',kind:'check'},
      // FONT_SIZE_SETTING_SRS FR-FSS-11·12: 터미널만 움직인다.
      {key:'termFontSize',id:'ds-termfs',kind:'number'},
      {key:'claudeScrollSpeed',id:'ds-scrollspeed',kind:'number'},
      {key:'migrationHook',id:'ds-mighook',kind:'check'},
      {key:'migrationHookCtxPct',id:'ds-mighookpct',kind:'number'},
      {key:'issueTreeMigration',id:'ds-treemig',kind:'check'},
      {key:'issueTreeCtxPct',id:'ds-treemigpct',kind:'number'},
    ]);
    this.paint();
    this._initTermGpu();
  }

  /** TERMINAL_GPU_RENDER_SRS FR-TGR-14·15: 기기별 값이다 — 서버 설정 블롭에 싣지 않는다. */
  _initTermGpu(){
    const cb=document.getElementById('ds-termgpu');
    if(!cb) return;
    cb.checked=TermGpu.enabled();
    this.listen(cb,'change',()=>TermGpu.setEnabled(cb.checked,this.app));
  }
}
