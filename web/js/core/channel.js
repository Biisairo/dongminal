/** delta 의 `ops` 를 `Map` 에 적용한다 (CHANNEL_PROTOCOL §11.2). */
function chanApply(map, ops){
  for(const o of ops||[]){
    if(o.op==='put') map.set(o.id,o.v);
    else if(o.op==='del') map.delete(o.id);
  }
  return map;
}

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
   * @param {{pingMs:()=>number, hidden?:()=>boolean, client?:()=>string}} opts
   */
  constructor(bus, timers, opts){
    this.bus=bus;
    this._t=timers;
    this._pingMs=opts.pingMs;
    this._hidden=opts.hidden||(()=>document.hidden);
    this._client=opts.client||(()=>'');
    this._ws=null; this._gen=0; this._stopped=false;
    this._slots=[];
    this._retry=CHAN_RETRY_MIN_MS; this._retryT=null;
    this._tickT=null; this._armedMs=0; this._seen=0;
    this._pingN=0; this._pingAt=0; this._latency=null;
    this._ready=false; this._epoch=null;
    this._topics=new Map();   // topic → {subs:Set<{fn,owner}>, seq, epoch, waiting}
    this._raw=new Map();      // t → Set<{fn,owner}>
    this._bin=new Set();
  }

  connect(){
    this._stopped=false;
    this._drop();
    const p=location.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(`${p}//${location.host}/channel?v=1`);
    ws.binaryType='arraybuffer';
    this._ws=ws;
    this._gen++;
    this._ready=false;
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

  alive(){ return this._open() }

  gen(){ return this._gen }

  /** 서버 `hello` 를 받았고 소켓이 열려 있다. */
  ready(){ return this._ready&&this._open() }

  send(v){
    if(!this._open()) return false;
    this._ws.send(JSON.stringify(v));
    return true;
  }

  sendBinary(u8){
    if(!this._open()) return false;
    this._ws.send(u8);
    return true;
  }

  sub(topic, fn, opts){
    let e=this._topics.get(topic);
    if(!e){
      e={subs:new Set(), seq:null, epoch:null, waiting:false};
      this._topics.set(topic,e);
      if(this._ready) this._subFrame(topic,e);
    }
    const rec={fn, owner:(opts&&opts.owner)||null};
    e.subs.add(rec);
    return {topic, stop:()=>this._unsub(topic,rec)};
  }

  on(kind, fn, opts){
    let set=this._raw.get(kind);
    if(!set){ set=new Set(); this._raw.set(kind,set) }
    const rec={fn, owner:(opts&&opts.owner)||null};
    set.add(rec);
    return {stop:()=>{ set.delete(rec); if(!set.size&&this._raw.get(kind)===set) this._raw.delete(kind) }};
  }

  onBinary(fn){
    const rec={fn};
    this._bin.add(rec);
    return {stop:()=>this._bin.delete(rec)};
  }

  disposeOwner(owner){
    if(owner==null) return 0;
    let n=0;
    for(const [topic,e] of Array.from(this._topics)){
      for(const r of Array.from(e.subs)) if(r.owner===owner){ this._unsub(topic,r); n++ }
    }
    for(const [kind,set] of Array.from(this._raw)){
      for(const r of Array.from(set)) if(r.owner===owner){ set.delete(r); n++ }
      if(!set.size) this._raw.delete(kind);
    }
    return n;
  }

  _unsub(topic, rec){
    const e=this._topics.get(topic);
    if(!e||!e.subs.delete(rec)||e.subs.size) return;
    this._topics.delete(topic);
    if(this._ready) this.send({t:'unsub',topic});
  }

  _subFrame(topic, e){
    const m={t:'sub',topic};
    if(e.seq!=null){ m.seq=e.seq; m.epoch=e.epoch }
    this.send(m);
  }

  _open(){ return !!this._ws&&this._ws.readyState===1 }

  _hello(){
    const m={t:'hello',slots:this._slots};
    const client=this._client();
    if(client) m.client=client;
    this.send(m);
  }

  /** 깨어남·소프트 리로드(C2a TC-CH2A-12): 닫혀 있으면(멈춘 것도) 곧바로, 열려 있으면 침묵일 때만 다시 연결한다. */
  kick(){
    if(this._open()&&!this._silent()) return;
    if(this._retryT){ this._retryT.stop(); this._retryT=null }
    this._retry=CHAN_RETRY_MIN_MS;
    this.connect();
  }

  // 숨은 동안 건 긴 주기가 보일 때 끝날 수 있다 — 침묵은 건 주기로 잰다.
  _silent(){ return Date.now()-this._seen>Math.max(this._armedMs,this._interval())*2+CHAN_SILENCE_GRACE_MS }

  /** §5.1: 빈틈이면 다시 구독하고 그 사이 프레임은 버린다. 받을 프레임이면 true. */
  _accept(topic, e, m){
    if(m.t==='full'||m.seq==null||e.seq==null){
      e.seq=m.seq==null?e.seq:m.seq; e.epoch=this._epoch; e.waiting=false;
      return true;
    }
    if(m.seq<=e.seq) return false;
    if(m.seq===e.seq+1){ e.seq=m.seq; e.epoch=this._epoch; e.waiting=false; return true }
    if(!e.waiting){ e.waiting=true; this._subFrame(topic,e) }
    return false;
  }

  _onTopic(m){
    const e=this._topics.get(m.topic);
    if(!e) return;
    let msg;
    if(m.t==='reset'){ e.seq=null; e.waiting=false; msg={kind:'reset'} }
    else{
      if(!this._accept(m.topic,e,m)) return;
      msg=m.t==='delta'?{kind:'delta',ops:m.ops,seq:m.seq}:{kind:m.t,data:m.data,seq:m.seq};
    }
    for(const r of Array.from(e.subs)){
      try{ r.fn(msg) }catch(err){ console.error('[chan]',m.topic,err) }
    }
  }

  _onMessage(e){
    this._seen=Date.now();
    if(typeof e.data!=='string'){
      const u8=new Uint8Array(e.data);
      for(const r of Array.from(this._bin)) r.fn(u8);
      return;
    }
    let m=null;
    try{ m=JSON.parse(e.data) }catch{ return }
    if(!m) return;
    if(m.t==='hello'){
      // 칸 수가 바뀌어 다시 받은 인사는 같은 연결이다 — 재구독·chan:open 을 되풀이하지 않는다.
      if(!this._ready){
        this._retry=CHAN_RETRY_MIN_MS;
        this._ready=true; this._epoch=m.epoch;
        for(const [topic,e] of this._topics){ e.waiting=false; this._subFrame(topic,e) }
        this.bus.publish('chan:open',{gen:this._gen,epoch:m.epoch,server:m.server||{}});
      }
    }else if(m.t==='pong'){
      if(m.n===this._pingN&&this._pingAt){ this._latency=Date.now()-this._pingAt; this._pingAt=0 }
    }else if(m.t==='full'||m.t==='delta'||m.t==='event'||m.t==='reset'){
      this._onTopic(m);
    }
    const raw=this._raw.get(m.t);
    if(raw) for(const r of Array.from(raw)){
      try{ r.fn(m) }catch(err){ console.error('[chan]',m.t,err) }
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
    if(this._silent()){
      this._retry=CHAN_RETRY_MIN_MS;
      this.connect();
      return;
    }
    this._pingN++;
    this._pingAt=Date.now();
    this.send({t:'ping',n:this._pingN});
    this._arm();
  }

  _drop(){
    if(this._tickT){ this._tickT.stop(); this._tickT=null }
    const ws=this._ws;
    this._ws=null;
    const was=this._ready;
    this._ready=false;
    // 준비됐던 연결을 잃었다 — 원시 수신 `lost` 로 알린다(터미널이 다시 붙는다, C5).
    if(was) for(const r of Array.from(this._raw.get('lost')||[])) r.fn({t:'lost'});
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
