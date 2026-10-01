/**
 * OPTIMIZE_REFACTOR_SRS FR-OPT-12-1 (FEU-14 · IPC-16): 터미널 한 칸의 WebSocket 배선.
 *
 * 연결·재접속(백오프·지터)·송신 큐·건강 판정을 갖는다. 수신 op 의 해석과 화면(오버레이)은
 * 주인(`TerminalTool`)이 한다. 주인이 주는 것:
 *   `_wsURL()` · `_wsStopped()` · `_wsOpened(viaRetry)` · `_wsLost(kind)` · `_onOp(d)`
 *
 * 소켓 콜백은 `_wire` 한 곳에서만 선다. 최초 연결과 재연결이 두 벌을 갖던 것이 OP.EXIT 처리가
 * 한쪽에만 들어가는 사고의 자리였다 (FR-RCS-1).
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

class TermSocket {
  constructor(host){
    this.host=host;
    this.ws=null;              // 붙은(또는 최초 연결 중인) 소켓
    this.pending=null;         // 재시도로 연 채 아직 열리지 않은 소켓
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
  }

  /** 명시적인 연결. 소켓을 곧바로 지금 소켓으로 삼는다. */
  open(){ this.ws=this._make(false) }

  _make(viaRetry){
    const ws=new WebSocket(this.host._wsURL());
    this._wire(ws,viaRetry);
    return ws;
  }

  /**
   * 콜백 한 벌. `viaRetry` 면 열릴 때 지금 소켓이 된다.
   *
   * stale 가드: 지금 소켓이 따로 있으면 이 소켓의 끊김에는 답하지 않는다 — 답하면 붙어 있는
   * 연결을 닫고 재연결이 두 벌로 돈다.
   */
  _wire(ws,viaRetry){
    ws.binaryType='arraybuffer';
    ws.onopen=()=>{
      if(viaRetry){ this.ws=ws; this.pending=null }
      this.everOpen=true;
      this.host._wsOpened(viaRetry);
    };
    ws.onmessage=e=>{
      const d=new Uint8Array(e.data); if(d.length) this.host._onOp(d);
    };
    const lost=kind=>{
      if(this.host._wsStopped()) return;
      if(this.ws&&this.ws!==ws) return;
      if(kind==='close'&&this.ws===ws) this.ws=null;
      this.host._wsLost(kind);
    };
    ws.onclose=()=>lost('close');
    ws.onerror=()=>lost('error');
  }

  _detach(s){
    s.onopen=null; s.onclose=null; s.onerror=null; s.onmessage=null;
    try{ s.close() }catch{ /* 이미 닫혔다 */ }
  }

  /**
   * 재시도를 걸 준비: 지금 소켓을 끊는다. 이미 걸려 있거나 주인이 멈췄으면 false —
   * 부르는 쪽은 그때 아무것도 하지 않는다 (FR-RCS-1).
   */
  arm(){
    if(this.host._wsStopped()||this.retryArmed) return false;
    this.retryArmed=true;
    this.clearHealthy();
    if(this.ws){ this._detach(this.ws); this.ws=null }
    return true;
  }

  /** 백오프 뒤에 새 소켓을 연다. 열릴 때까지는 `pending` 이다. */
  retry(){
    if(this.host._wsStopped()) return;
    const wait=termRetryWait(this.retryDelay,Math.random());
    this.retryDelay=termNextRetryDelay(this.retryDelay);
    TIMERS.after(wait,()=>{
      // FR-RCS-5: 대기 중에 판정이 섰을 수 있다. 깨어난 뒤에 다시 본다.
      if(this.host._wsStopped()) return;
      this.retryArmed=false;
      this.pending=this._make(true);
    },{owner:this.host,label:'ws-retry'});
  }

  /** 사용자·앱이 부른 즉시 재연결의 앞단: 두 소켓을 다 끊고 백오프를 되돌린다. */
  reset(){
    this.clearHealthy();
    this.retryArmed=false;
    for(const k of ['ws','pending']){
      if(this[k]){ this._detach(this[k]); this[k]=null }
    }
    this.retryDelay=0;
  }

  close(){
    this.clearHealthy();
    if(this.pending&&this.pending!==this.ws) this._detach(this.pending);
    this.pending=null;
    if(this.ws){ this._detach(this.ws); this.ws=null }
  }

  // FR-RCS-3: 연결이 WS_HEALTHY_MS 이상 유지되어야 백오프를 되돌린다.
  markHealthy(){
    this.clearHealthy();
    this.healthyTimer=TIMERS.after(WS_HEALTHY_MS,()=>{this.healthyTimer=null;this.retryDelay=0},{owner:this.host,label:'ws-healthy'});
  }
  clearHealthy(){
    if(this.healthyTimer){TIMERS.cancel(this.healthyTimer);this.healthyTimer=null}
  }

  send(m){
    const ws=this.ws;
    if(ws&&ws.readyState===1){ws.send(m);return}
    if(ws&&ws.readyState===0){
      if(this.queue.length>=TERM_SEND_QUEUE_MAX){this.queue.shift();this.dropCount++}
      this.queue.push(m);
      return;
    }
    this.dropCount++;
  }
  /** FR-HIN-1·2: 사용자 입력을 지금 보내지 않고 붙잡아야 하는가. */
  holding(){
    return this.everOpen&&!(this.ws&&this.ws.readyState===1);
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
    if(!this.ws||this.ws.readyState!==1)return;
    const q=this.queue;this.queue=[];
    for(const m of q){this.ws.send(m)}
  }
}
