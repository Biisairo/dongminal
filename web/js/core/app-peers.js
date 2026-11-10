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
        this._peersPaint();
      }
      this._restoreEnd('peers',flight);
    });
  },

  _onPeersChanged(a){
    if(a&&a.paired) Toast.show(t('peer.paired_notice',{name:a.paired}),'ok',0);
    return this._peersRestore();
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
