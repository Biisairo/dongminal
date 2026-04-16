/**
 * Remote Terminal — cmux style
 * Session → LayoutTree(Region|Split), Region has own tab bar + terminal
 */

const OP={INPUT:0,RESIZE:1,OUTPUT:0,ERROR:1,EXIT:2,SID:3};
const enc=new TextEncoder(), dec=new TextDecoder();
const THEME={
  background:'#1a1b26',foreground:'#a9b1d6',cursor:'#c0caf5',cursorAccent:'#1a1b26',
  selectionBackground:'#33467c',selectionForeground:'#c0caf5',
  black:'#15161e',red:'#f7768e',green:'#9ece6a',yellow:'#e0af68',
  blue:'#7aa2f7',magenta:'#bb9af7',cyan:'#7dcfff',white:'#a9b1d6',
  brightBlack:'#414868',brightRed:'#f7768e',brightGreen:'#9ece6a',
  brightYellow:'#e0af68',brightBlue:'#7aa2f7',brightMagenta:'#bb9af7',
  brightCyan:'#7dcfff',brightWhite:'#c0caf5',
};
const TOPTS={
  scrollback:50000,cursorBlink:true,cursorStyle:'block',
  fontSize:14,lineHeight:1.2,allowProposedApi:true,logLevel:'off',
  fontFamily:"'Menlo','Monaco','Consolas','Liberation Mono','Courier New',monospace",
  theme:THEME,
};

// ═══ TermPane: xterm + WebSocket ═══

