/**
 * Remote Terminal — keyboard/mouse/shortcut dispatch
 * App 의 _bind 책임을 분리. 동작은 1:1 보존.
 */

class InputBinding {
  constructor(app){ this.app = app; }

  bind(){
    if(this.app._kb) return; this.app._kb=true;
    const sbEl=document.getElementById('sidebar');
    document.getElementById('split-h').addEventListener('click',()=>this.app.split('horizontal'));
    document.getElementById('split-v').addEventListener('click',()=>this.app.split('vertical'));
    document.getElementById('agents-toggle').addEventListener('click',()=>this.app._agentsToggle());
    const ap=document.getElementById('agents-panel'),aph=document.getElementById('agents-handle');
    try{if(localStorage.getItem('agentsPanelOpen')==='1'){ap.classList.add('open');aph.classList.add('open');document.getElementById('agents-toggle').classList.add('open');this.app._agentsStartPoll()}}catch{}
    aph.addEventListener('mousedown',e=>{e.preventDefault();
      const sx=e.clientX,sw=ap.offsetWidth;
      const mv=e=>{const w=sw-(e.clientX-sx);if(w>=160&&w<=480){document.documentElement.style.setProperty('--ag-w',w+'px')}};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();try{localStorage.setItem('agentsWidth',ap.offsetWidth)}catch{}};
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
    try{const aw=parseInt(localStorage.getItem('agentsWidth'));if(aw>=160&&aw<=480)document.documentElement.style.setProperty('--ag-w',aw+'px')}catch{}
    // 문서 전역 DnD 수락(1회 바인딩): 드래그 중 화면 전체를 드롭 수락 영역으로 만들어
    // native snap-back(미수락 release 시 원위치 복귀 애니메이션)을 패널 안/밖 어디서든 제거,
    // drop 에서 마지막 dragover 가 기록한 대상 기준 즉시 커밋. FR-AAP-21 / 창 사이드바 공유.
    //
    // UX_REVISION_SRS FR-BLP-13: 사이드바 리스트는 **타입으로 서술자를 찾아** 한
    // 경로로 커밋한다 — 목록이 늘어도 이 배선은 늘지 않는다. 에이전트 패널은
    // 사이드바 리스트가 아니므로 자기 경로를 유지한다.
    document.addEventListener('dragover',e=>{const dr=this.app._drag;if(dr&&(dr.type==='agent'||SidebarList.defByDragType(dr.type)))e.preventDefault()});
    // FR-MOV-1: 탭 드래그가 사이드바 위에서 죽지 않게 한다. 창 항목이 자기
    // dragover 에서 preventDefault 하지만, 항목 사이 여백에 걸치면 그 이벤트가
    // 오지 않아 native 가 드롭을 거절한다 — 여기서 사이드바 전체를 수락한다.
    // 드롭 자체는 창 항목만 처리하므로 여백에서 놓으면 아무 일도 없다.
    sbEl.addEventListener('dragover',e=>{const dr=this.app._drag;if(dr&&dr.type==='tab')e.preventDefault()});
    document.addEventListener('drop',e=>{
      const dr=this.app._drag; if(!dr) return;
      if(dr.type==='agent'){e.preventDefault();this.app._reorderAgents(dr);return}
      const def=SidebarList.defByDragType(dr.type);
      if(def){e.preventDefault();SidebarList.commit(this.app,def,dr)}
    });
    const sb=sbEl,sbh=document.getElementById('sb-handle');
    sbh.addEventListener('mousedown',e=>{e.preventDefault();
      const sx=e.clientX,sw=sb.offsetWidth;
      const mv=e=>{const w=sw+(e.clientX-sx);if(w>=100&&w<=400){document.documentElement.style.setProperty('--sb-w',w+'px');this.app.ws.sidebarWidth=w}};
      const up=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();try{localStorage.setItem('sidebarWidth',this.app.ws.sidebarWidth)}catch{}this.app._save()};
      document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
    });
    this.app._recording=null;
    window.addEventListener('keydown',e=>{
      if(this.app._recording){e.preventDefault();e.stopImmediatePropagation();
        if(e.code==='Escape'){
          const btn=document.querySelector('.sc-key.recording');
          if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
          this.app._recording=null;return;
        }
        if(MOD_CODES.has(e.code))return;
        shortcuts[this.app._recording]=fmtShortcut(e);
        const btn=document.querySelector(`.sc-key[data-action="${this.app._recording}"]`);
        this.app._recording=null;
        if(btn){btn.classList.remove('recording');btn.textContent=displayKey(shortcuts[btn.dataset.action]||'')}
        this.app._saveSettings();
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
      if(this.app._edTrySearchKey(e)) return;
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
    si.addEventListener('input',()=>this.app._doSearch('next'));
    si.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();this.app._doSearch(e.shiftKey?'prev':'next')}
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.app.closeSearch()}
      e.stopPropagation();
    });
    document.getElementById('search-next').addEventListener('click',()=>this.app._doSearch('next'));
    document.getElementById('search-prev').addEventListener('click',()=>this.app._doSearch('prev'));
    document.getElementById('search-case').addEventListener('click',function(){this.classList.toggle('active')});
    document.getElementById('search-close').addEventListener('click',()=>this.app.closeSearch());
    this.app._initModal();
    this.app._initStatusBar();
    this.app._initPresets();
    this.app._initMobile();
    this.app._initMobileKeybar();
    this.app._initAttn();
    this.app._initAgentsSettings();
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
