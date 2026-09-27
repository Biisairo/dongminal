/**
 * Dongminal — 브라우저 탭 (BROWSER_TAB_SRS 묶음 T·V·L).
 *
 * 탭 레코드(`type:'browser'`)는 화면이 소유한다 — 여는 자리(FR-BRT-32·33), 제목·주소의
 * 갱신, 닫기의 전달. 페이지는 서버의 매니저가 소유하며 이 파일은 그 둘을 잇는다.
 *
 * 뷰는 **(탭, 슬롯)마다** 하나다 — Run 뷰와 같은 규약이다 (FR-SRV-1: DOM 노드는
 * 한 부모에만 붙는다). 보이는 뷰만 스트림을 연다 (FR-BRT-40).
 *
 * 로드 순서: `app.js` 뒤, `main.js` 앞. `browser-view.js`·`browser-place.js` 뒤.
 */

// 브라우저 탭 UI 단축키 → 뷰가 할 일 (FR-BRT-56). 전역 배선은 이 이름들을 건너뛴다 —
// 탭에 포커스가 있을 때만 뜻이 있다 (input-binding.js).
const BRV_ACTIONS={
  brvAddress:v=>v.focusAddress(),
  brvReload:v=>v.nav('reload'),
  brvHardReload:v=>v._send({op:'nav',action:'reload',hard:true}),
  brvBack:v=>v.nav('back'),
  brvForward:v=>v.nav('forward'),
  brvZoomIn:v=>v.setZoom(1),
  brvZoomOut:v=>v.setZoom(-1),
  brvZoomReset:v=>v.setZoom(0),
  brvFind:v=>v.toggleFind(),
  brvDevtools:v=>v._send({op:'devtools'}),
};

// 고정 키 — 관용이라 표에 두지 않는다 (F5 새로고침 · Alt+←/→ 뒤로/앞으로 · F12 DevTools ·
// Mod+F 찾기 — 터미널 검색과 같은 규약이고 표의 Editor 찾기와 겹치지 않게 한다).
const BRV_FIXED_KEYS=[
  {match:e=>e.code==='F5'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey,act:'brvReload'},
  {match:e=>e.code==='ArrowLeft'&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey,act:'brvBack'},
  {match:e=>e.code==='ArrowRight'&&e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey,act:'brvForward'},
  {match:e=>e.code==='F12'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey,act:'brvDevtools'},
  {match:e=>matchShortcut(e,'Mod+KeyF'),act:'brvFind'},
];

