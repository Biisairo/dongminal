/**
 * Dongminal — 간선 상태와 그 알림 (PEER_NETWORK_SRS FR-PNW-81, EDGE_PAIRING_SRS FR-EPR-5·23).
 *
 * 서버가 `edges_changed` 를 밀면 `GET /api/edges` 를 다시 읽는다 — 주기로 묻지 않는다.
 * 설정의 Edges 패널(`settings-edges.js`)은 여기서 읽은 `_edges` 를 그린다.
 *
 * 로드 순서 계약: `app.js` 뒤, `state-registry.js` 뒤.
 */

/** FR-EPR-32: 화면에 보이는 지문의 길이. */
const EDGE_FP_SHOWN=16;

function edgeFp16(fp){ return String(fp||'').slice(0,EDGE_FP_SHOWN) }

/** UX_AUDIT_FIX_SRS FR-UXF-53: 지문의 4자 묶음. 앞 `EDGE_FP_SHOWN` 자가 강조(`key`)다. 이어 붙이면 원문이다. */
const EDGE_FP_GROUP=4;
function edgeFpGroups(fp){
  const s=String(fp||''),out=[];
  for(let i=0;i<s.length;i+=EDGE_FP_GROUP) out.push({text:s.slice(i,i+EDGE_FP_GROUP),key:i<EDGE_FP_SHOWN});
  return out;
}

/** PROFILE_NAME_SRS FR-PFN-6: `이름#번호`. 번호는 서버가 준 값이고, 없으면 이름만이다. */
function edgeHandle(p){ return p.tag?p.name+'#'+p.tag:p.name }

/** FR-EPR-32 · PROFILE_NAME_SRS FR-PFN-22: 간선 한 줄 — `이름#번호 · 주소:포트`. 주소를 모르면 `-` 다. */
function edgeWho(p){
  const addr=!p.addr?'-':(String(p.addr).includes(':')?'['+p.addr+']':p.addr)+':'+p.port;
  return edgeHandle(p)+' · '+addr;
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
        // PROFILE_NAME_SRS FR-PFN-20: 탭 제목의 이름은 노드 이름이다. 이름을 바꾸면 방송이 다시 읽힌다.
        if(r.data.node&&r.data.node.name!==profileName){ profileName=r.data.node.name; this._applyPageTitle() }
        if(this._pfFollow) this._pfFollow(r);
        this._edgesPaint();
        // EDGE_MESH_SRS FR-EGM-56: 개인채팅의 초대 버튼은 망 그림을 따른다.
        if(this._chatViewsPaint) this._chatViewsPaint();
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
    if(paired) Toast.show(t('edge.paired_notice',{name:edgeHandle(paired)}),'ok',0);
    // FR-EPR-23: 상대가 지운 간선만 알린다. 이쪽에서 끊은 것은 끊기 단계에서 이미 보였다.
    if(removed&&a.byPeer) Toast.show(t('edge.removed_notice',{name:edgeHandle(removed)}),'',0);
    // EDGE_MESH_SRS FR-EGM-55: 망 이웃이 보낸 간선 초대를 받았다. 맺기·거절은 Edges 에서 한다.
    if(a&&a.invited) Toast.show(t('edge.invited_notice',{name:edgeHandle(a.invited)}),'',0);
    return this._edgesRestore();
  },
});
