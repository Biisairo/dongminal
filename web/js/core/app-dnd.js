/**
 * Remote Terminal — App 드래그앤드롭 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 5개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  // ── Drag helpers ──
  getDragZone(el,e){const rect=el.getBoundingClientRect();const x=e.clientX-rect.left;const y=e.clientY-rect.top;const w=rect.width,h=rect.height;if(x/w<0.25)return'left';if(x/w>0.75)return'right';if(y/h<0.25)return'top';if(y/h>0.75)return'bottom';return'center'},
  showBodyDropIndicator(bodyEl,zone){let ind=bodyEl.querySelector('.pn-drop-indicator');if(!ind){ind=document.createElement('div');ind.className='pn-drop-indicator';bodyEl.appendChild(ind)}ind.dataset.zone=zone;ind.style.display=''},
  clearBodyDropIndicator(bodyEl){const ind=bodyEl?.querySelector('.pn-drop-indicator');if(ind)ind.style.display='none'},

  /**
   * 그 분할 칸이 사는 창. **모든 창을 본다** (`12-func-ui.md FUI-19`).
   *
   * `aw()`(포커스 칸의 창) 하나만 보던 것이 슬롯이 둘일 때의 결함이었다 —
   * 다른 칸의 창에 있는 pane 은 찾지 못하고 조용히 물러났다.
   */
  _winOfPane(rid){
    if(!rid) return null;
    for(const s of this.ws.windows) if(s&&s.layout&&findPane(s.layout,rid)) return s;
    return null;
  },

  /**
   * 탭 하나를 칸 하나로 옮긴다.
   *
   * `12-func-ui.md FUI-19`: **슬롯을 건너는 드롭이 조용히 무시됐다.**
   *
   *   이전 동작: 출발·도착 pane 을 `this.aw()` 안에서만 찾았다. 슬롯 둘이
   *             서로 다른 창을 보이면 도착 pane 이 그 창에 없으므로
   *             `if(!srcRg||!dstRg) return` 으로 물러났다 — **드롭 표식은 떴는데
   *             놓으면 아무 일도 없었다.** 표식이 약속한 것을 동작이 지키지 않는다
   *   새  동작: 두 pane 이 사는 창을 각각 찾는다. 다른 창이면 창 경계의 규약
   *             (`moveTabToWindow` 의 것)을 그대로 지나 옮긴다
   *   이유:     사용자에게 슬롯은 "같은 화면의 두 자리" 다. 거기서만 드래그가
   *             듣지 않을 이유가 없다
   */
  moveTabToPane(srcRid,tabId,dstRid,beforeTabId,insertBefore){
    const src=this._winOfPane(srcRid),dstWin=this._winOfPane(dstRid);
    if(!src||!dstWin) return;
    // 창이 갈리면 창 경계의 규약이 선다 (FR-MOV-4·5·6 / FR-EDT-53).
    if(src.id!==dstWin.id)
      return this._moveTabAcrossWindows(src,srcRid,tabId,dstWin,dstRid,beforeTabId,insertBefore);
    const s=src;
    // FR-GIT-181: Git 창은 탭을 받지도 내주지도 않는다.
    if(this.isGitWin(s))return;
    // FR-EDT-53: **Editor 창은 여기서 막지 않는다.** 이 경로는 활성 창 **안**의
    // 분할 칸끼리이며, 같은 Editor 창 안의 이동은 허용이다 (FR-EDT-51). 조건을
    // 탭 타입 자리(:22)에 넣으면 편집기 탭이 자기 창 안에서도 못 움직인다 (§2.2).
    const srcRg=findPane(s.layout,srcRid);const dstRg=findPane(s.layout,dstRid);
    if(!srcRg||!dstRg)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    // REPO_TAB_UNIFY_SRS FR-RTU-33: **git 뷰 탭도 옮긴다.** 옛 FR-GIT-28 이
    // 그것을 막은 근거는 Git 창의 탭이 **고정 일곱**이어서 자리가 늘 같아야
    // 근육 기억이 선다는 것이었다. 그 창이 사라지고 뷰가 본문의 탭이 된 지금
    // (FR-RTU-30) 자리를 정하는 것은 사용자다. 창 밖으로는 여전히 못 나간다 —
    // 그 판정은 `moveTabToWindow` 가 창 타입으로 한다 (FR-RTU-17).
    const[tab]=srcRg.tabs.splice(ti,1);
    if(srcRg.tabs.length===0){s.layout=doRemove(s.layout,srcRid);if(this.focused===srcRid)this.setFocusState(dstRid, s)}
    else if(srcRg.activeTab===tabId)srcRg.activeTab=srcRg.tabs[0].id;
    const dst=findPane(s.layout,dstRid);if(!dst)return;
    if(beforeTabId){let ins=dst.tabs.findIndex(t=>t.id===beforeTabId);if(ins<0)ins=dst.tabs.length;else if(!insertBefore)ins++;dst.tabs.splice(ins,0,tab)}
    else dst.tabs.push(tab);
    this.paneTabSet(dst,tab.id);this.setFocusState(dstRid, s);
    // FR-EDT-55: pane 이 없는 Editor 창은 정상 상태다 — 여기서 터미널 창을
    // 만들면 안 된다.
    if(!s.layout&&!this.isEditorWin(s)){this._mkWindow();return}
    this.save();this.render();
  },

  /**
   * UX_REVISION_SRS FR-MOV-1~9: 탭을 **다른 창**으로 옮긴다.
   *
   * `moveTabToPane` 과 갈라져 있는 이유는 대상이 다른 창이라는 것 하나다 —
   * 그쪽은 활성 창 안의 분할 칸끼리이고, 여기는 창 경계를 넘는다. 도구는 다시
   * 만들지 않는다 (FR-MOV-9): 탭 레코드가 `toolId` 를 들고 그대로 옮겨 간다.
   */
  moveTabToWindow(srcRid,tabId,dstWinId){
    const src=this.aw(); if(!src) return;
    // FR-MOV-5: Git 창은 주지도 받지도 않는다 (FR-GIT-181).
    // FR-EDT-53: Editor 창의 탭은 그 창 **밖으로 나가지 못한다** — 다른 Editor
    // 창으로도, 일반 창으로도.
    if(this.isGitWin(src)||this.isEditorWin(src)) return;
    const dst=this.ws.windows.find(w=>w&&w.id===dstWinId);
    // FR-EDT-53: 밖에서 들어오지도 못한다.
    if(!dst||dst.id===src.id||this.isGitWin(dst)||this.isEditorWin(dst)||!dst.layout) return;
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
    // FR-MOV-3: 빈 분할 칸은 접힌다 — `moveTabToPane` 과 같은 규약이다.
    if(!srcPane.tabs.length){
      src.layout=doRemove(src.layout,srcRid);
      if(this.focused===srcRid) this.setFocusState(firstPane(src.layout)?.id||null, src);
    }else if(srcPane.activeTab===tabId){
      srcPane.activeTab=srcPane.tabs[0].id;
    }
    dstPane.tabs.push(tab);
    this.paneTabSet(dstPane,tab.id);
    dst.focusedPane=dstRid;
    // FR-MOV-8: 옮긴 창으로 따라간다. 옮겼는데 보이지 않으면 사용자는 탭이
    // 사라진 것으로 읽는다. switchWindow 가 저장·그리기까지 한다.
    this.switchWindow(dst.id);
  },

  /**
   * FUI-19: 창을 건너는 이동. **대상 칸을 지정해서** 옮긴다.
   *
   * `moveTabToWindow` 와 규약이 같고 다른 것은 하나다 — 그쪽은 대상 창의
   * 포커스 칸을 스스로 고르고(FR-MOV-2), 여기는 **사용자가 놓은 칸**이 대상이다.
   * 드래그는 자리를 가리키는 동작이므로 그 자리를 지어내면 안 된다.
   *
   * 판정은 한 글자도 새로 만들지 않는다 — Git·Editor 창의 경계(FR-MOV-5 /
   * FR-EDT-53), 마지막 탭(FR-MOV-4), git 뷰 탭(FR-MOV-6)이 그대로 선다.
   */
  _moveTabAcrossWindows(src,srcRid,tabId,dst,dstRid,beforeTabId,insertBefore){
    if(this.isGitWin(src)||this.isEditorWin(src)) return;
    if(this.isGitWin(dst)||this.isEditorWin(dst)||!dst.layout) return;
    const srcPane=findPane(src.layout,srcRid); if(!srcPane) return;
    const ti=srcPane.tabs.findIndex(t=>t.id===tabId); if(ti<0) return;
    if(srcPane.tabs[ti].type===TAB_TYPE_GIT) return;
    if(this._windowTabCount(src)<=1) return;
    const dstPane=findPane(dst.layout,dstRid); if(!dstPane) return;

    const[tab]=srcPane.tabs.splice(ti,1);
    // FR-MOV-3: 빈 분할 칸은 접힌다 — `moveTabToPane` 과 같은 규약이다.
    if(!srcPane.tabs.length){
      src.layout=doRemove(src.layout,srcRid);
      if(this.focused===srcRid) this.setFocusState(firstPane(src.layout)?.id||null, src);
    }else if(srcPane.activeTab===tabId){
      srcPane.activeTab=srcPane.tabs[0].id;
    }
    // 놓은 자리가 곧 넣을 자리다 (`moveTabToPane` 과 같은 삽입 규칙).
    if(beforeTabId){
      let ins=dstPane.tabs.findIndex(t=>t.id===beforeTabId);
      if(ins<0) ins=dstPane.tabs.length; else if(!insertBefore) ins++;
      dstPane.tabs.splice(ins,0,tab);
    }else dstPane.tabs.push(tab);
    this.paneTabSet(dstPane,tab.id);
    dst.focusedPane=dstRid;
    /**
     * **창을 갈아타지 않는다** — `moveTabToWindow` 와 갈리는 둘째 자리다.
     *
     * 그쪽은 사이드바에서 "다른 창으로 보내기" 이고, 보낸 뒤 그 창이 보이지
     * 않으면 사용자는 탭을 잃은 것으로 읽는다 (FR-MOV-8). 여기서는 **대상 칸이
     * 이미 화면에 있다** — 그 칸으로 끌어다 놓았기 때문이다. 활성 창을 옮기면
     * 오히려 사용자가 보고 있던 칸이 바뀐다.
     */
    this.save(); this.render();
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

  splitPaneWithTab(srcRid,tabId,targetRid,zone){
    const s=this.aw();if(!s)return;
    // FR-GIT-179·181: Git 창에는 분할 칸이 생기지 않는다.
    if(this.isGitWin(s))return;
    // FR-EDT-51: **Editor 창은 여기서 막지 않는다.** 드래그드롭이 분할이 생기는
    // 유일한 길이므로(D-8) 이 경로는 허용이다 — 막는 자리는 단축키·버튼
    // (`_splitInner`) 쪽이다 (FR-EDT-50).
    const srcRg=findPane(s.layout,srcRid);if(!srcRg)return;
    if(srcRid===targetRid&&srcRg.tabs.length<=1)return;
    const ti=srcRg.tabs.findIndex(t=>t.id===tabId);if(ti<0)return;
    // FR-RTU-33: git 뷰 탭도 분할로 떼어낸다 (`moveTabToPane` 과 같은 근거).
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
    // FR-EDT-55: pane 이 없는 Editor 창은 정상 상태다.
    if(!s.layout&&!this.isEditorWin(s)){this._mkWindow();return}
    this.setFocusState(newRid, s);this.save();this.render();
  },
});
