/**
 * 브라우저 탭 뷰어의 소리 (BROWSER_TAB_SRS FR-BRT-91, `BrowserView.prototype` 증강).
 *
 * 설정 `browserAudio` 가 `viewer` 이고 탭이 **보이는** 동안만 받는다. 서버가 ICE 수집을 마친
 * offer 를 주면 answer 를 한 번에 돌려준다(trickle 없음, STUN·TURN 없음). 연결되지 않으면
 * 조용히 소리 없이 둔다 — 화면은 그대로 돈다.
 *
 * 로드 순서: `browser-view.js` 뒤.
 */

Object.assign(BrowserView.prototype, {
  _audioStart(){
    if(browserAudio!=='viewer'||!this.visible||this._audio||!this.ws||this.ws.readyState!==1) return;
    this._audio={peer:'',pc:null,sink:null};
    this._send({op:'audio',action:'offer'});
  },

  async _onAudio(info){
    const a=this._audio;
    // 서버가 거절했다(임시 탭·설정 불일치) — 화면을 가리지 않고 소리만 없다.
    if(!info||!info.peer){if(a&&!a.pc) this._audioStop(true);return}
    if(!a||a.pc){this._send({op:'audio',action:'stop',peer:String(info.peer)});return}
    a.peer=String(info.peer);
    const pc=new RTCPeerConnection();
    a.pc=pc;
    pc.ontrack=(e)=>{
      if(a.sink) return;
      const el=new Audio();el.srcObject=e.streams[0];a.sink=el;
      this._audioPlay();
    };
    pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'&&this._audio===a) this._audioStop()};
    try{
      await pc.setRemoteDescription({type:'offer',sdp:String(info.sdp||'')});
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise(r=>{
        if(pc.iceGatheringState==='complete'){r();return}
        pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete') r()});
        TIMERS.after(BRV_AUDIO_ICE_MS,r,{owner:this,label:'brv-audio-ice'});
      });
    }catch{
      if(this._audio===a) this._audioStop();
      return;
    }
    if(this._audio!==a) return;
    this._send({op:'audio',action:'answer',peer:a.peer,sdp:pc.localDescription.sdp});
  },

  /** 자동 재생 정책에 막히면 이 뷰의 다음 입력 때 다시 튼다. */
  _audioPlay(){
    const a=this._audio;
    if(!a||!a.sink) return;
    a.sink.play().catch(()=>{
      if(this._audioRetry) return;
      this._audioRetry=()=>{this._audioRetry=null;this._audioPlay()};
      this.el.addEventListener('pointerdown',this._audioRetry,{once:true,capture:true});
      this.el.addEventListener('keydown',this._audioRetry,{once:true,capture:true});
    });
  },

  /** 끝낸다. `quiet` 면 서버에 알리지 않는다 — WS 가 끊기면 서버가 그 peer 를 끝낸다. */
  _audioStop(quiet){
    const a=this._audio;
    if(!a) return;
    this._audio=null;
    if(this._audioRetry){
      this.el.removeEventListener('pointerdown',this._audioRetry,{capture:true});
      this.el.removeEventListener('keydown',this._audioRetry,{capture:true});
      this._audioRetry=null;
    }
    if(a.sink){a.sink.pause();a.sink.srcObject=null}
    if(a.pc) a.pc.close();
    if(!quiet&&a.peer) this._send({op:'audio',action:'stop',peer:a.peer});
  },
});
