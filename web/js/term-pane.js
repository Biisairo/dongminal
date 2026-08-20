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
      const w=window.open(uri,'_blank');
      const pendingId=codeServerPending.get(uri);
      if(pendingId&&w){codeServerPending.delete(uri);codeServerTrack(pendingId,w)}
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
      let out=d;
      // Apply mobile sticky modifier (Ctrl/Alt) to virtual-keyboard input
      const A=window.app;
      if(A && A.isMobile && A._modKbd && out.length===1){
        const mk=A._modKbd;
        const c=out.charCodeAt(0);
        if(mk.ctrl && c>=0x40 && c<=0x7e) out=String.fromCharCode(c & 0x1f);
        if(mk.alt) out='\x1b'+out;
        let changed=false;
        if(mk.ctrl===true){mk.ctrl=false;changed=true}
        if(mk.alt===true){mk.alt=false;changed=true}
        if(changed){
          document.querySelectorAll('#mobile-keybar .mkb-btn[data-mod]').forEach(b=>{
            const mm=b.dataset.mod, st=mk[mm];
            b.classList.toggle('sticky', st===true);
            b.classList.toggle('locked', st==='lock');
          });
        }
      }
      const b=enc.encode(out);
      const m=new Uint8Array(1+b.length);m[0]=OP.INPUT;m.set(b,1);
      this._send(m);
    });
    this.term.onResize(({cols,rows})=>{
      // Only the OS-focused window that owns the pane's window may send resize.
      if(!window.app||!window.app._resizeCheck(this.id)) return;
      const m=new Uint8Array(5);m[0]=OP.RESIZE;
      new DataView(m.buffer).setUint16(1,cols,false);
      new DataView(m.buffer).setUint16(3,rows,false);
      this._send(m);
    });
    try{this.fit.fit()}catch{}
    for(const d of this._buf) try{this.term.write(d)}catch{}
    this._buf=[];
    if(this.term) this.term.scrollToBottom();
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
      else if(cmd==='OpenCodeServer') this._openCodeServer(val);
      else if(cmd==='CodeServerList') this._listCodeServers(val);
    }
    const clean=text.replace(/\x1b\]777;\w+;[^\x07]*\x07/g,'');
    if(this.term) try{this.term.write(clean||'')}catch{}
    else if(clean) this._buf.push(enc.encode(clean));
  }
  _onCwd(cwd){
    this._cwd=cwd;
    if(app)app._cwd=cwd;
    if(app)app._updateStatusBar();
  }
  _downloadFile(path){
    const a=document.createElement('a');
    a.href='/api/download?path='+encodeURIComponent(path);
    a.download='';document.body.appendChild(a);a.click();a.remove();
    this.term.write('\x1b[2m↓ Downloading: '+path+'\x1b[0m\r\n');
  }
  _listCodeServers(json){
    let list=[];
    try{list=JSON.parse(json)||[]}catch{}
    const T=this.term;
    const cols=Math.max(40,(T&&T.cols)||80);
    const line=ch=>ch.repeat(Math.min(cols-2,60));
    const fmtAge=s=>{
      s=s|0;
      if(s<60)return s+'s';
      if(s<3600)return Math.floor(s/60)+'m';
      const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
      return m?h+'h'+m+'m':h+'h';
    };
    const shortFolder=p=>{
      if(!p)return'';
      const max=Math.max(20,cols-20);
      return p.length<=max?p:'…'+p.slice(-(max-1));
    };
    T.write('\r\n');
    if(!list.length){
      T.write('  \x1b[2m─── \x1b[0m\x1b[36mcode-server\x1b[0m \x1b[2m──────── (없음) ─\x1b[0m\r\n');
      T.write('  \x1b[2m   `edit <path>` 로 새 인스턴스 생성\x1b[0m\r\n\r\n');
      return;
    }
    const maxId=Math.max(2,...list.map(x=>x.id.length));
    const maxAge=Math.max(3,...list.map(x=>fmtAge(x.age||0).length));
    T.write(`  \x1b[2m─── \x1b[0m\x1b[1;36mcode-server\x1b[0m \x1b[2m── ${list.length}개 활성 ${line('─').slice(12+String(list.length).length)}\x1b[0m\r\n`);
    for(const it of list){
      const url=location.origin+it.path+'?folder='+encodeURIComponent(it.folder);
      codeServerPending.set(url,it.id);
      const id=it.id.padEnd(maxId,' ');
      const age=fmtAge(it.age||0).padStart(maxAge,' ');
      T.write('\r\n');
      T.write(`  \x1b[32m●\x1b[0m \x1b[1;33m${id}\x1b[0m  \x1b[2m${age}\x1b[0m  \x1b[37m${shortFolder(it.folder)}\x1b[0m\r\n`);
      T.write(`    ${' '.repeat(maxId)}\x1b[2m↳\x1b[0m  \x1b[4;38;5;75m${url}\x1b[0m\r\n`);
    }
    T.write(`  \x1b[2m${line('─')}\x1b[0m\r\n`);
    T.write(`  \x1b[2m URL 클릭 → 해당 인스턴스 열기   ·   edit stop <id|all> 로 종료\x1b[0m\r\n\r\n`);
  }
  _openCodeServer(val){
    // val = "id|path|folder"
    const parts=val.split('|');
    if(parts.length<2)return;
    const id=parts[0], csPath=parts[1], folder=parts.slice(2).join('|');
    const url=location.origin+csPath+'?folder='+encodeURIComponent(folder);
    // FR-E2: 같은 id 의 살아있는 창이 이미 있으면 새 창을 열지 않는다.
    const existing=codeServerWatchers.get(id);
    if(existing&&existing.win&&!existing.win.closed){
      try{existing.win.focus()}catch{}
      this.term.write('\x1b[36m[edit] 이미 열려 있음: '+url+'\x1b[0m\r\n');
      return;
    }
    const open=()=>{
      const w=window.open(url,'_blank');
      if(w){codeServerTrack(id,w);return true}
      return false;
    };
    if(!open()){
      // popup blocker — 터미널에 클릭 가능한 링크 표시 (사용자 제스처로 재시도)
      this.term.write('\x1b[33m[edit] 팝업이 차단됨 — 아래 URL 클릭: '+url+'\x1b[0m\r\n');
      codeServerPending.set(url,id);
    } else {
      this.term.write('\x1b[36m[edit] VSCode 열림: '+url+'\x1b[0m\r\n');
    }
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
