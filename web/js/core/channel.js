/**
 * Channel — 브라우저 탭 하나가 서버와 여는 WebSocket 하나 (PERF_OPTIMIZATION_SRS FR-CON ·
 * `docs/internal/perf/CHANNEL_PROTOCOL.md`).
 *
 * 버스처럼 시간을 주입받는다(`after`). 서버 인사(`hello`)는 버스의 `chan:open` 으로 나간다.
 */
class Channel {
  /**
   * @param {{publish:Function}} bus
   * @param {{after:Function}} timers
   * @param {{pingMs:()=>number, hidden?:()=>boolean}} opts
   */
  constructor(bus, timers, opts){
    this.bus=bus;
    this._t=timers;
    this._pingMs=opts.pingMs;
    this._hidden=opts.hidden||(()=>document.hidden);
    this._ws=null; this._gen=0; this._stopped=false;
    this._slots=[];
    this._retry=CHAN_RETRY_MIN_MS; this._retryT=null;
    this._tickT=null; this._armedMs=0; this._seen=0;
    this._pingN=0; this._pingAt=0; this._latency=null;
  }

  connect(){
    this._stopped=false;
    this._drop();
    const p=location.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(`${p}//${location.host}/channel?v=1`);
    ws.binaryType='arraybuffer';
    this._ws=ws;
    this._gen++;
    this._seen=Date.now();
    ws.onopen=()=>{ this._seen=Date.now(); this._hello(); this._arm() };
    ws.onmessage=e=>this._onMessage(e);
    const lost=()=>{ if(this._ws===ws) this._lost() };
    ws.onclose=lost;
    ws.onerror=lost;
  }

  close(){
    this._stopped=true;
    if(this._retryT){ this._retryT.stop(); this._retryT=null }
    this._drop();
  }

  setSlots(ids){
    this._slots=Array.from(ids||[]);
    this._hello();
  }

  latency(){ return this._latency }

  _open(){ return !!this._ws&&this._ws.readyState===1 }

  _send(v){ if(this._open()) this._ws.send(JSON.stringify(v)) }

  _hello(){ this._send({t:'hello',slots:this._slots}) }

  _onMessage(e){
    this._seen=Date.now();
    if(typeof e.data!=='string') return;
    let m=null;
    try{ m=JSON.parse(e.data) }catch{ return }
    if(!m) return;
    if(m.t==='hello'){
      this._retry=CHAN_RETRY_MIN_MS;
      this.bus.publish('chan:open',{gen:this._gen,epoch:m.epoch});
    }else if(m.t==='pong'&&m.n===this._pingN&&this._pingAt){
      this._latency=Date.now()-this._pingAt;
      this._pingAt=0;
    }
  }

  _interval(){ return this._hidden()?CHAN_PING_HIDDEN_MS:this._pingMs() }

  _arm(){
    if(this._tickT) this._tickT.stop();
    this._armedMs=this._interval();
    this._tickT=this._t.after(this._armedMs,()=>{ this._tickT=null; this._tick() },{owner:'channel',label:'chan-ping'});
  }

  _tick(){
    if(!this._open()) return;
    // 숨은 동안 건 긴 주기가 보일 때 끝날 수 있다 — 침묵은 건 주기로 잰다.
    if(Date.now()-this._seen>Math.max(this._armedMs,this._interval())*2+CHAN_SILENCE_GRACE_MS){
      this._retry=CHAN_RETRY_MIN_MS;
      this.connect();
      return;
    }
    this._pingN++;
    this._pingAt=Date.now();
    this._send({t:'ping',n:this._pingN});
    this._arm();
  }

  _drop(){
    if(this._tickT){ this._tickT.stop(); this._tickT=null }
    const ws=this._ws;
    this._ws=null;
    if(!ws) return;
    ws.onopen=null; ws.onclose=null; ws.onerror=null; ws.onmessage=null;
    try{ ws.close() }catch{ /* 이미 닫혔다 */ }
  }

  _lost(){
    this._drop();
    if(this._stopped||this._retryT) return;
    const wait=this._retry;
    this._retry=Math.min(wait*2,CHAN_RETRY_MAX_MS);
    this._retryT=this._t.after(wait,()=>{ this._retryT=null; if(!this._stopped) this.connect() },{owner:'channel',label:'chan-retry'});
  }
}
