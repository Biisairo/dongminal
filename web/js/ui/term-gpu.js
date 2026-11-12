/**
 * 터미널 GPU 렌더링 (TERMINAL_GPU_RENDER_SRS).
 * `TerminalTool` 의 증강 분할이다 — 보이는 칸에만 `WebglAddon` 을 붙이고, 숨으면 뗀다.
 * addon 을 떼면 xterm 이 DOM 렌더러로 돌아간다.
 *
 * 로드 순서: `term-pane.js` 뒤.
 */

/** 페이지 상태 — 설정·GPU 사용 불가·컨텍스트 손실 횟수. */
const TermGpu={
  unavailable:false,
  losses:0,
  _on:null,

  /** FR-TGR-13: 기기별 설정. 값이 없거나 모르는 값이면 켬이다. 프레임마다 저장소를 읽지 않게 쥔다. */
  enabled(){
    if(this._on===null) this._on=PrefStore.local.bool(STORE_KEYS.termGpu,true);
    return this._on;
  },

  /** FR-TGR-15: 바꾸면 곧바로 보이는 칸 전부에 적용한다. */
  setEnabled(on,app){
    this._on=!!on;
    PrefStore.local.setBool(STORE_KEYS.termGpu,this._on);
    this.apply(app);
  },

  apply(app){
    if(!app||!app.tools) return;
    // FR-TGR-7a: 두 렌더러의 칸 폭이 다르다 — 바뀐 칸은 다시 잰다.
    for(const p of app.tools.values()){
      const vis=p.el.classList.contains('vis'), was=!!p._gpu;
      p.syncGpu(vis);
      if(vis&&was!==!!p._gpu) p.doFit();
    }
  },

  /** FR-TGR-9·11: 이 페이지에서는 다시 시도하지 않는다. 흔적은 한 번만 남긴다. */
  _giveUp(why){
    if(this.unavailable) return;
    this.unavailable=true;
    ErrorLog.push('gpu',why);
  },
};

Object.assign(TerminalTool.prototype,{
  /** FR-TGR-4~7·10: 멱등이다. 상태가 같으면 아무것도 하지 않는다. */
  syncGpu(visible){
    if(!this.term){ this._gpu=null; return }
    // FR-TGR-10: 손실된 칸은 한 번 숨어야 다시 붙는다.
    if(!visible) this._gpuLost=false;
    // D-TGR-6: 터치 기기는 DOM 글자 위의 OS 선택을 쓴다 (FR-TCP-7·8) — 같은 판정으로 비켜선다.
    const want=!!visible&&!this._gpuLost&&!TermGpu.unavailable&&TermGpu.enabled()&&typeof WebglAddon!=='undefined'&&!this._tsTouch();
    if(want===!!this._gpu) return;
    if(want) this._gpuAttach();
    else this._gpuDetach();
  },

  gpuRenderer(){ return this._gpu?'webgl':'dom' },

  _gpuAttach(){
    let addon=null;
    const before=this._gpuCanvases();
    try{
      addon=new WebglAddon.WebglAddon();
      this.term.loadAddon(addon);
    }catch(e){
      if(addon) addon.dispose();
      TermGpu._giveUp('webgl: '+((e&&e.message)||e));
      return;
    }
    addon.onContextLoss(()=>{ if(this._gpu===addon) this._gpuOnLoss() });
    this._gpu=addon;
    // addon 은 링크 표시용 2D 캔버스도 만든다 — 새 캔버스 중 WebGL 의 것을 고른다.
    this._gpuCanvas=this._gpuCanvases().find(c=>!before.includes(c)&&c.getContext('webgl2'))||null;
    // FR-TGR-10 개정: 캔버스의 손실을 곧바로 받는다. addon 은 복구를 3초 기다리고 그동안 칸이 빈다.
    if(!this._gpuLossHook&&this.el&&typeof this.el.addEventListener==='function'){
      this._gpuLossHook=e=>{ if(this._gpu&&e.target===this._gpuCanvas) this._gpuOnLoss() };
      this.el.addEventListener('webglcontextlost',this._gpuLossHook,true);
    }
  },

  _gpuCanvases(){
    const el=this.term&&this.term.element;
    return el&&typeof el.querySelectorAll==='function'?[...el.querySelectorAll('canvas')]:[];
  },

  _gpuOnLoss(){
    this._gpuDetach();
    this._gpuLost=true;
    this.doFit();
    if(++TermGpu.losses>=TERM_GPU_LOSS_LIMIT) TermGpu._giveUp('webgl: context lost '+TermGpu.losses+' times');
  },

  _gpuDetach(){
    const addon=this._gpu, canvas=this._gpuCanvas;
    this._gpu=null;
    this._gpuCanvas=null;
    if(addon) addon.dispose();
    // FR-TGR-10a: addon 은 컨텍스트를 반납하지 않는다 — 쌓이면 보이는 칸의 것이 회수된다.
    const gl=canvas&&canvas.getContext('webgl2');
    const ext=gl&&gl.getExtension('WEBGL_lose_context');
    if(ext) ext.loseContext();
  },
});