Object.assign(App.prototype, {
  _brvMap(){
    if(!this._brvViews) this._brvViews=new Map();
    return this._brvViews;
  },

  /** renderer._mountTabBody 가 부른다. (탭, 슬롯)마다 하나를 재사용한다. */
  browserViewEl(tab,slot){
    const m=this._brvMap();
    const key=this.slotKey(tab.id,slot||0);
    let v=m.get(key);
    if(!v){v=new BrowserView(this,tab,slot||0);m.set(key,v)}
    v.tab=tab;
    this._brvSyncSoon();
    return v.el;
  },

  /** 포커스를 받을 뷰 — 포커스 슬롯의 것이 먼저다. */
  browserViewAny(tabId){
    const m=this._brvMap();
    const own=m.get(this.slotKey(tabId,this.slotFocused?this.slotFocused():0));
    if(own) return own;
    for(const [k,v] of m) if(this.slotBase(k)===tabId) return v;
    return null;
  },

  _brvSyncSoon(){
    if(this._brvSyncing) return;
    this._brvSyncing=true;
    TIMERS.frame(()=>{this._brvSyncing=false;this._brvSync()},{owner:this,label:'brv-sync'});
  },

  /**
   * 보이는 뷰만 스트림을 연다. 탭이 사라진 뷰는 거둔다 — closeTab 은 이 파일이
   * 소유하지 않으므로 여기서 스스로 맞춘다 (Run 뷰와 같은 규약).
   */
  _brvSync(){
    const m=this._brvMap();
    if(!m.size) return;
    const live=new Set();
    for(const s of this.ws.windows) for(const pn of panesOf(s&&s.layout)) for(const tab of pn.tabs||[])
      if(tab.type===TAB_TYPE_BROWSER) live.add(tab.id);
    for(const [k,v] of [...m]){
      if(!live.has(this.slotBase(k))){v.destroy();m.delete(k);continue}
      const shown=v.el.isConnected&&v.el.classList.contains('vis')&&!document.hidden;
      v.setVisible(shown);
    }
  },

  /** 창의 주인 변화 — 뷰포트의 주인이 바뀐다 (FR-BRT-51). */
  _brvOwnersChanged(){
    for(const v of this._brvMap().values()) v.ownerChanged();
  },

  _brvWindowOf(tabId){
    const f=findTabWhere(this.ws.windows,tab=>tab.id===tabId);
    return f?f.win:null;
  },

  /**
   * 이 뷰가 뷰포트를 정하는가 — 그 창의 주인이다. 주인은 OS 포커스를 잃어도 주인이다(다른 앱으로
   * 옮겨도 흐려지지 않는다). 주인이 없으면 OS 포커스가 있는 화면만 정한다 — 두 화면이 다투지 않는다.
   */
  brvOwns(tabId,slot){
    const win=this._brvWindowOf(tabId);
    const owner=win&&this._windowFocusOwner&&this._windowFocusOwner[win.id];
    if(owner) return owner===this._slotIdentity(slot||0);
    return !!this.windowFocused;
  },

  /**
   * 뷰어에 입력하면 기존 규칙대로 주인이 된다 (FR-BRT-51). 캔버스는 누름의 기본 동작을
   * 막으므로 칸의 mousedown 배선이 돌지 않는다 — 칸 포커스도 여기서 옮긴다.
   */
  brvTouched(tabId,slot){
    const f=findTabWhere(this.ws.windows,x=>x.id===tabId);
    if(!f) return;
    if(f.win.id===this.ws.activeWindow&&this.focused!==f.pane.id&&this.setFocus) this.setFocus(f.pane.id);
    this._focusWindow(f.win.id,slot);
  },

  /** 샌드박스 창의 브라우저 탭도 호스트 네트워크에서 돈다 — 그 사실을 알린다 (FR-BRT-43). */
  brvInSandbox(tabId){
    const win=this._brvWindowOf(tabId);
    return !!(win&&win.sandbox);
  },

  /** 페이지의 제목·주소가 바뀌었다 — 탭 레코드가 복원의 근거다 (FR-BRT-30·39). */
  brvOnState(tabId,st){
    const f=findTabWhere(this.ws.windows,tab=>tab.id===tabId);
    if(!f) return;
    let changed=false;
    const name=clampEntityName(st.title||st.url||'');
    if(name&&f.tab.name!==name){f.tab.name=name;changed=true}
    if(st.url&&st.url!=='about:blank'&&f.tab.url!==st.url){f.tab.url=st.url;changed=true}
    // FR-BRT-52: 고정 크기는 탭 레코드에 적어 복원 때 다시 건다.
    const vp=st.viewport&&st.viewport.w>0&&st.viewport.h>0?{w:st.viewport.w,h:st.viewport.h}:null;
    const had=f.tab.viewport||null;
    if(vp&&(!had||had.w!==vp.w||had.h!==vp.h)){f.tab.viewport=vp;changed=true}
    else if(!vp&&had&&st.viewport===null){delete f.tab.viewport;changed=true}
    if(!changed) return;
    this.renderTabTitles?this.renderTabTitles():this.render();
    if(this._brvSaveTimer) TIMERS.cancel(this._brvSaveTimer);
    this._brvSaveTimer=TIMERS.after(500,()=>{this._brvSaveTimer=null;this.save()},{owner:this,label:'brv-save'});
  },

  // ── 여는 자리 ──

  /** TAB_OPENERS 의 한 줄 — 칸 하나에 탭 레코드를 넣는다. */
  _addBrowserTab(s,pn,opts){
    const tab=this._brvTabRecord(opts);
    pn.tabs.push(tab);
    if(!opts.keepFocus){this.paneTabSet(pn,tab.id);this.setFocusState(pn.id,s)}
    this.render();
    this.save();
    return {uuid:tab.id};
  },

  _brvTabRecord(a){
    const tab={id:a.tab||newEntityId(),type:TAB_TYPE_BROWSER,name:clampEntityName(a.name||a.url||'Browser'),
      url:a.url||'about:blank'};
    if(a.profile&&a.profile!=='default') tab.profile=a.profile;
    if(a.isolated) tab.isolated=true;
    if(a.popup) tab.popup=true;
    if(a.devtoolsOf) tab.devtoolsOf=String(a.devtoolsOf);
    return tab;
  },

  /**
   * 서버가 보낸 배치 (FR-BRT-32·33·34). 페이지는 이미 있다 — 여기서는 탭 레코드를
   * 놓는 자리만 정한다. 이미 그 탭이 있으면 아무것도 하지 않는다(중복 배치).
   */
  _remoteOpenBrowserTab(a){
    if(!a||!a.tab) return;
    if(findTabWhere(this.ws.windows,tab=>tab.id===a.tab)) return;
    const tab=this._brvTabRecord(a);
    const focus=!!a.focus;
    // DevTools — 호출 칸은 대상 탭의 칸이고 여는 자리는 설정을 따른다 (FR-BRT-84·32).
    if(a.devtoolsOf){
      const o=findTabWhere(this.ws.windows,x=>x.id===a.devtoolsOf);
      if(o){
        const place=browserPlace(o.win.layout,o.pane.id,browserOpenPlacement==='tab'?'none':'right',o.win.focusedPane);
        if(place&&place.pane){
          const pn=findPane(o.win.layout,place.pane);
          pn.tabs.push(tab);
          this._brvPlaced(o.win,pn,tab,true);
          return;
        }
        if(place){
          const np={type:'pane',id:newEntityId(),tabs:[tab],activeTab:tab.id};
          o.win.layout=browserSplitInsert(o.win.layout,place.split.target,place.split.dir,np);
          this._brvPlaced(o.win,np,tab,true);
          return;
        }
      }
    }
    // 페이지가 연 탭 — 연 탭의 칸, 바로 뒤 (FR-BRT-33).
    if(a.opener){
      const o=findTabWhere(this.ws.windows,x=>x.id===a.opener);
      if(o){
        browserInsertAfter(o.pane,o.tab.id,tab);
        this._brvPlaced(o.win,o.pane,tab,focus);
        return;
      }
    }
    // 호출 칸 — 부른 도구가 있는 칸. 없으면 그 창의 포커스 칸 (FR-BRT-32).
    let win=null,callerPane=null;
    if(a.tool){
      const c=findTabWhere(this.ws.windows,x=>x.toolId===a.tool);
      if(c){win=c.win;callerPane=c.pane.id}
    }
    if(!win) win=this.aw();
    if(!win||!win.layout||!this._tabTypeFits(win,TAB_TYPE_BROWSER)){
      win=this.ws.windows.find(w=>w&&w.layout&&this._tabTypeFits(w,TAB_TYPE_BROWSER))||null;
    }
    if(!win) return;
    const place=browserPlace(win.layout,callerPane,a.split||'right',win.focusedPane);
    if(!place) return;
    if(place.pane){
      const pn=findPane(win.layout,place.pane);
      pn.tabs.push(tab);
      this._brvPlaced(win,pn,tab,focus);
      return;
    }
    const np={type:'pane',id:newEntityId(),tabs:[tab],activeTab:tab.id};
    win.layout=browserSplitInsert(win.layout,place.split.target,place.split.dir,np);
    this._brvPlaced(win,np,tab,focus);
  },

  _brvPlaced(win,pn,tab,focus){
    if(focus){
      this._activateWindow(win.id,{rememberFocus:true});
      this.paneTabSet(pn,tab.id);
      this.setFocusState(pn.id,win);
      this.focusHandoff=true;
    }else if(!pn.activeTab||pn.tabs.length===1){
      pn.activeTab=tab.id;
    }
    this.render();
    this.save();
  },

  /** 받을 화면이 없어 서버가 들고 있던 배치를 가져온다 (FR-BRT-36). */
  async _brvClaimPending(){
    const r=await apiPost(BROWSER_API.claim,{});
    if(!r.ok||!r.data) return;
    for(const p of r.data.placements||[]) this._remoteOpenBrowserTab(p);
  },

  /** 탭 닫기 → 페이지 닫기 (FR-BRT-37). */
  _brvClosePage(tab){
    if(!tab||tab.type!==TAB_TYPE_BROWSER) return;
    apiPost(BROWSER_API.close,{tab:tab.id});
  },

  /** 포커스된 브라우저 탭의 뷰. */
  _brvFocusedView(){
    const s=this.aw();
    const pn=s&&this.focused?findPane(s.layout,this.focused):null;
    const tab=pn&&pn.tabs.find(x=>x.id===this.paneTab(pn));
    return tab&&tab.type===TAB_TYPE_BROWSER?this.browserViewAny(tab.id):null;
  },

  /**
   * 브라우저 탭의 UI 단축키 (FR-BRT-56 ②). 전역 단축키 다음, 페이지 앞이다. 잡았으면
   * 참이다 — `preventDefault` 로 dongminal 페이지 자체의 새로고침을 막는다.
   */
  brvTryKey(e){
    const ae=document.activeElement;
    let v=null;
    for(const x of this._brvMap().values()) if(x.input===ae){v=x;break}
    if(!v) v=this._brvFocusedView();
    if(!v) return false;
    for(const [action,fn] of Object.entries(BRV_ACTIONS)){
      if(matchShortcut(e,shortcuts[action])){e.preventDefault();e.stopImmediatePropagation();fn(v);return true}
    }
    for(const k of BRV_FIXED_KEYS){
      if(k.match(e)){e.preventDefault();e.stopImmediatePropagation();BRV_ACTIONS[k.act](v);return true}
    }
    return false;
  },

  /** FR-BRT-80: 받은 파일을 서버 탐색기에서 보인다 — 그 폴더의 Editor 창을 열고 가리킨다. */
  async brvReveal(path){
    if(!path) return;
    const dir=path.replace(/[\\/][^\\/]*$/,'')||'/';
    await this.edOpenWindow(dir);
    TIMERS.after(300,()=>{const tr=this.edActiveTree&&this.edActiveTree();if(tr&&tr.revealPath) tr.revealPath(path)},{owner:this,label:'brv-reveal'});
  },

  // ── 링크 (묶음 L) ──

  /**
   * dongminal 화면의 링크 클릭 (FR-BRT-68). 설정 `browserLinkTarget`(기본 내장)을
   * 따르고, ⇧⌘/Ctrl+Shift 클릭은 반대로 연다. `viewer` 는 **클릭 핸들러 안에서**
   * 연다 — 제스처 밖의 `window.open` 은 막힌다.
   */
  openLink(url,ev){
    const flip=!!(ev&&ev.shiftKey&&(ev.metaKey||ev.ctrlKey));
    const internal=(browserLinkTarget!=='viewer')!==flip;
    if(!internal||!/^https?:/i.test(url)){
      window.open(url,'_blank','noopener');
      return;
    }
    this.openBrowser(url,{focus:true});
  },

  /** 브라우저 탭 하나를 연다 — 서버가 페이지를 만들고 배치를 보낸다. */
  async openBrowser(url,opts){
    const o=opts||{};
    const s=this.aw();
    const pn=s&&this.focused?findPane(s.layout,this.focused):null;
    const tab=pn&&pn.tabs.find(x=>x.id===this.paneTab(pn));
    const r=await apiPost(BROWSER_API.open,{url,focus:!!o.focus,split:o.split||'',profile:o.profile||'',
      tool:tab&&tab.toolId?tab.toolId:''});
    if(!r.ok) this._notify(apiErrText(r,t('brv.open_fail')));
  },
});

