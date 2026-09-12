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
    // FR-LSP-36: 진단 토글. 라벨과 안내문도 상수에서 온다 — 화면에 문장을
    // 박아 두면 그 문장이 두 자리에 살게 된다.
    const lab=document.getElementById('lsp-diag-label');
    if(lab) lab.textContent=LSP_DIAG_LABEL;
    const dh=document.getElementById('lsp-diag-hint');
    if(dh) dh.textContent=LSP_DIAG_HINT;
    const cb=document.getElementById('lsp-diag');
    if(cb){
      cb.checked=lspDiagOn;
      cb.addEventListener('change',()=>this._lspSetDiag(cb.checked));
    }
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
    const r=await apiPost(LSP_STATUS_API,{overrides:this._lspOverrides()});
    const d=r.ok?r.data:null;
    if(!d||!Array.isArray(d.servers)){
      // 503 은 배선이 없는 서버다 — 고장이 아니라 그 서버의 성질이므로 다르게 말한다.
      list.innerHTML='<div class="lsp-empty">'+
        escHtml(r.status===503?LSP_UNAVAILABLE:LSP_STATUS_FAIL)+'</div>';
      return;
    }
    this._lspPaint(d.servers);
    // FR-EXT-8: 읽지 못한 선언이 있으면 그 사실이 보여야 한다.
    if(Array.isArray(d.problems)&&d.problems.length){
      const box=document.createElement('div');
      box.className='lsp-empty';
      box.textContent=LSP_DECL_PROBLEM+': '+d.problems.join(' / ');
      list.appendChild(box);
    }
  },

  /**
   * FR-EXT-5·28·29: **팩이 줄이고 서버가 그 아래다.**
   *
   * 조달의 단위가 팩이므로 버튼도 팩마다 하나다 — 서버 다섯을 내는 패키지를 서버마다
   * 받으면 같은 것을 다섯 번 받는다. 그리고 PATH 에서 찾은 것은 **격리되지 않았음**을
   * 함께 말한다: 사용자가 자기 것을 쓰는 것은 정당하지만 그 사실이 조용하면
   * "격리했다" 는 말이 거짓이 된다.
   */
  _lspPaint(servers){
    const list=document.getElementById('lsp-list');
    if(!list) return;
    const packs=new Map();
    for(const s of servers){
      const k=s.pack||s.id;
      if(!packs.has(k)) packs.set(k,[]);
      packs.get(k).push(s);
    }
    const rows=[];
    for(const [pack,srvs] of packs){
      const found=srvs.filter(x=>x.found).length;
      const head=srvs[0]||{};
      // 어디서 찾았는지는 선 것들의 것이다 — 하나도 없으면 말할 것이 없다.
      const origin=(srvs.find(x=>x.found)||{}).origin;

      let state;
      if(found===srvs.length&&found>0){
        state=LSP_FOUND+' · '+(LSP_ORIGIN_LABEL[origin]||origin||'');
        if(origin&&origin!=='managed') state+=' · '+LSP_NOT_ISOLATED;
      }else if(found>0){
        state=LSP_PARTIAL+' ('+found+'/'+srvs.length+')';
      }else{
        state=LSP_MISSING+(head.note?' · '+head.note:'');
      }

      const done=found===srvs.length&&found>0;
      const btn=head.installing
        ? '<button class="lsp-install" title="'+escHtml(LSP_INSTALL_TITLE)+'" data-id="'+escHtml(pack)+'" disabled>'+LSP_INSTALLING+'</button>'
        : (done ? ''
          : '<button class="lsp-install" title="'+escHtml(LSP_INSTALL_TITLE)+'" data-id="'+escHtml(pack)+'"'+
            (head.canInstall?'':' disabled')+'>'+LSP_INSTALL+'</button>');

      // 이 팩이 덮는 언어들. 서버가 준 표를 그대로 쓴다 (FR-EXT-1) — 화면이 따로
      // 적으면 선언과 어긋난다.
      const langs=[];
      for(const x of srvs) for(const l of (x.langs||[])) if(!langs.includes(l)) langs.push(l);

      rows.push('<div class="lsp-row" data-id="'+escHtml(pack)+'" data-found="'+done+'">'+
        '<div class="lsp-head">'+
          '<span class="lsp-name">'+escHtml(langs.join(' · '))+'</span>'+
          '<span class="lsp-id">'+escHtml(pack)+'</span>'+
        '</div>'+
        '<div class="lsp-state">'+escHtml(state)+'</div>'+
        '<div class="lsp-path">'+escHtml((srvs.find(x=>x.found)||{}).exe||'')+'</div>'+
        '<div class="lsp-act">'+btn+'</div>'+
        '<div class="lsp-msg"></div>'+
      '</div>');
    }
    list.innerHTML=rows.join('');
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
    const r=await apiPost(LSP_INSTALL_API,{id});
    const d=r.ok?r.data:null;
    if(msg){
      if(d&&d.ok) msg.textContent=LSP_INSTALL_OK;
      // 사유는 서버가 사람의 말로 적어 보낸다 (FR-LSP-11) — 화면이 다시 쓰지 않는다.
      else msg.textContent=(d&&d.reason)||LSP_STATUS_FAIL;
      if(d&&d.detail) msg.title=d.detail;
    }
    // 성공이든 실패든 다시 관측한다 — 화면이 자기 짐작으로 상태를 고치지 않는다.
    this._lspStatusInvalidate();
    await this._lspRefresh();
  },

  // ── 정의·참조 이동 (묶음 C·F · M2) ──
  //
  // **`F12` 경로는 우리가 그린다** (D-8b·D-8c). 알림 줄의 사유와 목록 껍데기가
  // 여기 있고, 그것이 Monaco 의 peek 이 주지 않는 것이다.
  //
  // 커맨드클릭은 다르다 — 링크 밑줄을 Monaco 만 그릴 수 있으므로 그쪽은 provider
  // 로 간다 (`_lspProvideDef`, FR-LSP-60~65). 두 벌 구현이 아니라 **같은 종단의
  // 두 계기**이며, 다른 파일로 가는 일은 `registerEditorOpener` 가 이 파일의
  // `edOpenFile` 로 되돌린다 (§2.11c 가 그 기각을 되짚었다).

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

  /**
   * FR-LSP-60·67 (U-1): 커맨드클릭이 닿는 자리. **`F12` 와 같은 경로다.**
   *
   * 클릭이 커서를 이미 그 자리에 놓지만 명시로 한 번 더 맞춘다 — `_lspJump` 는
   * 커서를 읽으므로(`_lspWhere`), 그 사이에 다른 것이 커서를 옮기면 엉뚱한
   * 심볼을 묻게 된다.
   */
  async lspClickDef(view,position){
    const ed=view&&view._editor;
    if(!ed||!position) return;
    ed.setPosition(position);
    await this._lspJump('def');
  },
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
    const r=await apiPost(kind==='refs'?LSP_REFS_API:LSP_DEF_API,body);
    const d=r.ok?r.data:null;
    if(!d){at.view.note(LSP_ASK_FAIL);return}
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
   * 다른 파일이면 탭으로 열린다. 그 경로는 `edOpenFile` 이 이미 알고 있으며 조상
   * 폴더를 탐색기에서 펼치는 일까지 한다 (FR-EKB-6).
   */
  _lspGo(at,loc){
    this._lspPush(at);
    this.edOpenFile(loc.path,{line:loc.line,col:loc.col});
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

  // 구분자를 `/` 로 굳히지 않는다 — Windows 에서는 어떤 절대경로도 그 접두로
  // 시작하지 않아 **상대화가 통째로 실패한다**(그러면 패널이 절대경로를 상대인
  // 척 들고 있다가 `pathJoin` 에서 루트를 두 번 이은 경로를 만든다).
  _lspRel(root,abs){
    return pathUnder(root,abs)?pathRel(root,abs):String(abs);
  },

  // ── 호버 (묶음 D · M3) ──
  //
  // **여기서는 Monaco 의 provider 를 쓴다** (D-8). 말풍선은 같은 파일 안의 일이므로
  // 탭 시스템을 알 필요가 없다 — 정의 이동과 갈리는 자리가 그것이다 (§2.11).

  /**
   * FR-LSP-39: provider 는 **언어마다 한 번** 등록된다. 편집기를 여럿 세워도 등록이
   * 늘지 않아야 한다 — 늘면 같은 호버가 여러 번 뜬다.
   *
   * Monaco 가 뜬 뒤에 불려야 하므로 `FileEditor` 가 편집기를 세운 직후에 부른다.
   * 두 번째부터는 아무 일도 하지 않는다.
   */
  async lspHoverRegister(){
    if(typeof monaco==='undefined'||!monaco.languages) return;
    // 언어 목록은 **선언에서 온다** (FR-EXT-1). 화면이 표를 따로 갖고 있으면
    // 언어를 더할 때 한쪽만 고쳐져 그 언어에서 호버가 붙지 않는다.
    const list=await this._lspStatusCached();
    if(!list) return;
    if(!this._lspHoverLangs) this._lspHoverLangs=new Set();
    if(!this._lspDefLangs) this._lspDefLangs=new Set();
    // FR-LSP-63: 다른 파일로 가는 일은 **우리 탭 시스템**의 것이다. 등록은 앱에
    // 한 번이며 언어와 무관하다.
    this._lspOpenerRegister();
    for(const s of list){
      for(const lang of (s.langs||[])){
        // FR-LSP-39: 언어마다 한 번이다 — 늘면 같은 호버가 여러 번 뜬다.
        if(!this._lspHoverLangs.has(lang)){
          this._lspHoverLangs.add(lang);
          monaco.languages.registerHoverProvider(lang,{
            provideHover:(model,position,token)=>this._lspHover(model,position,token),
          });
        }
        // FR-LSP-60·62 (U-1): 커맨드클릭으로 정의로 간다. **같은 규약·같은 자리**다
        // — 표를 두 벌로 두면 언어를 더할 때 한쪽만 고쳐진다.
        if(!this._lspDefLangs.has(lang)){
          this._lspDefLangs.add(lang);
          monaco.languages.registerDefinitionProvider(lang,{
            provideDefinition:(model,position,token)=>this._lspProvideDef(model,position,token),
          });
        }
      }
    }
  },

  /**
   * FR-LSP-60·61·65 (U-1): 커맨드클릭이 딛는 속.
   *
   * **새 종단도 새 상태도 만들지 않는다** — `F12` 가 쓰는 그 종단이다. 다른 것은
   * 계기와 그림뿐이다: 링크 밑줄·peek 은 Monaco 만 그릴 수 있고, 알림 줄과 목록
   * 껍데기는 `F12` 경로의 것이다 (D-8c).
   *
   * 답하지 못하면 **조용하다.** 마우스가 지나갈 때마다 "서버가 없습니다" 가 뜨면
   * 그것이 곧 고장이며, 호버가 같은 이유로 이미 그렇게 정했다 (FR-LSP-65).
   */
  async _lspProvideDef(model,position,token){
    const at=this._lspHoverWhere(model,position);
    if(!at) return null;
    const ctl=new AbortController();
    if(token&&token.onCancellationRequested) token.onCancellationRequested(()=>ctl.abort());
    const r=await apiPost(LSP_DEF_API,
      {root:at.root,path:at.path,text:at.text,
        line:position.lineNumber,col:position.column},
      {signal:ctl.signal});
    const d=r.ok?r.data:null;
    const locs=(d&&d.locations)||[];
    if(!locs.length) return null;
    // 좌표는 양쪽이 1 부터다 — 여기서 셈법을 바꾸지 않는다 (Location 의 주석).
    if(!this._lspUriPath) this._lspUriPath=new Map();
    return locs.map(l=>{
      const uri=monaco.Uri.file(l.path);
      // **되돌릴 짝을 기억한다.** uri 에서 경로를 다시 만들지 않는 이유는 실측이다 —
      // 이 판의 `uri.fsPath` 는 POSIX 기계에서도 역슬래시 경로를 냈고(`\private\tmp\…`),
      // 그 경로는 어느 탭과도 견줄 수 없다. 우리가 만든 uri 이므로 그 짝을 아는
      // 쪽이 우리다.
      this._lspUriPath.set(String(uri),l.path);
      return {
        uri,
        range:{startLineNumber:l.line,startColumn:l.col,
          endLineNumber:l.line,endColumn:l.col},
      };
    });
  },

  /**
   * FR-LSP-63·64 (U-1): Monaco 가 "다른 파일을 열어라" 고 할 때 우리 탭으로 연다.
   *
   * §2.11 은 이 자리를 "문서화되지 않은 내부 서비스" 라고 적고 provider 경로를
   * 기각했다. **그 문장은 낡았다** — `monaco.editor.registerEditorOpener` 는
   * `monaco.editor` 표면의 공개 함수다 (§2.11c). 없는 판에서는 등록만 건너뛰고
   * 같은 파일 안의 이동은 그대로 된다.
   *
   *   같은 파일이면 `false` — Monaco 가 스스로 한다(그쪽이 선택·접힘을 안다).
   *   다른 파일이면 우리가 열고 `true` — 그 길이 조상 펼치기까지 한다 (FR-EKB-6).
   */
  _lspOpenerRegister(){
    if(this._lspOpener) return;
    if(typeof monaco==='undefined'||!monaco.editor||!monaco.editor.registerEditorOpener) return;
    this._lspOpener=true;
    monaco.editor.registerEditorOpener({
      openCodeEditor:(source,resource,selectionOrPosition)=>{
        const path=this._lspUriPathOf(resource);
        if(!path) return false;
        const v=this._edActiveEditor();
        // 같은 파일 안의 이동은 Monaco 의 것이다.
        if(v&&v.filePath===path) return false;
        const sel=selectionOrPosition||{};
        const line=sel.startLineNumber||sel.lineNumber||1;
        const col=sel.startColumn||sel.column||1;
        // FR-LSP-64: 계기가 둘이어도 돌아오는 길은 하나다 — 여기서도 쌓는다.
        const at=this._lspWhere();
        if(at) this._lspPush(at);
        this.edOpenFile(path,{line,col});
        return true;
      },
    });
  },

  /**
   * uri 에서 파일 경로를 되돌린다.
   *
   * **기억한 짝을 먼저 본다** (`_lspProvideDef` 가 넣는다). `uri.fsPath` 로 되돌리는
   * 길은 실측에서 틀렸다 — 이 판은 POSIX 기계에서도 `\private\tmp\…` 를 냈고 그
   * 경로는 어느 탭과도 견줄 수 없다.
   *
   * 짝이 없으면(우리가 만들지 않은 uri) 열려 있는 편집기에서 찾고, 그것도 없으면
   * `path` 를 쓴다 — Windows 의 `/C:/…` 는 앞의 `/` 를 뗀다.
   */
  _lspUriPathOf(uri){
    if(!uri) return '';
    const key=String(uri);
    const known=this._lspUriPath&&this._lspUriPath.get(key);
    if(known) return known;
    for(const ed of this.fileEditors.values()){
      if(!ed||!ed.filePath) continue;
      if(String(monaco.Uri.file(ed.filePath))===key) return ed.filePath;
    }
    const p=String(uri.path||'');
    return /^\/[A-Za-z]:/.test(p)?p.slice(1):p;
  },

  /**
   * FR-LSP-29·31: 그 자리 심볼의 타입·문서.
   *
   * Monaco 가 **언제 물을지를 정한다** — 마우스가 멈춘 뒤에 부르고, 그 사이 다른
   * 자리로 옮기면 앞선 요청의 토큰을 취소한다. 우리는 그 취소를 `fetch` 에 이어
   * 붙이기만 한다: 잇지 않으면 취소된 요청이 서버에서 계속 돌아 언어 서버를
   * 헛되게 바쁘게 한다.
   */
  async _lspHover(model,position,token){
    const at=this._lspHoverWhere(model,position);
    if(!at) return null;
    const ctl=new AbortController();
    if(token&&token.onCancellationRequested) token.onCancellationRequested(()=>ctl.abort());
    const r=await apiPost(LSP_HOVER_API,
      {root:at.root,path:at.path,text:at.text,
        line:position.lineNumber,col:position.column},
      {signal:ctl.signal});
    const d=r.ok?r.data:null;
    // 호버가 비는 것은 **흔한 일이다** — 빈 자리에 마우스를 얹으면 그렇다. 그래서
    // 여기서는 사유를 알림 줄로 띄우지 않는다: 마우스를 움직일 때마다 "서버가
    // 없습니다" 가 뜨면 그것이 곧 고장이다. 그 사실은 F12 를 눌렀을 때 말한다.
    if(!d||!d.markdown) return null;
    return {contents:[{value:d.markdown}]};
  },

  /**
   * 이 모델이 어느 Editor 창의 어느 파일인가.
   *
   * `_lspWhere` 를 쓸 수 없는 이유는 호버가 **활성 편집기가 아닐 수도 있는** 모델에
   * 대해 불리기 때문이다 (분할 칸 둘 중 마우스가 놓인 쪽). 모델의 uri 로 그 파일을
   * 찾아 그 파일이 속한 루트를 정한다.
   */
  _lspHoverWhere(model,position){
    if(!model||!position) return null;
    const path=this._lspPathOfModel(model);
    if(!path) return null;
    const root=this._lspRootOfPath(path);
    if(!root) return null;
    return {root,path,text:model.getValue()};
  },

  // 모델의 uri 에서 파일 경로를 되돌린다. 모델은 `edDoc` 이 파일마다 하나로
  // 만들므로 그 규약을 그대로 딛는다.
  _lspPathOfModel(model){
    const v=this._edActiveEditor();
    if(v&&v._editor&&v._editor.getModel()===model) return v.filePath;
    // 활성 편집기의 것이 아니면 열려 있는 편집기들에서 찾는다.
    for(const ed of this.fileEditors.values()){
      if(ed&&ed._editor&&ed._editor.getModel()===model) return ed.filePath;
    }
    return '';
  },

  // 그 파일을 품은 Editor 루트. 등록된 루트 중 가장 긴 것이 답이다 — 루트가
  // 겹쳐 있을 때 짧은 쪽을 고르면 언어 서버가 엉뚱한 저장소를 읽는다.
  _lspRootOfPath(path){
    let best='';
    for(const w of this.edWindows()){
      const r=w.editor&&w.editor.root;
      if(!r) continue;
      // 구분자를 `/` 로 굳히지 않는다 — Windows 에서는 어떤 루트도 걸리지 않아
      // 이 함수가 빈 값을 내고, 그러면 코드 탐색이 통째로 서지 않는다.
      if(pathUnder(r,path)&&r.length>best.length) best=r;
    }
    return best;
  },

  // ── 설치 제안 (묶음 G · M5) ──

  /**
   * FR-LSP-44: 언어 서버가 없는 파일을 **열 때** 제안한다.
   *
   * 상태를 파일마다 다시 묻지 않는다 — 한 번 받아 두고 설치가 일어났을 때만
   * 버린다. 파일을 여는 것은 흔한 일이고, 그때마다 종단을 치면 그 자체가 지연이 된다.
   */
  async lspOfferFor(view){
    if(!view||!view.filePath||!view._editor) return;
    const ext=this._lspExtOf(view.filePath);
    if(!ext) return;
    const list=await this._lspStatusCached();
    if(!list) return;
    // 확장자 → 서술자는 **서버가 준 표**로 찾는다 (FR-LSP-44) — 화면이 그 표를
    // 따로 적으면 서술자와 어긋나 엉뚱한 제안이 뜬다.
    const s=list.find(x=>(x.exts||[]).some(e=>e===ext));
    if(!s||s.found) return;
    if(this._lspDismissed(s.id)) return;
    if(view.offer) view.offer(s);
  },

  _lspExtOf(path){
    const m=String(path).match(/(\.[^./\\]+)$/);
    return m?m[1].toLowerCase():'';
  },

  async _lspStatusCached(){
    if(this._lspStatus) return this._lspStatus;
    if(this._lspStatusP) return this._lspStatusP;
    this._lspStatusP=(async()=>{
      const r=await apiPost(LSP_STATUS_API,{overrides:this._lspOverrides()});
      const d=r.ok?r.data:null;
      // 배선이 없는 서버(503)는 제안할 것도 없다 — 빈 목록으로 굳혀 다시 묻지
      // 않는다.
      this._lspStatus=(d&&Array.isArray(d.servers))?d.servers:[];
      this._lspStatusP=null;
      return this._lspStatus;
    })();
    return this._lspStatusP;
  },

  // 설치가 일어났으면 굳혀 둔 상태를 버린다 — 받아 놓고도 제안이 계속 뜨면
  // 사용자는 설치가 실패한 줄로 읽는다 (FR-LSP-47 과 같은 근거).
  _lspStatusInvalidate(){ this._lspStatus=null },

  // FR-LSP-45: 닫으면 그 언어에 다시 뜨지 않는다. 기기별인 이유는 "이 화면에서
  // 그만 보겠다" 는 뜻이기 때문이다.
  _lspDismissed(id){
    try{
      const raw=localStorage.getItem(LSP_OFFER_KEY);
      if(!raw) return false;
      const o=JSON.parse(raw);
      return !!(o&&o[id]);
    }catch{return false}
  },

  lspDismiss(id){
    try{
      let o={};
      const raw=localStorage.getItem(LSP_OFFER_KEY);
      if(raw){const p=JSON.parse(raw); if(p&&typeof p==='object') o=p}
      o[id]=true;
      localStorage.setItem(LSP_OFFER_KEY,JSON.stringify(o));
    }catch{}
  },

  /**
   * 배너의 `받기`. 설정창의 것과 **같은 종단**을 쓴다 — 두 벌로 두면 한쪽만
   * 고쳐진다.
   */
  async lspOfferInstall(id,view){
    const out=await this._lspInstallOnce(id);
    this._lspStatusInvalidate();
    if(view&&view.note) view.note(out&&out.ok?LSP_INSTALL_OK:((out&&out.reason)||LSP_STATUS_FAIL),8000);
    if(out&&out.ok&&view&&view.offerClose) view.offerClose();
  },

  // 설정창의 `_lspInstall` 은 그 패널을 다시 칠하는 일까지 한다. 배너에는 칠할
  // 패널이 없으므로 종단만 치는 자리를 따로 둔다 — 둘이 같은 종단을 쓴다.
  async _lspInstallOnce(id){
    const r=await apiPost(LSP_INSTALL_API,{id});
    return r.ok?r.data:null;
  },

  // ── 진단 (묶음 E · M4) ──
  //
  // 밑줄은 Monaco 가 그린다 (D-8) — 같은 파일 안의 일이므로 탭 시스템을 알 필요가
  // 없다. 우리가 하는 일은 그 파일의 모델을 찾아 marker 를 얹는 것뿐이다.

  /**
   * FR-LSP-32·33·34: 서버가 밀어 준 진단을 그 파일에 얹는다.
   *
   * owner 가 우리 것 **하나**인 것이 규칙이다 (FR-LSP-34) — 그래야 갱신이 앞선
   * 것을 덮고 밑줄이 겹쳐 남지 않는다. 그리고 **빈 진단도 얹는다**: 그것이 "이
   * 파일은 이제 깨끗하다" 는 뜻이며, 걷지 않으면 고친 줄에 밑줄이 남는다.
   */
  _lspOnDiagnostics(d){
    if(!d||!d.path) return;
    // FR-LSP-36: 꺼져 있으면 얹지 않는다. 서버는 계속 밀어 주지만 그것을 막을
    // 이유는 없다 — 세션은 어차피 정의 이동을 위해 서 있고, 진단 계산은 언어
    // 서버가 자기 판단으로 한다.
    if(!lspDiagOn) return;
    if(typeof monaco==='undefined'||!monaco.editor) return;
    const items=Array.isArray(d.items)?d.items:[];
    for(const v of this.fileEditors.values()){
      if(!v||v.filePath!==d.path||!v._editor) continue;
      const model=v._editor.getModel();
      if(!model) continue;
      monaco.editor.setModelMarkers(model,LSP_DIAG_OWNER,items.map(it=>({
        // Monaco 도 1 부터 센다 — 서버가 이미 우리 셈법으로 보냈으므로 여기서
        // 셈법을 바꾸지 않는다.
        startLineNumber:it.line, startColumn:it.col,
        endLineNumber:it.endLine||it.line, endColumn:it.endCol||it.col,
        message:it.message||'',
        source:it.source||'',
        severity:LSP_DIAG_SEVERITY[it.severity]||2,
      })));
    }
  },

  /**
   * FR-LSP-35: 탭을 닫으면 그 파일의 진단을 걷는다.
   *
   * 모델이 파일마다 하나이고 탭을 닫아도 남을 수 있으므로(`edDocDrop` 이 수명을
   * 정한다), 걷지 않으면 다시 열었을 때 낡은 밑줄이 먼저 보인다.
   */
  lspClearDiagnostics(model){
    if(!model||typeof monaco==='undefined'||!monaco.editor) return;
    monaco.editor.setModelMarkers(model,LSP_DIAG_OWNER,[]);
  },

  /**
   * FR-LSP-36: 진단 토글. 끄면 지금 서 있는 밑줄을 **즉시 걷는다** — 껐는데 남아
   * 있으면 설정이 듣지 않는 것으로 보인다.
   */
  _lspSetDiag(on){
    lspDiagOn=!!on;
    try{localStorage.setItem(LSP_DIAG_KEY,lspDiagOn?'1':'0')}catch{}
    if(lspDiagOn) return;
    for(const v of this.fileEditors.values()){
      if(v&&v._editor) this.lspClearDiagnostics(v._editor.getModel());
    }
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
    this.edOpenFile(to.path,{line:to.line,col:to.col});
  },
});
