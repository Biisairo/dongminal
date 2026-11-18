/**
 * Dongminal — 간선 상태와 그 알림 (PEER_NETWORK_SRS FR-PNW-81, EDGE_PAIRING_SRS FR-EPR-5·23).
 *
 * 서버가 `edges_changed` 를 밀면 `GET /api/edges` 를 다시 읽는다 — 주기로 묻지 않는다.
 * 설정의 Edges 패널(`app-settings-edges.js`)은 여기서 읽은 `_edges` 를 그린다.
 *
 * 로드 순서 계약: `app.js` 뒤, `state-registry.js` 뒤.
 */

/** FR-EPR-32: 화면에 보이는 지문의 길이. */
const EDGE_FP_SHOWN=16;

function edgeFp16(fp){ return String(fp||'').slice(0,EDGE_FP_SHOWN) }

/** FR-EPR-32: 간선 한 줄 — `표시 이름 · 지문 앞 16자리 · 주소:포트`. 주소를 모르면 `-` 다. */
function edgeWho(p){
  const addr=!p.addr?'-':(String(p.addr).includes(':')?'['+p.addr+']':p.addr)+':'+p.port;
  return p.name+' · '+edgeFp16(p.fp)+' · '+addr;
}

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
      // 503 은 노드 계층이 없는 서버다.
      if(r.ok&&r.data){
        this._edges=r.data;
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
    const paired=a&&a.paired, removed=a&&a.removed;
    if(paired) Toast.show(t('edge.paired_notice',{name:paired.name,fp:edgeFp16(paired.fp)}),'ok',0);
    // FR-EPR-23: 상대가 지운 간선만 알린다. 이쪽에서 끊은 것은 끊기 단계에서 이미 보였다.
    if(removed&&a.byPeer) Toast.show(t('edge.removed_notice',{name:removed.name}),'',0);
    return this._edgesRestore();
  },
});
