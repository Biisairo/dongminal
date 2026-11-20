/**
 * Dongminal — 작업 중 표식 (UX_AUDIT_FIX_SRS FR-UXF-60~64, 진단 X6·O2, 사용자 결정 D-18).
 *
 * 도구의 활동 보고가 `working` 이면 칸의 탭·사이드바 창 행·작업 패널의 에이전트 탭이 같은 점을 가진다.
 * 주의(`_attn`) 표식이 있는 자리에는 점을 두지 않는다 — 사람이 손대야 하는 것이 앞선다.
 *
 * 로드 순서 계약: app-attn.js · app-agents.js 뒤 — prototype 확장이다.
 */
const WORK_DOT_CLASS='work-dot';

/** FR-UXF-60: `el` 의 직계 자식 표식을 `on` 에 맞춘다. 새로 둘 때는 `before` 앞(없으면 끝)이다. */
function workDotSync(el,on,before){
  const cur=el.querySelector(':scope > .'+WORK_DOT_CLASS);
  if(!on){ if(cur) cur.remove(); return }
  if(cur) return;
  const d=document.createElement('span');
  d.className=WORK_DOT_CLASS;
  d.setAttribute('aria-hidden','true');
  el.insertBefore(d,before||null);
}

Object.assign(App.prototype, {
  /** FR-UXF-60: 도구가 작업 중인가. */
  toolWorking(toolId){
    const a=toolId&&this._activity.get(toolId);
    return !!a&&a.state===ACTIVITY_STATE.WORKING;
  },

  /** 작업 중이고 창에 자리가 있는 도구 — 모바일 작업 단추·에이전트 탭 배지의 수가 이것이다. */
  workingToolIds(){
    const out=new Set();
    for(const id of this._activity.keys()) if(this.toolWorking(id)&&this.findToolLocation(id)) out.add(id);
    return out;
  },

  /** FR-UXF-62: 창 layout 안에 작업 중인 도구가 있는가 (`windowHasAttn` 과 같은 걸음). */
  windowWorking(s){
    if(!s||!s.layout||!this._activity.size) return false;
    const walk=(node)=>{
      if(!node) return false;
      if(node.type==='pane') return (node.tabs||[]).some(tab=>this.toolWorking(tab.toolId));
      if(node.children) return node.children.some(walk);
      return false;
    };
    return walk(s.layout);
  },

  /** FR-UXF-61: 탭에 점을 두는가. */
  tabWorkDot(toolId){ return this.toolWorking(toolId)&&!this.attnHas(toolId) },

  /** FR-UXF-62: 창 행에 점을 두는가. */
  windowWorkDot(s){ return this.windowWorking(s)&&!this.windowHasAttn(s) },

  /** FR-UXF-64: 작업 중 모임이 바뀌었을 때만 표식을 고친다. */
  _workSync(){
    const sig=Array.from(this.workingToolIds()).sort().join(',');
    if(sig===this._workSig) return;
    this._workSig=sig;
    this._workRefresh();
  },

  /** 전체 render() 없이 표식만 고친다 — `_attnRefresh` 와 같은 이유(포커스 플리커). */
  _workRefresh(){
    document.querySelectorAll('#area .pn-tab[data-toolid]').forEach(el=>{
      workDotSync(el,this.tabWorkDot(el.dataset.toolid),el.querySelector('.pn-tab-label'));
    });
    document.querySelectorAll('#windows .si[data-sid]').forEach(el=>{
      const s=this.ws.windows.find(x=>x.id===el.dataset.sid);
      const name=el.querySelector('.sbl-name');
      workDotSync(el,!!s&&this.windowWorkDot(s),name?name.nextSibling:null);
    });
  },
});
