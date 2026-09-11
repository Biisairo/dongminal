/**
 * Dongminal — Editor 창의 파일 탐색기 (EDITOR_TAB_SRS 묶음 X / FR-EDT-57~78)
 *
 * **인스턴스는 창별로 하나이고 렌더러보다 오래 산다.** 렌더러의 `_rLayout` 은 매
 * render 마다 `.ed-win` 을 지우고 다시 만드는데(renderer.js), 트리를 거기서 함께
 * 만들면 SSE 한 번에 펼침·선택·스크롤이 전부 사라진다 (FR-EDT-66). 그래서 요소는
 * 여기서 한 번 만들고 렌더러는 `mount()` 가 준 것을 **옮겨 붙이기만** 한다.
 *
 * 갱신 계기는 넷이다 — 새로고침 · 조작 후 재조회(M5) · git 색 폴링 (FR-EDT-67) ·
 * **겹의 스탬프 폴링** (NOTES_LIVE_EXPLORER_SRS FR-FSL-7~9).
 *
 * 넷째가 나중에 붙었다. 앞의 셋만 있는 동안 디렉터리 목록은 **바깥의 변경을
 * 영영 따라가지 않았다** — git 색 폴링이 갱신하는 것은 색뿐이라, 터미널이나
 * `git checkout` 이 파일을 더하고 지워도 사용자가 새로고침을 누르기 전까지
 * 트리는 옛 목록이었다. 파일 감시(fsnotify)는 여전히 하지 않는다 — 스탬프는
 * 그 대신 "이 겹이 바뀌었나"를 주기마다 한 번의 요청으로 묻는다 (D-5·D-6).
 *
 * **메서드는 이 파일에 없다.** 클래스 본문에는 `constructor`·접근자·마운트·파괴만
 * 남고, 나머지 55개는 주제별 파일이 `Object.assign(FileTree.prototype, …)` 로 얹는다
 * (SPLIT_REFACTOR_SRS 묶음 C). 접근자가 여기 남은 이유는 `Object.assign` 이 getter 를
 * **호출해 그 반환값을 복사**하기 때문이다 — 옮기면 store 로 가는 통로가 값으로 굳는다.
 *
 *   file-tree-paint.js  조회 · git 색 · 무시 · 항목 계산 · 그리기
 *   file-tree-edit.js   생성 · 이름 변경 · 삭제 · 낙관적 갱신
 *   file-tree-xfer.js   다운로드 · 업로드 · 우클릭 · 드래그드롭
 *
 * 루트마다 하나인 관측(`FileTreeStore`)은 file-tree-store.js 다.
 */
