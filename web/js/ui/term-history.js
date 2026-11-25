/**
 * 위로 스크롤 받기 (PERF FR-TRM-5, D-20 · `perf/M2_DESIGN.md` §2.7).
 *
 * 실시간 xterm 의 기록 맨 위에서 더 올리면 데몬 줄 저장소에서 그 위 구간을 받아, 같은 칸 위에 덮은 읽기 전용
 * xterm(기록 보기)에 그린다. 실시간 버퍼는 건드리지 않고, 기록 보기가 떠 있는 동안에도 출력은 실시간 xterm 으로,
 * 입력은 서버로 그대로 간다. 기록 보기 맨 위에 닿으면 다음 구간을 받아 위에 붙인다(xterm 은 위에 끼울 수 없어
 * 다시 그리고 보던 자리를 지킨다). 맨 아래에서 더 내리거나 Esc 를 누르거나 입력하면 닫힌다.
 *
 * 줄 번호: 스냅숏 `SEQ` 꼬리의 첫 기록 줄 번호가 버퍼 0행의 번호다. 그 행에 표지(marker)를 달고, 맨 윗줄 번호는
 * 표지 위의 논리 줄 수를 빼서 센다. 표지가 위로 밀려 사라지기 전에 아래로 옮긴다. 데몬(alacritty)은 ED2 때
 * 화면을 기록으로 밀어 올리고 xterm.js 는 그러지 않아 번호가 어긋날 수 있다 — 그래서 요청은 맨 윗줄까지 함께
 * 받아 글자를 맞춰 보고, 어긋났거나 번호를 잃었으면(ED3·재생) 한 번 다시 깨워 스냅숏으로 번호를 새로 세운다.
 */

/** ANSI(CSI·OSC)를 걷은 글자. 비교용이라 끝 공백도 뗀다. */
function termHistPlain(s){
  return String(s||'').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trimEnd();
}

/** 버퍼 `row` 에서 시작하는 논리 줄의 글자(감싼 행을 잇는다). */
function termHistLineText(buf,row){
  let s='';
  for(let i=row;i<buf.length;i++){
    const l=buf.getLine(i);
    if(!l||(i>row&&!l.isWrapped)) break;
    s+=l.translateToString(true);
  }
  return s.trimEnd();
}

/** 행 `[a, b)` 에서 시작하는 논리 줄 수(감싼 이음 행은 세지 않는다). */
function termHistStarts(buf,a,b){
  let n=0;
  for(let i=a;i<b;i++){ const l=buf.getLine(i); if(l&&!l.isWrapped) n++ }
  return n;
}

class TermHistory {
  constructor(pane){
    this.pane=pane;
    this.mk=null; this.mkNo=0;          // 표지와 그 행에서 시작하는 줄의 번호
    this.view=null; this.el=null;       // 기록 보기
    this.lines=[]; this.from=0; this.top=0;
    this.asking=false;                  // 답을 기다리는 중 — 두 벌로 묻지 않는다
    this.want=-1;                       // 다시 깨운 뒤 이어서 열 `before`(-1 은 없음)
    this.resynced=false;                // 이번 열기에서 이미 한 번 다시 깨웠다
    this.verify=null;                   // 답의 마지막 줄과 맞춰 볼 맨 윗줄 글자
  }

  _buf(){ const xt=this.pane.term; return xt&&xt.buffer&&xt.buffer.active }

  /** 스냅숏 `SEQ` 의 첫 기록 줄 번호. 스냅숏을 다 그린 뒤 0행에 표지를 단다. */
  base(no){
    const xt=this.pane.term;
    if(!xt) return;
    // 스냅숏 글자는 아직 출력 묶음(`_doFlush` 대기)에 있을 수 있다 — 먼저 xterm 에 넣어야 0행이 스냅숏 첫 줄이다.
    if(this.pane._flushScheduled) this.pane.output._doFlush();
    xt.write('',()=>{
      this._drop();
      const b=this._buf();
      if(!b||b.type!=='normal') return;
      this._mark(0,no);
      if(this.want>=0){ const w=this.want; this.want=-1; this._ask(w===Infinity?this.topNo():w,true) }
    });
  }

  _drop(){ if(this.mk){ const m=this.mk; this.mk=null; try{m.dispose()}catch{} } }

  _mark(row,no){
    const xt=this.pane.term, b=this._buf();
    const m=xt.registerMarker(row-(b.baseY+b.cursorY));
    if(!m) return;
    this.mk=m; this.mkNo=no;
    m.onDispose(()=>{ if(this.mk===m) this.mk=null });
  }

