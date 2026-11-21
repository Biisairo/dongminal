/**
 * KitModal — 킷 모달 (UI_KIT_SRS FR-UIK-25 · REFACTOR3_FE_DIALOG_SRS FR-FED-8). `UIKit.modal(spec)` 이 이것에 맡긴다.
 *
 * 오버레이 + 상자. 닫는 길 셋(닫기 버튼·바깥 클릭·Esc)이 **같은 onClose 로 간다** — 지금까지 셋 중 둘만 있는
 * 상자가 있었다. `open()` 이 돌려주는 것은 `{el, box, body, foot, close, defBtn}` 이고, 붙이는 것은 부르는 쪽의
 * 일이다.
 *
 * FR-OPT-11-5 (FEC-27): 머리 없는 확인 상자도 이 골격을 쓴다 —
 *   head:false   머리(제목·닫기 버튼)를 세우지 않는다. 이름은 `labelledBy` 가 준다
 *   boxCls·bodyCls·footCls  상자·본문·버튼 줄에 더할 클래스
 *   focus        열 때 포커스를 줄 자리(목적 버튼 대신)
 *   action.value 그 버튼으로 닫으면 `onClose(value)` 로 간다. 다른 닫는 길은 값이 없다
 *   action.tip   툴팁만 준다 — 이름(aria-label)은 글자가 준다
 *   action.default  목적 버튼으로 삼는다
 * `close(v)` 도 값을 받는다 — 비동기로 끝나는 동작이 결과를 싣고 닫는 자리다.
 */
class KitModal extends Dialog {
  constructor(spec){
    super();
    this.spec=spec||{};
    this.closed=false;
  }

  open(){
    const s=this.spec;
    const ov=document.createElement('div');
    ov.className=['ui-modal',s.cls||''].filter(Boolean).join(' ');
    const box=document.createElement('div');
    box.className=['ui-modal-box',s.boxCls||''].filter(Boolean).join(' ');
    if(s.width) box.style.width=s.width;
    ov.appendChild(box);
    this.ov=this.el=ov; this.box=box;

    let head=null,titleEl=null;
    if(s.head!==false){
      head=document.createElement('div');
      head.className='ui-modal-head';
      titleEl=document.createElement('span');
      titleEl.className='ui-modal-title';
      titleEl.textContent=s.title||'';
      head.appendChild(titleEl);
      const sp=document.createElement('span');
      sp.className='ui-modal-spacer';
      head.appendChild(sp);
      box.appendChild(head);
    }

    const body=document.createElement('div');
    body.className=['ui-modal-body',s.bodyCls||''].filter(Boolean).join(' ');
    if(s.body) body.appendChild(s.body);
    box.appendChild(body);

    let foot=null;
    if(s.actions&&s.actions.length){
      foot=document.createElement('div');
      foot.className=['ui-modal-foot',s.footCls||''].filter(Boolean).join(' ');
      box.appendChild(foot);
    }

    const close=v=>this.close(v);
    if(head) head.appendChild(UIKit.button({icon:'x',title:s.closeTitle||'Close',kind:'ghost',cls:'ui-modal-close',onClick:()=>close()}));
    ov.addEventListener('mousedown',e=>{ if(e.target===ov) close() });
    /**
     * FR-PDA-1·11: 목적 버튼은 **기제가 정한다** — `kind` 가 `primary` 또는 `danger` 인 마지막 action 이고, 없으면
     * 마지막 action 이다. 여기 두면 앞으로 생길 호출자도 자동으로 덮인다. 붙기 전에는 `focus()` 가 아무 일도
     * 하지 않으므로 포커스는 `dialogOpen` 이 다음 프레임에 준다.
     */
    let primary=null,last=null,def=null;
    for(const a of (s.actions||[])){
      const b=UIKit.button(Object.assign({},a,{
        onClick:()=>{ if(!a.keepOpen) close(a.value); if(a.onClick) a.onClick() },
      }));
      if(a.tip) b.title=a.tip;
      foot.appendChild(b);
      last=b;
      if(a.kind==='primary'||a.kind==='danger') primary=b;
      if(a.default) def=b;
    }
    /**
     * FR-A11Y-30 / D-A11Y-13: 액션 줄을 `←`/`→` 로도 옮긴다. `keepTabStops` 다 — 버튼은 **각각** 탭 정지점으로
     * 남는다. 비활성 버튼은 목록에서 빠진다.
     */
    if(foot){
      this.own(UIKit.roving(foot,{
        horizontal:true,
        keepTabStops:true,
        items:()=>[...foot.querySelectorAll('.ui-btn')].filter(b=>!b.disabled),
      }));
    }
    const defBtn=def||primary||last;
    // 어느 버튼에 포커스를 주는지는 여기가 정한다(위 FR-PDA-1·11). 주는 방법은 트랩·복귀와 한 벌이다(FR-A11Y-18).
    this._attach({
      labelledBy:s.labelledBy||titleEl,label:s.label||s.title||'',returnTo:s.returnTo,focus:s.focus||defBtn,
    });
    return {el:ov,box,body,foot,close,defBtn};
  }

  _escape(){ this.close() }

  /** 닫는 길 셋과 `close(v)` 가 여기로 온다. `onClose` 는 한 번만 부른다. */
  close(v){
    if(this.closed) return;
    this.closed=true;
    this._detach();
    if(this.ov&&this.ov.parentNode) this.ov.parentNode.removeChild(this.ov);
    this.dispose();
    if(this.spec.onClose) this.spec.onClose(v);
  }
}
