/**
 * Otterminal — 간선 상태와 그 알림 (PEER_NETWORK_SRS FR-PNW-81, EDGE_PAIRING_SRS FR-EPR-5·23).
 *
 * 서버가 `edges_changed` 를 밀면 `GET /api/edges` 를 다시 읽는다 — 주기로 묻지 않는다.
 * 설정의 Edges 패널(`settings-edges.js`)은 여기서 읽은 `_edges` 를 그린다.
 *
 * `EdgesController` 가 읽기·알림과 설정 ▸ Edges 의 망 그림·받은 초대(EDGE_MESH_SRS FR-EGM-50~56)를 진다. App 은 이것을
 * `edges` 로 든다(REFACTOR3_FE_APPCTL_SRS 9a). 읽은 `_edges` 는 App 에 남는다 — 설정 섹션·채팅이 읽는다(FR-FEA-2).
 * 망 그림의 순수 함수(`meshLayout` 등)는 `edges-mesh.js` 다. 망 그림과 받은 초대를 그리는 메서드는 `settings` 화면 묶음의
 * `edges-mesh-view.js` 가 이 원형에 얹는다 (PERF D-41).
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
  const s=Math.ceil(ms/MS_PER_SEC);
  return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
}

class EdgesController extends Controller {
  _edgesRestore(src){
    const flight=this.app.wsSync._restoreBegin('edges');
    return stateFetch(src,'/api/edges').then(r=>{
      if(!this.app.wsSync._restoreLive('edges',flight)) return;
      // 503 은 노드 계층이 없는 서버다.
      if(r.ok&&r.data){
        this.app._edges=r.data;
        // PROFILE_NAME_SRS FR-PFN-20: 탭 제목의 이름은 노드 이름이다. 이름을 바꾸면 방송이 다시 읽힌다.
        if(r.data.node&&r.data.node.name!==profileName){ profileName=r.data.node.name; this.app.settings.apply._applyPageTitle() }
        this.app.settings.section('profile')?._pfFollow(r);
        this.app.settings.section('edges')?._edgesPaint();
        // EDGE_MESH_SRS FR-EGM-56: 개인채팅의 초대 버튼은 망 그림을 따른다.
        if(this.app.chat.views?._chatViewsPaint) this.app.chat.views._chatViewsPaint();
        // UX_BATCH12 FR-LIV-4: 노드 설정 폼은 목록과 따로 — 지문이 바뀌었을 때만 따라간다.
        const v=r.data;
        if(this.app.settings.live._liveOpen('edges')) this.app.settings.live._liveChanged('edges',r,this.app.settings.section('edges')?._egNodeCollect(),()=>{
          this.app.settings.section('edges')?._egNodePaint(v); this.app.settings.live._liveMark('edges',r,this.app.settings.section('edges')?._egNodeCollect());
        });
      }
      this.app.wsSync._restoreEnd('edges',flight);
    });
  }

  /** CHANNEL_PROTOCOL C2b: `edges.notice` 사건. 상태는 `edges` 토픽이 따로 준다. */
  _onEdgesNotice(a){
    const paired=a&&a.paired, removed=a&&a.removed;
    if(paired) Toast.show(t('edge.paired_notice',{name:edgeHandle(paired)}),'ok',0);
    // FR-EPR-23: 상대가 지운 간선만 알린다. 이쪽에서 끊은 것은 끊기 단계에서 이미 보였다.
    if(removed&&a.byPeer) Toast.show(t('edge.removed_notice',{name:edgeHandle(removed)}),'',0);
    // EDGE_MESH_SRS FR-EGM-55: 망 이웃이 보낸 간선 초대를 받았다. 맺기·거절은 Edges 에서 한다.
    if(a&&a.invited) Toast.show(t('edge.invited_notice',{name:edgeHandle(a.invited)}),'',0);
  }

  /** 망 이웃 n 에게 간선 초대를 보낸다 (FR-EGM-53·56). */
  async _egInviteSend(n){
    const r=await apiPost('/api/edges/invite/send',{to:n.fp});
    if(r.ok) Toast.show(t('edge.invite_sent',{name:edgeHandle(n)}),'ok');
    else Toast.show(apiErrText(r,t('edge.invite_send_fail')),'err');
    return r;
  }
}
