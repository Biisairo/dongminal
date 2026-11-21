/**
 * Remote Terminal — 활동 패널의 서브에이전트 (ACTIVITY_STATE_SUBAGENT_SRS 묶음 V)
 *
 * 에이전트 카드(`app-agents.js`)에서 서브에이전트를 그리는 부분이다. 보기는 카드 안의
 * 목록 하나다 (UX_BATCH12_SRS FR-SVL-1 — 폴더형 하위 카드는 없어졌다).
 *
 * 로드 순서 계약: `app-agents.js` 뒤. 서로 부르는 이름은 **호출 시점**에만 있으면 된다.
 */

/**
 * SUBAGENT_USAGE_SRS FR-SAU-20~23 · ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-31: 서브에이전트가 그리는 값.
 * 상태는 서버가 훅 활동과 statusLine 을 합쳐 준다. 없으면 statusLine 의 status 로 정한다.
 */
function agentSubagentView(s){
  const hasPct=typeof s.ctxPct==='number';
  const type=s.agentType||'agent';
  const model=(s.model||'').replace(/^claude-/,'');
  const label=[model,s.effort].filter(Boolean).join('·');
  const num=n=>n.toLocaleString('en-US');
  const tokens=typeof s.tokens!=='number'?''
    :typeof s.windowTokens==='number'?num(s.tokens)+' / '+num(s.windowTokens)+' tokens'
    :num(s.tokens)+' tokens';
  const state=s.state||(s.status==='running'?ACTIVITY_STATE.WORKING:ACTIVITY_STATE.DONE);
  const title=[type,s.model||'',s.effort?'effort '+s.effort:'',tokens,s.status||'',s.description||''].filter(Boolean).join(' · ');
  return {type,label,pct:hasPct?Math.round(s.ctxPct):null,fill:hasPct?Math.min(100,Math.max(0,s.ctxPct)):null,
    level:s.ctxLevel||'',done:state===ACTIVITY_STATE.DONE,title,state,tool:s.tool||'',text:s.detail||s.description||''};
}

/** FR-SAU-24 · FR-ASV-37: 서브에이전트들의 재조정 근거. 그려지는 값만 담는다. */
function agentSubagentsSig(list){
  if(!Array.isArray(list)) return '';
  return list.map(s=>{const v=agentSubagentView(s);return [s.id,v.type,v.label,v.pct,v.level,v.done?1:0,v.state,v.tool,v.text].join('\u0003')})
    .join('\u0002');
}

/** FR-ASV-31: 상태 표시 글자 — main 카드의 상태 줄과 같은 모양이다. 앞의 상태 아이콘은 `agentStateIcon` 이 따로 그린다 (UX_AUDIT_FIX_SRS FR-UXF-100). */
function agentStateText(state,tool){
  return (AGENT_STATE_LABEL[state]||state)+(tool?' · '+tool:'');
}

/** UX_AUDIT_FIX_SRS FR-UXF-100: 상태 아이콘 — 카드의 점과 하위 행이 같이 쓴다. 작업 중의 점은 채워 그린다. */
function agentStateIcon(state){
  const name=AGENT_STATE_ICON[state]||AGENT_STATE_ICON.working;
  return UIKit.icon(name,{size:'sm',fill:name==='dot'});
}

/** UX_BATCH12_SRS FR-SVL-3: 없어진 보기 전환이 남긴 브라우저 값의 키. 읽지 않고 지우기만 한다. */
const AGENT_SUB_VIEW_KEY='agentsSubView';

Object.assign(App.prototype, {
  /**
   * ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-36: SSE tool_subagent_activity — 그 서브에이전트의
   * 상태·도구·내용만 바꾼다. 사용량·모델은 다음 복원이 채운다. main 항목이 없으면 버린다.
   */
  _onToolSubagentActivity({toolId,agentId,agentType,state,tool,detail}={}){
    const info=toolId&&agentId&&this._activity.get(toolId);
    if(!info) return;
    const list=Array.isArray(info.subagents)?info.subagents.slice():[];
    const i=list.findIndex(x=>x.id===agentId);
    const upd={state,tool:tool||'',detail:detail||''};
    if(i>=0) list[i]={...list[i],...upd};
    else list.push({id:agentId,agentType:agentType||'',...upd});
    this._activity.set(toolId,{...info,subagents:list});
    this.agentsRender();
  },

  /** FR-ASV-31: 서브에이전트 머리 — (↳) · 종류 · 상태. */
  _agSubHeadEl(v){
    const head=document.createElement('div');head.className='ag-sub-head';
    // UX_AUDIT_FIX_SRS FR-UXF-100: 화살표·상태 기호는 아이콘이다(이전 `↳`·`●` 글자).
    head.appendChild(domEl('span','ag-sub-arrow','')).appendChild(UIKit.icon('corner-down-right',{size:'sm'}));
    head.appendChild(domEl('span','ag-sub-type',v.type));
    head.appendChild(domEl('span','ag-sub-state '+v.state,agentStateText(v.state,v.tool))).prepend(agentStateIcon(v.state),' ');
    return head;
  },

  /** FR-ASV-31: 서브에이전트의 사용량 줄. 그릴 값이 없으면 null 이다. */
  _agSubUsageEl(v){
    if(!v.label&&v.pct===null) return null;
    return this._agUsageEl({pct:v.pct,fill:v.fill,level:v.level,label:v.label,title:v.title});
  },

  /** FR-ASV-34: 목록형 — 카드 안에서 머리 한 줄과 사용량 줄. 내용은 툴팁으로만 보인다. */
  _agSubagentEl(v){
    const row=document.createElement('div');
    row.className='ag-sub'+(v.done?' done':'');
    row.title=v.title;
    row.appendChild(this._agSubHeadEl(v));
    const u=this._agSubUsageEl(v);
    if(u) row.appendChild(u);
    return row;
  },
});
