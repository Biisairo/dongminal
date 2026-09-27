/**
 * 브라우저 탭의 뷰어 — 서버 기기의 Chrome 페이지 하나를 그리고 입력을 보낸다
 * (BROWSER_TAB_SRS 묶음 V · FR-BRT-41·50~58).
 *
 * 화면은 JPEG 프레임을 canvas 에 **비율을 지켜** 그린다. 입력은 페이지의 CSS 좌표로
 * 바꿔 `/api/browser/stream` WS 로 보낸다 — 조작은 서버의 매니저가 신뢰 입력으로
 * 넣는다. 격리 world 와 페이지에서 온 문자열(제목·주소·오류)은 **텍스트로만** 그린다
 * (NFR-BRT-S2).
 *
 * 로드 순서: `ui-kit.js`·`shortcuts.js` 뒤, `app-browser.js` 앞.
 */

// 뷰어가 보내는 수정키 비트 — CDP 의 `modifiers` 와 같다.
function brvMods(e){return (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0)}

// 마우스 버튼 이름 (CDP `button`).
const BRV_BUTTONS=['left','middle','right','back','forward'];

// 숨긴 창에서 연결을 끊기까지의 유예 — 탭을 잠깐 오가는 사이에 스트림을 다시 세우지 않는다.
const BRV_HIDE_GRACE_MS=1500;

// 확대 단계 (FR-BRT-57). Chrome 의 관용 단계와 같다.
const BRV_ZOOMS=[0.25,0.33,0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5];

class BrowserView{
  /**
   * @param {object} app  App
   * @param {object} tab  워크스페이스 탭 레코드 (`type:'browser'`)
   * @param {number} slot 이 인스턴스가 선 슬롯
   */
  constructor(app,tab,slot){
    this.app=app;this.tabId=tab.id;this.slot=slot||0;
    this.tab=tab;
    this.ws=null;this.meta=null;this.state={url:tab.url||'',title:tab.name||''};
    this._keysDown=new Set();
    this.zoom=1;this.visible=false;this._hideTimer=null;this._pending=null;this._decoding=false;
    this._composing=false;this._lastVp='';
    this._build();
  }

