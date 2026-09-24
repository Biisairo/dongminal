/**
 * 코드 탐색: 언어 서버 실행 파일 경로 — 서버가 보관하는 표의 편집
 * (REPO_FIX 02 §3A-3 · FR-LSP-4b 개정)
 *
 * 표는 서버 한 벌이다(`<dataDir>/lsp-paths.json`). 모든 브라우저가 같은 값을 보고,
 * 상태 조회와 세션 기동이 같은 표로 해석한다. 이 파일은 설정 ▸ Code 의 서버 행마다
 * 경로 입력 한 칸과 저장·지우기를 둔다.
 *
 *   이전 동작: 경로는 기기별 localStorage 에서 읽혀 상태 조회에만 실렸고 기동은 무시했다
 *   새  동작: 서버 표를 여기서 편집한다. 옛 localStorage 값은 버린다
 *   이유:     실행 파일은 서버 기계의 사실이고 세션은 서버에서 공유된다
 */
Object.assign(App.prototype, {

  // 패널이 열릴 때마다 읽는다 — 방송 없음, 상태는 관측이다 (FR-LSP-47).
  async _lspPathsLoad(){
    const r=await apiGet(LSP_PATHS_API);
    this._lspPathMap=(r.ok&&r.data&&r.data.paths)||{};
  },

  // 팩 한 줄 아래의 서버별 경로 칸. 키는 `팩/서버` 다.
  _lspPathRows(pack,srvs){
    const map=this._lspPathMap||{};
    return '<div class="lsp-paths">'+srvs.map(s=>{
      const key=(s.pack||pack)+'/'+s.id;
      return '<div class="lsp-pathrow" data-key="'+escHtml(key)+'">'+
        '<span class="lsp-pathid">'+escHtml(s.id)+'</span>'+
        '<input class="ui-input lsp-pathin" spellcheck="false" placeholder="'+escHtml(LSP_PATH_PH)+'" value="'+escHtml(map[key]||'')+'">'+
        '<button class="ui-btn ui-btn-sm lsp-pathsave" title="'+escHtml(LSP_PATH_SAVE_TITLE)+'">'+escHtml(LSP_PATH_SAVE)+'</button>'+
        '<button class="ui-btn ui-btn-sm lsp-pathclear" title="'+escHtml(LSP_PATH_CLEAR_TITLE)+'">'+escHtml(LSP_PATH_CLEAR)+'</button>'+
      '</div>';
    }).join('')+'</div>';
  },

  _lspPathsBind(list){
    for(const row of list.querySelectorAll('.lsp-pathrow')){
      const inp=row.querySelector('.lsp-pathin');
      row.querySelector('.lsp-pathsave').addEventListener('click',()=>this._lspPathPut(row,inp.value.trim()));
      row.querySelector('.lsp-pathclear').addEventListener('click',()=>this._lspPathPut(row,''));
    }
  },

  // 표 전체를 보낸다(PUT 은 전체 교체). 성공하면 상태를 다시 읽어 "어디서 찾았는지"
  // 를 갱신하고, 실패하면 서버 사유를 그 행의 안내 자리에 둔다.
  async _lspPathPut(row,value){
    const key=row.dataset.key;
    const next=Object.assign({},this._lspPathMap||{});
    if(value) next[key]=value; else delete next[key];
    const r=await apiPut(LSP_PATHS_API,{paths:next});
    const msg=row.closest('.lsp-row')&&row.closest('.lsp-row').querySelector('.lsp-msg');
    if(!r.ok){
      if(msg) msg.textContent=(r.data&&r.data.error)||LSP_STATUS_FAIL;
      return;
    }
    this._lspPathMap=(r.data&&r.data.paths)||next;
    this._lspStatusInvalidate();
    await this._lspRefresh();
  },
});
