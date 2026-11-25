/**
 * Remote Terminal — App 드래그앤드롭 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * 끌어 놓기의 자리 판정과 탭 옮기기. `LayoutController` 의 부품 `.dnd` 다(REFACTOR3_FE_APPCTL_SRS 9i-2, 옛 `app-dnd.js`).
 * 부팅 껍데기다 (PERF 3.4.12.10, D-47): `dragover` 안에서 곧바로 답해야 하는 자리 판정과 표식은 여기 있고, 탭 옮기기 셋의
 * 본체는 `uiact` 묶음의 `layout-dnd-move.js` 가 이 원형에 바꿔 단다. 실리기 전의 부름은 묶음을 실은 뒤 본체로 넘긴다.
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
class LayoutDnd extends Controller {
  // ── Drag helpers ──
  getDragZone(el,e){
    const rect=el.getBoundingClientRect();
    const x=e.clientX-rect.left;const y=e.clientY-rect.top;
    const w=rect.width,h=rect.height;
    if(x/w<0.25)return'left';
    if(x/w>0.75)return'right';
    if(y/h<0.25)return'top';
    if(y/h>0.75)return'bottom';
    return'center';
  }
  showBodyDropIndicator(bodyEl,zone){
    let ind=bodyEl.querySelector('.pn-drop-indicator');
    if(!ind){ind=document.createElement('div');ind.className='pn-drop-indicator';bodyEl.appendChild(ind)}
    ind.dataset.zone=zone;ind.style.display='';
  }
  clearBodyDropIndicator(bodyEl){const ind=bodyEl?.querySelector('.pn-drop-indicator');if(ind)ind.style.display='none'}

  moveTabToPane(...a){ return Screens.call('uiact',this,'moveTabToPane',a) }
  moveTabToWindow(...a){ return Screens.call('uiact',this,'moveTabToWindow',a) }
  splitPaneWithTab(...a){ return Screens.call('uiact',this,'splitPaneWithTab',a) }
}