  /** 출력을 그린 뒤마다: 표지가 위쪽 가장자리에 가까우면 화면 바로 위의 줄 시작 행으로 옮긴다. */
  track(){
    const b=this._buf();
    if(!this.mk||!b||b.type!=='normal'||this.mk.line>=TERM_HISTORY_REANCHOR_ROWS) return;
    let row=b.baseY-1;   // 기록 행은 바뀌지 않는다(화면 행은 앱이 고쳐 쓴다)
    while(row>this.mk.line&&b.getLine(row)&&b.getLine(row).isWrapped) row--;
    if(row<=this.mk.line) return;
    const no=this.mkNo+termHistStarts(b,this.mk.line,row);
    this._drop();
    this._mark(row,no);
  }

  /** 버퍼 맨 윗줄의 번호. 번호를 모르면 -1. */
  topNo(){
    const b=this._buf();
    if(!this.mk||!b) return -1;
    return this.mkNo-termHistStarts(b,0,this.mk.line);
  }

  /** 실시간 xterm 맨 위에서 더 올렸다. */
  enter(){
    if(this.view||this.asking) return;
    this.resynced=false;
    const no=this.topNo();
    if(no<0){ this._resync(Infinity); return }
    this._ask(no,true);
  }

  /**
   * 줄 번호 `no` 가 화면 가운데쯤 오게 연다 — "이전 기록에서 찾기"(2.8.2)가 `openHistoryAt` 으로 부른다.
   * 아래로는 실시간 버퍼 맨 윗줄 앞까지만 받는다.
   */
  openAt(no){
    if(this.asking) return;
    this.resynced=true;
    this.want=-1;
    this._close(false);
    const xt=this.pane.term, top=this.topNo();
    let before=no+1+Math.floor(((xt&&xt.rows)||0)/2);
    if(top>no) before=Math.min(before,top);
    this._send(before,TERM_HISTORY_CHUNK,null);
  }

  /**
   * 번호 `no`(버퍼 맨 윗줄) 앞을 묻는다. `check` 면 맨 윗줄까지 함께 받아 글자를 맞춰 본다.
   */
  _ask(no,check){
    const b=this._buf();
    if(check&&b) this._send(no+1,TERM_HISTORY_CHUNK+1,termHistLineText(b,0));
    else this._send(no,TERM_HISTORY_CHUNK,null);
  }

  _send(before,count,verify){
    const s=this.pane._sock;
    if(!s||!s.live||!TERM_MUX.chan) return;
    if(!TERM_MUX.chan.send({t:'term.history',sid:s.sid,before,count})) return;
    this.asking=true; this.verify=verify;
  }

  /** 번호를 새로 세운다: 다시 깨워 스냅숏을 받고, 그 뒤 `before` 로 이어서 연다. 한 번만. */
  _resync(before){
    if(this.resynced) return;
    this.resynced=true;
    this.want=before;
    this.pane.sleep();
    this.pane.wake();
  }

  /** 서버의 `term.history{from,top,lines}`. */
  onAnswer(m){
    if(!this.asking) return;
    this.asking=false;
    let lines=Array.isArray(m.lines)?m.lines:[];
    const from=Number(m.from)||0, top=Number(m.top)||0;
    if(this.verify!=null){
      const v=this.verify; this.verify=null;
      // 맨 윗줄을 끝에서부터 찾아 그 앞까지만 쓴다. 번호가 크게 셌으면 끝보다 앞에서 찾는다. 빈 줄은 어디에나 있어
      // 찾지 않는다. 못 찾으면(번호를 작게 셌다) 한 번 다시 깨운다. 다시 깨운 뒤에도 못 찾으면 받은 것을 쓴다 —
      // 맨 윗줄이 아직 저장소에 없는 경우다(브라우저 기록이 데몬 에뮬레이터 기록보다 짧다).
      let at=-1;
      if(v) for(let i=lines.length-1;i>=0;i--) if(termHistPlain(lines[i])===v){ at=i; break }
      if(at>=0) lines=lines.slice(0,at);
      else if(lines.length&&!this.resynced){ this._resync(Infinity); return }
    }
    if(!lines.length&&!this.view) return;
    this.top=top;
    if(!this.view){ this.lines=lines; this.from=from; this._open(); return }
    this.lines=lines.concat(this.lines); this.from=from;
    this._redraw(true);
  }

