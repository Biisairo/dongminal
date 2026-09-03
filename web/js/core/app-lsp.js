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

  // ── 정의·참조 이동 (묶음 C·F · M2) ──
  //
  // **Monaco 의 peek 을 쓰지 않는다** (§2.11 / D-8b). 그것은 다른 파일로 갈 때
  // 우리 탭 시스템을 모르고, 갈아 끼우려면 문서화되지 않은 내부 서비스에 의존해야
  // 한다. 그리고 그렇게 얻을 것을 우리는 이미 갖고 있다 — 파일을 탭으로 열고 그
  // 줄로 가는 길(`_edOpenFile`)과, 자리 목록의 껍데기(찾기 패널)다.

  /**
   * 지금 물을 자리. 활성 편집기의 **커서 위치와 현재 텍스트**다 (D-3).
   *
   * 텍스트를 함께 싣는 것이 이 기능의 핵심이다 — 저장 전 편집은 브라우저에만
   * 있으므로 디스크만 보는 서버는 방금 쓴 함수를 모른다.
   */
  _lspWhere(){
    const v=this._edActiveEditor();
    const ed=v&&v._editor;
    if(!ed) return null;
    const root=this._edSearchRoot();
    if(!root) return null;
    const pos=ed.getPosition();
    const model=ed.getModel();
    if(!pos||!model) return null;
    return {
      view:v, root,
      path:v.filePath,
      text:model.getValue(),
      // 편집기와 우리 종단은 둘 다 1 부터 센다 — 여기서 셈법을 바꾸지 않는다.
      line:pos.lineNumber, col:pos.column,
    };
  },

  async _lspGotoDef(){ await this._lspJump('def') },
  async _lspFindRefs(){ await this._lspJump('refs') },

  /**
   * FR-LSP-21·22·25·28: 물어서 옮긴다.
   *
   * 하나면 그 자리로, 여럿이면 목록으로 고르게 한다. **답하지 못한 이유는 알림
   * 줄에 남는다** (D-9) — 침묵은 고장과 구별되지 않는다.
   */
  async _lspJump(kind){
    const at=this._lspWhere();
    if(!at) return;
    at.view.note(LSP_ASKING, 1500);
    const body={root:at.root,path:at.path,text:at.text,line:at.line,col:at.col};
    if(kind==='refs') body.includeDeclaration=false;
    let r=null,d=null;
    try{
      r=await fetch(kind==='refs'?LSP_REFS_API:LSP_DEF_API,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    }catch{r=null}
    if(r&&r.ok){try{d=await r.json()}catch{d=null}}
    if(!r||!d){at.view.note(LSP_ASK_FAIL);return}
    // 서버가 사유를 적어 보냈으면 그것을 그대로 보인다 — 화면이 다시 쓰지 않는다.
    if(d.reason){at.view.note(d.reason);return}
    const locs=d.locations||[];
    if(!locs.length){at.view.note(kind==='refs'?LSP_NO_REFS:LSP_NO_DEF);return}
    if(locs.length===1&&kind!=='refs'){
      this._lspGo(at,locs[0]);
      return;
    }
    this._lspList(at,locs,kind==='refs'?'refs':'defs');
  },

  /**
   * FR-LSP-26·27: 한 자리로 옮긴다.
   *
   * 지금 자리를 **먼저 스택에 넣는다** — 넣지 않으면 뛴 뒤에 돌아올 수 없고, 그러면
   * 그 이동은 길을 잃는 일이 된다.
   *
   * 다른 파일이면 탭으로 열린다. 그 경로는 `_edOpenFile` 이 이미 알고 있으며 조상
   * 폴더를 탐색기에서 펼치는 일까지 한다 (FR-EKB-6).
   */
  _lspGo(at,loc){
    this._lspPush(at);
    this._edOpenFile(loc.path,{line:loc.line,col:loc.col});
  },

  // FR-LSP-25: 여럿이면 고르게 한다. 껍데기는 전체 검색과 같은 것이다 — 사용자가
  // 이미 아는 조작(↑↓·Enter)이 그대로다.
  _lspList(at,locs,mode){
    const p=this._edPanel(mode,at.root);
    // 패널의 pick 은 `root + '/' + item.path` 로 절대경로를 만든다. 그 규약에
    // 맞추려면 우리가 상대경로를 넣어야 한다 — 규약을 바꾸면 grep 이 깨진다.
    p._items=locs.map(l=>({
      path:this._lspRel(at.root,l.path),
      line:l.line, col:l.col,
      text:'',
    }));
    p._sel=0;
    // 여기서 자리를 담는다 — 목록에서 무엇을 고르든 돌아올 곳은 지금 이 자리다.
    this._lspPush(at);
    this._edPanelPaint(p,{});
    const note=p.querySelector('.ed-find-note');
    if(note) note.textContent=(mode==='refs'?LSP_REFS_HINT:LSP_DEFS_HINT)
      .replace('%s',String(locs.length));
  },

  _lspRel(root,abs){
    const r=String(root).replace(/\/+$/,'')+'/';
    return String(abs).startsWith(r)?String(abs).slice(r.length):String(abs);
  },

  // ── 뒤로 가기 (FR-LSP-27) ──

  _lspPush(at){
    this._lspBack=this._lspBack||[];
    this._lspBack.push({path:at.path,line:at.line,col:at.col});
    // 무한히 쌓으면 그 자체가 새는 자리가 된다.
    if(this._lspBack.length>LSP_BACK_MAX) this._lspBack.shift();
  },

  _lspCanBack(){ return !!(this._lspBack&&this._lspBack.length) },

  /**
   * FR-LSP-27: 뛴 자리에서 돌아온다.
   *
   * 갈 자리가 없으면 **키를 삼키지 않는다** — 그 판정은 `_edKeyGate` 가 이미 했다.
   * 여기 오는 것은 갈 자리가 있는 경우뿐이지만, 다른 진입점(설정의 액션 실행)도
   * 이것을 부르므로 한 번 더 본다.
   */
  _lspNavBack(){
    const v=this._edActiveEditor();
    if(!this._lspCanBack()){
      if(v) v.note(LSP_NO_BACK);
      return;
    }
    const to=this._lspBack.pop();
    this._edOpenFile(to.path,{line:to.line,col:to.col});
  },
});
