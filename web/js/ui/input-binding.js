/**
 * Remote Terminal — keyboard/mouse/shortcut dispatch
 * App 의 _bind 책임을 분리. 동작은 1:1 보존.
 */

class InputBinding {
  constructor(app){ this.app = app; }

  bind(){
    if(this.app.kb) return; this.app.kb=true;
    const sbEl=document.getElementById('sidebar');
    // FR-HSZ-3: 두 핸들의 반대쪽이 같은 요소다 — 콘텐츠 영역.
    const contentEl=document.getElementById('content');
    document.getElementById('split-h').addEventListener('click',()=>this.app.split('horizontal'));
    document.getElementById('split-v').addEventListener('click',()=>this.app.split('vertical'));
    document.getElementById('agents-toggle').addEventListener('click',()=>this.app.agentsToggle());
    const ap=document.getElementById('agents-panel'),aph=document.getElementById('agents-handle');
    try{if(localStorage.getItem('agentsPanelOpen')==='1'){ap.classList.add('open');aph.classList.add('open');document.getElementById('agents-toggle').classList.add('open');this.app.agentsStartPoll()}}catch{}
    /**
     * UI_KIT_SRS FR-HSZ-1·10: 여섯 핸들이 `UIKit.drag` 한 골격을 쓴다.
     *
     * `sides` 가 이 핸들의 **양쪽이 무엇인가**를 말한다 — 왼쪽은 콘텐츠(터미널이
     * 들어 있으므로 `C×R` 이 나온다), 오른쪽은 Agents 패널이다. 자리로 어느
     * 값인지 말하므로 라벨을 붙이지 않는다 (FR-HSZ-3).
     */
    UIKit.drag(aph,{
      axis:'x',
      start:()=>({w0:ap.offsetWidth,c0:contentEl?contentEl.offsetWidth:0}),
      move:(ctx,ev)=>{
        const w=ctx.w0-(ev.clientX-ctx.sx0);
        if(w>=160&&w<=480) document.documentElement.style.setProperty('--ag-w',w+'px');
      },
      sides:(ctx)=>{
        const aw=ap.offsetWidth, cw=contentEl?contentEl.offsetWidth:0, tot=aw+cw;
        return [
          {px:cw,cell:UIKit.grid(this.app.focusedTerminal&&this.app.focusedTerminal(),'x',cw-ctx.c0,0),
            pct:tot?cw/tot*100:null},
          {px:aw,pct:tot?aw/tot*100:null},
        ];
      },
      end:()=>{
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
        try{localStorage.setItem('agentsWidth',ap.offsetWidth)}catch{}
      },
    });
    try{const aw=parseInt(localStorage.getItem('agentsWidth'));if(aw>=160&&aw<=480)document.documentElement.style.setProperty('--ag-w',aw+'px')}catch{}
    // 문서 전역 DnD 수락(1회 바인딩): 드래그 중 화면 전체를 드롭 수락 영역으로 만들어
    // native snap-back(미수락 release 시 원위치 복귀 애니메이션)을 패널 안/밖 어디서든 제거,
    // drop 에서 마지막 dragover 가 기록한 대상 기준 즉시 커밋. FR-AAP-21 / 창 사이드바 공유.
    //
    // UX_REVISION_SRS FR-BLP-13: 사이드바 리스트는 **타입으로 서술자를 찾아** 한
    // 경로로 커밋한다 — 목록이 늘어도 이 배선은 늘지 않는다. 에이전트 패널은
    // 사이드바 리스트가 아니므로 자기 경로를 유지한다.
    document.addEventListener('dragover',e=>{const dr=this.app.drag;if(dr&&(dr.type==='agent'||SidebarList.defByDragType(dr.type)))e.preventDefault()});
    // FR-MOV-1: 탭 드래그가 사이드바 위에서 죽지 않게 한다. 창 항목이 자기
    // dragover 에서 preventDefault 하지만, 항목 사이 여백에 걸치면 그 이벤트가
    // 오지 않아 native 가 드롭을 거절한다 — 여기서 사이드바 전체를 수락한다.
    // 드롭 자체는 창 항목만 처리하므로 여백에서 놓으면 아무 일도 없다.
    sbEl.addEventListener('dragover',e=>{const dr=this.app.drag;if(dr&&dr.type==='tab')e.preventDefault()});
    document.addEventListener('drop',e=>{
      const dr=this.app.drag; if(!dr) return;
      if(dr.type==='agent'){e.preventDefault();this.app.reorderAgents(dr);return}
      const def=SidebarList.defByDragType(dr.type);
      if(def){e.preventDefault();SidebarList.commit(this.app,def,dr)}
    });
    // SIDEBAR_COLLAPSE_SRS FR-SBC-7·9: 접기 토글. 리사이즈 핸들 바로 옆에 배선을
    // 두는 것은 둘이 같은 것(사이드바의 폭)을 건드리기 때문이다.
    const sb=sbEl,sbh=document.getElementById('sb-handle');
    /**
     * SIDEBAR_COLLAPSE_SRS FR-SBC-7 (2026-09-06 개정): **손잡이 하나가 접고 편다.**
     *
     *   이전 동작: 탑바의 `☰` 버튼이 접고 폈고, 손잡이는 폭만 바꿨다
     *   새  동작: 버튼이 없다. 폭을 줄이다 `SIDEBAR_COLLAPSE_AT_PX` 아래로 끌면
     *             접히고, 접힌 경계를 오른쪽으로 끌면 펼쳐진다
     *   이유:     접는 것과 좁히는 것은 같은 손짓의 끝과 끝이다 (사용자 지시).
     *             손이 이미 그 자리에 있으므로 화면에 버튼을 세울 이유가 없다.
     *
     * 키로도 같은 일을 한다 (`sidebarToggle`) — 손잡이는 마우스의 길이고, 그것이
     * 유일한 길이면 키보드만 쓰는 사람에게는 길이 없다.
     */
    UIKit.drag(sbh,{
      axis:'x',
      // 접힘에서 시작하면 기준은 레일의 폭이다 — 그 자리에서 오른쪽으로 끌면
      // 임계를 넘어 펼쳐진다.
      start:()=>({w0:sb.offsetWidth,c0:contentEl?contentEl.offsetWidth:0}),
      move:(ctx,ev)=>{
        const raw=ctx.w0+(ev.clientX-ctx.sx0);
        const collapse=raw<SIDEBAR_COLLAPSE_AT_PX;
        // 접힘 자체는 `setSidebarCollapsed` 한 자리에서 정한다 — 클래스·저장·
        // 터미널 재적합이 거기 묶여 있고, 두 벌로 두면 한쪽만 고쳐진다.
        if(collapse!==this.app.sidebarCollapsed()) this.app.setSidebarCollapsed(collapse);
        // 펼친 동안에만 폭을 따라간다. 접힌 폭(레일)은 고정이다 (FR-SBC-2·16).
        // FE-18: 구간은 상수 둘이 정한다 — 드래그로 갈 수 없는 폭이 저장에서
        // 살아남는(또는 그 반대의) 어긋남을 막는다.
        if(!collapse&&raw>=SIDEBAR_W_MIN_PX&&raw<=SIDEBAR_W_MAX_PX){
          document.documentElement.style.setProperty('--sb-w',raw+'px');
          this.app.ws.sidebarWidth=raw;
        }
      },
      // FR-HSZ-3: 왼쪽은 사이드바, 오른쪽은 콘텐츠다. 사이드바에는 `C×R` 이
      // 없다 — 터미널이 아니다 (FR-HSZ-5).
      sides:(ctx)=>{
        const sw=sb.offsetWidth, cw=contentEl?contentEl.offsetWidth:0, tot=sw+cw;
        return [
          {px:sw,pct:tot?sw/tot*100:null},
          {px:cw,cell:UIKit.grid(this.app.focusedTerminal&&this.app.focusedTerminal(),'x',cw-ctx.c0,0),
            pct:tot?cw/tot*100:null},
        ];
      },
      end:()=>{
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
        try{localStorage.setItem('sidebarWidth',this.app.ws.sidebarWidth)}catch{}
        this.app.save();
      },
    });
    this.app.recording=null;
    window.addEventListener('keydown',e=>{
      if(this.app.recording){e.preventDefault();e.stopImmediatePropagation();
        if(e.code==='Escape'){
          const btn=document.querySelector('.sc-key.recording');
          if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
          this.app.recording=null;return;
        }
        if(MOD_CODES.has(e.code))return;
        shortcuts[this.app.recording]=fmtShortcut(e);
        const btn=document.querySelector(`.sc-key[data-action="${this.app.recording}"]`);
        this.app.recording=null;
        if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
        this.app.saveSettings();
        return;
      }
      const ae=document.activeElement;
      if(ae.tagName==='INPUT'||(ae.tagName==='TEXTAREA'&&!ae.classList.contains('xterm-helper-textarea')))return;
      // EDITOR_GIT_UX_SRS FR-EKB-1: Monaco **밖**(탐색기·탭바)에서 누른 경우다.
      // 안쪽은 위의 activeElement 게이트에 걸려 여기 오지 않으므로 file-editor.js
      // 가 같은 함수를 따로 건다. FR-EKB-2: cmd+p 는 브라우저의 인쇄라 반드시 막는다.
      //
      // BUILTIN_HOTKEYS 보다 **먼저** 묻는다. 파일 내 검색의 기본값 `Mod+F` 가
      // 터미널 검색의 관용 배선과 같은 조합이기 때문이다 — Editor 창이면 편집기
      // 검색이, 아니면 터미널 검색이 뜬다. Editor 창이 아닐 때 이 함수는 키를
      // 삼키지 않고 false 를 돌려준다 (FR-EKB-4).
      if(this.app.edTrySearchKey(e)) return;
      for(const h of BUILTIN_HOTKEYS){
        if(h.match(e)){e.preventDefault();e.stopImmediatePropagation();this.app.executeAction(h.action);return}
      }
      for(const[action,key]of Object.entries(shortcuts)){
        // 편집기 검색·코드 탐색 셋은 위에서 이미 판정했다. 여기서 다시 잡으면
        // Editor 창이 아닐 때 그 키를 삼켜 터미널 검색이 죽는다 (FR-EKB-4).
        if(ED_CAPTURE_ACTIONS[action]) continue;
        if(matchShortcut(e,key)){e.preventDefault();e.stopImmediatePropagation();this.app.executeAction(action);return}
      }
      this._blockBrowserDefault(e);
    },true);
    const si=document.getElementById('search-input');
    si.addEventListener('input',()=>this.app.doSearch('next'));
    si.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();this.app.doSearch(e.shiftKey?'prev':'next')}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.app.closeSearch()}
      e.stopPropagation();
    });
    document.getElementById('search-next').addEventListener('click',()=>this.app.doSearch('next'));
    document.getElementById('search-prev').addEventListener('click',()=>this.app.doSearch('prev'));
    /**
     * FUI-15: 토글 셋. **누르면 곧바로 다시 찾는다** — 옵션을 바꾼 뒤 Enter 를
     * 한 번 더 눌러야 한다면 그 토글은 반쯤 듣는 것이다 (편집기 찾기 줄이
     * 그렇게 하고 있다).
     */
    for(const id of ['search-case','search-word','search-regex']){
      document.getElementById(id).addEventListener('click',ev=>{
        ev.currentTarget.classList.toggle('active');
        this.app.doSearch('next');
      });
    }
    document.getElementById('search-close').addEventListener('click',()=>this.app.closeSearch());
    this.app.initModal();
    this.app.initStatusBar();
    this.app.initPresets();
    this.app.initMobile();
    this.app.initMobileKeybar();
    this.app.initAttn();
    // POLL_INTERVAL_SETTINGS_SRS FR-PIS-20: `Polling` 탭의 행을 표에서 만든다.
    // 옛 `_initAgentsSettings` 가 있던 자리이며, 그 드롭다운이 이 탭으로 옮겼다.
    this.app.initPollingSettings();
  }

  /**
   * FR-KEY-1~5: 앱 단축키가 아닌 수식키 조합의 **브라우저 기본 동작**을 막는다.
   *
   * 여기까지 온 키는 어느 단축키에도 매칭되지 않은 것이다. 그대로 두면 Chrome 이
   * 저장·인쇄·찾기·북마크를 열고, 그러면 그 조합은 단축키로 쓸 수 없다 — 배정해도
   * 브라우저가 먼저 가져간다고 사용자가 믿게 된다.
   *
   * **`preventDefault` 만 한다** (FR-KEY-3). 전파를 멈추면 xterm 이 키를 받지 못해
   * 터미널이 죽는다 — 막으려는 것은 브라우저이지 앱이 아니다.
   */
  _blockBrowserDefault(e){
    if(!blockBrowserKeys) return;
    if(KEY_BLOCK_EXEMPT_BARE.has(e.code)) return;
    // FR-KEY-2: 수식키 없는 키는 대상이 아니다. 터미널에 그냥 글자를 치는 것을
    // 막을 이유가 없다.
    if(!e.ctrlKey&&!e.metaKey) return;
    if(MOD_CODES.has(e.code)) return;
    if(KEY_BLOCK_EXEMPT_MOD.has(e.code)) return;
    e.preventDefault();
  }
}
