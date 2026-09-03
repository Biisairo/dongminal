/**
 * Remote Terminal — 코드 탐색: 언어 서버의 관측과 받기
 * (EDITOR_LSP_SRS 묶음 A · M1)
 *
 * 이 파일이 아는 것은 **상태와 버튼**뿐이다. 정의로 이동·참조 찾기·호버·진단은
 * M2 이후의 것이며, 그것들이 설 바닥이 여기다 — 서버가 있는지 없는지를 사용자가
 * 볼 수 있어야 비로소 "왜 F12 가 아무 일도 안 하는가" 를 설명할 수 있다 (D-9).
 */
Object.assign(App.prototype, {

  _initLSP(){
    const hint=document.getElementById('lsp-hint');
    if(hint) hint.textContent=LSP_PANEL_HINT;
  },

  /**
   * FR-LSP-4b: 설정에 적은 절대경로 표를 실어 보낸다.
   *
   * 서버가 설정 블롭을 해석하지 않으므로(PAGE_TITLE_SRS §2.2) 이 길이 유일하다.
   * M1 에서 이 표는 비어 있다 — 그것을 편집하는 자리는 M5 의 것이다.
   */
  _lspOverrides(){ return lspServerPaths||{} },

  /**
   * FR-LSP-47: 상태는 캐시가 아니라 **관측**이다. 패널을 열 때마다 다시 읽는 이유가
   * 그것이다 — 사용자가 바깥에서 지운 서버를 우리가 있다고 우기면 안 된다.
   */
  async _lspRefresh(){
    const list=document.getElementById('lsp-list');
    if(!list) return;
    let r=null,d=null;
    try{
      r=await fetch(LSP_STATUS_API,{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({overrides:this._lspOverrides()})});
    }catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(!r||!d||!Array.isArray(d.servers)){
      // 503 은 배선이 없는 서버다 — 고장이 아니라 그 서버의 성질이므로 다르게 말한다.
      list.innerHTML='<div class="lsp-empty">'+
        escHtml(r&&r.status===503?LSP_UNAVAILABLE:LSP_STATUS_FAIL)+'</div>';
      return;
    }
    this._lspPaint(d.servers);
  },

  _lspPaint(servers){
    const list=document.getElementById('lsp-list');
    if(!list) return;
    list.innerHTML=servers.map(s=>{
      // FR-LSP-5: 있음이면 **어디서 찾았는지**까지 말한다. 그것이 "왜 저 서버가
      // 쓰이는가" 의 답이다.
      let state;
      if(s.found) state=LSP_FOUND+' · '+(LSP_ORIGIN_LABEL[s.origin]||s.origin||'');
      else if(s.installer&&!s.canInstall) state=LSP_MISSING+' · '+LSP_NO_TOOL.replace('%s',s.installer);
      else state=LSP_MISSING;

      const btn=s.installing
        ? '<button class="lsp-install" data-id="'+escHtml(s.id)+'" disabled>'+LSP_INSTALLING+'</button>'
        // 이미 있는 서버에도 버튼을 두지 않는다 — M1 에서 다시 받을 이유가 없고,
        // 그 자리는 갱신(M5)의 것이다.
        : (s.found ? ''
          : '<button class="lsp-install" data-id="'+escHtml(s.id)+'"'+
            (s.canInstall?'':' disabled')+'>'+LSP_INSTALL+'</button>');

      return '<div class="lsp-row" data-id="'+escHtml(s.id)+'" data-found="'+(!!s.found)+'">'+
        '<div class="lsp-head">'+
          '<span class="lsp-name">'+escHtml((s.langs||[]).join(' · '))+'</span>'+
          '<span class="lsp-id">'+escHtml(s.id)+'</span>'+
        '</div>'+
        '<div class="lsp-state">'+escHtml(state)+'</div>'+
        '<div class="lsp-path">'+escHtml(s.exe||'')+'</div>'+
        '<div class="lsp-act">'+btn+'</div>'+
        '<div class="lsp-msg"></div>'+
      '</div>';
    }).join('');
    for(const b of list.querySelectorAll('.lsp-install')){
      b.addEventListener('click',()=>this._lspInstall(b.dataset.id));
    }
  },

  /**
   * FR-LSP-8·10: 사용자가 눌러야 받는다. 그리고 **결과가 그 자리에 남는다** —
   * 조용히 실패하면 사용자는 우리 버그로 읽는다.
   *
   * FR-LSP-48 의 판정은 서버가 한다. 여기서 버튼을 비활성으로 바꾸는 것은 이 화면의
   * 편의일 뿐이고, 다른 탭·다른 기기에서 누른 두 번째 설치는 서버가 거절한다.
   */
  async _lspInstall(id){
    const row=document.querySelector('.lsp-row[data-id="'+id+'"]');
    const btn=row&&row.querySelector('.lsp-install');
    const msg=row&&row.querySelector('.lsp-msg');
    if(btn){btn.disabled=true;btn.textContent=LSP_INSTALLING}
    if(msg) msg.textContent='';
    let r=null,d=null;
    try{
      r=await fetch(LSP_INSTALL_API,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    }catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(msg){
      if(d&&d.ok) msg.textContent=LSP_INSTALL_OK;
      // 사유는 서버가 사람의 말로 적어 보낸다 (FR-LSP-11) — 화면이 다시 쓰지 않는다.
      else msg.textContent=(d&&d.reason)||LSP_STATUS_FAIL;
      if(d&&d.detail) msg.title=d.detail;
    }
    // 성공이든 실패든 다시 관측한다 — 화면이 자기 짐작으로 상태를 고치지 않는다.
    await this._lspRefresh();
  },
});
