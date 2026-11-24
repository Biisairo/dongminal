/**
 * 터미널 한 칸의 채널 배선 (PERF_OPTIMIZATION_SRS M1 C5 · `docs/internal/perf/CHANNEL_PROTOCOL.md` §4·§10.6).
 *
 * 옛 칸별 WebSocket(`TermSocket`)의 자리다. 소켓을 열지 않고 탭의 채널 하나에 `term.open` 으로 붙으며,
 * 프레임은 `[op][sid u32 BE][payload]` 다. 주인(`TerminalTool`)에게 주는 표면은 종전과 같다:
 *   `_termOpenArgs()` · `_wsStopped()` · `_wsOpened(viaRetry)` · `_wsLost(kind)` · `_onOp(d)`
 * 앞 5바이트를 떼면 옛 프레임과 같아서 `_onOp` 의 해석과 `_seq` 재동기는 바뀌지 않는다.
 */

/**
 * UX_BATCH11_SRS FR-HIN-4: 보류한 입력의 미리보기. 제어 문자는 `^X`(ESC 는 `^[`, DEL 은 `^?`),
 * CR·LF 는 `⏎` 로 적고 `TERM_HELD_PREVIEW_CHARS` 자에서 자른다.
 */
function termHeldPreview(s){
  let out='';
  for(const ch of String(s||'')){
    const c=ch.codePointAt(0);
    if(c===0x0d||c===0x0a) out+='⏎';
    else if(c<0x20) out+='^'+String.fromCharCode(c+0x40);
    else if(c===0x7f) out+='^?';
    else out+=ch;
  }
  return Array.from(out).slice(0,TERM_HELD_PREVIEW_CHARS).join('');
}

/** 다음 재시도 지연(지터 없음). FR-RCS-4: 0 으로는 `markHealthy` 의 타이머만 되돌린다. */
function termNextRetryDelay(d){
  if(!(d>0)) return TERM_WS_RETRY_FIRST_MS;
  if(d<=TERM_WS_RETRY_FAST_UNTIL_MS) return Math.min(d*TERM_WS_RETRY_FAST_FACTOR,TERM_WS_RETRY_FAST_MAX_MS);
  return Math.min(d*TERM_WS_RETRY_FACTOR,TERM_WS_RETRY_MAX_MS);
}

/** 실제로 기다릴 시간. 지연 `d` 에 ±`TERM_WS_RETRY_JITTER` 를 얹는다 (`r` ∈ [0,1)). */
function termRetryWait(d,r){
  if(!(d>0)) return 0;
  return Math.round(d*(1+TERM_WS_RETRY_JITTER*(2*r-1)));
}

const TERM_FRAME_HEAD=5;

/** 채널 하나에 붙은 터미널들 — sid 를 나눠 주고 채널의 사건을 칸에 나른다. */
class TermMux {
  constructor(){ this.socks=new Map(); this.next=1; this.chan=null }

  attach(ch){
    if(!ch||this.chan===ch) return;
    this.chan=ch;
    ch.onBinary(u8=>this._onBinary(u8));
    ch.on('hello',()=>{ for(const s of Array.from(this.socks.values())) s._chanReady() });
    ch.on('lost',()=>{ for(const s of Array.from(this.socks.values())) s._chanLost() });
    ch.on('term.lost',m=>{ const s=this.socks.get(m.sid); if(s) s._chanLost() });
    if(ch.ready()) for(const s of Array.from(this.socks.values())) s._chanReady();
  }

  ready(){ return !!this.chan&&this.chan.ready() }

  add(s){ const sid=this.next++; this.socks.set(sid,s); return sid }
  remove(sid){ this.socks.delete(sid) }

  _onBinary(u8){
    if(u8.length<TERM_FRAME_HEAD) return;
    const sid=new DataView(u8.buffer,u8.byteOffset,u8.length).getUint32(1,false);
    const s=this.socks.get(sid);
    if(!s) return;
    const d=new Uint8Array(u8.length-TERM_FRAME_HEAD+1);
    d[0]=u8[0]; d.set(u8.subarray(TERM_FRAME_HEAD),1);
    s._frame(d);
  }
}

const TERM_MUX=new TermMux();

class TermChannel {
  constructor(host){
    this.host=host;
    this.sid=0;
    this.want=false;           // 주인이 붙기를 원한다
    this.live=false;           // term.open 을 보냈고 채널이 살아 있다
    this.retryDelay=0;
    this.retryArmed=false;     // 재시도가 걸려 있다 — 두 벌로 걸지 않는다
    this.healthyTimer=null;
    this.queue=[];
    this.dropCount=0;
    // UX_BATCH11_SRS FR-HIN-1: 한 번이라도 열렸는가. 그 뒤의 끊김에서만 사용자 입력을 붙잡는다.
    this.everOpen=false;
    this.held=[];
    this.heldBytes=0;
    this.heldOver=false;
    const me=this;
    // 옛 `pane.ws` 를 읽는 진단·e2e 가 보는 손잡이. `close()` 는 이 터미널만 끊긴 것으로 다룬다.
    this._handle={
      get readyState(){ return me.live?1:(me._connecting()?0:3) },
      close(){ me._localLost() },
    };
  }