class TermPane {
  constructor(id, name) {
    this.id=id; this.name=name;
    this.ws=null; this.term=null; this.fit=null; this._opened=false; this._buf=[]; this._reconnecting=false;
    this.el=document.createElement('div');
    this.el.className='tp'; this.el.dataset.pid=id;
    this.box=document.createElement('div');
    this.box.style.cssText='width:100%;height:100%';
    this.el.appendChild(this.box);
  }
  open() {
    if(this._opened) return; this._opened=true;
    console.log('[TermPane] open', this.id);
    this.term=new Terminal(TOPTS);
    this.fit=new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    try{this.term.loadAddon(new WebLinksAddon.WebLinksAddon())}catch(e){}
    try{this.term.loadAddon(new Unicode11Addon.Unicode11Addon());this.term.unicode.activeVersion='11'}catch(e){}
    this.term.open(this.box);
    this.term.onData(d=>{
      const b=enc.encode(d);
      const m=new Uint8Array(1+b.length);m[0]=OP.INPUT;m.set(b,1);
      this._send(m);
    });
    this.term.onResize(({cols,rows})=>{
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
    const url=`${p}//${location.host}/ws?cols=120&rows=40&pane=${encodeURIComponent(this.id)}`;
    console.log('[TermPane] connect', url);
    this.ws=new WebSocket(url); this.ws.binaryType='arraybuffer';
    this.ws.onopen=()=>{
      // Send actual terminal size so server can resize PTY correctly
      if(this.term){
        const m=new Uint8Array(5);m[0]=OP.RESIZE;
        new DataView(m.buffer).setUint16(1,this.term.cols,false);
        new DataView(m.buffer).setUint16(3,this.term.rows,false);
        this._send(m);
      }
      // Reveal terminal after SIGWINCH redraw completes
      if(this._reconnecting){
        setTimeout(()=>{this.el.style.opacity='1';this._reconnecting=false;if(this.term)this.term.scrollToBottom()},300);
      }
    };
    this.ws.onmessage=e=>{
      const d=new Uint8Array(e.data); if(!d.length) return;
      if(d[0]===OP.OUTPUT){
        if(this.term) try{this.term.write(d.subarray(1))}catch{}
        else this._buf.push(new Uint8Array(d.subarray(1)));
      } else if(d[0]===OP.SID){
        this.id=dec.decode(d.subarray(1)); this.el.dataset.pid=this.id;
      } else if(d[0]===OP.EXIT){
        this.write('\r\n\x1b[90m── exited ──\x1b[0m\r\n');
      } else if(d[0]===OP.ERROR){
        this.write('\r\n\x1b[31m'+dec.decode(d.subarray(1))+'\x1b[0m\r\n');
      }
    };
    this.ws.onclose=()=>this.write('\r\n\x1b[90m── disconnected ──\x1b[0m\r\n');
    this.ws.onerror=()=>console.error('[TermPane] ws error', this.id);
  }
  write(s){if(this.term)try{this.term.write(s)}catch{}else this._buf.push(s)}
  doFit(){if(this.fit)try{this.fit.fit()}catch{}}
  focus(){if(this.term)try{this.term.focus()}catch{}}
  destroy(){
    if(this.ws){this.ws.onclose=null;this.ws.onerror=null;this.ws.close();this.ws=null}
    if(this.term){this.term.dispose();this.term=null}
    this.el.remove(); this._opened=false;
  }
  _send(m){if(this.ws&&this.ws.readyState===1)this.ws.send(m)}
}

// ═══ Layout helpers ═══

function doSplit(n,rid,nr,dir){
  if(n.type==='region') return n.id===rid?{type:'split',direction:dir,children:[n,nr]}:n;
  if(n.children) n.children=n.children.map(c=>doSplit(c,rid,nr,dir));
  return n;
}
function doRemove(n,rid){
  if(!n) return null;
  if(n.type==='region') return n.id===rid?null:n;
  if(!n.children) return null;
  n.children=n.children.map(c=>doRemove(c,rid)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}
function findRg(n,rid){
  if(!n) return null;
  if(n.type==='region') return n.id===rid?n:null;
  if(n.children) for(const c of n.children){const f=findRg(c,rid);if(f)return f}
  return null;
}
function firstRg(n){
  if(!n) return null;
  if(n.type==='region') return n;
  if(n.children) for(const c of n.children){const f=firstRg(c);if(f)return f}
  return null;
}
function allPids(n){
  if(!n) return [];
  if(n.type==='region') return (n.tabs||[]).map(t=>t.paneId);
  if(n.children) return n.children.flatMap(c=>allPids(c));
  return [];
}
function clean(n,ok){
  if(!n) return null;
  if(n.type==='region'){
    if(n.tabs) n.tabs=n.tabs.filter(t=>ok.has(t.paneId));
    if(!n.tabs||!n.tabs.length) return null;
    if(!n.tabs.find(t=>t.id===n.activeTab)) n.activeTab=n.tabs[0].id;
    return n;
  }
  if(!n.children) return null;
  n.children=n.children.map(c=>clean(c,ok)).filter(Boolean);
  if(!n.children.length) return null;
  if(n.children.length===1) return n.children[0];
  return n;
}

// ═══ App ═══

class App {
  constructor(){
    this.panes=new Map();
    this.ws={sessions:[],activeSession:null};
    this.focused=null;
    this._s=0;this._r=0;this._t=0;this._kb=false;
  }

  async init(){
    console.log('[App] init start');
    try{
      const st=await(await fetch('/api/state')).json();
      const sp=st.panes||[];
      const sv=st.workspace;
      const ok=new Set(sp.map(p=>p.id));
      for(const p of sp){const pane=this._mkPane(p.id,p.name);pane._reconnecting=true;pane.el.style.opacity='0'}
      if(sv&&sv.sessions&&sv.sessions.length){
        this.ws=sv;
        for(const s of this.ws.sessions){
          if(!s||!s.id) continue;
          const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;
          s.layout=clean(s.layout,ok);
          if(s.layout) this._rids(s.layout);
        }
        this.ws.sessions=this.ws.sessions.filter(s=>s&&s.layout);
        if(!this.ws.sessions.find(s=>s.id===this.ws.activeSession))
          this.ws.activeSession=this.ws.sessions[0]?.id||null;
      }
      if(!this.ws.sessions.length) await this._mkSession();
    }catch(e){
      console.error('[App] init error:',e);
      if(!this.ws.sessions.length) await this._mkSession();
    }
    const a=this._as();
    if(a&&a.layout){const f=firstRg(a.layout);if(f)this.focused=f.id}
    this.render();
    this._bind();
    console.log('[App] init done, sessions:', this.ws.sessions.length);
  }

  _rids(n){
    if(!n) return;
    if(n.type==='region'){
      const r=parseInt((n.id||'').replace(/\D/g,''),10);if(r>this._r)this._r=r;
      if(n.tabs) for(const t of n.tabs){const x=parseInt((t.id||'').replace(/\D/g,''),10);if(x>this._t)this._t=x}
      return;
    }
    if(n.children) for(const c of n.children) this._rids(c);
  }

  _mkPane(id,name){
    if(this.panes.has(id)) return this.panes.get(id);
    const p=new TermPane(id,name);
    document.getElementById('area').appendChild(p.el);
    p.connect();
    this.panes.set(id,p);
    console.log('[App] pane created:', id);
    return p;
  }

  async _newPane(){
    const r=await fetch('/api/panes?cols=120&rows=40',{method:'POST'});
    if(!r.ok) throw new Error('create pane failed');
    const {id,name}=await r.json();
    return this._mkPane(id,name);
  }

  async _kill(pid){
    const p=this.panes.get(pid);
    if(p){p.destroy();this.panes.delete(pid)}
    try{await fetch(`/api/panes/${pid}`,{method:'DELETE'})}catch{}
  }

  _as(){return this.ws.sessions.find(s=>s.id===this.ws.activeSession)||null}

  async _mkSession(){
    const p=await this._newPane();
    const r=`r${++this._r}`,t=`t${++this._t}`;
    const s={
      id:`s${++this._s}`,name:'Session',
      layout:{type:'region',id:r,tabs:[{id:t,name:'Shell',paneId:p.id}],activeTab:t}
    };
    this.ws.sessions.push(s);
    this.ws.activeSession=s.id;
    this.focused=r;
    await this._save();
    console.log('[App] session created:', s.id);
  }

  async addSession(){await this._mkSession();this.render()}

  async delSession(sid){
    const i=this.ws.sessions.findIndex(s=>s.id===sid);
    if(i<0) return;
    const s=this.ws.sessions[i];
    for(const pid of allPids(s.layout)) this._kill(pid);
    this.ws.sessions.splice(i,1);
    if(!this.ws.sessions.length){await this._mkSession();this.render();return}
    if(this.ws.activeSession===sid)
      this.ws.activeSession=this.ws.sessions[Math.min(i,this.ws.sessions.length-1)].id;
    const a=this._as(); this.focused=a?firstRg(a.layout)?.id:null;
    await this._save(); this.render();
  }

  switchSession(sid){
    if(this.ws.activeSession===sid) return;
    this.ws.activeSession=sid;
    const a=this._as(); this.focused=a?firstRg(a.layout)?.id:null;
    this._save(); this.render();
  }

  async addTab(rid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    const p=await this._newPane();
    const t=`t${++this._t}`;
    rg.tabs.push({id:t,name:'Shell',paneId:p.id});
    rg.activeTab=t;
    await this._save(); this.render();
  }

  async closeTab(rid,tid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    const tab=rg.tabs.find(t=>t.id===tid); if(!tab) return;
    await this._kill(tab.paneId);
    rg.tabs=rg.tabs.filter(t=>t.id!==tid);
    if(!rg.tabs.length){
      s.layout=doRemove(s.layout,rid);
      if(!s.layout){await this.delSession(s.id);return}
      this.focused=firstRg(s.layout)?.id||null;
    } else {
      if(rg.activeTab===tid) rg.activeTab=rg.tabs[0].id;
    }
    await this._save(); this.render();
  }

  switchTab(rid,tid){
    const s=this._as(); if(!s) return;
    const rg=findRg(s.layout,rid); if(!rg) return;
    if(rg.activeTab===tid) return;
    rg.activeTab=tid; this.focused=rid;
    this._save(); this.render();
  }

  async split(dir){
    const s=this._as(); if(!s||!this.focused) return;
    const p=await this._newPane();
    const r=`r${++this._r}`,t=`t${++this._t}`;
    const nr={type:'region',id:r,tabs:[{id:t,name:'Shell',paneId:p.id}],activeTab:t};
    s.layout=doSplit(s.layout,this.focused,nr,dir);
    this.focused=r;
    await this._save(); this.render();
  }

  setFocus(rid){
    if(this.focused===rid) return;
    this.focused=rid;
    document.querySelectorAll('.rg').forEach(el=>{
      el.classList.toggle('focused',el.dataset.rid===rid);
    });
  }

  async _save(){
    try{await fetch('/api/workspace',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(this.ws)})}catch{}
  }

  _rename(obj, el){
    const old = obj.name;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = old;
    input.className = 'rename-input';
    el.replaceWith(input);
    input.focus();
    input.select();
    const done = () => {
      const v = input.value.trim();
      if(v && v !== old) { obj.name = v; this._save(); }
      this.render();
    };
    input.addEventListener('blur', done, {once:true});
    input.addEventListener('keydown', e => {
      if(e.key==='Enter'){e.preventDefault();input.blur()}
      if(e.key==='Escape'){input.value=old;input.blur()}
    });
  }

  // ── Render ──

  render(){
    this._rSidebar();
    this._rTopbar();
    this._rLayout();
  }

  _rSidebar(){
    const el=document.getElementById('sessions'); el.innerHTML='';
    for(const s of this.ws.sessions){
      const d=document.createElement('div');
      d.className='si'+(s.id===this.ws.activeSession?' active':'');
      d.innerHTML=`<span class="si-dot"></span><span class="si-name">${s.name}</span><span class="si-x">×</span>`;
      d.addEventListener('click',e=>{if(!e.target.classList.contains('si-x'))this.switchSession(s.id)});
      d.querySelector('.si-x').addEventListener('click',e=>{e.stopPropagation();this.delSession(s.id)});
      d.querySelector('.si-name').addEventListener('dblclick',e=>{e.stopPropagation();this._rename(s,e.target)});
      el.appendChild(d);
    }
  }

  _rTopbar(){
    const a=this._as();
    document.getElementById('session-name').textContent=a?a.name:'';
  }

  _rLayout(){
    const area=document.getElementById('area');
    const s=this._as();

    // detach all panes
    for(const p of this.panes.values()){p.el.classList.remove('vis');area.appendChild(p.el)}
    // clear layout
    for(const c of [...area.children]){if(c.classList.contains('sp')||c.classList.contains('rg'))c.remove()}

    if(!s?.layout) return;
    if(!findRg(s.layout,this.focused)) this.focused=firstRg(s.layout)?.id||null;

    const dom=this._buildNode(s.layout);
    if(dom) area.appendChild(dom);

    requestAnimationFrame(()=>{
      for(const p of this.panes.values()){
        if(p.el.classList.contains('vis')){
          if(!p._opened) p.open();
          p.doFit();
        }
      }
      if(this.focused){
        const rg=findRg(s.layout,this.focused);
        if(rg){
          const tab=rg.tabs.find(t=>t.id===rg.activeTab);
          if(tab){const p=this.panes.get(tab.paneId);if(p)p.focus()}
        }
      }
    });
  }

  _buildNode(n){
    if(!n) return null;
    if(n.type==='region') return this._buildRg(n);
    if(n.type==='split'&&n.children) return this._buildSp(n);
    return null;
  }

  _buildRg(n){
    const el=document.createElement('div');
    el.className='rg'+(n.id===this.focused?' focused':'');
    el.dataset.rid=n.id;

    // tab bar
    const tabs=document.createElement('div');
    tabs.className='rg-tabs';
    for(const tab of(n.tabs||[])){
      const t=document.createElement('div');
      t.className='rt'+(tab.id===n.activeTab?' active':'');
      t.innerHTML=`<span>${tab.name}</span><span class="rt-x">×</span>`;
      t.addEventListener('click',e=>{
        e.stopPropagation();
        if(e.target.classList.contains('rt-x')) this.closeTab(n.id,tab.id);
        else this.switchTab(n.id,tab.id);
      });
      t.querySelector('span').addEventListener('dblclick',e=>{e.stopPropagation();this._rename(tab,e.target)});
      tabs.appendChild(t);
    }
    const add=document.createElement('button');
    add.className='rt-add'; add.textContent='+';
    add.addEventListener('click',e=>{e.stopPropagation();this.addTab(n.id)});
    tabs.appendChild(add);
    el.appendChild(tabs);

    // body
    const body=document.createElement('div');
    body.className='rg-body';
    const at=(n.tabs||[]).find(t=>t.id===n.activeTab);
    if(at){
      const p=this.panes.get(at.paneId);
      if(p){body.appendChild(p.el);p.el.classList.add('vis')}
    }
    el.appendChild(body);

    el.addEventListener('mousedown',()=>this.setFocus(n.id));
    return el;
  }

  _buildSp(n){
    const el=document.createElement('div');
    el.className='sp'; el.dataset.d=n.direction;
    el._node=n; // back-ref for saving sizes
    for(let i=0;i<n.children.length;i++){
      const sc=document.createElement('div');
      sc.className='sc';
      if(n.sizes&&n.sizes[i]!=null) sc.style.flex=n.sizes[i];
      const built=this._buildNode(n.children[i]);
      if(built) sc.appendChild(built);
      el.appendChild(sc);
      if(i<n.children.length-1){
        const h=document.createElement('div');
        h.className='sh';
        el.appendChild(h);
        this._handle(h,el);
      }
    }
    return el;
  }

  _handle(h,sp){
    h.addEventListener('mousedown',e=>{
      e.preventDefault();
      const dir=sp.dataset.d;
      const prev=h.previousElementSibling, next=h.nextElementSibling;
      const sx=e.clientX, sy=e.clientY;
      // Capture total size ONCE at mousedown
      const tot=dir==='horizontal'?prev.offsetWidth+next.offsetWidth:prev.offsetHeight+next.offsetHeight;
      const start=dir==='horizontal'?prev.offsetWidth:prev.offsetHeight;
      const mv=e=>{
        if(dir==='horizontal'){
          const nw=start+(e.clientX-sx);
          if(nw<60||tot-nw<60)return;
          prev.style.flex=`${nw/tot}`;next.style.flex=`${(tot-nw)/tot}`;
        }else{
          const nh=start+(e.clientY-sy);
          if(nh<60||tot-nh<60)return;
          prev.style.flex=`${nh/tot}`;next.style.flex=`${(tot-nh)/tot}`;
        }
      };
      const up=()=>{
        document.removeEventListener('mousemove',mv);
        document.removeEventListener('mouseup',up);
        // Save current ratios to layout node
        const nd=sp._node;
        if(nd){
          nd.sizes=[];
          for(const c of sp.children){
            if(c.classList.contains('sc')) nd.sizes.push(parseFloat(c.style.flex)||1);
          }
          this._save();
        }
        for(const p of this.panes.values()) if(p.el.classList.contains('vis')) p.doFit();
      };
      document.addEventListener('mousemove',mv);
      document.addEventListener('mouseup',up);
    });
  }

  _bind(){
    if(this._kb) return; this._kb=true;
    document.addEventListener('keydown',e=>{
      if(e.ctrlKey&&e.shiftKey){
        if(e.key==='H'){e.preventDefault();this.split('horizontal')}
        if(e.key==='V'&&!e.metaKey){e.preventDefault();this.split('vertical')}
      }
    });
    document.getElementById('split-h').addEventListener('click',()=>this.split('horizontal'));
    document.getElementById('split-v').addEventListener('click',()=>this.split('vertical'));

    const sb=document.getElementById('sidebar'),sbh=document.getElementById('sb-handle');
    sbh.addEventListener('mousedown',e=>{e.preventDefault();
      const sx=e.clientX,sw=sb.offsetWidth;
      const mv=e=>{const w=sw+(e.clientX-sx);if(w>=100&&w<=400){sb.style.width=w+'px';sb.style.minWidth=w+'px'}};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);for(const p of this.panes.values())if(p.el.classList.contains('vis'))p.doFit()};
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });

    console.log('[App] keys bound');
  }
}

const app=new App();
app.init();
document.getElementById('add-session').addEventListener('click',()=>app.addSession());
window.addEventListener('resize',()=>{for(const p of app.panes.values())if(p.el.classList.contains('vis'))p.doFit()});
window.addEventListener('beforeunload',e=>{if(app.panes.size>0){e.preventDefault();e.returnValue=''}});