class FileTree {
  constructor(app,win){
    this.app=app;
    this.winId=win.id;
    this.root=app._edRootOf(win);

    // FR-SVS-20·21: 관측은 루트마다 하나이고 이 뷰는 그것을 **빌려 본다**.
    // 아래 접근자들이 `this._kids` 같은 이름을 그대로 store 로 잇는다 — 뷰의
    // 본문이 관측의 자리를 알 필요가 없다.
    this.store=app._edStore(this.root);
    this.store.attach(this);

    // 펼침·선택은 **보는 자리의 것**이다 — 워크스페이스에 저장하지 않고
    // (FR-EDT-62) 칸마다 따로 산다 (FR-SVS-21).
    this._open=new Set();
    // EXPLORER_MULTI_SELECT_SRS FR-EMS-1: 선택은 **앵커 하나 + 집합**이다.
    // 앵커(`_sel`)를 남기는 것이 D-1 이다 — 그것을 읽는 자리가 열 곳이 넘고,
    // 집합으로 대체하면 하나만 놓쳐도 "선택이 없다" 로 읽혀 조용히 아무 일도
    // 하지 않는다. 집합은 언제나 앵커를 포함한다.
    this._sel='';
    this._selSet=new Set();
    this._scrollY=0;
    // M5 의 조작 상태 (FR-EDT-79~92). 셋 다 **런타임 상태**이고 워크스페이스에
    // 저장하지 않는다 — 새로고침 뒤에 반쯤 쓰다 만 이름이 살아날 이유가 없다.
    this._edit=null;   // 인라인 입력 하나. 두 개가 동시에 열리는 자리가 없다.
    this._err=null;    // 마지막 실패. {anchor,msg} — 그 자리에 붙는다 (FR-EDT-92).
    this._drag='';     // 끌고 있는 경로. dataTransfer 는 dragover 에서 읽을 수 없다.
    this._focusEdit=false;
    // FR-EXR-58: 이 탐색기가 포커스를 쥐고 있는가. render 가 요소를 떼면 포커스는
    // 사라지므로, 되돌릴 근거는 이 플래그 하나다 (아래 `focusin`/`focusout`).
    this._focusOwn=false;

    // FR-FTR-20: 헤더는 루트 드롭 존이다 — 표시를 위해 들고 있는다.
    this._dropDir='';
    this._springTimer=null;
    this._springPath='';

    this.el=document.createElement('div');
    this.el.className='ed-explorer';
    // FR-EXR-50: 탐색기가 포커스를 받는 자리. 사용자가 말한 "편집기로부터 키보드
    // 주도권을 가져온다" 는 **포커스를 옮기는 일**이고 전역 핸들러를 바꾸는 일이
    // 아니다 — 전역 `keydown`(FR-EKB-1·4)은 탐색기를 의도적으로 담당하며 이
    // 스펙의 키와 겹치지 않는다 (EXPLORER_ROOT_KEYS_SRS §2.5).
    this.el.tabIndex=0;
    this.head=this._head();
    this.el.appendChild(this.head);
    // FR-EXR-2: 머리도 루트다 — 드롭이 이미 그렇게 읽는다 (FR-FTR-20). 머리는
    // 수명 내내 같은 요소이므로 리스너는 하나면 된다.
    this.head.addEventListener('click',e=>{
      // 버튼은 자기 동작을 갖는다. 여기서 선택까지 바꾸면 새로고침이 선택을
      // 옮기는 것으로 읽힌다.
      if(e.target.closest('.ed-head-btn')) return;
      this._selectRoot();
    });
    // FR-EXR-51: 키는 컨테이너 하나에 건다 — 머리와 트리 어느 쪽에 포커스가
    // 있어도 같은 길이어야 한다. 행에 거는 것은 reconcile 이 행을 다시 만들기
    // 때문에 성립하지 않는다 (아래 `click` 과 같은 근거).
    this.el.addEventListener('keydown',e=>this._onKey(e));
    /**
     * FR-EXR-58: **누가 포커스를 쥐고 있는가.** `_rLayout` 이 매 render 마다
     * `.ed-win` 을 떼었다 붙이므로 포커스는 빼앗기는 것이 아니라 **잃는다** —
     * 인라인 입력이 겪는 함정과 같은 것이다 (FR-EDT-66, `_restoreEditFocus`).
     *
     * `focusout` 은 **바깥으로 나간 것만** 센다. 요소가 떨어져 나가며 잃은
     * 포커스는 `relatedTarget` 이 없고, 그 blur 는 요소가 다시 붙은 뒤에
     * 도착하므로(실측 — 같은 주석 참조) 그것으로 소유를 지우면 안 된다.
     */
    this.el.addEventListener('focusin',()=>{ this._focusOwn=true });
    this.el.addEventListener('focusout',e=>{
      const to=e.relatedTarget;
      if(to&&!this.el.contains(to)) this._focusOwn=false;
    });
    this.list=document.createElement('div');
    this.list.className='ed-tree';
    this.el.appendChild(this.list);

    // 행은 reconcile 로 다시 만들어질 수 있다 — 리스너는 컨테이너 하나에만 건다.
    this.list.addEventListener('click',e=>this._onClick(e));
    // FR-RTU-42(④): 더블클릭은 **고정**이다. 클릭 두 번이 이미 그 파일을 미리보기로
    // 열어 두었으므로 여기서는 고정만 한다 — 목록에서 더블클릭하는 손짓은 "이것을
    // 열어 둔다" 이지 "잠깐 본다" 가 아니다.
    this.list.addEventListener('dblclick',e=>this._onDbl(e));
    // FR-EDT-80: 진입점 둘 중 하나. 같은 이유로 여기 한 번만 건다.
    this.list.addEventListener('contextmenu',e=>this._onCtx(e));
    this._initDnd();
    this.list.addEventListener('scroll',()=>{
      if(this.el.isConnected) this._scrollY=this.list.scrollTop;
    });

    this.load(this.root);
  }

