/**
 * FileTree — 키보드 길 (FR-EXR-51~57 · UX_BATCH12 FR-EXK-1~6).
 *
 * file-tree-paint.js 에서 갈랐다 — 모듈 크기 게이트(FR-STR-40)가 그 파일의 성장을 막는다.
 */
Object.assign(FileTree.prototype, {
  /**
   * FR-EXR-51~57: 탐색기의 키보드 길. **조작을 만들지 않는다** — 이미 있는
   * `doDelete`·`edClipSet`·`doPasteInto`·`startRename` 에 길만 낸다.
   *
   * 전역 `keydown`(`input-binding.js`, capture)은 이 키들을 삼키지 않는다
   * (EXPLORER_ROOT_KEYS_SRS §2.5 실측) — 그래서 그 규약(FR-EKB-1·4)을 뒤집지
   * 않는다. 대신 **처리한 키만** 삼킨다 (FR-EXR-56).
   */
  _onKey(e){
    // FR-EXR-55: 인라인 입력의 키는 그 입력의 것이다. `Delete` 가 글자가 아니라
    // 파일을 지우면 그것이 놀람이다.
    if(e.target.closest('.ed-edit')) return;
    // FR-EXR-57: 머리 버튼에 포커스가 있는 동안의 키도 그 버튼의 것이다.
    if(e.target.closest('button')) return;
    const p=this._sel;
    // FR-EXR-54: 루트는 지울 수도 이름을 고칠 수도 복사할 수도 없다. 붙여넣기만
    // 된다 — 그 자리가 루트라는 뜻이다 (FR-EXR-5).
    const pick=p&&p!==this.root?p:'';
    const take=()=>{e.preventDefault();e.stopPropagation()};
    if(e.metaKey||e.ctrlKey){
      if(e.altKey||e.shiftKey) return;
      // UX_BATCH12 FR-EXK-2·6: 복사·잘라내기는 선택 전체다. 루트만 고르면 대상이 없다.
      if(e.code==='KeyC'||e.code==='KeyX'){
        const ps=pick?this._selTargets(pick).filter(x=>x&&x!==this.root):[];
        if(!ps.length) return;
        take(); this.app.edClipSet(this.root,ps,e.code==='KeyX'); return;
      }
      if(e.code==='KeyV'){
        take(); this.doPasteInto(this._targetDir()); return;
      }
      if(e.code==='KeyA'){
        if(!this._selAll()) return;
        take(); this._paintAll(); return;
      }
      // FR-EXK-4: ⌘+Backspace 는 macOS Finder 의 삭제 관용이다.
      if(e.metaKey&&e.code==='Backspace'){
        if(!pick) return;
        take(); this.doDelete(pick); return;
      }
      return;
    }
    if(e.altKey||e.shiftKey) return;
    const kind=pick?this._kindOf(pick):'';
    switch(e.code){
      // FR-EXR-53: 확인은 `doDelete` 가 든다 (FR-EDT-83·84). 키보드라는 이유로
      // 확인을 빼는 갈래를 만들지 않는다 — `U-10` 이 그 부류의 결함이었다.
      // `Backspace` 를 함께 받는 것은 macOS 의 삭제 관용이 그것이기 때문이다.
      case 'Delete': case 'Backspace':
        if(!pick) return;
        take(); this.doDelete(pick); return;
      case 'F2':
        if(!pick) return;
        take(); this.startRename(pick); return;
      // FR-EXK-5: 여럿을 고른 동안만 받는다 — 그 밖의 Escape 는 다른 이의 것이다.
      case 'Escape':
        if(this._selSet.size<2) return;
        take(); this._selOnly(this._sel); this._paintAll(); return;
      case 'ArrowDown': take(); this._moveSel(1); return;
      case 'ArrowUp': take(); this._moveSel(-1); return;
      case 'ArrowRight':
        if(kind!=='dir'||this._open.has(pick)) return;
        take(); this.toggle(pick); return;
      case 'ArrowLeft':
        if(kind!=='dir'||!this._open.has(pick)) return;
        take(); this.toggle(pick); return;
      case 'Enter':
        if(!pick) return;
        take();
        // 더블클릭과 뜻이 같다 (FR-RTU-42) — 다만 키보드로는 미리보기를 지나지
        // 않았을 수 있으므로 `edPinTabFor` 가 아니라 여는 자리를 부른다.
        if(kind==='dir') this.toggle(pick);
        else if(kind==='file') this.app.edOpenFile(pick,{preview:false});
        return;
    }
  },
});
