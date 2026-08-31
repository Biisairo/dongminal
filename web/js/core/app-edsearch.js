/**
 * Remote Terminal — Editor 창의 파일 찾기·전체 내용 찾기
 * (EDITOR_GIT_UX_SRS 묶음 F·G·K)
 *
 * 두 패널은 같은 껍데기(오버레이 + 질의 칸 + 결과 목록)를 쓰고 무엇을 물어
 * 무엇을 그리는지만 다르다. 한 벌로 두는 이유는 키 조작(↑↓·Enter·Escape)이
 * 완전히 같기 때문이다 — 두 벌로 두면 한쪽만 고쳐진다.
 *
 * 파일 내 검색은 여기서 패널을 만들지 않는다 (FR-EKB-3) — Monaco 의 find 위젯이
 * 이미 그 자리이고 우리가 만들 어떤 것도 그보다 낫지 않다. 다만 **여는 키는**
 * 다른 둘과 같은 체계로 온다 (FR-EKB-5): 셋이 나란히 설정에 보여야 한다.
 */
Object.assign(App.prototype, {

  // 검색이 걸릴 루트. I-3 대로 **현재 Editor 창의 루트**다 (FR-EKB-4) —
  // 터미널 창에는 검색할 루트가 없으므로 아무 일도 일어나지 않는다.
  //
  // 활성 창은 `ws.activeWindow` 에 산다 — `app.activeWindow` 는 존재하지 않는다.
  // 처음에 그것을 읽어 이 함수가 언제나 빈 문자열을 냈고, 두 단축키가 통째로
  // 죽어 있었다. "터미널 창에서는 빈 문자열"만 보던 검사는 그것을 통과시킨다.
  _edSearchRoot(){
    const s=this.ws.windows.find(w=>w.id===this.ws.activeWindow);
    if(!this._isEditorWin(s)) return '';
    return this._edRootOf(s)||'';
  },

  _edQuickOpen(){ this._edPanelOpen('find') },
  _edSearchOpen(){ this._edPanelOpen('grep') },

  /**
   * FR-EKB-3·5: 파일 내 검색은 Monaco 에게 시킨다. 우리 패널을 하나 더 만들면
   * 정규식·대소문자·선택영역 한정이 전부 두 벌이 된다.
   *
   * 편집기가 없으면 아무 일도 하지 않는다 — 이진 파일 탭이나 빈 pane 이 그렇다.
   */
  _edFindInFile(){
    const v=this._edActiveEditor();
    const ed=v&&v._editor;
    if(!ed) return;
    ed.focus();
    ed.trigger('dongminal','actions.find',null);
  },

  // 활성 Editor 창에서 지금 보이는 편집기. `fileEditors` 는 탭 id 로 열려 있고
  // 활성 탭은 pane 이 안다.
  _edActiveEditor(){
    const s=this.ws.windows.find(w=>w.id===this.ws.activeWindow);
    if(!this._isEditorWin(s)) return null;
    const p=findPane(s.layout,s.focusedPane||this.focused)
      ||((s.layout&&s.layout.type==='pane')?s.layout:null);
    const tid=p&&p.activeTab;
    return (tid&&this.fileEditors.get(tid))||null;
  },

  /**
   * FR-EKB-1·5: 편집기 검색 세 키의 **단일 판정 자리**. Monaco 안(file-editor.js)
   * 과 밖(input-binding.js) 두 곳에서 부른다 — 두 벌로 두면 한쪽만 고쳐진다.
   *
   * Editor 창이 아니면 **삼키지 않고 false 를 돌려준다** (FR-EKB-4). 터미널
   * 창에서 `Mod+F` 를 눌렀을 때 터미널 검색이 떠야 하기 때문이다. 여기서
   * preventDefault 까지 하고 아무 일도 안 하면 그 키는 죽은 키가 된다.
   */
  _edTrySearchKey(e){
    for(const[action,fn] of Object.entries(ED_SEARCH_ACTIONS)){
      if(!matchShortcut(e,shortcuts[action])) continue;
      if(action!=='edFindInFile'&&!this._edSearchRoot()) return false;
      if(action==='edFindInFile'&&!this._edActiveEditor()) return false;
      e.preventDefault(); e.stopImmediatePropagation();
      this[fn]();
      return true;
    }
    return false;
  },

  _edPanelOpen(mode){
    const root=this._edSearchRoot();
    if(!root) return;
    this._edPanel(mode,root);
  },

  // 패널은 하나다. 모드가 바뀌면 내용만 갈아 끼운다 — 둘을 동시에 띄우면
  // 어느 쪽이 Enter 를 받는지 모호해진다.
  _edPanel(mode,root){
    let p=this._edPanelEl;
    if(!p){
      p=document.createElement('div');
      p.className='ed-find';
      p.innerHTML=
        '<div class="ed-find-box">'+
          '<input class="ed-find-q" type="text" spellcheck="false" autocomplete="off">'+
          '<div class="ed-find-note"></div>'+
          '<div class="ed-find-list"></div>'+
        '</div>';
      document.body.appendChild(p);
      this._edPanelEl=p;
      this._edPanelWire(p);
    }
    p._mode=mode; p._root=root; p._sel=0; p._items=[];
    const q=p.querySelector('.ed-find-q');
    q.placeholder=mode==='find'?ED_FIND_PLACEHOLDER:ED_GREP_PLACEHOLDER;
    q.value='';
    p.querySelector('.ed-find-list').innerHTML='';
    p.querySelector('.ed-find-note').textContent=
      mode==='find'?ED_FIND_HINT:ED_GREP_HINT;
    p.classList.add('vis');
    q.focus();
  },

  _edPanelClose(){
    const p=this._edPanelEl;
    if(!p) return;
    p.classList.remove('vis');
    // 닫으면서 포커스도 놓는다. 질의 칸에 포커스가 남으면 전역 keydown 의
    // activeElement 게이트(INPUT 이면 곧바로 return)가 다음 단축키를 통째로
    // 막는다 — 닫은 패널을 **같은 키로 다시 열 수 없게 된다.**
    const q=p.querySelector('.ed-find-q');
    if(q&&q.blur) q.blur();
  },

  _edPanelWire(p){
    const q=p.querySelector('.ed-find-q');
    // 입력마다 부르지 않는다 — 한 글자에 저장소 전체를 훑는 요청이 나간다.
    q.addEventListener('input',()=>{
      clearTimeout(p._t);
      p._t=setTimeout(()=>this._edPanelQuery(p),ED_SEARCH_DEBOUNCE_MS);
    });
    q.addEventListener('keydown',e=>{
      // 패널 안의 키는 밖으로 내보내지 않는다 — 앱 단축키가 끼어들면
      // 타이핑 중에 창이 바뀐다.
      e.stopPropagation();
      if(e.key==='Escape'){e.preventDefault();this._edPanelClose();return}
      if(e.key==='ArrowDown'){e.preventDefault();this._edPanelMove(p,1);return}
      if(e.key==='ArrowUp'){e.preventDefault();this._edPanelMove(p,-1);return}
      if(e.key==='Enter'){e.preventDefault();this._edPanelPick(p);return}
    });
    p.addEventListener('mousedown',e=>{
      // 바깥을 누르면 닫는다. 안쪽(.ed-find-box)은 그대로 둔다.
      if(e.target===p) this._edPanelClose();
    });
    p.querySelector('.ed-find-list').addEventListener('click',e=>{
      const row=e.target.closest('.ed-find-row');
      if(!row) return;
      p._sel=parseInt(row.dataset.i,10)||0;
      this._edPanelPick(p);
    });
  },

  async _edPanelQuery(p){
    const q=p.querySelector('.ed-find-q').value;
    const note=p.querySelector('.ed-find-note');
    if(!q){
      p._items=[]; p.querySelector('.ed-find-list').innerHTML='';
      note.textContent=p._mode==='find'?ED_FIND_HINT:ED_GREP_HINT;
      return;
    }
    // 세대 검사 — 늦게 온 응답이 새 질의의 결과를 덮지 않게 한다.
    const seq=(p._seq=(p._seq||0)+1);
    const url=(p._mode==='find'?ED_FIND_API:ED_GREP_API)+
      '?root='+encodeURIComponent(p._root)+'&q='+encodeURIComponent(q);
    let r=null,d=null;
    try{r=await fetch(url)}catch{r=null}
    if(r){try{d=await r.json()}catch{d=null}}
    if(seq!==p._seq) return;
    if(!r||!r.ok||!d){note.textContent=ED_SEARCH_FAIL;return}
    p._items=(p._mode==='find'?d.files:d.matches)||[];
    p._sel=0;
    this._edPanelPaint(p,d);
  },

  _edPanelPaint(p,d){
    const list=p.querySelector('.ed-find-list');
    const note=p.querySelector('.ed-find-note');
    const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,
      c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    if(!p._items.length){note.textContent=ED_SEARCH_EMPTY;list.innerHTML='';return}
    // 어느 구현으로 훑었는지 함께 보인다 (FR-EGS-3) — .gitignore 존중 여부가
    // 달라 결과가 다를 수 있고, 사용자가 그것을 설명할 수 있어야 한다.
    let n=p._items.length+(d.truncated?'+':'')+ED_SEARCH_COUNT_SUFFIX;
    if(p._mode==='grep'&&d.engine) n+=' · '+d.engine;
    note.textContent=n;
    list.innerHTML=p._items.map((it,i)=>
      p._mode==='find'
        ? '<div class="ed-find-row" data-i="'+i+'"><span class="ed-find-name">'+
          esc(it.name)+'</span><span class="ed-find-path">'+esc(it.path)+'</span></div>'
        : '<div class="ed-find-row" data-i="'+i+'"><span class="ed-find-path">'+
          esc(it.path)+':'+esc(it.line)+'</span><span class="ed-find-text">'+
          esc(it.text)+'</span></div>'
    ).join('');
    this._edPanelMark(p);
  },

  _edPanelMove(p,d){
    if(!p._items.length) return;
    p._sel=(p._sel+d+p._items.length)%p._items.length;
    this._edPanelMark(p);
  },

  _edPanelMark(p){
    const rows=p.querySelectorAll('.ed-find-row');
    rows.forEach((r,i)=>r.classList.toggle('sel',i===p._sel));
    const cur=rows[p._sel];
    if(cur&&cur.scrollIntoView) cur.scrollIntoView({block:'nearest'});
  },

  // FR-EQO-7 · FR-EGS-10: 고른 것을 연다. grep 결과는 그 **줄로** 연다.
  _edPanelPick(p){
    const it=p._items[p._sel];
    if(!it) return;
    this._edPanelClose();
    const abs=p._root.replace(/\/+$/,'')+'/'+it.path;
    this._edOpenFile(abs,p._mode==='grep'?{line:it.line,col:it.col}:undefined);
  },
});
