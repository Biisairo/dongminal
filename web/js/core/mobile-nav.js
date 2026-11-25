/**
 * Remote Terminal — App 모바일 상단바의 길 (MOBILE_UX_OVERHAUL_SRS FR-MUX-74~79)
 *
 * 상단바의 Activity 단추와 Repo 창의 세그먼트. 둘 다 **모바일에서 처음 필요할 때** 만든다 — 데스크톱
 * DOM 이 종전과 같아야 계산값 기준선(UI_LAYOUT_DEFAULTS_SRS V-LAY-1)이 재는 대상이 바뀌지 않는다.
 * 한 번 서면 남고, 데스크톱에서는 `.mobile-only` 가 감춘다.
 *
 * `MobileNav` 는 `MobileController` 의 부품이다(`mobile.nav`, REFACTOR3_FE_APPCTL_SRS 9c).
 *
 * 로드 순서 계약: mobile 묶음에서 mobile-sheets.js 뒤 (PERF 3.4.12.8).
 */
class MobileNav extends Controller {
  /**
   * PANEL_TEMPLATE_SRS FR-PNT-15~17: 모바일 Activity 시트에서 **다른 화면으로 이동한 뒤** 시트를 닫는 한 자리.
   *
   * 시트는 화면 전체를 덮으므로 이동한 곳은 시트를 닫아야 보인다. 이동을 실제로 한 처리기만 부른다 — 탭 전환·
   * 접기·확인·취소처럼 패널 안에서 끝나는 누름은 부르지 않으므로 시트가 남는다 (FR-PNT-16). 데스크톱 패널은
   * 화면을 덮지 않으므로 그대로 둔다.
   *
   * 부르는 자리: 에이전트 카드(`agents-controller.js`), Background 행(`statusbar-controller.js`), Runs 행(`runs-panel.js`),
   * 채팅 탭 열기(`chat-window.js` `_chatOpenTab`).
   */
  actSheetLeave(){
    if(this.app.isMobile&&this.app.agents.agentsPanelOpen()) this.app.agents.setAgentsPanelOpen(false);
  }

  /**
   * FR-MUX-74·75: Activity 단추의 수. `agentsRender` 가 맨 앞에서 부른다 — 모바일에서 패널이 닫혀
   * 있으면 그 함수가 곧바로 물러서므로, 단추는 그보다 먼저 칠해야 한다.
   * 수는 카드가 그려지는 에이전트(창에 자리가 있는 것)만 센다.
   */
  mobileActSync(){
    if(!this.app.isMobile) return;
    const btn=document.getElementById('m-act-btn')||this._mActBtnEl();
    if(!btn) return;
    const n=this.app.tool.work.workingToolIds().size;   // UX_AUDIT_FIX_SRS FR-UXF-63 과 같은 판정
    const num=btn.querySelector('.m-act-n');
    if(num) num.textContent=n?String(n):'';
    btn.classList.toggle('working',n>0);
    const label=n?TIP_MOBILE_ACTIVITY_WORKING.replace('{n}',String(n)):TIP_MOBILE_ACTIVITY;
    btn.title=label;btn.setAttribute('aria-label',label);
  }

  _mActBtnEl(){
    const menu=document.getElementById('m-drawer-toggle');
    if(!menu) return null;
    const b=document.createElement('button');
    b.type='button';b.id='m-act-btn';
    b.className='mtbtn ui-btn ui-btn-icon ui-btn-ghost mobile-only';
    b.appendChild(UIKit.icon('bot'));
    const dot=document.createElement('span');dot.className='m-act-dot';dot.setAttribute('aria-hidden','true');
    const num=document.createElement('span');num.className='m-act-n';num.setAttribute('aria-hidden','true');
    b.append(dot,num);
    b.addEventListener('click',()=>{
      if(this.app.drawerOpen) this.app.mobile._toggleDrawer(false);
      this.app.agents.list.actPanelOpen();
    });
    menu.before(b);
    return b;
  }

