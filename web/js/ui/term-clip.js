/**
 * 터미널의 복사·붙여넣기 키와 모바일 텍스트 시트 (UX_BATCH11_SRS FR-TCP).
 * `term-input.js` 의 증강 분할이다 — 계약은 `TerminalTool` 한 클래스에 남고 주제만 이 파일로
 * 옮겼다 (FE_MODULE_BOUNDARY 규약). 키 배선·터치 스크롤이 이 메서드들을 부른다.
 */
Object.assign(TerminalTool.prototype, {
  /**
   * UX_BATCH11_SRS FR-TCP-1·6: 단독 Ctrl+C·Ctrl+V 가 무엇이 되는가. `'copy'` · `'paste'` · `null`.
   *
   * 판정은 `e.code` 로도 한다 — 한글 자판에서는 Ctrl+C 의 `key` 가 `ㅊ` 로 온다.
   */
  _clipKey(e,mac=IS_MAC){
    if(!e.ctrlKey||e.shiftKey||e.altKey||e.metaKey) return null;
    const k=String(e.key||'').toLowerCase();
    if(k==='c'||e.code==='KeyC') return this.term&&this.term.hasSelection()?'copy':null;
    if((k==='v'||e.code==='KeyV')&&!mac) return 'paste';
    return null;
  },

  /** FR-TCP-1·4: 선택을 복사하고 해제한다. 쓰기 3단의 1·2단이 성공했을 때만 토스트를 띄운다. */
  _copySelection(){
    const sel=this.term.getSelection();
    this.term.clearSelection();
    ClipboardWriter.write(sel).then(ok=>{ if(ok) Toast.show(t('term.copied'),'ok',TOAST_MS) });
  },

  /**
   * UX_BATCH11_SRS FR-TCP-7·8 (개정 2, D-20): 터치 기기에서 길게 누르기는 **OS 의 선택**이다.
   *
   * 터미널 글자는 이미 선택할 수 있는 글자다(`style.css` 의 `.xterm{user-select:text}`) — 막고 있던
   * 것은 Android 의 길게 누르기가 내는 `contextmenu` 에 터미널 메뉴가 서며 기본 동작을 막던 것이다.
   * 그 메뉴만 세우지 않고 기본 동작(선택 도구 막대)은 둔다. 데스크톱 포인터는 종전대로다.
   *
   * 복사는 그 선택의 글자다. DOM 렌더러가 칸을 채우려 쓴 `\xa0` 은 공백으로 바꾼다. xterm 자체의
   * 선택이 있으면 그쪽이 이긴다 — xterm 의 `copy` 처리가 그대로 돈다.
   */
  _wireNativeSelect(){
    this.el.addEventListener('contextmenu',e=>{
      if(this._tsTouch()) e.stopImmediatePropagation();
    },true);
    this.el.addEventListener('copy',e=>{
      if(this.term&&this.term.hasSelection()) return;
      const sel=document.getSelection();
      if(!sel||sel.isCollapsed||!this.el.contains(sel.anchorNode)||!e.clipboardData) return;
      e.clipboardData.setData('text/plain',sel.toString().replace(/\xa0/g,' '));
      e.preventDefault();
    });
  },
});
