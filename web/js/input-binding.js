/**
 * Remote Terminal — keyboard/mouse/shortcut dispatch
 * App 의 _bind 책임을 분리. 동작은 1:1 보존.
 */

class InputBinding {
  constructor(app){ this.app = app; }

  bind(){
    if(this.app._kb) return; this.app._kb=true;
    document.getElementById('split-h').addEventListener('click',()=>this.app.split('horizontal'));
    document.getElementById('split-v').addEventListener('click',()=>this.app.split('vertical'));
    document.getElementById('agents-toggle').addEventListener('click',()=>this.app._agentsToggle());
    // FR-GIT-183: Git 창은 WINDOWS 목록에 없으므로 닫는 길이 자기 상단 바에 있다.
    document.getElementById('git-close').addEventListener('click',()=>this.app._gitCloseWindow());
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
    document.addEventListener('dragover',e=>{const dr=this.app._drag;if(dr&&(dr.type==='window'||dr.type==='agent'))e.preventDefault()});
    document.addEventListener('drop',e=>{const dr=this.app._drag;if(!dr)return;if(dr.type==='window'){e.preventDefault();this.app._reorderWindows(dr)}else if(dr.type==='agent'){e.preventDefault();this.app._reorderAgents(dr)}});
    const sb=document.getElementById('sidebar'),sbh=document.getElementById('sb-handle');
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
      for(const h of BUILTIN_HOTKEYS){
        if(h.match(e)){e.preventDefault();e.stopImmediatePropagation();this.app.executeAction(h.action);return}
      }
      for(const[action,key]of Object.entries(shortcuts)){
        if(matchShortcut(e,key)){e.preventDefault();e.stopImmediatePropagation();this.app.executeAction(action);return}
      }
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
  }
}
