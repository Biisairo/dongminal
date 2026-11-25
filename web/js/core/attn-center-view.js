/**
 * Otterminal — 주의 센터 팝오버의 열기·그리기 (PERF 3.4.12.10, D-47). `uiact` 묶음이다.
 *
 * 부팅의 `AttnCenter`(`attn-center.js`) 원형에 자리 잡기·열고 닫기·그리기를 바꿔 단다. 배지를 처음 누를 때 부팅 껍데기의
 * 자리표시가 이 묶음을 싣는다(`Screens.call`). 닫기는 묶음 없이 돌아야 하므로 부팅에 남는다.
 */
Object.assign(AttnCenter.prototype,{

  _positionAttnCenter(){
    const badge=document.getElementById('attn-badge');
    const center=document.getElementById('attn-center');
    if(!badge||!center) return;
    const r=badge.getBoundingClientRect();
    center.style.top=(r.bottom+4)+'px';
    center.style.left='';
    center.style.right=(window.innerWidth-r.right)+'px';
  },

  _attnCenterToggle(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    if(center.classList.contains('open')) this._attnCenterClose();
    else{this._positionAttnCenter();center.classList.add('open');this._attnCenterRender()}
  },

  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-16-2 (FEC-32): 비우고 다시 만들지 않는다 (FR-RPT-3).
   *
   * 알림이 바뀔 때마다 `_attnRefresh` 가 부른다 — 바깥 계기다. 통째로 다시 만들면
   * 보고 있던 행의 `:hover`·툴팁이 알림 하나가 오갈 때마다 사라진다. 머리도 항목이다 —
   * 개수가 바뀌면 그것만 다시 만든다.
   */
  _attnCenterRender(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    if(!this.app._attn.size){center.replaceChildren();this._attnCenterClose();return}
    const items=[{head:true,title:t('attn.title',{n:this.app._attn.size}),clear:t('attn.clear_all')}];
    for(const [toolId,info] of this.app._attn){
      // FR-NAM-6: 알림도 파생 이름을 쓴다 — 화면의 탭과 다른 이름을 부르면
      // 사용자가 어느 도구인지 못 찾는다.
      items.push({toolId,name:this.app.tool.life._toolName(toolId,toolId),
        reason:info&&info.reason==='idle'?t('attn.reason_idle'):t('attn.reason_signal'),
        detail:this.app.attn._attnDetail(toolId)});
    }
    reconcileList(center,items,{
      key:it=>it.head?'head':'item:'+it.toolId,
      // 행이 읽는 값 전부다 (FR-RPT-2).
      sig:it=>it.head?rptKey(it.title,it.clear):rptKey(it.name,it.reason,it.detail),
      build:it=>it.head?this._attnCenterHeadEl(it):this._attnCenterItemEl(it),
    });
  },

  _attnCenterHeadEl(it){
    const head=document.createElement('div');
    head.className='attn-head';
    head.innerHTML=`<span class="attn-title">${escHtml(it.title)}</span>`+
      `<button class="ui-btn ui-btn-sm ui-btn-attn attn-clear-all" title="${escHtml(TIP_ATTN_CLEAR_ALL)}">${escHtml(it.clear)}</button>`;
    head.querySelector('.attn-clear-all').addEventListener('click',e=>{e.stopPropagation();this.app.attn._attnClearAll()});
    return head;
  },

  _attnCenterItemEl(it){
    const toolId=it.toolId;
    const item=document.createElement('div');
    item.className='attn-item';
    const nameSpan=document.createElement('span');nameSpan.className='attn-name';nameSpan.textContent=it.name;
    const reasonSpan=document.createElement('span');reasonSpan.className='attn-reason';reasonSpan.textContent=it.reason;
    item.appendChild(nameSpan);
    item.appendChild(reasonSpan);
    // FR-AEV-15: 무엇에 대한 알람인지. 내용이 없는 에이전트도 있으므로(그 쪽은
    // 페이로드가 비어 온다) 있을 때만 붙인다 — 빈 줄이 자리를 먹지 않는다.
    if(it.detail){
      const d=document.createElement('span');
      d.className='attn-detail';
      d.textContent=it.detail;
      d.title=it.detail;
      item.appendChild(d);
    }
    item.addEventListener('click',()=>{this.app.attn.jumpToTool(toolId);this._attnCenterClose()});
    // 로드맵 M7 `FUI-22`: **하나만** 뗀다. 항목 클릭은 이동이고 "모두 제거" 는
    // 전부다 — 보고 넘기려는 알림 하나를 위해 그 둘 중 하나를 고르게 하지 않는다.
    // 서버에도 알린다(`_attnClear`) — 다른 브라우저의 배지도 함께 내려간다.
    // 다시 그리기는 `_attnClear` → `_attnRefresh` 가 한다(센터가 열려 있으면) — 여기서
    // 한 번 더 그리지 않는다 (FR-OPT-11-7 · FEC-32).
    const x=UIKit.button({icon:'check-check',title:TIP_ATTN_DISMISS,kind:'ghost',size:'sm',cls:'attn-x'});
    x.addEventListener('click',e=>{e.stopPropagation();this.app.attn._attnClear(toolId,false)});
    item.appendChild(x);
    return item;
  },
});