  // 관측으로 가는 통로. 이름은 예전과 같으므로 뷰의 본문은 한 줄도 바뀌지 않는다
  // — 바뀐 것은 **그 값이 어디 사는지**뿐이다 (FR-SVS-20).
  get _kids(){ return this.store.kids }
  set _kids(v){ this.store.kids=v }
  get _busy(){ return this.store.busy }
  get _st(){ return this.store.st }
  set _st(v){ this.store.st=v }
  get _partial(){ return this.store.partial }
  set _partial(v){ this.store.partial=v }
  get _dirSt(){ return this.store.dirSt }
  set _dirSt(v){ this.store.dirSt=v }
  // GIT_DIR_ENTRY_SRS FR-DIR-10·41: 디렉터리 항목과 저장소 접두. 관측의 것이므로
  // 같은 루트를 보는 칸 넷이 한 벌을 나눠 쓴다 (FR-SVS-20).
  get _dirOwn(){ return this.store.dirOwn }
  set _dirOwn(v){ this.store.dirOwn=v }
  get _repoPrefix(){ return this.store.repoPrefix }
  set _repoPrefix(v){ this.store.repoPrefix=v }
  get _gitOff(){ return this.store.gitOff }
  set _gitOff(v){ this.store.gitOff=v }
  get _gitRetryAt(){ return this.store.gitRetryAt }
  set _gitRetryAt(v){ this.store.gitRetryAt=v }
  get _gitBusy(){ return this.store.gitBusy }
  set _gitBusy(v){ this.store.gitBusy=v }
  get _ign(){ return this.store.ign }
  get _ignOff(){ return this.store.ignOff }
  set _ignOff(v){ this.store.ignOff=v }
  get _stamps(){ return this.store.stamps }
  get _stampBusy(){ return this.store.stampBusy }
  set _stampBusy(v){ this.store.stampBusy=v }
  get _stampOff(){ return this.store.stampOff }
  set _stampOff(v){ this.store.stampOff=v }

  // FR-SVS-22: 관측을 바꾼 뒤에는 그 루트를 보는 칸 전부를 칠한다. 시선만 바뀐
  // 경우에도 이것을 부른다 — 다른 칸은 자기 시선으로 그리므로 결과가 같고,
  // reconcile 이 서명으로 걸러 실제 DOM 변경은 일어나지 않는다.
  _paintAll(){ this.store.paintAll() }

  /**
   * FR-EXR-30: 이 루트에서는 폴더를 만들 수 없다 — 메모장이다.
   *
   * 루트 판정은 `app-editor.js:50` 이 이름을 가르는 데 쓰는 것과 같은 것이다.
   * 새 판정을 만들지 않는다. 루트는 인스턴스 수명 동안 불변이므로
   * (`app-editor.js:535` 가 바뀌면 버린다) 머리를 만들 때 물어도 된다.
   */
  _noDirs(){
    const notes=this.app._edNotes();
    return !!notes&&this.root===notes;
  }

  _head(){
    const h=document.createElement('div'); h.className='ed-head';
    const n=document.createElement('span'); n.className='ed-head-name';
    n.textContent=this.app._edName(this.root); n.title=this.root;
    h.appendChild(n);
    // FR-EDT-80: 상단 버튼 셋 — 새 파일 · 새 폴더 · 새로고침. 만드는 자리는
    // 선택이 정한다 (FR-EDT-81) — 버튼은 그 규칙을 다시 적지 않는다.
    h.appendChild(this._headBtn('ed-head-new-file',EDITOR_TREE_NEW_FILE,
      EDITOR_TREE_NEW_FILE_TITLE,()=>this.startCreate(false)));
    // FR-EXR-31: 메모장에는 이 버튼을 두지 않는다. 눌러도 아무 일이 없는 버튼은
    // 고장으로 읽힌다 — `+` 자리를 Editor·Git 창에서 빼는 것과 같은 근거다
    // (FR-EDT-54).
    if(!this._noDirs()) h.appendChild(this._headBtn('ed-head-new-dir',EDITOR_TREE_NEW_DIR,
      EDITOR_TREE_NEW_DIR_TITLE,()=>this.startCreate(true)));
    h.appendChild(this._headBtn('ed-head-refresh',EDITOR_TREE_REFRESH,
      EDITOR_TREE_REFRESH_TITLE,()=>this.refresh()));
    return h;
  }

  /**
   * 머리의 버튼 하나. `label` 이 **알려진 아이콘**이면 그림으로, 아니면 글자로
   * 넣는다.
   *
   * 판정이 "SVG 처럼 생겼는가" 가 아니라 `EDITOR_HEAD_ICONS` 에 **있는가** 인
   * 것이 요점이다 — 모양으로 판정하면 언젠가 사용자 입력이 그 모양을 하고
   * 들어온다. 목록에 있는 것만 그림이 되므로 그 경로가 아예 없다.
   */
  _headBtn(cls,label,title,fn){
    const b=document.createElement('button'); b.className='ed-head-btn '+cls;
    if(EDITOR_HEAD_ICONS.has(label)) b.innerHTML=label;
    else b.textContent=label;
    b.title=title;
    b.addEventListener('click',fn);
    return b;
  }