  /** FR-MUX-78: 지금 자리의 세그먼트 — 사이드 자리면 그 사이드 탭, 아니면 편집기. */
  mobileRepoSegCur(){
    return this.app.mobile.mobileOnSide()?this.app.editor.pane.edSideOf(this.app.tool.life.aw()):REPO_SEG_EDITOR.id;
  }

  /**
   * FR-MUX-78: 세그먼트를 누른 일. 사이드 탭이면 사이드 자리로 가서 그 탭으로 바꾼다. 편집기면 포커스
   * 칸의 자리로 간다 — 이미 편집기 자리이고 칸이 여럿이면 다음 칸이다 (칸 순회가 하던 일을 잃지 않는다).
   */
  mobileRepoSegGo(key){
    const s=this.app.tool.life.aw();
    if(!s) return;
    if(key!==REPO_SEG_EDITOR.id){
      this.app.mPaneIdx=0;
      if(this.app.editor.pane.edSideOf(s)!==key) this.app.editor.pane.edSetSide(s,key);   // 다시 그린다
      else this.app.render();
      return;
    }
    const regs=s.layout?this.app.flattenPanes(s.layout):[];
    if(!regs.length) return;
    const off=this.app.mobile.mobileSideSlots();
    let i=regs.findIndex(p=>p&&p.id===this.app.focused);
    if(!this.app.mobile.mobileOnSide()&&regs.length>1) i=(this.app.mPaneIdx-off+1)%regs.length;
    if(i<0) i=0;
    this.app.mPaneIdx=i+off;
    this.app.focus.setFocusState(regs[i].id);
    this.app.wsSave.save();
    this.app.render();
  }

  /**
   * FR-MUX-77·79: 세그먼트를 칠한다. 모바일 Repo 창에서만 서고, 칸 순회(`.m-pane-nav`)는 그동안
   * 감춘다(`_rPaneIndicator`). 그 창에 설 수 없는 사이드 탭은 세그먼트에도 없다.
   */
  mobileRepoSegSync(){
    const on=this.app.mobile.mobileSideSlots()>0;
    const seg=document.getElementById('m-repo-seg')||(on?this._mRepoSegEl():null);
    if(!seg) return;
    seg.hidden=!on;
    if(!on) return;
    const s=this.app.tool.life.aw(),cur=this.mobileRepoSegCur();
    const allowed=new Set(this.app.editor.pane.edSideTabs(s).map(d=>d.id));
    let n=0;
    if(s.layout) for(const p of this.app.flattenPanes(s.layout)) n+=(p&&p.tabs)?p.tabs.length:0;
    for(const b of seg.children){
      const k=b.dataset.seg;
      if(k===REPO_SEG_EDITOR.id){
        b.disabled=!n;
        const num=b.querySelector('.m-seg-n');
        if(num) num.textContent=n?String(n):'';
      }else b.hidden=!allowed.has(k);
      b.setAttribute('aria-pressed',String(k===cur));
    }
  }

  _mRepoSegEl(){
    const nav=document.querySelector('#topbar .m-pane-nav');
    if(!nav) return null;
    const seg=document.createElement('span');
    seg.id='m-repo-seg';seg.className='m-repo-seg mobile-only';
    seg.setAttribute('role','group');
    for(const d of [...REPO_SIDE_TABS,REPO_SEG_EDITOR]){
      const b=document.createElement('button');
      b.type='button';b.className='ui-btn m-seg-btn';
      b.dataset.seg=d.id;b.title=d.title;
      const name=document.createElement('span');name.textContent=d.label;
      b.appendChild(name);
      if(d.id===REPO_SEG_EDITOR.id){
        const num=document.createElement('span');num.className='m-seg-n';
        b.appendChild(num);
      }
      b.addEventListener('click',()=>this.mobileRepoSegGo(d.id));
      seg.appendChild(b);
    }
    nav.after(seg);
    return seg;
  }
}