  _more(){ return this.from>this.top }

  _open(){
    const p=this.pane, term=p.term;
    const el=document.createElement('div'); el.className='tp-hist';
    const bg=term.options&&term.options.theme&&term.options.theme.background;
    if(bg) el.style.background=bg;
    const bar=document.createElement('div'); bar.className='tp-hist-bar'; bar.textContent=t('term.history_banner');
    const box=document.createElement('div'); box.className='tp-hist-box';
    el.appendChild(bar); el.appendChild(box);
    p.el.appendChild(el);
    const v=this._makeView(box);
    this.el=el; this.view=v;
    v.onScroll(y=>{ if(y===0&&this._more()&&!this.asking) this._ask(this.from,false) });
    el.addEventListener('wheel',e=>{
      const b=v.buffer.active;
      if(e.deltaY>0&&b.viewportY>=b.baseY) this._close(false);
    },{passive:true});
    el.addEventListener('keydown',e=>{ if(e.key==='Escape') this.close(); else if(!TERM_HISTORY_KEEP_KEYS.has(e.key)) this._close(true) },true);
    this._redraw(false);
  }

  /** 읽기 전용 xterm. 실시간 xterm 과 글꼴·색·폭이 같다. */
  _makeView(box){
    const xt=this.pane.term;
    const v=new Terminal(Object.assign({},TOPTS,{fontSize:termFontSizeNow(),scrollback:TERM_HISTORY_VIEW_ROWS,
      disableStdin:true,cursorBlink:false,cols:xt.cols,rows:xt.rows}));
    try{ v.loadAddon(new Unicode11Addon.Unicode11Addon()); v.unicode.activeVersion='11' }catch{ /* 애드온이 없는 판 */ }
    v.open(box);
    return v;
  }

  /** 받은 줄을 다시 그린다. `keep` 이면 위에 붙인 행 수만큼 내려 보던 자리를 지킨다. */
  _redraw(keep){
    const v=this.view, b=v.buffer.active;
    const before=b.length, y=b.viewportY;
    v.reset();
    // 마지막 줄 뒤에 줄바꿈을 두지 않는다 — 기록 보기 맨 아래가 실시간 버퍼 맨 윗줄 바로 위다.
    v.write('\x1b[?25l'+this.lines.join('\r\n'),()=>{
      const nb=v.buffer.active;
      if(keep) v.scrollToLine(y+(nb.length-before));
      else v.scrollToBottom();
    });
  }

  /** Esc: 닫고 실시간 화면 맨 아래로. */
  close(){ this._close(true) }

  /** 닫는다. `bottom` 이면 실시간 화면을 맨 아래로, 아니면 그대로(맨 위) 둔다. */
  _close(bottom){
    if(!this.view) return;
    const v=this.view, el=this.el;
    this.view=null; this.el=null; this.lines=[];
    try{v.dispose()}catch{}
    if(el) el.remove();
    const xt=this.pane.term;
    if(xt){ if(bottom) xt.scrollToBottom(); xt.focus() }
  }

  /**
   * 실시간 xterm 에 키가 왔다. Esc 는 닫고 삼킨다(true). 수식 키만 누른 것 말고 다른 키는 기록 보기를 닫고 그대로
   * 터미널로 보낸다(false) — 입력은 막히지 않는다. Shift+PageUp 은 맨 위에서 기록 보기를 연다.
   */
  onKey(e){
    if(e.type!=='keydown') return false;
    if(!this.view){
      if(e.shiftKey&&e.key==='PageUp') this.onUp();
      // 답을 기다리는 동안 입력했으면 답이 와도 열지 않는다.
      else if(!TERM_HISTORY_KEEP_KEYS.has(e.key)){ this.asking=false; this.verify=null; this.want=-1 }
      return false;
    }
    if(e.key==='Escape'){ this.close(); return true }
    if(!TERM_HISTORY_KEEP_KEYS.has(e.key)) this.close();
    return false;
  }

  /** 잠들거나 다시 깨울 때: 표지를 버리고 기록 보기를 닫는다. 이어서 열 요청(`want`)은 남긴다. */
  sleep(){ this._drop(); this.asking=false; this.verify=null; this._close(false) }

  /** 실시간 xterm 의 휠·Shift+PageUp: 맨 위에서 더 올리면 연다. */
  onUp(){
    const b=this._buf();
    if(!b||b.type!=='normal'||b.viewportY>0) return;
    this.enter();
  }

  get isOpen(){ return !!this.view }
}
