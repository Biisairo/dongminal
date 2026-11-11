/**
 * Dongminal — 짝 상태와 그 알림 (PEER_NETWORK_SRS FR-PNW-81·82).
 *
 * 서버가 `peers_changed` 를 밀면 `GET /api/peers` 를 다시 읽는다 — 주기로 묻지 않는다.
 * 설정의 Peers 패널(`app-settings-peers.js`)은 여기서 읽은 `_peers` 를 그린다.
 *
 * 로드 순서 계약: `app.js` 뒤, `state-registry.js` 뒤.
 */

/** FR-PNW-80: 화면에 보이는 지문의 길이. */
const PEER_FP_SHOWN=16;

/** 승인 대기의 만료 뒤 다시 읽기까지 더 기다리는 여유. 서버 시계와의 작은 차이를 넘긴다. */
const PEER_EXPIRY_SLACK_MS=1000;

function peerFp16(fp){ return String(fp||'').slice(0,PEER_FP_SHOWN) }

/** 만료까지 남은 시간 `m:ss`. 지났거나 읽을 수 없으면 빈 값이다. */
function peerRemain(expires,now){
  const ms=Date.parse(expires)-now;
  if(!(ms>0)) return '';
  const s=Math.ceil(ms/1000);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

Object.assign(App.prototype, {
  _peersRestore(src){
    const flight=this._restoreBegin('peers');
    return stateFetch(src,'/api/peers').then(r=>{
      if(!this._restoreLive('peers',flight)) return;
      // 503 은 노드 계층이 없는 서버다. 읽기 실패로 알림을 거두지 않는다.
      if(r.ok&&r.data){
        this._peers=r.data;
        this._peersPendingNotice(r.data.pending||[]);
        this._peersExpiryArm(r.data.pending||[]);
        this._peersPaint();
        // UX_BATCH12 FR-LIV-4: 노드 설정 폼은 목록과 따로 — 지문이 바뀌었을 때만 따라간다.
        const v=r.data;
        if(this._liveOpen('peers')) this._liveChanged('peers',r,this._pnNodeCollect(),()=>{
          this._pnNodePaint(v); this._liveMark('peers',r,this._pnNodeCollect());
        });
      }
      this._restoreEnd('peers',flight);
    });
  },

  _onPeersChanged(a){
    if(a&&a.paired) Toast.show(t('peer.paired_notice',{name:a.paired}),'ok',0);
    return this._peersRestore();
  },

  /**
   * 승인 대기는 시간으로 만료돼도 방송이 없다. 가장 이른 만료 뒤에 한 번 다시 읽는다.
   * 주기 조회가 아니다 — 대기가 없으면 타이머도 없다 (I-24·I-64).
   */
  _peersExpiryArm(pending){
    this.timers.cancel(this._peerExpiryTimer);
    this._peerExpiryTimer=null;
    const at=Math.min(...pending.map(p=>Date.parse(p.expires)).filter(Number.isFinite));
    if(!Number.isFinite(at)) return;
    this._peerExpiryTimer=this.timers.after(Math.max(0,at-Date.now())+PEER_EXPIRY_SLACK_MS,
      ()=>this._peersRestore(),{owner:'app',label:'peer-expiry'});
  },

  /** FR-PNW-81: 처음 보는 대기가 있을 때만 띄운다. 대기가 없어지면 거둔다. */
  _peersPendingNotice(pending){
    const seen=this._peerSeen||new Set();
    const fresh=pending.some(p=>!seen.has(p.id));
    this._peerSeen=new Set(pending.map(p=>p.id));
    const live=this._peerToast&&this._peerToast.el.isConnected?this._peerToast:null;
    if(!pending.length){
      if(live) live.close();
      this._peerToast=null;
      return;
    }
    const msg=t('peer.pending_notice',{n:pending.length});
    if(live){ live.update(msg,'',0); return }
    if(!fresh) return;
    const h=Toast.show(msg,'',0,{cls:'peer-attn',actions:[{
      label:t('peer.pending_open'),
      onClick:()=>{ h.close(); this._openSettings('peers') },
    }]});
    this._peerToast=h;
  },
});
