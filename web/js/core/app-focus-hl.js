/**
 * App — 포커스 탭 하이라이트 (UX_BATCH12_SRS FR-FHL-1~7).
 *
 * Repo 창의 하이라이트(선택)는 Changes 와 Explorer 를 통틀어 하나이고 포커스 탭을 따른다.
 * 포커스 탭이 **바뀔 때만** 맞춘다(FR-FHL-6) — 같은 탭에서 사용자가 고른 것은 그대로다.
 * 부르는 자리는 `App.render`(탭 전환이 지나는 길)와 Changes 의 `_select`(Diff 대상 이동)다.
 */
Object.assign(App.prototype, {
  /**
   * UX_BATCH12_SRS FR-AFC-1·2: 포커스 탭의 도구가 **다른 도구에서** 알람 도구로 바뀌면 본 것으로 끈다.
   * 바뀌지 않으면 아무것도 하지 않는다 — 첫 판정·브라우저 복귀·포커스 탭에 새로 선 알람 (FR-ATA-1).
   */
  attnFocusSync(){
    const cur=this._agFocusedTool(),first=this._afcAt===undefined,changed=this._afcAt!==cur;
    this._afcAt=cur;
    if(!first&&changed&&cur&&this._attn.has(cur)) this._attnClear(cur,false);
  },

  focusHighlightSync(){
    const s=this.aw(); if(!s||!s.layout) return;
    const root=this.edRootOf(s); if(!root) return;
    const pn=findPane(s.layout,this.focused); if(!pn) return;
    const tab=(pn.tabs||[]).find(x=>x.id===this.paneTab(pn));
    const slot=this.slotFocused();
    const panel=this.gitPanels?this.gitPanels.get(this._gitPanelKey(root,slot)):null;
    // 미리보기 탭은 id 를 지킨 채 Diff ↔ 파일·다른 파일로 바뀐다(FR-RTB-1) — 내용까지 키에 넣는다.
    const at=s.id+'\0'+slot+'\0'+(tab?tab.id+'\0'+tab.type+'\0'+(tab.filePath||''):'');
    if(tab&&tab.type===TAB_TYPE_EDITOR&&tab.filePath){
      if(this._fhlAt===at){this._fhlRetry(s,panel,at);return}
      this._fhlAt=at; this._fhlTarget=''; this._fhlPend=null;
      this._fhlFile(s,panel,root,tab.filePath,at);
      return;
    }
    if(tab&&tab.type===TAB_TYPE_GIT&&tab.gitView==='diff'){
      // UX_BATCH12_SRS FR-RTB-12: Diff 탭이 여럿이다 — 패널 하나의 대상이 아니라 **그 탭의 대상**이다.
      const f=tab.diffTarget||null;
      const target=f&&f.path?(f.group||'')+'\0'+f.path:'';
      if(this._fhlAt===at&&this._fhlTarget===target){this._fhlRetry(s,panel,at);return}
      this._fhlAt=at; this._fhlTarget=target; this._fhlPend=null;
      this._fhlDiff(s,panel,f,at);
      return;
    }
    // FR-FHL-7: 파일·Diff 가 아니면 바꾸지 않는다. 기록만 옮겨 다음에 돌아올 때 다시 맞춘다.
    this._fhlAt=at; this._fhlTarget=''; this._fhlPend=null;
  },

  // FR-FHL-9·10: 탭이 바뀔 때 아직 서지 않았거나 숨어 있던 쪽(트리·Changes)은 보이게 된 뒤 처음 그릴 때
  // 맞춘다 — 숨은 목록은 스크롤할 수 없다. 선택은 이미 바뀌었고(FR-FHL-5), 사용자는 숨은 쪽을 고를 수 없다.
  _fhlRetry(s,panel,at){
    const p=this._fhlPend; if(!p||p.at!==at) return;
    if(p.path){
      const tree=this._edTreeFor(s); if(!tree||!tree.list||!tree.list.offsetParent) return;
      this._fhlPend=null; tree.revealPath(p.path);
      return;
    }
    const el=panel&&panel._els.get('changes'); if(!el||!el.offsetParent) return;
    this._fhlPend=null; this._fhlDiffSel(panel,p.diff,at);
  },

  // FR-FHL-2: Explorer 는 그 파일 하나(조상 펼침·스크롤), Changes 는 비운다. 루트 밖이면 손대지 않는다.
  _fhlFile(s,panel,root,path,at){
    if(!pathUnder(String(root).replace(/[\\/]+$/,''),path)) return;
    const tree=this._edTreeFor(s);
    if(tree) tree.revealPath(path);
    if(!tree||!tree.list||!tree.list.offsetParent) this._fhlPend={at,path};
    if(panel&&panel._sel.size){panel._sel.clear();panel._anchor=null;panel._paint()}
  },

  // FR-FHL-3·4: 탭이나 그 탭의 대상이 바뀌었으면 Changes 를 대상 행 하나로 한다. ‹ › 이동은 Diff 탭의
  // 패널이 하므로(FR-RTB-9) Changes 의 선택을 스스로 바꾸지 않는다 — 여기서 맞춘다.
  _fhlDiff(s,panel,f,at){
    if(f&&f.path&&f.group){
      if(panel) this._fhlDiffSel(panel,f,at); else this._fhlPend={at,diff:f};
    }
    const tree=this._edTreeFor(s);
    if(tree&&(tree._selSet.size||tree._sel)){tree._selOnly('');tree._paintAll()}
  },

  _fhlDiffSel(panel,f,at){
    const key=panel._selKey(f.group,f.path);
    // Changes 의 현재 행(`cur`)도 그 대상이다 — 그 행이 ‹ › 와 범위 선택의 기준이다.
    const cur=panel.previewFile;
    if(!cur||cur.group!==f.group||cur.path!==f.path){panel.previewFile={...f,repo:panel.repo};panel._anchor={group:f.group,path:f.path};panel._paint()}
    if(panel._sel.size!==1||!panel._sel.has(key)){
      panel._sel.clear(); panel._sel.add(key);
      panel._anchor={group:f.group,path:f.path};
      panel._paint();
    }
    // FR-FHL-10: 접힌 그룹·트리 폴더·"더 보기" 뒤에 있어도 보이게 한다. 숨어 있으면 보일 때 다시 한다.
    if(!panel.revealRow(f.group,f.path)) this._fhlPend={at,diff:f};
  },
});
