/**
 * Dongminal — 간선 상태와 그 알림 (PEER_NETWORK_SRS FR-PNW-81·82).
 *
 * 서버가 `edges_changed` 를 밀면 `GET /api/edges` 를 다시 읽는다 — 주기로 묻지 않는다.
 * 설정의 Edges 패널(`app-settings-edges.js`)은 여기서 읽은 `_edges` 를 그린다.
 *
 * 로드 순서 계약: `app.js` 뒤, `state-registry.js` 뒤.
 */

/** FR-PNW-80: 화면에 보이는 지문의 길이. */
const EDGE_FP_SHOWN=16;

/** 승인 대기의 만료 뒤 다시 읽기까지 더 기다리는 여유. 서버 시계와의 작은 차이를 넘긴다. */
const EDGE_EXPIRY_SLACK_MS=1000;

function edgeFp16(fp){ return String(fp||'').slice(0,EDGE_FP_SHOWN) }

/** 만료까지 남은 시간 `m:ss`. 지났거나 읽을 수 없으면 빈 값이다. */
function edgeRemain(expires,now){
  const ms=Date.parse(expires)-now;
  if(!(ms>0)) return '';
  const s=Math.ceil(ms/1000);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

Object.assign(App.prototype, {
  _edgesRestore(src){
    const flight=this._restoreBegin('edges');
    return stateFetch(src,'/api/edges').then(r=>{
      if(!this._restoreLive('edges',flight)) return;
      // 503 은 노드 계층이 없는 서버다. 읽기 실패로 알림을 거두지 않는다.
      if(r.ok&&r.data){
        this._edges=r.data;
        this._edgesPendingNotice(r.data.pending||[]);
        this._edgesExpiryArm(r.data.pending||[]);
        this._edgesPaint();
        // UX_BATCH12 FR-LIV-4: 노드 설정 폼은 목록과 따로 — 지문이 바뀌었을 때만 따라간다.
        const v=r.data;
        if(this._liveOpen('edges')) this._liveChanged('edges',r,this._egNodeCollect(),()=>{
          this._egNodePaint(v); this._liveMark('edges',r,this._egNodeCollect());
        });
      }
      this._restoreEnd('edges',flight);
    });
  },

  _onEdgesChanged(a){
    if(a&&a.paired) Toast.show(t('edge.paired_notice',{name:a.paired}),'ok',0);
    return this._edgesRestore();
  },

  /**
   * 승인 대기는 시간으로 만료돼도 방송이 없다. 가장 이른 만료 뒤에 한 번 다시 읽는다.
   * 주기 조회가 아니다 — 대기가 없으면 타이머도 없다 (I-24·I-64).
   */
  _edgesExpiryArm(pending){
    this.timers.cancel(this._edgeExpiryTimer);
    this._edgeExpiryTimer=null;
    const at=Math.min(...pending.map(p=>Date.parse(p.expires)).filter(Number.isFinite));
    if(!Number.isFinite(at)) return;
    this._edgeExpiryTimer=this.timers.after(Math.max(0,at-Date.now())+EDGE_EXPIRY_SLACK_MS,
      ()=>this._edgesRestore(),{owner:'app',label:'edge-expiry'});
  },

  /** FR-PNW-81: 처음 보는 대기가 있을 때만 띄운다. 대기가 없어지면 거둔다. */
  _edgesPendingNotice(pending){
    const seen=this._edgeSeen||new Set();
    const fresh=pending.some(p=>!seen.has(p.id));
    this._edgeSeen=new Set(pending.map(p=>p.id));
    const live=this._edgeToast&&this._edgeToast.el.isConnected?this._edgeToast:null;
    if(!pending.length){
      if(live) live.close();
      this._edgeToast=null;
      return;
    }
    const msg=t('edge.pending_notice',{n:pending.length});
    if(live){ live.update(msg,'',0); return }
    if(!fresh) return;
    const h=Toast.show(msg,'',0,{cls:'edge-attn',actions:[{
      label:t('edge.pending_open'),
      onClick:()=>{ h.close(); this._openSettings('edges') },
    }]});
    this._edgeToast=h;
  },
});
