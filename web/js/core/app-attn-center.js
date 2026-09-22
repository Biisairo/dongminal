/**
 * Remote Terminal — 주의 센터 팝오버 (UIUX_OVERHAUL_SRS FR-ACT-8·9, D-7)
 *
 *   이전 동작: 배지가 활동 패널의 주의 구역을 연다 (FR-ACT-1)
 *   새  동작: 배지 아래에 팝오버가 뜬다. 패널은 열리지 않는다
 *   이유:     FR-ACT-1 이 한 표면으로 모은 넷에는 **질문이 둘** 있었다 —
 *             주의는 "나를 기다리는 것이 있나" 이고 나머지 셋은 "지금 뭐가
 *             돌고 있나" 다. 물음이 다르면 자리도 다르다
 *
 * 새로 짓지 않았다 — `e9849d4d`("조회는 한 자리에 모인다")가 지운 넷을 그
 * 커밋의 부모에서 그대로 회수했다. 행의 규칙(`.attn-item`)은 지운 적이 없다.
 *
 * **제 파일에 사는 이유.** 되받아 온 넷이 `app-attn.js` 를 500줄 위로 밀었다
 * (FR-STR-40). 가르는 자리가 표면의 경계와 같다 — 이 파일은 **띄우는 일**만
 * 알고, 알람의 수명(`_attn`·`_attnClear`·배지)은 `app-attn.js` 의 것이다.
 *
 * 로드 순서 계약: `app.js` 뒤, `app-attn.js` 뒤.
 */

Object.assign(App.prototype, {

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

  _attnCenterClose(){
    const center=document.getElementById('attn-center');
    if(center) center.classList.remove('open');
  },

  _attnCenterRender(){
    const center=document.getElementById('attn-center');
    if(!center) return;
    center.innerHTML='';
    if(!this._attn.size){this._attnCenterClose();return}
    const head=document.createElement('div');
    head.className='attn-head';
    head.innerHTML=`<span class="attn-title">${escHtml(t('attn.title',{n:this._attn.size}))}</span><button class="ui-btn ui-btn-sm ui-btn-attn attn-clear-all" title="Clear every attention alert">${escHtml(t('attn.clear_all'))}</button>`;
    head.querySelector('.attn-clear-all').addEventListener('click',e=>{e.stopPropagation();this._attnClearAll()});
    center.appendChild(head);
    for(const [toolId,info] of this._attn){
      // FR-NAM-6: 알림도 파생 이름을 쓴다 — 화면의 탭과 다른 이름을 부르면
      // 사용자가 어느 도구인지 못 찾는다.
      const name=this._toolName(toolId,toolId);
      const reason=info&&info.reason==='idle'?t('attn.reason_idle'):t('attn.reason_signal');
      const item=document.createElement('div');
      item.className='attn-item';
      const nameSpan=document.createElement('span');nameSpan.className='attn-name';nameSpan.textContent=name;
      const reasonSpan=document.createElement('span');reasonSpan.className='attn-reason';reasonSpan.textContent=reason;
      item.appendChild(nameSpan);
      item.appendChild(reasonSpan);
      // FR-AEV-15: 무엇에 대한 알람인지. 내용이 없는 에이전트도 있으므로(그 쪽은
      // 페이로드가 비어 온다) 있을 때만 붙인다 — 빈 줄이 자리를 먹지 않는다.
      const detail=this._attnDetail(toolId);
      if(detail){
        const d=document.createElement('span');
        d.className='attn-detail';
        d.textContent=detail;
        d.title=detail;
        item.appendChild(d);
      }
      item.addEventListener('click',()=>{this.jumpToTool(toolId);this._attnCenterClose()});
      // 로드맵 M7 `FUI-22`: **하나만** 뗀다. 항목 클릭은 이동이고 "모두 제거" 는
      // 전부다 — 보고 넘기려는 알림 하나를 위해 그 둘 중 하나를 고르게 하지 않는다.
      // 서버에도 알린다(`_attnClear`) — 다른 브라우저의 배지도 함께 내려간다.
      const x=UIKit.button({icon:'x',title:'Dismiss this alert',kind:'ghost',size:'sm',cls:'attn-x'});
      x.addEventListener('click',e=>{e.stopPropagation();this._attnClear(toolId,false);this._attnCenterRender()});
      item.appendChild(x);
      center.appendChild(item);
    }
  },

});
