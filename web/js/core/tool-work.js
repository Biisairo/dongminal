/**
 * Dongminal — 작업 중 표식 (UX_AUDIT_FIX_SRS FR-UXF-60~64, 진단 X6·O2, 사용자 결정 D-18).
 *
 * 도구의 활동 보고가 `working` 이면 칸의 탭·사이드바 창 행·작업 패널의 에이전트 탭이 표식을 가진다.
 * 사이드바 창 행은 점 대신 선택 점을 두르는 링이다 (FR-UXF-129, D-44).
 * 주의(`_attn`) 표식이 있는 자리에는 점을 두지 않는다 — 사람이 손대야 하는 것이 앞선다.
 *
 * `ToolController` 의 부품 `.work` 다(REFACTOR3_FE_APPCTL_SRS 9j, 옛 `app-work.js`). 마지막으로 칠한 표식 `_workSig` 는 이 부품의
 * 것이다(§2.2 SH-4).
 */
const WORK_DOT_CLASS='work-dot';
// FR-UXF-129 (D-44): 사이드바 창 행은 점 대신 이 클래스로 선택 점에 링을 두른다.
const WORK_ROW_CLASS='working';

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

/**
 * REFACTOR3_FE_FIX_SRS FR-FFX-1~3 (P8-2): 작업 중이면 툴팁 첫 줄 끝과 접근 이름이 `working` 을 말한다.
 * 첫 줄인 이유는 둘째 줄이 계정 틴트이기 때문이다(D-FFX-3). 이름은 `aria-hidden` 이 아닌 자식의 글자다.
 * 작업 중이 아니면 덧붙인 것을 걷고 `aria-label` 을 지운다(D-FFX-2). 멱등이다.
 */
function workLabelSync(el,on){
  const lines=String(el.title||'').split('\n');
  if(lines[0].endsWith(TIP_WORKING_SUFFIX)) lines[0]=lines[0].slice(0,-TIP_WORKING_SUFFIX.length);
  if(on) lines[0]+=TIP_WORKING_SUFFIX;
  el.title=lines.join('\n');
  if(!on){ el.removeAttribute('aria-label'); return }
  const name=Array.from(el.children).filter(c=>c.getAttribute('aria-hidden')!=='true')
    .map(c=>(c.textContent||'').trim()).filter(Boolean).join(' ');
  el.setAttribute('aria-label',name+TIP_WORKING_SUFFIX);
}

class ToolWork extends Controller {
  /** FR-UXF-60: 도구가 작업 중인가. */
  toolWorking(toolId){
    const a=toolId&&this.app._activity.get(toolId);
    return !!a&&a.state===ACTIVITY_STATE.WORKING;
  }

  /** 작업 중이고 창에 자리가 있는 도구 — 모바일 작업 단추·에이전트 탭 배지의 수가 이것이다. */
  workingToolIds(){
    const out=new Set();
    for(const id of this.app._activity.keys()) if(this.toolWorking(id)&&this.app.findToolLocation(id)) out.add(id);
    return out;
  }

  /** FR-UXF-62: 창 layout 안에 작업 중인 도구가 있는가 (`windowHasAttn` 과 같은 걸음). */
  windowWorking(s){
    if(!s||!s.layout||!this.app._activity.size) return false;
    const walk=(node)=>{
      if(!node) return false;
      if(node.type==='pane') return (node.tabs||[]).some(tab=>this.toolWorking(tab.toolId));
      if(node.children) return node.children.some(walk);
      return false;
    };
    return walk(s.layout);
  }

  /** FR-UXF-61: 탭에 점을 두는가. */
  tabWorkDot(toolId){ return this.toolWorking(toolId)&&!this.app.attn.attnHas(toolId) }

  /** FR-UXF-62·129: 창 행의 선택 점에 링을 두는가. */
  windowWorkDot(s){ return this.windowWorking(s)&&!this.app.attn.windowHasAttn(s) }

  /** FR-UXF-64: 작업 중 모임이 바뀌었을 때만 표식을 고친다. */
  _workSync(){
    const sig=Array.from(this.workingToolIds()).sort().join(',');
    if(sig===this._workSig) return;
    this._workSig=sig;
    this._workRefresh();
  }

  /** 전체 render() 없이 표식만 고친다 — `_attnRefresh` 와 같은 이유(포커스 플리커). */
  _workRefresh(){
    document.querySelectorAll('#area .pn-tab[data-toolid]').forEach(el=>{
      const on=this.tabWorkDot(el.dataset.toolid);
      workDotSync(el,on,el.querySelector('.pn-tab-label'));
      workLabelSync(el,on);
    });
    document.querySelectorAll('#windows .si[data-sid]').forEach(el=>{
      const s=this.app.ws.windows.find(x=>x.id===el.dataset.sid);
      const on=!!s&&this.windowWorkDot(s);
      el.classList.toggle(WORK_ROW_CLASS,on);
      workLabelSync(el,on);
    });
  }
}

// 바깥이 부르는 이름 — 렌더러·사이드바·작업 패널·e2e.
Controller.delegate(App,'tool.work',['workingToolIds','tabWorkDot','windowWorkDot','_workSync','_workRefresh']);