  _build(){
    const el=document.createElement('div');el.className='brv';
    const bar=document.createElement('div');bar.className='brv-bar';
    const btn=(icon,title,fn)=>{const b=UIKit.button({icon,title,kind:'ghost',size:'sm'});b.addEventListener('click',fn);return b};
    this.backBtn=btn('chevron-left',t('brv.back'),()=>this.nav('back'));
    this.fwdBtn=btn('chevron-right',t('brv.forward'),()=>this.nav('forward'));
    this.reloadBtn=btn('refresh-cw',t('brv.reload'),()=>this.nav(this.state.loading?'stop':'reload'));
    const addr=document.createElement('input');addr.type='text';addr.className='brv-addr';
    addr.spellcheck=false;addr.setAttribute('aria-label',t('brv.address'));
    addr.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();this._submitAddress()}
      if(e.key==='Escape'){e.preventDefault();addr.value=this.state.url||'';this.focus()}
      e.stopPropagation();
    });
    addr.addEventListener('blur',()=>{if(addr.dataset.err!=='1') addr.value=this.state.url||''});
    this.addr=addr;
    this.badges=document.createElement('span');this.badges.className='brv-badges';
    this.menuBtn=btn('more-horizontal',t('brv.menu'),e=>this._menu(e));
    bar.append(this.backBtn,this.fwdBtn,this.reloadBtn,addr,this.badges,this.menuBtn);
    const stage=document.createElement('div');stage.className='brv-stage';
    const canvas=document.createElement('canvas');canvas.className='brv-canvas';
    const input=document.createElement('textarea');input.className='brv-input';
    input.setAttribute('aria-label',t('brv.page_input'));input.autocapitalize='off';input.spellcheck=false;
    const overlay=document.createElement('div');overlay.className='brv-overlay';overlay.hidden=true;
    stage.append(canvas,input,overlay);
    el.append(bar,stage);
    this.el=el;this.stage=stage;this.canvas=canvas;this.input=input;this.overlay=overlay;
    this._wireInput();
    this._paintBadges();
    this._paintState();
    if(typeof ResizeObserver==='function'){
      this._ro=new ResizeObserver(()=>this._onResize());
      this._ro.observe(stage);
    }
  }

  // ── 수명 ──

  /** 화면에 보이는가. 보이면 붙고, 오래 안 보이면 끊는다 (FR-BRT-40). */
  setVisible(on){
    if(on===this.visible) return;
    this.visible=on;
    if(on){
      if(this._hideTimer){TIMERS.cancel(this._hideTimer);this._hideTimer=null}
      this._connect();
      this._sendViewport(true);
      this._audioStart();
      return;
    }
    this._audioStop();
    if(this._hideTimer) return;
    this._hideTimer=TIMERS.after(BRV_HIDE_GRACE_MS,()=>{this._hideTimer=null;if(!this.visible) this._disconnect()},{owner:this,label:'brv-hide'});
  }

  destroy(){
    this.visible=false;
    if(this._hideTimer){TIMERS.cancel(this._hideTimer);this._hideTimer=null}
    if(this._ro){try{this._ro.disconnect()}catch{}this._ro=null}
    this._disconnect();
    this.el.remove();
  }

  _connect(){
    if(this.ws) return;
    const q=new URLSearchParams({tab:this.tabId});
    if(this.tab.url) q.set('url',this.tab.url);
    if(this.tab.profile) q.set('profile',this.tab.profile);
    if(this.tab.isolated) q.set('isolated','1');
    // FR-BRT-94: 받은 프레임을 확인한다 — 서버는 확인받지 못한 것을 2장까지만 보낸다.
    q.set('ack','1');
    const proto=location.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(proto+'//'+location.host+BROWSER_API.stream+'?'+q.toString());
    ws.binaryType='arraybuffer';
    ws.onmessage=ev=>this._onMessage(ev);
    ws.onopen=()=>{
      this._lastVp='';this._sendViewport(true);if(this.zoom!==1) this._send({op:'zoom',zoom:this.zoom});
      const q=this._outbox;this._outbox=null;
      if(q) for(const m of q) this._send(m);
      this._audioStart();
    };
    ws.onclose=()=>{
      if(this.ws!==ws) return;
      this.ws=null;this._outbox=null;
      // 보이는 동안 끊겼으면 다시 붙는다 — 서버 재시작·네트워크 끊김.
      if(this.visible) TIMERS.after(1000,()=>{if(this.visible&&!this.ws) this._connect()},{owner:this,label:'brv-reconnect'});
    };
    this.ws=ws;
  }

  _disconnect(){
    this._outbox=null;
    this._audioStop(true);
    const ws=this.ws;this.ws=null;
    if(ws){try{ws.close()}catch{}}
  }

  /**
   * 열려 있으면 보내고, 여는 중이면 모았다가 열리면 보낸다 — 탭이 뜨자마자 누른 메뉴(고정 크기
   * 등)가 조용히 사라졌다(CI 실측). 끊겨 있으면 버린다: 다시 붙으면 상태를 새로 받는다.
   */
  _send(m){
    const ws=this.ws;
    if(ws&&ws.readyState===1){ws.send(JSON.stringify(m));return}
    if(ws&&ws.readyState===0&&(this._outbox||(this._outbox=[])).length<BRV_OUTBOX_MAX) this._outbox.push(m);
  }

  // ── 받기 ──

  _onMessage(ev){
    if(typeof ev.data!=='string'){this._onFrame(ev.data);return}
    let m;try{m=JSON.parse(ev.data)}catch{return}
    const info=m.info||{};
    if(m.t==='state'){
      this.state=Object.assign({},this.state,info);
      if(typeof info.zoom==='number') this.zoom=info.zoom;
      this._paintState();
      this.app.brvOnState(this.tabId,this.state);
      if(info.crashed) this._showOverlay(t('brv.crashed'),t('brv.reload'),()=>this.nav('reload'));
      else if(!this._errShown) this._hideOverlay();
    }else if(m.t==='error'){
      this._errShown=true;
      this._showOverlay(String(info.message||t('brv.error')),t('brv.retry'),()=>{this._errShown=false;this._hideOverlay();this.nav('reload')});
    }else if(m.t==='act'){
      this._showAct(info);
    }else if(m.t==='report'){
      this._onReport(info);
    }else if(m.t==='dialog'){
      this._onDialog(info);
    }else if(m.t==='auth'){
      this._onAuth(info);
    }else if(m.t==='chooser'){
      this._onChooser(info);
    }else if(m.t==='download'){
      this._onDownload(info);
    }else if(m.t==='find'){
      this._onFind(info);
    }else if(m.t==='audio'){
      this._onAudio(info);
    }else if(m.t==='image'){
      this._onImage(info);
    }else if(m.t==='closed'){
      this._showOverlay(t('brv.closed'),null,null);
    }
  }

  // 프레임은 `[4바이트 메타 길이][메타 JSON][JPEG]` 다. **최신 하나만** 그린다 —
  // 디코드가 밀리면 중간 프레임을 버린다.
  _onFrame(buf){
    const dv=new DataView(buf);
    const n=dv.getUint32(0);
    let meta=null;
    try{meta=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,4,n)))}catch{meta=null}
    // 그리지 못하고 밀려난 프레임도 받은 것이다.
    if(this._pending) this._ackFrame();
    this._pending={meta,blob:new Blob([new Uint8Array(buf,4+n)],{type:'image/jpeg'})};
    if(!this._decoding) this._drawNext();
  }

  /** FR-BRT-94: 받음 확인. 여는 중·끊긴 소켓에는 보내지 않는다 — 새 연결은 셈이 새로 시작한다. */
  _ackFrame(){
    const ws=this.ws;
    if(ws&&ws.readyState===1) ws.send('{"op":"frameAck"}');
  }

  async _drawNext(){
    const f=this._pending;this._pending=null;
    if(!f) return;
    this._decoding=true;
    try{
      const bmp=await createImageBitmap(f.blob);
      if(f.meta&&f.meta.deviceWidth) this.meta=f.meta;
      this._draw(bmp);
      bmp.close&&bmp.close();
    }catch{ /* 깨진 프레임은 건너뛴다 — 다음 프레임이 메운다 */ }
    this._ackFrame();
    this._decoding=false;
    if(this._pending) this._drawNext();
  }

  _draw(bmp){
    const c=this.canvas,dpr=window.devicePixelRatio||1;
    const cw=Math.max(1,Math.round(this.stage.clientWidth*dpr)),ch=Math.max(1,Math.round(this.stage.clientHeight*dpr));
    if(c.width!==cw||c.height!==ch){c.width=cw;c.height=ch}
    const g=c.getContext('2d');
    const s=Math.min(cw/bmp.width,ch/bmp.height);
    const dw=bmp.width*s,dh=bmp.height*s,dx=(cw-dw)/2,dy=(ch-dh)/2;
    g.clearRect(0,0,cw,ch);
    g.drawImage(bmp,dx,dy,dw,dh);
    // 좌표 환산의 근거 — CSS 픽셀로 둔다.
    this._rect={x:dx/dpr,y:dy/dpr,w:dw/dpr,h:dh/dpr};
  }

  // ── 상태 그리기 ──

  _paintState(){
    const st=this.state;
    if(document.activeElement!==this.addr) this.addr.value=st.url||'';
    this.backBtn.disabled=!st.canBack;
    this.fwdBtn.disabled=!st.canForward;
    this.reloadBtn.title=st.loading?t('brv.stop'):t('brv.reload');
    this.el.classList.toggle('brv-loading',!!st.loading);
  }

  _paintBadges(){
    this.badges.textContent='';
    const add=(txt,cls,title)=>{const s=document.createElement('span');s.className='brv-badge '+cls;s.textContent=txt;if(title)s.title=title;this.badges.appendChild(s)};
    if(this.tab.isolated) add(t('brv.badge_temp'),'brv-temp',t('brv.badge_temp_title'));
    if(this.tab.profile&&this.tab.profile!=='default') add(this.tab.profile,'brv-profile',t('brv.badge_profile_title'));
    if(this.tab.popup) add(t('brv.badge_popup'),'brv-popup','');
    if(this.app.brvInSandbox&&this.app.brvInSandbox(this.tabId)) add(t('brv.badge_host'),'brv-host',t('brv.badge_host_title'));
  }

  _showOverlay(msg,btnLabel,fn){
    const o=this.overlay;o.textContent='';
    const p=document.createElement('div');p.className='brv-overlay-msg';p.textContent=msg;o.appendChild(p);
    if(btnLabel&&fn){const b=UIKit.button({label:btnLabel,kind:'primary',size:'sm'});b.addEventListener('click',fn);o.appendChild(b)}
    o.hidden=false;
  }

  _hideOverlay(){this.overlay.hidden=true}

  /**
   * FR-BRT-79: 에이전트 조작(`dmctl browser click` 등)의 자리를 잠깐 그린다. 페이지 DOM 이
   * 아니라 이 뷰어 위의 장식이다 — 페이지는 아무것도 모른다.
   */
  _showAct(a){
    const r=this._rect,m=this.meta;
    if(!r||!m||!m.deviceWidth) return;
    const sx=r.w/m.deviceWidth,sy=r.h/m.deviceHeight;
    const box=document.createElement('div');box.className='brv-act';
    box.style.left=(r.x+(a.x-a.w/2)*sx)+'px';box.style.top=(r.y+(a.y-a.h/2)*sy)+'px';
    box.style.width=Math.max(4,a.w*sx)+'px';box.style.height=Math.max(4,a.h*sy)+'px';
    const dot=document.createElement('div');dot.className='brv-act-dot';
    dot.style.left=(r.x+a.x*sx)+'px';dot.style.top=(r.y+a.y*sy)+'px';
    this.stage.append(box,dot);
    TIMERS.after(900,()=>{box.remove();dot.remove()},{owner:this,label:'brv-act'});
  }

  // ── 뷰포트 (FR-BRT-51·52) ──

  _onResize(){
    if(this._rsTimer) TIMERS.cancel(this._rsTimer);
    this._rsTimer=TIMERS.after(80,()=>{this._rsTimer=null;this._sendViewport(false)},{owner:this,label:'brv-resize'});
  }

  /** 창의 주인이면 이 뷰어의 크기를 페이지에 준다. 주인이 아니면 흐리게 그린다. */
  _sendViewport(force){
    const own=this.app.brvOwns(this.tabId,this.slot);
    this.el.classList.toggle('brv-dim',!own);
    if(!own||!this.visible) return;
    const w=Math.round(this.stage.clientWidth),h=Math.round(this.stage.clientHeight);
    if(w<50||h<50) return;
    const dpr=window.devicePixelRatio||1;
    const key=w+'x'+h+'@'+dpr;
    if(!force&&key===this._lastVp) return;
    this._lastVp=key;
    this._send({op:'viewport',w,h,dpr});
  }

  /** 소유권이 바뀌었다 — 흐림과 크기를 다시 본다. */
  ownerChanged(){this._sendViewport(true)}

  // ── 이동 (FR-BRT-58) ──

  nav(action,url){
    const m={op:'nav',action};
    if(url) m.url=url;
    this._send(m);
  }

  _submitAddress(){
    const u=browserAddressURL(this.addr.value);
    if(!u){
      this.addr.dataset.err='1';
      this.addr.classList.add('brv-addr-bad');
      this.addr.title=t('brv.bad_address');
      return;
    }
    delete this.addr.dataset.err;
    this.addr.classList.remove('brv-addr-bad');this.addr.title='';
    this.nav('goto',u);
    this.focus();
  }

  focusAddress(){this.addr.focus();this.addr.select()}

  setZoom(dir){
    let z=this.zoom||1;
    if(dir===0) z=1;
    else{
      const i=BRV_ZOOMS.findIndex(v=>v>=z-1e-6);
      const j=Math.max(0,Math.min(BRV_ZOOMS.length-1,(i<0?BRV_ZOOMS.length-1:i)+dir));
      z=BRV_ZOOMS[j];
    }
    this.zoom=z;
    this._send({op:'zoom',zoom:z});
  }

  _menu(ev){
    const r=this.menuBtn.getBoundingClientRect();
    UIKit.menu([
      {id:'zoomIn',label:t('brv.zoom_in'),onClick:()=>this.setZoom(1)},
      {id:'zoomOut',label:t('brv.zoom_out'),onClick:()=>this.setZoom(-1)},
      {id:'zoomReset',label:t('brv.zoom_reset')+' ('+Math.round((this.zoom||1)*100)+'%)',onClick:()=>this.setZoom(0)},
      {sep:true},
      // FR-BRT-52: 고정 크기 — 고정 중에는 창 주인의 크기를 따르지 않는다.
      ...BRV_FIXED_SIZES.map(v=>({id:'vp'+v.w+'x'+v.h,label:t('brv.viewport_fixed',{size:v.w+'×'+v.h}),
        onClick:()=>this._send({op:'viewport',w:v.w,h:v.h,dpr:1,fixed:true})})),
      {id:'vpAuto',label:t('brv.viewport_auto'),disabled:!this.state.viewport,onClick:()=>this._send({op:'viewport',fixed:false})},
      {sep:true},
      {id:'hardReload',label:t('brv.hard_reload'),onClick:()=>this._send({op:'nav',action:'reload',hard:true})},
      {id:'viewer',label:t('brv.open_viewer'),onClick:()=>{if(this.state.url) window.open(this.state.url,'_blank','noopener')}},
    ],{at:{x:r.left,y:r.bottom},cls:'brv-menu'});
  }

  // ── 입력 (FR-BRT-53~55) ──

  focus(){try{this.input.focus({preventScroll:true})}catch{}}

  /** 화면 좌표를 페이지 CSS 좌표로. 그린 적이 없으면 null. */
  _pagePoint(e){
    const r=this._rect,m=this.meta;
    if(!r||!m||!m.deviceWidth) return null;
    const b=this.canvas.getBoundingClientRect();
    const x=(e.clientX-b.left-r.x)/r.w*m.deviceWidth;
    const y=(e.clientY-b.top-r.y)/r.h*m.deviceHeight;
    if(x<0||y<0||x>m.deviceWidth||y>m.deviceHeight) return null;
    return {x,y};
  }

  _mouse(type,e,extra){
    const p=this._pagePoint(e);
    if(!p) return;
    this._send(Object.assign({op:'input',t:'mouse',type,x:p.x,y:p.y,mods:brvMods(e),buttons:e.buttons},extra||{}));
  }

  _wireInput(){
    const c=this.canvas,input=this.input;
    let clicks=0,lastDown=0,lastPos=null,touch=null;
    c.addEventListener('contextmenu',e=>e.preventDefault());
    c.addEventListener('pointerdown',e=>{
      this.app.brvTouched(this.tabId,this.slot);
      this.focus();
      if(e.pointerType==='touch'){touch={x:e.clientX,y:e.clientY,moved:false};return}
      e.preventDefault();
      c.setPointerCapture&&c.setPointerCapture(e.pointerId);
      const now=performance.now();
      const near=lastPos&&Math.abs(lastPos.x-e.clientX)<5&&Math.abs(lastPos.y-e.clientY)<5;
      clicks=(now-lastDown<500&&near)?clicks+1:1;
      lastDown=now;lastPos={x:e.clientX,y:e.clientY};
      this._mouse('mousePressed',e,{button:BRV_BUTTONS[e.button]||'left',clickCount:clicks});
    });
    c.addEventListener('pointermove',e=>{
      if(e.pointerType==='touch'){
        if(!touch) return;
        const dx=e.clientX-touch.x,dy=e.clientY-touch.y;
        if(!touch.moved&&Math.hypot(dx,dy)<8) return;
        touch.moved=true;
        const p=this._pagePoint(e);
        if(p) this._send({op:'input',t:'wheel',x:p.x,y:p.y,dx:-dx,dy:-dy,mods:0});
        touch.x=e.clientX;touch.y=e.clientY;
        return;
      }
      this._mouse('mouseMoved',e,{button:'none'});
    });
    c.addEventListener('pointerup',e=>{
      if(e.pointerType==='touch'){
        // 탭은 클릭이다 (FR-BRT-53).
        if(touch&&!touch.moved){
          this._mouse('mousePressed',e,{button:'left',clickCount:1,buttons:1});
          this._mouse('mouseReleased',e,{button:'left',clickCount:1,buttons:0});
        }
        touch=null;
        return;
      }
      this._mouse('mouseReleased',e,{button:BRV_BUTTONS[e.button]||'left',clickCount:clicks});
    });
    c.addEventListener('wheel',e=>{
      e.preventDefault();
      const p=this._pagePoint(e);
      if(!p) return;
      const k=e.deltaMode===1?16:e.deltaMode===2?this.stage.clientHeight:1;
      this._send({op:'input',t:'wheel',x:p.x,y:p.y,dx:e.deltaX*k,dy:e.deltaY*k,mods:brvMods(e)});
    },{passive:false});

    // 키는 숨긴 textarea 가 받는다. 전역 단축키와 탭 단축키는 창의 캡처 단계가 먼저
    // 가져간다 (input-binding.js, FR-BRT-56) — 여기 오는 것은 페이지의 것이다.
    const key=(type,e)=>{
      if(e.isComposing||e.keyCode===229||this._composing) return;
      // 붙여넣기는 이 기기의 클립보드다 — 키를 보내지 않고 paste 이벤트로 글을 넣는다 (FR-BRT-82).
      if(e.code==='KeyV'&&(IS_MAC?e.metaKey:e.ctrlKey)&&!e.altKey) return;
      e.preventDefault();
      // 누름을 보내지 않은 키(단축키가 가져갔다)의 뗌은 보내지 않는다 — 페이지에 짝 없는 keyup 이 간다.
      if(type==='keyDown') this._keysDown.add(e.code);
      else if(!this._keysDown.delete(e.code)) return;
      this._send({op:'input',t:'key',type,key:e.key,code:e.code,keyCode:e.keyCode,location:e.location,
        mods:brvMods(e),repeat:e.repeat,mac:IS_MAC});
    };
    input.addEventListener('keydown',e=>key('keyDown',e));
    input.addEventListener('keyup',e=>key('keyUp',e));
    // 한글 등 조합 입력 (FR-BRT-55, P5).
    input.addEventListener('compositionstart',()=>{this._composing=true});
    input.addEventListener('compositionupdate',e=>{this._send({op:'input',t:'ime',text:e.data||''})});
    input.addEventListener('compositionend',e=>{
      this._composing=false;
      this._send({op:'input',t:'insert',text:e.data||''});
      input.value='';
    });
    input.addEventListener('paste',e=>{
      const text=e.clipboardData&&e.clipboardData.getData('text/plain');
      e.preventDefault();
      if(text) this._send({op:'input',t:'insert',text});
    });
    // 조합이 아닌 글자 입력(모바일 가상 키보드 등)은 넣고 비운다.
    input.addEventListener('input',e=>{
      if(this._composing||e.isComposing) return;
      if(input.value){this._send({op:'input',t:'insert',text:input.value});input.value=''}
    });
  }
}