  /**
   * 렌더러의 마운트 지점. 요소를 **돌려줄 뿐** 다시 만들지 않는다.
   *
   * 떼었다 붙이는 사이에 scrollTop 은 브라우저마다 다르게 남는다 (term-pane 의
   * 뷰포트 복원이 같은 함정을 다룬다). 값으로 되돌리는 쪽이 확실하다 (FR-EDT-68).
   */
  mount(){
    const y=this._scrollY;
    if(y) TIMERS.frame(()=>{ if(this.list.scrollTop!==y) this.list.scrollTop=y },{owner:this,label:'tree-frame'});
    // FR-EDT-66: 스크롤과 같은 함정이 인라인 입력에도 있다. 요소가 문서에서
    // 떨어지는 순간 포커스가 사라지므로(SSE 한 번이면 충분하다) 값으로 되돌린다 —
    // 입력이 **열려 있는 동안**에만이다.
    if(this._edit) this._restoreEditFocus();
    // FR-EXR-58: 입력이 없을 때는 **컨테이너 자신**이 그 자리다. 이것이 없으면
    // 방향키가 한 번 눌린 뒤 다음 render 에 길이 끊긴다.
    else if(this._focusOwn) this._restoreOwnFocus();
    return this.el;
  }

  /**
   * 컨테이너의 포커스를 되돌린다. `_restoreEditFocus` 와 **같은 가드**를 쓴다 —
   * 다른 요소가 쥐고 있으면 뺏지 않는다. 떨어져 나가며 잃은 포커스는 `body` 로
   * 돌아가므로 그 경우만 우리 것이다.
   *
   * 붙기 전에는 `focus()` 가 아무 일도 하지 않으므로 다음 프레임에 건다.
   * 렌더러의 재포커스(renderer.js)보다 **먼저** 돈다 — 그쪽 프레임이 뒤에
   * 등록되기 때문이며, 그래서 명시적으로 여는 손짓(FR-EXR-59)은 그 뒤에
   * 우리를 덮어쓸 수 있다.
   */
  _restoreOwnFocus(){
    TIMERS.frame(()=>{
      if(!this._focusOwn||!this.el.isConnected) return;
      const cur=document.activeElement;
      if(cur&&cur!==document.body) return;
      this.el.focus();
    },{owner:this,label:'tree-focus'});
  }

  /**
   * 포커스와 선택 구간을 되돌린다. 구간까지 되돌리지 않으면 폴링 한 번에 캐럿이
   * 끝으로 튀어 타이핑하던 자리를 잃는다 (FR-EDT-82 의 미리 선택도 같이 사라진다).
   *
   * 붙기 전에는 focus() 가 아무 일도 하지 않으므로 다음 프레임에 건다 — 렌더러는
   * `mount()` 가 준 요소를 그 뒤에 붙인다 (renderer.js `_rEditorWin`).
   */
  _restoreEditFocus(){
    const el=this.list.querySelector('.ed-input');
    if(!el) return;
    const a=el.selectionStart,b=el.selectionEnd;
    TIMERS.frame(()=>{
      if(!this._edit||!el.isConnected||document.activeElement===el) return;
      // 다른 요소가 포커스를 쥐고 있으면 뺏지 않는다. 떨어져 나가면서 잃은
      // 포커스는 `body` 로 돌아가므로 그 경우만 우리 것이다 — 입력이 잃은 blur 는
      // 요소가 다시 붙은 **뒤에** 도착해서 (실측) 플래그로는 가릴 수 없다.
      const cur=document.activeElement;
      if(cur&&cur!==document.body) return;
      el.focus();
      el.setSelectionRange(a,b);
    },{owner:this,label:'tree-frame'});
  }

  destroy(){
    this._springCancel();
    // FR-SVS-23: 이 칸의 시선은 사라진다. 관측은 다른 칸이 보고 있으면 남고,
    // 마지막 칸이었으면 store 가 스스로 거둬진다.
    if(this.store) this.store.detach(this);
    if(this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // ── 조회 (FR-EDT-59·63·65) ──

  // 구분자는 `pathJoin` 이 정한다 (helpers.js) — 그 OS 의 것을 따른다.
  _join(dir,name){ return pathJoin(dir,name) }

  // 루트 기준 상대경로. git status 의 경로가 그 형식이다.
  // 키는 git 의 것이다 — 어느 OS 에서도 `/` 다 (helpers.js `pathRel`).
  _rel(p){ return pathRel(this.root,p) }
}

// 고전 스크립트의 class 선언은 window 의 속성이 되지 않는다 — e2e 가 창 밖에서
// 부르므로 명시적으로 붙인다 (repaint.js 와 같은 규약).
window.FileTree=FileTree;
