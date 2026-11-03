/**
 * Remote Terminal — 코드 탐색: 언어 서버의 관측과 받기
 * (EDITOR_LSP_SRS 묶음 A · M1)
 *
 * 이 파일이 아는 것은 **상태와 버튼**뿐이다. 정의로 이동·참조 찾기·호버·진단은
 * M2 이후의 것이며, 그것들이 설 바닥이 여기다 — 서버가 있는지 없는지를 사용자가
 * 볼 수 있어야 비로소 "왜 F12 가 아무 일도 안 하는가" 를 설명할 수 있다 (D-9).
 *
 * APP_STATE_EXTRACT_SRS FR-ASE-7: 이 가족의 상태와 메서드는 `App` 이 아니라 `LspClient`
 * 가 갖는다. 본문은 `app-lsp.js` 에서 구간 이동했고 편집은 앱으로 나가는 자리
 * (`this.app.`)뿐이다. 바깥이 부르는 이름은 `app-lsp.js` 의 위임 껍데기가 지킨다.
 */
class LspClient {
  constructor(app){ this.app=app }
}

Object.assign(LspClient.prototype, {

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
   * FR-LSP-47: 상태는 캐시가 아니라 **관측**이다. 패널을 열 때마다 다시 읽는 이유가
   * 그것이다 — 사용자가 바깥에서 지운 서버를 우리가 있다고 우기면 안 된다.
   */
  async _lspRefresh(){
    const list=document.getElementById('lsp-list');
    if(!list) return;
    // REPO_FIX 02 §3A-3: 요청은 경로를 싣지 않는다 — 서버 표로 해석한다. 경로 칸을
    // 칠하려면 그 표가 먼저 있어야 한다.
    const [r]=await Promise.all([apiPost(LSP_STATUS_API,{}),this._lspPathsLoad()]);
    const d=r.ok?r.data:null;
    if(!d||!Array.isArray(d.servers)){
      // 503 은 배선이 없는 서버다 — 고장이 아니라 그 서버의 성질이므로 다르게 말한다.
      list.innerHTML='<div class="ui-empty lsp-empty">'+
        escHtml(r.status===503?LSP_UNAVAILABLE:LSP_STATUS_FAIL)+'</div>';
      return;
    }
    this._lspPaint(d.servers);
    // FR-EXT-8: 읽지 못한 선언이 있으면 그 사실이 보여야 한다.
    if(Array.isArray(d.problems)&&d.problems.length){
      const box=document.createElement('div');
      box.className='ui-empty lsp-empty';
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
        ? '<button class="ui-btn ui-btn-sm lsp-install" title="'+escHtml(LSP_INSTALL_TITLE)+'" data-id="'+escHtml(pack)+'" disabled>'+LSP_INSTALLING+'</button>'
        : (done ? ''
          : '<button class="ui-btn ui-btn-sm lsp-install" title="'+escHtml(LSP_INSTALL_TITLE)+'" data-id="'+escHtml(pack)+'"'+
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
        this._lspPathRows(pack,srvs)+
        '<div class="lsp-msg">'+escHtml(this._lspConnNote(srvs))+'</div>'+
      '</div>');
    }
    list.innerHTML=rows.join('');
    for(const b of list.querySelectorAll('.lsp-install')){
      b.addEventListener('click',()=>this._lspInstall(b.dataset.id));
    }
    this._lspPathsBind(list);
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

  // ── 정의·참조 이동 (CODEMIRROR_MIGRATION_SRS FR-CMR-92·93 · §11.6 L1) ──
  //
  // `@codemirror/lsp-client` 의 명령을 부른다 — 정의는 첫 항목으로 가고, 참조는 그
  // 라이브러리의 패널에 보인다 (M8 결정 6, §3.16). 연결이 닫혀 있으면 먼저 다시 연다.

  async _lspGotoDef(){ await this._lspRun(()=>CM.jumpToDefinition) },
  async _lspFindRefs(){ await this._lspRun(()=>CM.findReferences) },

  /**
   * FR-LSP-60·67 · EDITOR_LINK_LSP_SRS FR-ELS-10 순서 2·3: 수정키+클릭이 닿는 자리 (`cm-link.js`).
   * 그 자리를 품은 `file:` 문서 링크가 있으면 그 파일을 연다. 없으면 **`F12` 와 같은 경로다** —
   * 커서를 그 자리에 놓고 정의로 이동을 부른다.
   */
  async lspClickDef(view,pos){
    if(!view||pos==null) return;
    const link=await this._lspLinkAt(view,pos);
    if(link){ await this.app.edOpenFile(link.path,link.line?{line:link.line}:{}); return }
    view.dispatch({selection:{anchor:pos}});
    await this._lspRunOn(view,CM.jumpToDefinition);
  },

  // FR-ELS-13: 클릭할 때 한 번 묻는다. 능력이 없거나 실패하면 null — 정의 이동으로 넘어간다.
  async _lspLinkAt(view,pos){
    const plugin=CM.LSPPlugin.get(view);
    const client=plugin&&this._lspConnOf(plugin.client)&&plugin.client;
    if(!client||!client.hasCapability('documentLinkProvider')) return null;
    client.sync();
    const links=await client.request('textDocument/documentLink',{textDocument:{uri:plugin.uri}}).then((r)=>r,()=>null);
    return edLspLinkTarget(view.state.doc,links,pos);
  },

  async _lspRun(cmdOf){
    if(typeof CM==='undefined') return;
    const v=this.app._edActiveEditor();
    if(!v||!v._view) return;
    await this._lspRunOn(v._view,cmdOf(),v);
  },

  async _lspRunOn(view,cmd,fe){
    const plugin=CM.LSPPlugin.get(view);
    const conn=plugin&&this._lspConnOf(plugin.client);
    if(!conn){ if(fe&&fe.note) fe.note(LSP_ASK_FAIL); return }
    const ok=await conn.ensure().then(()=>true,()=>false);
    if(!ok){
      if(fe&&fe.note) fe.note(edLspCloseNote(conn.lastClose)||LSP_ASK_FAIL);
      return;
    }
    cmd(view);
  },

  /**
   * 이 파일의 편집기에 넣을 LSP 확장. 서버가 없거나 루트가 없으면 null 이다 —
   * 그때 편집기는 LSP 없이 선다.
   */
  async lspExtFor(path){
    if(!path||typeof CM==='undefined') return null;
    const root=this._lspRootOfPath(path);
    const ext=this._lspExtOf(path);
    if(!root||!ext) return null;
    const list=await this._lspStatusCached();
    const s=list&&list.find(x=>(x.exts||[]).some(e=>e===ext));
    if(!s||!s.found) return null;
    const conn=this._lspConn(root,(s.pack?s.pack+'/':'')+s.id);
    conn.ensure();
    return conn.plugin(path,edLspLangId(path,s.langs));
  },

  // 페이지의 (루트, 서술자)마다 연결 하나 (FR-CMR-90).
  _lspConn(root,desc){
    this._lspConns=this._lspConns||new Map();
    const key=root+'\0'+desc;
    let c=this._lspConns.get(key);
    if(!c){
      // FR-CMR-92: 진단은 그룹의 버퍼에 보관하고 모든 칸에 그린다 (§11.6 L2).
      const bufOf=(path)=>{ const d=this.app.edDocAt(path); return (d&&d.buf)||null };
      c=new EdLspConn({
        root, desc,
        display:(path)=>this._lspDisplay(path),
        // 갱신 도중에 불린다 — 그리기는 그 뒤로 미룬다.
        joined:(path)=>queueMicrotask(()=>edLspDiagShow(bufOf(path),lspDiagOn)),
        // FR-CMR-94: hover Markdown 은 DOMPurify 를 지난다.
        sanitizeHTML:(html)=>DOMPurify.sanitize(html),
        extensions:[CM.hoverTooltips(),edLspDiagnostics({bufOf,on:()=>lspDiagOn})],
      });
      this._lspConns.set(key,c);
    }
    return c;
  },

  // FR-CMR-102: 그 팩의 서버 연결 중 상한·기동 실패로 닫힌 것의 사유. 없으면 빈 값이다.
  _lspConnNote(srvs){
    if(!this._lspConns) return '';
    const descs=new Set(srvs.map(s=>(s.pack?s.pack+'/':'')+s.id));
    for(const c of this._lspConns.values()){
      const n=descs.has(c.desc)&&c.state==='closed'?edLspCloseNote(c.lastClose):null;
      if(n) return n;
    }
    return '';
  },

  _lspConnOf(client){
    if(!this._lspConns) return null;
    for(const c of this._lspConns.values()) if(c.client===client) return c;
    return null;
  },

  // `Workspace.displayFile` — 앱이 그 파일을 열고 편집기가 선 뒤 그 뷰를 낸다.
  async _lspDisplay(path){
    await this.app.edOpenFile(path,{});
    const tab=this.app._findEditorTab(path);
    const fe=tab&&this.app.editorAny(tab.tab.id);
    return fe&&fe.whenView?await fe.whenView():null;
  },

  // 그 파일을 품은 Editor 루트. 등록된 루트 중 가장 긴 것이 답이다 — 루트가
  // 겹쳐 있을 때 짧은 쪽을 고르면 언어 서버가 엉뚱한 저장소를 읽는다.
  _lspRootOfPath(path){
    let best='';
    for(const w of this.app.edWindows()){
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
    if(!view||!view.filePath||!view._view) return;
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
      const r=await apiPost(LSP_STATUS_API,{});
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
    const o=PrefStore.local.json(LSP_OFFER_KEY,null);
    return !!(o&&o[id]);
  },

  lspDismiss(id){
    const p=PrefStore.local.json(LSP_OFFER_KEY,null);
    const o=(p&&typeof p==='object')?p:{};
    o[id]=true;
    PrefStore.local.setJson(LSP_OFFER_KEY,o);
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

  // ── 진단 (CODEMIRROR_MIGRATION_SRS FR-CMR-92 · §11.6 L2) ──

  /**
   * FR-LSP-36 · FR-CMR-92: 진단 토글. 끄면 지금 서 있는 밑줄을 **즉시 걷는다** — 껐는데
   * 남아 있으면 설정이 듣지 않는 것으로 보인다. 켜면 그룹마다 보관한 진단을 다시 그린다.
   */
  _lspSetDiag(on){
    lspDiagOn=!!on;
    PrefStore.local.setBool(LSP_DIAG_KEY,lspDiagOn);
    if(!this.app._edDocs) return;
    for(const d of this.app._edDocs.values()) if(d&&d.buf) edLspDiagShow(d.buf,lspDiagOn);
  },
});