/**
 * 마지막 누름의 수정키. Monaco 의 링크 오프너는 이벤트를 넘기지 않으므로, ⌘⇧ 로
 * 반대쪽을 고르는 규칙(FR-BRT-68)을 그 누름에서 읽는다.
 */
let brvLastPress={at:0,shiftKey:false,metaKey:false,ctrlKey:false};
if(typeof window!=='undefined'&&window.addEventListener){
  window.addEventListener('mousedown',e=>{
    brvLastPress={at:performance.now(),shiftKey:e.shiftKey,metaKey:e.metaKey,ctrlKey:e.ctrlKey};
  },true);
}

/** 편집기 URL 의 오프너 (FR-BRT-68). Monaco 가 선 뒤 한 번 부른다(file-editor.js). */
function browserLinkOpenerInstall(){
  if(browserLinkOpenerInstall.done) return;
  if(typeof monaco==='undefined'||!monaco.editor||!monaco.editor.registerLinkOpener) return;
  browserLinkOpenerInstall.done=true;
  monaco.editor.registerLinkOpener({
    open(resource){
      const u=String(resource);
      if(!/^https?:/i.test(u)||!window.app||!window.app.openLink) return false;
      const recent=performance.now()-brvLastPress.at<2000?brvLastPress:null;
      window.app.openLink(u,recent);
      return true;
    },
  });
}
