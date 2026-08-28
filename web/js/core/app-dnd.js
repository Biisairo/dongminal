/**
 * Remote Terminal — App 드래그앤드롭 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 5개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── Drag helpers ──
  _getDragZone(el,e){const rect=el.getBoundingClientRect();const x=e.clientX-rect.left;const y=e.clientY-rect.top;const w=rect.width,h=rect.height;if(x/w<0.25)return'left';if(x/w>0.75)return'right';if(y/h<0.25)return'top';if(y/h>0.75)return'bottom';return'center'},
  _showBodyDropIndicator(bodyEl,zone){let ind=bodyEl.querySelector('.pn-drop-indicator');if(!ind){ind=document.createElement('div');ind.className='pn-drop-indicator';bodyEl.appendChild(ind)}ind.dataset.zone=zone;ind.style.display=''},
  _clearBodyDropIndicator(bodyEl){const ind=bodyEl?.querySelector('.pn-drop-indicator');if(ind)ind.style.display='none'},

  _moveTabToPane(srcRid,tabId,dstRid,beforeTabId,insertBefore){
    const s=this._aw();if(!s)return;
    // FR-GIT-181: Git 창은 탭을 받지도 내주지도 않는다.
    if(this._isGitWin(s))return;
    const srcRg=findPane(s.layout,srcRid);const dstRg=findPane(s.layout,dstRid);
    if(!srcRg||!dstRg)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    // FR-GIT-28: git 탭은 pane 을 옮기지 않는다. draggable=false 로 드래그 시작은
    // 막았지만, 이 경로는 드롭 핸들러 밖에서도 불릴 수 있어 여기서 한 번 더 막는다.
    if(srcRg.tabs[ti].type===TAB_TYPE_GIT)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0){s.layout=doRemove(s.layout,srcRid);if(this.focused===srcRid)this._setFocus(dstRid, s)}
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const dst=findPane(s.layout,dstRid);if(!dst)return;
    if(beforeTabId){let ins=dst.tabs.findIndex(t=>t.id===beforeTabId);if(ins<0)ins=dst.tabs.length;else if(!insertBefore)ins++;dst.tabs.splice(ins,0,tab)}
    else dst.tabs.push(tab);
    dst.activeTab=tab.id;this._setFocus(dstRid, s);
    if(!s.layout){this._mkWindow();return}
    this._save();this.render();
  },

  /**
   * UX_REVISION_SRS FR-MOV-1~9: 탭을 **다른 창**으로 옮긴다.
   *
   * `_moveTabToPane` 과 갈라져 있는 이유는 대상이 다른 창이라는 것 하나다 —
   * 그쪽은 활성 창 안의 분할 칸끼리이고, 여기는 창 경계를 넘는다. 도구는 다시
   * 만들지 않는다 (FR-MOV-9): 탭 레코드가 `toolId` 를 들고 그대로 옮겨 간다.
   */
  _moveTabToWindow(srcRid,tabId,dstWinId){
    const src=this._aw(); if(!src) return;
    // FR-MOV-5: Git 창은 주지도 받지도 않는다 (FR-GIT-181).
    if(this._isGitWin(src)) return;
    const dst=this.ws.windows.find(w=>w&&w.id===dstWinId);
    if(!dst||dst.id===src.id||this._isGitWin(dst)||!dst.layout) return;
    const srcPane=findPane(src.layout,srcRid); if(!srcPane) return;
    const ti=srcPane.tabs.findIndex(t=>t.id===tabId); if(ti<0) return;
    // FR-MOV-6: git 탭은 옮기지 않는다 (FR-GIT-28).
    if(srcPane.tabs[ti].type===TAB_TYPE_GIT) return;
    // FR-MOV-4: 창의 마지막 탭은 내주지 않는다 — 탭 없는 창이 남으면 그 창으로
    // 돌아갈 진입점이 사이드바 항목뿐이고, 거기서는 아무것도 할 수 없다.
    if(this._windowTabCount(src)<=1) return;
    // FR-MOV-2: 대상은 그 창의 포커스 분할 칸, 없으면 첫 분할 칸이다.
    const dstRid=(dst.focusedPane&&findPane(dst.layout,dst.focusedPane))
      ? dst.focusedPane : firstPane(dst.layout)?.id;
    const dstPane=dstRid?findPane(dst.layout,dstRid):null;
    if(!dstPane) return;

    const[tab]=srcPane.tabs.splice(ti,1);
    // FR-MOV-3: 빈 분할 칸은 접힌다 — `_moveTabToPane` 과 같은 규약이다.
    if(!srcPane.tabs.length){
      src.layout=doRemove(src.layout,srcRid);
      if(this.focused===srcRid) this._setFocus(firstPane(src.layout)?.id||null, src);
    }else if(srcPane.activeTab===tabId){
      srcPane.activeTab=srcPane.tabs[0].id;
    }
    dstPane.tabs.push(tab);
    dstPane.activeTab=tab.id;
    dst.focusedPane=dstRid;
    // FR-MOV-8: 옮긴 창으로 따라간다. 옮겼는데 보이지 않으면 사용자는 탭이
    // 사라진 것으로 읽는다. switchWindow 가 저장·그리기까지 한다.
    this.switchWindow(dst.id);
  },

  // 창 하나가 가진 탭 수. FR-MOV-4 의 판정 하나에만 쓰인다.
  _windowTabCount(win){
    let n=0;
    const walk=node=>{
      if(!node) return;
      if(node.tabs) n+=node.tabs.length;
      for(const c of node.children||[]) walk(c);
    };
    walk(win&&win.layout);
    return n;
  },

  _splitPaneWithTab(srcRid,tabId,targetRid,zone){
    const s=this._aw();if(!s)return;
    // FR-GIT-179·181: Git 창에는 분할 칸이 생기지 않는다.
    if(this._isGitWin(s))return;
    const srcRg=findPane(s.layout,srcRid);if(!srcRg)return;
    if(srcRid===targetRid&&srcRg.tabs.length<=1)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    // FR-GIT-28: git 탭은 분할로 떼어내지지 않는다 (_moveTabToPane 과 같은 이유).
    if(srcRg.tabs[ti].type===TAB_TYPE_GIT)return;
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0)s.layout=doRemove(s.layout,srcRid);
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const newRid=newEntityId();
    const newRg={type:'pane',id:newRid,tabs:[tab],activeTab:tab.id};
    const dir=(zone==='left'||zone==='right')?'horizontal':'vertical';
    const before=zone==='left'||zone==='top';
    const splitNode=n=>{
      if(!n)return null;
      if(n.type==='pane'&&n.id===targetRid)return{type:'split',direction:dir,children:before?[newRg,n]:[n,newRg]};
      if(n.type==='split'){n.children=n.children.map(splitNode).filter(Boolean);if(!n.children.length)return null;if(n.children.length===1)return n.children[0]}
      return n;
    };
    s.layout=splitNode(s.layout);
    if(!s.layout){this._mkWindow();return}
    this._setFocus(newRid, s);this._save();this.render();
  },
});
