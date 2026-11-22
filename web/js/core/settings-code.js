/**
 * CodeSection — Settings ▸ Code (REFACTOR3_FE_SETTINGS_SRS 8a).
 *
 * 줄 바꿈(WORKBENCH_REVIEW_SRS FR-WBR-10·11)과 미니맵(EDITOR_MINIMAP_TOGGLE_SRS FR-MMT-1·4)은 **이미 열려 있는
 * 편집기에도 곧바로 얹는다** — 새로 여는 탭부터 듣게 하면 사용자는 설정이 고장난 것으로 읽는다. 얹는 것은 set 이
 * 한다(`_edApplyWordWrap`·`_edApplyMinimap`). 언어 서버(EDITOR_LSP_SRS 묶음 A)의 상태와 받기는 `LspClient` 의 일이고,
 * 이 섹션은 그 안내문과 진단 토글만 배선한다.
 */
class CodeSection extends SettingsSection {
  constructor(app){ super(app,'code') }

  init(){
    this.bindRows([
      {key:'editorWordWrap',id:'ds-wordwrap',kind:'check'},
      {key:'editorMinimap',id:'ds-minimap',kind:'check'},
    ]);
    this.paint();
    this._initLsp();
  }

  /**
   * FR-LSP-47: 언어 서버의 상태는 캐시가 아니라 관측이다 — 탭을 고를 때마다 다시 읽는다. 진단 토글은 기기별
   * 값이라 다른 탭에서 바뀔 일이 없지만, 고를 때마다 다시 칠하는 것이 이 모달의 규약이다 (FR-LVC-3).
   */
  onTab(){
    this.app.lspClient()._lspRefresh();
    const dcb=document.getElementById('lsp-diag');
    if(dcb) dcb.checked=lspDiagOn;
  }

  // FR-LSP-36: 진단 토글. 라벨과 안내문도 상수에서 온다 — 화면에 문장을 박아 두면 그 문장이 두 자리에 살게 된다.
  _initLsp(){
    const hint=document.getElementById('lsp-hint');
    if(hint) hint.textContent=LSP_PANEL_HINT;
    const lab=document.getElementById('lsp-diag-label');
    if(lab) lab.textContent=LSP_DIAG_LABEL;
    const dh=document.getElementById('lsp-diag-hint');
    if(dh) dh.textContent=LSP_DIAG_HINT;
    const cb=document.getElementById('lsp-diag');
    if(cb){
      cb.checked=lspDiagOn;
      this.listen(cb,'change',()=>this.app.lspClient()._lspSetDiag(cb.checked));
    }
  }
}
