/**
 * Dongminal — Editor 창을 **열고 그 안에 무엇을 세우는가** (FE_MODULE_BOUNDARY_SRS FR-FMB-20).
 *
 * 창·문서·탐색기 트리의 생성 자리. 셋이 한 파일인 이유는 **여는 한 번**이 셋을
 * 함께 세우기 때문이다 — 창을 열면 문서 스토어가 서고 그 위에 트리가 붙는다.
 */
Object.assign(App.prototype, {
  /**
   * FR-EDT-103·104: 일반 창에 남은 `type==='editor'` 탭을 제거한다.
   *
   * **`clean()` 에 넣지 않는다** — `clean` 은 편집기 탭을 보존하도록 만들어져
   * 있고(§2.9) 시그니처가 창 타입을 알지 못한다. 창을 순회하는 자리인
   * `_migrateGitWindow` 옆이 그 자리다 (D-19).
   *
   * 확인창은 띄우지 않는다 (D-9) — 로드 시점이라 확인이 걸릴 자리가 아니고,
   * 파일 자체는 디스크에 그대로 있다.
   */
  _migrateEditorTabs(list){
    if(!this.edOn()) return 0;
    const ws=list||this.ws.windows;
    if(!Array.isArray(ws)) return 0;
    let n=0;
    for(const s of ws){
      if(!s||!s.layout) continue;
      if(this.isEditorWin(s)||this.isGitWin(s)) continue;
      const panes=[];this._collectPanes(s.layout,panes);
      for(const p of panes){
        const before=(p.tabs||[]).length;
        p.tabs=(p.tabs||[]).filter(t=>!t||t.type!=='editor');
        n+=before-p.tabs.length;
        if(!p.tabs.find(t=>t.id===p.activeTab)) p.activeTab=p.tabs.length?p.tabs[0].id:null;
      }
      // FR-EDT-105: 탭이 0이 된 pane 은 붕괴 규약대로 사라지고, layout 이 빈
      // 일반 창도 사라진다 (호출처의 필터가 거둔다).
      for(const p of panes) if(!p.tabs.length) s.layout=doRemove(s.layout,p.id);
    }
    return n;
  },

  // ── 탭 ↔ 창 (FR-EDT-7·9) ──

  // FR-EDT-7: Editor 탭을 고르면 마지막으로 활성이었던 Editor 창으로 간다.
  // 그런 창이 없으면 root 에디터 창이다 (`gitBackTarget` 과 같은 모양).
  edActivateTarget(){
    const wins=this.edWindows();
    return wins.find(s=>s.id===this._lastEditorWindow)
      ||this.edWindowFor(this._edHome())||wins[0]||null;
  },

  edOpenWindow(root){
    const w=this.edWindowFor(root);
    if(w) this.switchWindow(w.id);
  },

  // ── 탐색기 (FR-EDT-57~68) ──

  /**
   * 창별 탐색기 인스턴스. 렌더러의 마운트 자리가 이것을 부른다.
   *
   * **렌더러가 소유하지 않는다.** `_rLayout` 은 매 render 마다 `.ed-win` 을 지우고
   * 다시 만드는데, 트리를 거기서 만들면 SSE 한 번에 펼침·선택·스크롤이 사라진다
   * (FR-EDT-66). `fileEditors` 와 같은 규약이다 — 인스턴스는 app 이 쥐고 요소만
   * 옮겨 붙는다.
   */
  // ── 문서 (SLOT_VIEW_STATE_SRS 묶음 E / FR-SVS-50~55) ──

  /**
   * FR-SVS-50: 편집 중인 파일의 **문서는 하나**다. 내용(Monaco 모델)과 dirty 는
   * 문서의 것이며 칸의 것이 아니다.
   *
   * 단위는 **파일 경로**다 (D-7) — 탭이 아니다. 같은 파일이 두 탭에 열릴 수 있는
   * 한, 탭 단위 문서는 한쪽 저장이 다른 쪽을 덮는 같은 손실을 다시 만든다.
   *
   * 슬롯이 생긴 뒤로 `FileEditor` 는 이미 칸마다 섰다 (`slotKey`). 그런데 내용과
   * dirty 를 그 뷰가 소유했으므로, 같은 파일을 두 칸에 열면 독립 편집기 둘이 같은
   * 파일을 각자 편집하고 한쪽 저장이 다른 쪽 저장에 덮였다.
   */
  edDoc(filePath){
    if(!this._edDocs) this._edDocs=new Map();
    let d=this._edDocs.get(filePath);
    if(!d){
      // `model` 은 첫 뷰가 내용을 받아 온 뒤에 채운다 — 문서의 자리를 먼저 잡아야
      // 두 번째 뷰가 "이미 누가 열어 두었다" 를 알 수 있다.
      // `dd` 는 변경 표시(EDITOR_DIRTY_DIFF_SRS)다. 문서의 것인 이유는 기준과
      // 계산이 모델 하나에 대한 것이기 때문이다 (FR-EDD-5·15 / D-4).
      // `stamp` 는 경합의 재료다 (EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-11). 문서의
      // 것인 이유는 dirty·내용과 같다 — 두 칸이 같은 파일을 볼 때 한쪽이 저장하면
      // **양쪽의** 표식이 함께 새것이 되어야 다음 저장이 제 발에 걸리지 않는다.
      d={model:null,dirty:false,saving:false,stamp:'',dd:null,views:new Set()};
      this._edDocs.set(filePath,d);
    }
    return d;
  },

  // FR-SVS-55: 그 파일을 보는 칸이 하나도 남지 않으면 문서를 거둔다. 칸이 줄어도
  // 다른 칸이 보고 있으면 내용은 남는다 — 편집 중이던 것이 칸 정리로 사라지면
  // 그것이 결함이다.
  edDocDrop(filePath,view){
    const d=this._edDocs&&this._edDocs.get(filePath);
    if(!d) return;
    d.views.delete(view);
    if(d.views.size) return;
    // FR-EDD-16·55: 표시의 수명은 문서의 수명이다. 모델보다 **먼저** 걷는다 —
    // 데코레이션을 버려진 모델에서 지우려 하면 그 자리가 예외다.
    if(d.dd){d.dd.dispose();d.dd=null}
    if(d.model){try{d.model.dispose()}catch{}}
    this._edDocs.delete(filePath);
  },

  /**
   * EDITOR_DIRTY_DIFF_SRS FR-EDD-5: 이 파일의 변경 표시. 문서마다 하나이므로
   * 같은 파일을 두 칸에서 열어도 기준 취득과 계산은 한 번이다 (NFR-EDD-2).
   *
   * `file-editor-diff.js` 가 없으면 `null` 이다 — 편집기가 그 경우를 그대로
   * 지난다 (NFR-EDD-3).
   */
  edDirtyDiff(filePath){
    if(typeof EdDirtyDiff!=='function') return null;
    const d=this.edDoc(filePath);
    if(!d.dd) d.dd=new EdDirtyDiff(this,filePath);
    return d.dd;
  },

  // FR-EDD-23b: 테마가 바뀌면 색을 다시 읽어 칠한다. 계기는 `FileEditor.applyTheme`
  // 하나이며 여기는 그것이 부르는 자리다.
  edDirtyDiffRepaint(){
    if(!this._edDocs) return;
    for(const d of this._edDocs.values()) if(d.dd) d.dd.recompute();
  },

  /**
   * FR-SVS-20: 탐색기의 **관측**은 루트마다 하나다. 창이 아니라 루트가 단위인
   * 이유는 두 Editor 창이 같은 루트를 볼 때 요청이 두 벌이 될 이유가 없기
   * 때문이다 (D-5). 마지막 뷰가 떠날 때 store 가 스스로 이 맵에서 빠진다.
   */
  edStore(root){
    if(!this.edStores) this.edStores=new Map();
    let st=this.edStores.get(root);
    if(!st){st=new FileTreeStore(this,root);this.edStores.set(root,st)}
    return st;
  },

  /**
   * FR-SVS-21·24: 탐색기의 **시선**은 칸마다 하나다. 키가 `slotKey` 를 지나므로
   * 칸 0 의 키는 창 id **그대로**다 (FR-WSL-75 와 같은 이유).
   *
   * 두 칸이 같은 Editor 창을 볼 때 예전에는 `mount()` 가 같은 요소를 돌려주어
   * 뒤에 그린 칸이 앞 칸에서 탐색기를 **떼어 갔다** — 앞 칸의 탐색기 자리가 비는
   * 것이 접수된 결함의 절반이었다.
   */
  edTree(s,slot){
    if(!this._edTrees) this._edTrees=new Map();
    // 회수의 주 자리는 `_edReapTrees`(재조정)다. 여기서 한 번 더 부르는 것은
    // 재조정을 지나지 않는 경로로 창이 사라졌을 때의 그물이다.
    this._edReapTrees();
    const key=this.slotKey(s.id,slot||0);
    let t=this._edTrees.get(key);
    if(t&&t.root!==this.edRootOf(s)){t.destroy();t=null}
    if(!t){t=new FileTree(this,s);this._edTrees.set(key,t)}
    // FR-DSP-1c: 트리가 없던 동안 열린 파일을 이제 드러낸다. 한 번만이다 —
    // 지운 뒤에 부르므로 다음 render 가 같은 일을 되풀이하지 않는다.
    if(this._edReveal&&this._edReveal.has(s.id)){
      const want=this._edReveal.get(s.id);
      this._edReveal.delete(s.id);
      if(t.revealPath) t.revealPath(want);
    }
    // FR-EDT-78: 창 활성화가 즉시 갱신의 계기 하나다. 여기가 그 사실을 아는
    // 유일한 자리다 — 마운트는 활성 창에만 일어난다. 관측이 공유되므로 어느
    // 칸에서 부르든 요청은 한 벌이고, 결과는 모든 칸에 칠해진다 (FR-SVS-22).
    // FR-FSL-7 과 같은 짝: 활성화는 색과 목록 **둘 다**의 계기다. 색만 새로
    // 받으면 사용자는 창을 바꾸자마자 "색은 맞는데 목록은 옛것" 을 본다.
    // FR-DIR-32: 활성화는 사용자가 방금 한 일이다 — 백오프를 넘겨 곧바로 묻는다.
    if(this._edLastActive!==s.id){this._edLastActive=s.id;t.pollGit({now:true});t.pollStamp()}
    return t;
  },

  // FR-EDT-76: 폴링의 대상은 **활성 Editor 창 하나**다. 비활성 창의 트리는 살아
  // 있어도 git 을 부르지 않는다 (FR-GIT-24 와 같은 근거).
  /**
   * FR-SVS-21: 그 창의 탐색기 중 **포커스 칸의 것**. 펼침·드러내기는 시선이므로
   * 사용자가 있는 칸에만 일어난다 — 다른 칸의 펼침을 앱이 임의로 바꾸지 않는다.
   */
  _edTreeFor(w){
    if(!w||!this._edTrees) return null;
    return this._edTrees.get(this.slotKey(w.id,this.slotFocused()))
      ||this._edTrees.get(w.id)||null;
  },

  // 관측이 루트마다 하나이므로 **어느 칸의 뷰를 통해 불러도** 요청은 한 벌이고
  // 결과는 모든 칸에 칠해진다 (FR-SVS-20·22). 포커스 칸의 것을 고르고, 없으면
  // 그 창을 보는 아무 칸의 것을 쓴다.
  edActiveTree(){
    const s=this.aw();
    if(!this.isEditorWin(s)||!this._edTrees) return null;
    // FR-RTU-12·14: 사이드가 `Changes` 면 탐색기는 화면에 없다 — `_edVisibleTrees`
    // 와 같은 게이트다. 이 자리가 빠지면 즉시 신호(`gitSignal`)마다 보이지도
    // 않는 트리의 status 가 한 건 더 나가 디바운스가 무의미해진다 (V5 실측).
    if(this.edSideOf(s)!==REPO_SIDE_EXPLORER) return null;
    const mine=this._edTrees.get(this.slotKey(s.id,this.slotFocused()));
    if(mine) return mine;
    for(const[key,t] of this._edTrees) if(this.slotBase(key)===s.id) return t;
    return null;
  },

  /**
   * SLOT_VIEW_STATE_SRS FR-SVS-39b: **화면에 있는 탐색기 전부.**
   *
   * `edActiveTree` 는 활성 창의 것 하나를 준다. 그것으로 폴링하면 칸 둘에 Editor
   * 창을 놓았을 때 서 있지 않은 쪽이 멎는다 — Git 쪽과 같은 결함이며 같은 근거로
   * 고친다 (FR-SVS-36).
   *
   * 요청이 늘지 않는 이유는 관측이 **루트마다** 하나이고 캐시 TTL·single-flight 가
   * 그 위에 있기 때문이다 (FR-EDT-77) — 두 칸이 같은 루트를 보아도 git 실행은
   * 한 번이다.
   */
  /**
   * `12-func-ui.md FUI-11`: 그 루트를 보는 **다른 탐색기**에게 다시 읽으라고 한다.
   *
   * 루트를 건너는 이동에서 출발 트리는 남의 인스턴스다 — 옮긴 트리의 `_after`
   * 로는 닿지 않고, 닿지 않으면 그쪽 화면에 **없는 파일이 남는다.**
   *
   * 같은 루트를 보는 트리가 여럿일 수 있다 (칸마다 하나, FR-SVS-42) — 전부 돈다.
   * 화면에 없는 트리도 돈다: 돌아왔을 때 낡아 있으면 안 되고, `load` 는 그
   * 트리가 이미 그 폴더를 펼쳐 두었을 때만 요청을 낸다.
   */
  edRefreshTreesFor(root,dir){
    if(!this._edTrees||!root||!dir) return;
    for(const t of this._edTrees.values()){
      if(!t||t.root!==root) continue;
      t.load(dir);
    }
  },

  _edVisibleTrees(){
    if(!this._edTrees) return [];
    const out=[];
    for(const [key,t] of this._edTrees){
      if(!t) continue;
      const id=this.slotBase(key);
      if(!this.windowVisible(id)) continue;
      /**
       * REPO_TAB_UNIFY_SRS FR-RTU-12·14: **사이드가 Explorer 일 때만** 묻는다.
       *
       * 창이 보이는 것과 탐색기가 보이는 것이 이제 다르다 — 사이드는 탭 교체이고
       * `Changes` 쪽에 있으면 트리는 화면에 없다. 트리 객체는 그때도 살아 있으므로
       * (돌아왔을 때 펼침·스크롤이 남아야 한다, FR-EDT-66) 목록에서만 뺀다.
       *
       * 실측: 이 게이트가 없으면 `Changes` 사이드에서도 3초마다 status·stamp 가
       * 나가 "폴링을 껐는데 status 가 온다" 가 됐다 (V18).
       */
      const w=this.ws.windows.find(x=>x&&x.id===id);
      if(this.isEditorWin(w)&&this.edSideOf(w)!==REPO_SIDE_EXPLORER) continue;
      out.push(t);
    }
    return out;
  },
});