/**
 * 주소창의 입력을 열 주소로 (FR-BRT-41·65). http·https·file·about:blank 만 받는다.
 * 스킴 없이 적은 `host:port` 나 점 있는 호스트는 http 로 읽는다. 검색 엔진 연동은
 * 비목표다 — 그 밖은 null(거절 안내).
 */
function browserAddressURL(raw){
  const s=String(raw||'').trim();
  if(!s) return null;
  if(s==='about:blank') return s;
  const m=/^([a-z][a-z0-9+.-]*):/i.exec(s);
  if(m&&m[1].length>1&&!/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d/i.test(s)){
    const sc=m[1].toLowerCase();
    if(sc==='http'||sc==='https'){try{return new URL(s).host?s:null}catch{return null}}
    if(sc==='file') return s;
    return null;
  }
  if(/^(localhost|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?(\/.*)?$/i.test(s)) return 'http://'+s;
  // 서버의 절대 경로 — 주소창에는 기준 폴더가 없으므로 상대 경로는 받지 않는다 (FR-BRT-41·66).
  if(s.startsWith('/')) return 'file://'+s.split('/').map(encodeURIComponent).join('/');
  const w=/^([a-z]):[\\/](.*)$/i.exec(s);
  if(w) return 'file:///'+w[1].toUpperCase()+':/'+w[2].split(/[\\/]/).map(encodeURIComponent).join('/');
  return null;
}
