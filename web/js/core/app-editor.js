/**
 * Dongminal — Editor 창의 **정체** (FE_MODULE_BOUNDARY_SRS FR-FMB-20).
 *
 * 무엇이 Editor 창이고(FR-EDT-40), 그 창의 루트가 어디이며, 그 아래 경로가
 * 무엇으로 불리는가(FR-EDT-19·20·29·120). 나머지 다섯이 전부 이것을 딛는다.
 *
 * Git 창이 특수 창의 선례다 (EDITOR_TAB_SRS §2.2) — 이 묶음은 `app-git.js` 의
 * 구조를 그대로 복제한다: 창을 찾는 자리 하나, 만드는 자리 하나, 마이그레이션
 * 하나, 목록을 서버에서 받아 로컬 사본에 반영하는 자리 하나.
 *
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 *
 * **나머지는 갈라져 나갔다.** 고칠 자리를 파일 이름이 말한다:
 *
 *   app-editor-sync.js      서버 목록 동기 · 창 재조정 · dirty 판정
 *   app-editor-open.js      창·문서·트리를 여는 자리
 *   app-editor-pane.js      칸과 사이드 · 탭 이동 · git 폴링
 *   app-editor-file.js      파일 조작 · 클립보드 · 삭제 확인
 *   app-editor-section.js   사이드바 Editor 섹션 — 목록의 변경
 */
Object.assign(App.prototype, {
  // `isGitWin` 과 같은 자리·같은 모양이다. 조건이 흩어지면 한 곳이 빠져도
  // 조용히 지나간다 (§2.2).
  isEditorWin(s){return !!(s&&s.type===WINDOW_TYPE_EDITOR)},

  edWindows(){return this.ws.windows.filter(s=>this.isEditorWin(s))},

  edRootOf(s){return (s&&s.editor&&s.editor.root)||''},

  edWindowFor(root){return this.edWindows().find(s=>this.edRootOf(s)===root)||null},

  // ── 목록 (FR-EDT-19·20·29·120) ──

  // FR-EDT-120: `home` 을 모르면 root 행도 root 창도 만들 수 없다. 그때는 표면
  // 전체가 없는 것으로 본다 — Git 이 `_gitOff` 로 하는 것과 같다.
  edOn(){return !this._edOff&&!!(this.editors&&this.editors.home)},

  _edHome(){return this.edOn()?this.editors.home:''},

  /**
   * NOTES_LIVE_EXPLORER_SRS FR-NOT-11: 메모 루트. 서버가 주지 못하면 빈 문자열이며
   * 그때 없는 것은 **메모장 행 하나뿐**이다 — 홈과 다르다. 홈은 root 창의
   * 근거라서 모르면 표면 전체가 서지 않지만(FR-EDT-120), 메모 루트는 자기 행
   * 하나의 근거일 뿐이다.
   */
  edNotes(){return this.edOn()?((this.editors||{}).notes||''):''},

  /**
   * FR-EXT-9b: 플러그인 선언의 루트. 메모 루트와 같은 규약이며, 서버가 주지
   * 못하면 없는 것은 **그 행 하나뿐**이다.
   */
  _edPlugins(){return this.edOn()?((this.editors||{}).plugins||''):''},

  // 경로의 마지막 조각. 행 이름과 창 이름이 같은 규칙을 쓴다 (FR-EDT-10·44).
  edBase(p){
    const s=String(p||'').replace(/[\\/]+$/,'');
    return pathBase(s)||s||p||'';
  },

  // FR-NOT-9: 고정 행 둘은 경로에서 이름을 뽑지 않는다 — 파생시키면 `~` 가
  // 홈 디렉터리 이름이 되고 메모장이 `notes` 가 된다.
  edName(root){
    if(root===this._edHome()) return EDITOR_ROOT_NAME;
    if(root&&root===this.edNotes()) return EDITOR_NOTES_NAME;
    if(root&&root===this._edPlugins()) return EDITOR_PLUGINS_NAME;
    return this.edBase(root);
  },

  // FR-EDT-16·37 / FR-NOT-7: 홈과 메모 루트는 고정 행이 대표한다 — 일반 행
  // 목록에 같은 경로가 있어도 두 번 그리지 않는다.
  edEntries(){
    const fixed=new Set(this.edFixed().map(e=>e.path));
    return ((this.editors||{}).list||[])
      .filter(p=>typeof p==='string'&&p&&!fixed.has(p))
      .map(p=>({path:p,root:false}));
  },

  /**
   * FR-EDT-13·14 / FR-NOT-8: 최하단 고정 행들. 서술자의 `fixed(app)` 이
   * 돌려주는 것이 이것이다.
   *
   * **배열의 순서가 화면의 순서이자 순회의 순서다** (`SidebarList.entries`).
   * 메모장이 앞에 오므로 `~` **위**에 그려진다 — 접수한 말이 요구한 자리다.
   */
  edFixed(){
    const out=[];
    const notes=this.edNotes();
    if(notes) out.push({path:notes,notes:true});
    const home=this._edHome();
    if(home) out.push({path:home,root:true});
    // 플러그인 선언은 `~` **아래**다 — 늘 쓰는 자리가 아니라 고칠 때 찾는 자리다.
    const plugins=this._edPlugins();
    if(plugins) out.push({path:plugins,plugins:true});
    return out;
  },

  /**
   * FR-EDT-42(1) / FR-NOT-6: 있어야 할 루트 집합. 메모 루트가 여기 드는 것이
   * 곧 메모장 창이 서는 근거다 — 재조정이 이 집합만 보고 창을 세운다.
   *
   * 순서는 서버의 `Roots()` 와 같은 `[home, notes, ...list]` 다. 고정 행의
   * 표시 순서(`edFixed`)와 **일부러 다르다**: 저쪽은 화면에서 무엇이 위에
   * 오는가이고, 이쪽은 창이 만들어지는 차례다. root 창이 먼저 서야 새
   * 워크스페이스의 첫 창이 지금까지와 같다.
   */
  edRoots(){
    const home=this._edHome();
    if(!home) return [];
    const notes=this.edNotes();
    const plugins=this._edPlugins();
    // 순서는 서버의 `Roots()` 와 같다 — [home, notes, plugins, ...list].
    return [home,...(notes?[notes]:[]),...(plugins?[plugins]:[]),
      ...this.edEntries().map(e=>e.path)];
  },
});
