/**
 * Remote Terminal — xterm + WebSocket pane
 */

class TerminalTool {
  constructor(id, name) {
    this.id=id; this.name=name;
    this.ws=null; this.term=null; this.fit=null; this._opened=false; this._buf=[]; this._reconnecting=false; this._destroyed=false; this._retryDelay=0;
    this._sendQueue=[]; this._sendQueueMax=64; this._sendDropCount=0;
    this._decoder=new TextDecoder('utf-8',{fatal:false}); this._outputBuf=''; this._flushScheduled=false;
    this.el=document.createElement('div');
    this.el.className='tp'; this.el.dataset.toolid=id;
    this.box=document.createElement('div');
    this.box.style.cssText='width:100%;height:100%';
    this.el.appendChild(this.box);
    // Drag & drop upload
    this.el.addEventListener('dragover',e=>{e.preventDefault();if([...e.dataTransfer.types].includes('Files')){e.stopPropagation();this.el.classList.add('dragover')}});
    this.el.addEventListener('dragleave',()=>this.el.classList.remove('dragover'));
    this.el.addEventListener('drop',e=>{if(!e.dataTransfer.files||!e.dataTransfer.files.length)return;e.preventDefault();e.stopPropagation();this.el.classList.remove('dragover');this._uploadFiles(e.dataTransfer.files)});
  }
  open() {
    if(this._opened) return; this._opened=true;
    this.term=new Terminal(TOPTS);
    this.fit=new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try{this.term.loadAddon(new WebLinksAddon.WebLinksAddon((_e,uri)=>{
      window.open(uri,'_blank');
    }))}catch(e){}
    try{this.term.loadAddon(new Unicode11Addon.Unicode11Addon());this.term.unicode.activeVersion='11'}catch(e){}
    try{this.search=new SearchAddon.SearchAddon();this.term.loadAddon(this.search)}catch(e){}
    this.term.open(this.box);
    this.term.attachCustomKeyEventHandler(e=>{
      if(e.key==='Enter'&&e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey){
        if(e.type==='keydown') this._send(new Uint8Array([OP.INPUT,0x1b,0x0d]));
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return true;
    });
    // Block browser Ctrl+ shortcuts → let them go to terminal
    // Cmd+ shortcuts left for browser (copy/paste/tab close etc)
    this.box.addEventListener('keydown',e=>{
      // Cmd+Left/Right → Home/End
      if(e.metaKey&&!e.ctrlKey&&!e.altKey){
        if(e.key==='ArrowLeft'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x01]));return}
        if(e.key==='ArrowRight'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x05]));return}
      }
      // Alt+Left/Right → word jump
      if(e.altKey&&!e.ctrlKey&&!e.metaKey){
        if(e.key==='ArrowLeft'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x1b,0x62]));return}
        if(e.key==='ArrowRight'){e.preventDefault();this._send(new Uint8Array([OP.INPUT,0x1b,0x66]));return}
      }
      // Ctrl+ shortcuts → bypass to terminal, block browser
      if(e.ctrlKey&&!e.metaKey) e.preventDefault();
    });
    this.term.onData(d=>{
      this._sendText(this._applyStickyMods(d));
    });
    this.term.onResize(({cols,rows})=>{
      // Only the OS-focused window that owns the pane's window may send resize.
      if(!window.app||!window.app._resizeCheck(this.id)) return;
      const m=new Uint8Array(5);m[0]=OP.RESIZE;
      new DataView(m.buffer).setUint16(1,cols,false);
      new DataView(m.buffer).setUint16(3,rows,false);
      this._send(m);
    });
    // FR-MTI-1: 모바일 소프트 키보드 입력을 xterm 의 CompositionHelper 경로에서
    // 떼어낸다. 그 경로는 setTimeout(0) 뒤에 누적된 textarea 값을 diff 하므로,
    // 같은 tick 에 두 글자가 오면 중복 전송하고(a,b,c → "abc","bc","c"),
    // Enter 가 textarea 를 비우면 직전 글자를 잃는다. beforeinput 을 취소하면
    // textarea 값이 변하지 않아 그 diff 가 항상 빈 값이 된다.
    const ta=this.box.querySelector('.xterm-helper-textarea');
    if(ta){
      // FR-MTI-19: 물리 키보드로 들어온 키는 xterm 이 이미 전송한다. 그 키에
      // 딸린 beforeinput 까지 우리가 보내면 글자가 두 번 들어간다. 두 신호로
      // 판정한다 — 둘 중 하나만으로는 새지 않는 경로가 남는다:
      //   · keydown 이 preventDefault 됐다 → xterm 이 _keyDown 에서 전송했다
      //   · keypress 가 왔다 → xterm 이 _keyPress 에서 전송했다. Space 가 이
      //     경로이며 preventDefault 를 하지 않아 beforeinput 이 그대로 온다
      // 소프트 키보드는 keypress 를 내지 않으므로 두 경로가 정확히 갈린다.
      ta.addEventListener('keydown',e=>{this._xtHandledKey=e.defaultPrevented},false);
      ta.addEventListener('keypress',()=>{this._xtHandledKey=true},false);
      ta.addEventListener('keyup',()=>{this._xtHandledKey=false},false);
      ta.addEventListener('beforeinput',e=>this._onBeforeInput(e),true);
    }
    this._initTouchScroll();
    try{this.fit.fit()}catch{}
    for(const d of this._buf) try{this.term.write(d)}catch{}
    this._buf=[];
    if(this.term) this.term.scrollToBottom();
  }

  // ── 입력 (MOBILE_TUI_INPUT_SCROLL_SRS §3.1 / §3.5) ──

  _sendText(s){
    if(!s) return;
    const b=enc.encode(s);
    const m=new Uint8Array(1+b.length);m[0]=OP.INPUT;m.set(b,1);
    this._send(m);
  }

  // FR-MTI-15~17: sticky 는 입력 길이와 무관하게 첫 코드포인트로 판정하고,
  // 대상이 아니어도 소비한다 — 잔존하면 다음 입력을 오염시킨다.
  _applyStickyMods(s){
    const A=window.app;
    if(!(A && A.isMobile && A._modKbd)) return s;
    const mk=A._modKbd;
    if(!mk.ctrl && !mk.alt) return s;
    let out=s;
    const c=out.codePointAt(0);
    if(mk.ctrl && c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f)+out.slice(1);
    if(mk.alt && c>=0x20 && c<=0x7e) out='\x1b'+out;
    let changed=false;
    if(mk.ctrl===true){mk.ctrl=false;changed=true}
    if(mk.alt===true){mk.alt=false;changed=true}
    if(changed && A._mkbRefresh) A._mkbRefresh();
    return out;
  }

  _onBeforeInput(e){
    const handled=this._xtHandledKey;
    this._xtHandledKey=false;                     // 일회 소비
    const A=window.app;
    if(!A || !A.isMobile) return;                 // FR-MTI-4
    if(e.inputType!=='insertText') return;        // FR-MTI-3
    if(e.isComposing) return;                     // FR-MTI-2
    if(handled) return;                           // FR-MTI-19
    if(!e.data) return;
    e.preventDefault();
    this._sendText(this._applyStickyMods(e.data));
  }

  // ── 터치 스크롤 (MOBILE_TUI_INPUT_SCROLL_SRS §3.2) ──

  // FR-MTI-8: capture 단계에서 가로채 xterm 의 1:1 터치 경로와 선택 경로에
  // 도달하지 않게 한다. xterm 쪽은 감도 배율도 관성도 없다.
  _initTouchScroll(){
    const opt={capture:true,passive:false};
    this.el.addEventListener('touchstart',e=>this._tsStart(e),opt);
    this.el.addEventListener('touchmove',e=>this._tsMove(e),opt);
    this.el.addEventListener('touchend',e=>this._tsEnd(e),opt);
    this.el.addEventListener('touchcancel',e=>this._tsEnd(e),opt);
  }

  _tsMobile(){return !!(window.app && window.app.isMobile)}

  _tsStart(e){
    this._flingStop();
    this._tsY0=null;
    if(!this._tsMobile()) return;
    if(!e.touches || e.touches.length!==1) return;
    this._tsY0=e.touches[0].clientY;
    this._tsY=this._tsY0;
    this._tsActive=false;this._tsResid=0;this._tsV=0;
  }

  _tsMove(e){
    if(this._tsY0===null||this._tsY0===undefined) return;
    if(!this._tsMobile()) return;
    if(!e.touches || e.touches.length!==1) return;
    const y=e.touches[0].clientY;
    if(!this._tsActive){
      // FR-MTI-9: slop 이내는 탭이다 — 그대로 통과시켜 포커스·선택을 남긴다.
      if(Math.abs(y-this._tsY0)<MTI_TOUCH_SLOP_PX) return;
      this._tsActive=true;
      this._tsY=y;   // slop 소진분은 버린다. 시작이 튀지 않는다
    }
    const dy=this._tsY-y;
    this._tsY=y;this._tsV=dy;
    e.preventDefault();e.stopPropagation();
    this._touchScrollBy(dy*MTI_TOUCH_GAIN);
  }

  _tsEnd(e){
    const wasActive=this._tsActive;
    this._tsY0=null;this._tsActive=false;
    if(!wasActive) return;
    e.preventDefault();e.stopPropagation();
    // FR-MTI-7: 마지막 관측 속도에서 시작해 프레임마다 감쇠한다.
    let v=this._tsV*MTI_TOUCH_GAIN;
    if(Math.abs(v)>MTI_FLING_MAX_V) v=v<0?-MTI_FLING_MAX_V:MTI_FLING_MAX_V;
    if(Math.abs(v)<MTI_FLING_MIN_V) return;
    const step=()=>{
      this._flingId=null;
      this._touchScrollBy(v);
      v*=MTI_FLING_DECAY;
      if(Math.abs(v)<MTI_FLING_MIN_V) return;
      this._flingId=requestAnimationFrame(step);
    };
    this._flingId=requestAnimationFrame(step);
  }

  _flingStop(){
    if(this._flingId){cancelAnimationFrame(this._flingId);this._flingId=null}
  }

  _rowHeightPx(){
    const sc=this.el.querySelector('.xterm-screen');
    if(sc && this.term && this.term.rows>0){
      const h=sc.clientHeight/this.term.rows;
      if(h>0) return h;
    }
    return 0;
  }

  // FR-MTI-10: scrollLines 로 ydisp 와 DOM scrollTop 을 함께 움직이고,
  // 행에 못 미친 픽셀은 누적해 다음 이동에서 쓴다.
  _touchScrollBy(px){
    if(!this.term) return;
    const rowH=this._rowHeightPx();
    if(!(rowH>0)) return;
    this._tsResid=(this._tsResid||0)+px;
    const lines=Math.trunc(this._tsResid/rowH);
    if(!lines) return;
    this._tsResid-=lines*rowH;
    try{this.term.scrollLines(lines)}catch{}
  }
  connect() {
    const p=location.protocol==='https:'?'wss:':'ws:';
    const cols=(this.term&&this.term.cols)||120;
    const rows=(this.term&&this.term.rows)||40;
    const url=`${p}//${location.host}/ws?cols=${cols}&rows=${rows}&tool=${encodeURIComponent(this.id)}`;
    this.ws=new WebSocket(url); this.ws.binaryType='arraybuffer';
    this.ws.onopen=()=>{
      if(this.term && window.app && window.app._resizeCheck(this.id)){
        const m=new Uint8Array(5);m[0]=OP.RESIZE;
        new DataView(m.buffer).setUint16(1,this.term.cols,false);
        new DataView(m.buffer).setUint16(3,this.term.rows,false);
        this._send(m);
      }
      this._flushSendQueue();
      if(this._reconnecting){
        setTimeout(()=>{this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},300);
      }
    };
    this.ws.onmessage=e=>{
      const d=new Uint8Array(e.data); if(!d.length) return;
      if(d[0]===OP.OUTPUT){
        this._handleOutput(d.subarray(1));
      } else if(d[0]===OP.TOOLID){
        this.id=dec.decode(d.subarray(1)); this.el.dataset.toolid=this.id;
      } else if(d[0]===OP.EXIT){
        this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
      } else if(d[0]===OP.ERROR){
        this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n');
      }
    };
    this.ws.onclose=()=>{
      if(this._destroyed) return;
      this._showOverlay('연결 끊김', '재연결 중...');
      this._scheduleReconnect();
    };
    this.ws.onerror=()=>{
      if(this._destroyed) return;
      this._showOverlay('연결 오류', '재연결 중...');
      this._scheduleReconnect();
    };
  }
  _scheduleReconnect(){
    if(this._destroyed||this._reconnectPending) return;
    this._reconnectPending=true;
    if(this.ws){try{this.ws.onclose=null;this.ws.onerror=null;this.ws.onmessage=null;this.ws.close()}catch{}this.ws=null}
    // Reset decoder state so any half-received multibyte sequence from the
    // dead connection doesn't get spliced with bytes from the new one.
    try{this._decoder=new TextDecoder('utf-8',{fatal:false});this._outputBuf=''}catch{}
    this._reconnect();
  }
  write(s){if(this.term)try{this.term.write(s)}catch{}else this._buf.push(s)}
  doFit(){if(this.fit)try{this.fit.fit()}catch{}}
  focus(){if(this.term)try{this.term.focus()}catch{}}
  _reconnect(){
    if(this._destroyed) return;
    // Instant first attempt, then fast backoff: 200, 500, 1s, 1.2x up to 10s.
    let delay=this._retryDelay;
    if(this._retryDelay===0){ delay=0; this._retryDelay=200 }
    else if(this._retryDelay<=500){ this._retryDelay=Math.min(this._retryDelay*2.5,1000) }
    else{ this._retryDelay=Math.min(this._retryDelay*1.2,10000) }
    setTimeout(()=>{
      if(this._destroyed) return;
      const p=location.protocol==='https:'?'wss:':'ws:';
      const cols=(this.term&&this.term.cols)||120;
      const rows=(this.term&&this.term.rows)||40;
      const url=`${p}//${location.host}/ws?cols=${cols}&rows=${rows}&tool=${encodeURIComponent(this.id)}`;
      const ws=new WebSocket(url); ws.binaryType='arraybuffer';
      this._pendingWs=ws;
      this._reconnectPending=false;
      ws.onopen=()=>{
        this.ws=ws; this._retryDelay=0;
        this._pendingWs=null;
        if(this.term && window.app && window.app._resizeCheck(this.id)){
          const m=new Uint8Array(5);m[0]=OP.RESIZE;
          new DataView(m.buffer).setUint16(1,this.term.cols,false);
          new DataView(m.buffer).setUint16(3,this.term.rows,false);
          this._send(m);
        }
        this._flushSendQueue();
        setTimeout(()=>{this._hideOverlay();this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},300);
      };
      ws.onmessage=e=>{
        const d=new Uint8Array(e.data); if(!d.length) return;
        if(d[0]===OP.OUTPUT){ this._handleOutput(d.subarray(1)); }
        else if(d[0]===OP.TOOLID){ this.id=dec.decode(d.subarray(1));this.el.dataset.toolid=this.id; }
        else if(d[0]===OP.EXIT){ this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n'); }
        else if(d[0]===OP.ERROR){ this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n'); }
      };
      ws.onclose=()=>{
        if(this._destroyed)return;
        if(this.ws&&this.ws!==ws) return;
        if(this.ws===ws) this.ws=null;
        this._showOverlay('연결 끊김','재연결 중...');
        this._scheduleReconnect();
      };
      ws.onerror=()=>{
        if(this._destroyed)return;
        if(this.ws&&this.ws!==ws) return;
        this._showOverlay('연결 오류','재연결 중...');
        this._scheduleReconnect();
      };
    },delay);
  }
  _showOverlay(title,sub){
    let ov=this.el.querySelector('.tp-overlay');
    if(!ov){ov=document.createElement('div');ov.className='tp-overlay';this.el.appendChild(ov)}
    ov.innerHTML=`<div class="tp-ov-title">${title}</div><div class="tp-ov-sub">${sub}</div>`;
    ov.classList.add('visible');
  }
  _hideOverlay(){
    const ov=this.el.querySelector('.tp-overlay');
    if(ov)ov.classList.remove('visible');
  }
  _handleOutput(data){
    // stream:true preserves UTF-8 multibyte state across WS chunk boundaries
    this._outputBuf+=this._decoder.decode(data,{stream:true});
    if(this._flushScheduled) return;
    this._flushScheduled=true;
    // Use setTimeout instead of requestAnimationFrame so output flushes
    // even when the browser tab is hidden/backgrounded.
    setTimeout(()=>this._doFlush(),0);
  }
  _doFlush(){
    this._flushScheduled=false;
    const text=this._outputBuf; this._outputBuf='';
    if(!text) return;
    const re=/\x1b\]777;(\w+);([^\x07]*)\x07/g;
    let m;
    while((m=re.exec(text))!==null){
      const cmd=m[1],val=m[2];
      if(cmd==='Download') this._downloadFile(val);
      else if(cmd==='Cwd') this._onCwd(val);
    }
    const clean=text.replace(/\x1b\]777;\w+;[^\x07]*\x07/g,'');
    if(this.term) try{this.term.write(clean||'')}catch{}
    else if(clean) this._buf.push(enc.encode(clean));
  }
  _onCwd(cwd){
    this._cwd=cwd;
    if(app)app._cwd=cwd;
    if(app)app._updateStatusBar();
    // precmd·에이전트 hook 은 같은 OSC 경로를 탄다 — 셸 명령 직후의 즉시 신호다 (FR-GIT-18).
    if(app)app._gitSignal('cwd');
  }
  _downloadFile(path){
    const a=document.createElement('a');
    a.href='/api/download?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    this.term.write('\x1b[2m↓ Downloading: '+path+'\x1b[0m\r\n');
  }
  _uploadFiles(files){
    if(!files||!files.length)return;
    // Get cwd from server for this pane
    fetch('/api/cwd?tool='+this.id).then(r=>r.json()).then(({cwd})=>{
      let i=0;
      const uploadNext=()=>{
        if(i>=files.length){this._send(new Uint8Array([OP.INPUT,0x0d]));return;}
        const f=files[i++];
        const fd=new FormData();fd.append('file',f);
        this.term.write('\x1b[2m↑ Uploading: '+f.name+'\x1b[0m\r\n');
        fetch('/api/upload?dir='+encodeURIComponent(cwd),{method:'POST',body:fd})
          .then(r=>r.json()).then(d=>{
            this.term.write('\x1b[2m  ✓ '+d.name+' ('+this._fmtSize(d.size)+')\x1b[0m\r\n');
            uploadNext();
          }).catch(()=>{
            this.term.write('\x1b[31m  ✗ Upload failed\x1b[0m\r\n');uploadNext();
          });
      };
      uploadNext();
    });
  }
  _fmtSize(b){
    if(b<1024)return b+'B';
    if(b<1048576)return(b/1024).toFixed(1)+'KB';
    return(b/1048576).toFixed(1)+'MB';
  }
  destroy(){
    this._destroyed=true;
    this._flingStop();
    if(this._pendingWs&&this._pendingWs!==this.ws){
      try{this._pendingWs.onopen=null;this._pendingWs.onclose=null;this._pendingWs.onerror=null;this._pendingWs.onmessage=null;this._pendingWs.close()}catch{}
      this._pendingWs=null;
    }
    if(this.ws){this.ws.onclose=null;this.ws.onerror=null;this.ws.close();this.ws=null}
    if(this.term){this.term.dispose();this.term=null}
    this.el.remove(); this._opened=false;
  }
  _send(m){
    const ws=this.ws;
    if(ws&&ws.readyState===1){ws.send(m);return}
    if(ws&&ws.readyState===0){
      if(this._sendQueue.length>=this._sendQueueMax){this._sendQueue.shift();this._sendDropCount++}
      this._sendQueue.push(m);
      return;
    }
    this._sendDropCount++;
  }
  _flushSendQueue(){
    if(!this.ws||this.ws.readyState!==1)return;
    const q=this._sendQueue;this._sendQueue=[];
    for(const m of q){this.ws.send(m)}
  }
}