  get ws(){ return (this.live||this._connecting())?this._handle:null }

  _connecting(){ return this.want&&!this.live&&!this.retryArmed }

  /** 명시적인 연결. */
  open(){
    this.want=true;
    if(!this.sid) this.sid=TERM_MUX.add(this);
    this._try(false);
  }

  _try(viaRetry){
    if(!this.want||this.live||this.host._wsStopped()||!TERM_MUX.ready()) return;
    const ok=TERM_MUX.chan.send(Object.assign({t:'term.open',sid:this.sid},this.host._termOpenArgs()));
    if(!ok) return;
    this.live=true;
    this.everOpen=true;
    this.host._wsOpened(viaRetry);
  }

  _chanReady(){ if(!this.retryArmed) this._try(this.everOpen) }

  /** 채널이 끊겼거나 서버가 이 터미널을 놓았다(`term.lost`). */
  _chanLost(){
    if(!this.live) return;
    this.live=false;
    if(this.host._wsStopped()) return;
    this.host._wsLost('close');
  }

  /** 손잡이의 `close()` — 이 터미널만 끊는다. */
  _localLost(){
    if(!this.live) return;
    this._detach();
    if(this.host._wsStopped()) return;
    this.host._wsLost('close');
  }

  _detach(){
    if(!this.live) return;
    this.live=false;
    if(TERM_MUX.chan) TERM_MUX.chan.send({t:'term.close',sid:this.sid});
  }

  _frame(d){ if(this.live) this.host._onOp(d) }

  /**
   * 재시도를 걸 준비: 지금 붙음을 뗀다. 이미 걸려 있거나 주인이 멈췄으면 false —
   * 부르는 쪽은 그때 아무것도 하지 않는다 (FR-RCS-1).
   */
  arm(){
    if(this.host._wsStopped()||this.retryArmed) return false;
    this.retryArmed=true;
    this.clearHealthy();
    this._detach();
    return true;
  }

  /** 백오프 뒤에 다시 붙는다. 채널이 아직 없으면 다음 서버 `hello` 에 붙는다. */
  retry(){
    if(this.host._wsStopped()) return;
    const wait=termRetryWait(this.retryDelay,Math.random());
    this.retryDelay=termNextRetryDelay(this.retryDelay);
    TIMERS.after(wait,()=>{
      // FR-RCS-5: 대기 중에 판정이 섰을 수 있다. 깨어난 뒤에 다시 본다.
      if(this.host._wsStopped()) return;
      this.retryArmed=false;
      this._try(true);
    },{owner:this.host,label:'ws-retry'});
  }

  /** 사용자·앱이 부른 즉시 재연결의 앞단: 붙음을 떼고 백오프를 되돌린다. */
  reset(){
    this.clearHealthy();
    this.retryArmed=false;
    this._detach();
    this.retryDelay=0;
  }

  close(){
    this.clearHealthy();
    this._detach();
    this.want=false;
    if(this.sid){ TERM_MUX.remove(this.sid); this.sid=0 }
  }

  // FR-RCS-3: 연결이 WS_HEALTHY_MS 이상 유지되어야 백오프를 되돌린다.
  markHealthy(){
    this.clearHealthy();
    this.healthyTimer=TIMERS.after(WS_HEALTHY_MS,()=>{this.healthyTimer=null;this.retryDelay=0},{owner:this.host,label:'ws-healthy'});
  }
  clearHealthy(){
    if(this.healthyTimer){TIMERS.cancel(this.healthyTimer);this.healthyTimer=null}
  }

  _wire(m){
    const f=new Uint8Array(m.length+TERM_FRAME_HEAD-1);
    f[0]=m[0];
    new DataView(f.buffer).setUint32(1,this.sid,false);
    f.set(m.subarray(1),TERM_FRAME_HEAD);
    return f;
  }

  /** `m` 은 op 바이트가 붙은 옛 프레임이다. */
  send(m){
    if(this.live&&TERM_MUX.chan.sendBinary(this._wire(m))) return;
    if(this._connecting()){
      if(this.queue.length>=TERM_SEND_QUEUE_MAX){this.queue.shift();this.dropCount++}
      this.queue.push(m);
      return;
    }
    this.dropCount++;
  }
  /** FR-HIN-1·2: 사용자 입력을 지금 보내지 않고 붙잡아야 하는가. */
  holding(){
    return this.everOpen&&!this.live;
  }
  /** FR-HIN-3: 상한을 넘는 입력은 담지 않는다 — 앞부분이 뜻이다. `m` 은 op 바이트가 붙은 프레임이다. */
  hold(m){
    const n=m.length-1;
    if(this.heldBytes+n>TERM_HELD_MAX){ this.heldOver=true; return }
    this.held.push(m);
    this.heldBytes+=n;
  }
  /** FR-HIN-5·7: 보류함을 비우고 담겼던 것을 돌려준다. */
  takeHeld(){
    const h=this.held;
    this.held=[];this.heldBytes=0;this.heldOver=false;
    return h;
  }
  flush(){
    if(!this.live)return;
    const q=this.queue;this.queue=[];
    for(const m of q) TERM_MUX.chan.sendBinary(this._wire(m));
  }
}
