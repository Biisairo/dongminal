/**
 * Dongminal — 렌더러의 가장자리: 사이드바·탑바·창의 사이드 (`Renderer.prototype` 증강)
 *
 * `renderer.js` 에서 **구간 이동**했다 (STRUCTURE_CLEANUP_SRS FR-STR-44).
 *
 * 본문이 아닌 것들이다 — 사이드바 탭(GIT_SIDEBAR_TABS_SRS FR-SBT-1·14) · 목록 ·
 * 창 이름(FR-STB-6) · 탑바 · Repo 창의 사이드와 그 손잡이(FR-RTU-11·12).
 * 칸과 pane 은 각각 `renderer-layout.js`·`renderer-pane.js` 다.
 *
 * 로드 순서: `renderer.js` **뒤**.
 */

Object.assign(Renderer.prototype, {

  /**
   * GIT_SIDEBAR_TABS_SRS FR-SBT-1·14: 사이드바 탭 바.
   *
   * 그리기 전에 **활성 창 → 탭**을 맞춘다 (FR-SBT-14). 반대 방향(탭 → 창)은
   * `SidebarTabs.setTab` 이 하며, 재진입 가드가 둘이 서로를 부르는 순환을 끊는다
   * (§3.9.2, V-SBT-10).
   */
  _rSbTabs(){
    this.app.sbSyncTabToWindow();
    SidebarTabs.paint(this.app);
  },

  /**
   * FR-RPT-3: 목록을 비우고 다시 만들지 않는다.
   *
   * `render()` 는 사용자 행동뿐 아니라 **SSE `workspace_changed`** 로도 불린다 —
   * 다른 브라우저나 다른 에이전트의 `dmctl` 이 워크스페이스를 고치면 사용자가
   * 아무것도 하지 않았는데 이 목록이 다시 만들어진다. 그러면 hover 로만 보이는
   * `×` 가 사라지고, 이름변경 더블클릭의 두 번째 클릭이 새 요소에 떨어지고,
   * 끌고 있던 창이 DOM 에서 빠져 재배치가 조용히 실패한다.
   */
  /**
   * EDITOR_TAB_SRS FR-EDT-4 / D-12: 목록 렌더는 **서술자 배열의 순회**다.
   *
   * 지금까지 탭 id 문자열이 두 번 하드코딩돼 있었고(§2.1), 셋째 탭이 목록을
   * 가지는 순간 걸렸다. 하드코딩으로 셋째를 더하면 넷째에서 같은 일이 반복되므로
   * 여기서 파생시킨다 — `list` 를 가진 서술자 전부를 그린다.
   */
  _rLists(){
    for(const d of SB_TAB_DEFS) if(d.list) SidebarList.paint(this.app,d);
  },

  // UX_REVISION_SRS FR-BLP-1: 두 이름이 남아 있는 이유는 호출처(SSE·알람·git 폴링)가
  // 이름으로 부르기 때문이다 — 그 배선을 바꾸는 것은 이 SRS 의 일이 아니다.
  // reconcile 이므로 값이 그대로면 DOM 은 손대지 않는다 (FR-RPT-3).
  _rSidebar(){ this._rLists() },
  // 리포 목록이 바뀌면 상단 이름의 근거도 바뀐다 — Git 창의 이름은 그 목록에서
  // 온다(`_rWinName`). 창이 먼저 뜨고 목록이 나중에 오는 순서가 흔하다.
  _rGitSection(){ this._rLists(); this._rTopbar() },

  /**
   * 상단에 적히는 창 이름.
   *
   * Window·Editor 는 창 자체가 대상이라 저장된 이름이 곧 목록의 이름이다. Git 만
   * 파생이다 — 창은 하나인데 리포를 갈아타므로, 저장된 이름(`Git`)은 지금 무엇을
   * 보고 있는지 말해 주지 않는다. 나머지 둘은 상단만 봐도 어느 것인지 아는데 Git
   * 만 그러지 못했다.
   *
   * 이름의 출처는 **사이드바 목록과 같은 자리**다 (`gitRepos.pinned` 의 `name`).
   * 여기서 경로를 따로 잘라 쓰면 목록과 상단이 같은 리포를 다른 이름으로 부를 수
   * 있다. 목록이 아직 오지 않았을 때만 경로의 마지막 조각으로 대신한다.
   */
  _rWinName(w){
    const app=this.app;
    if(!w) return '';
    if(!app.isGitWin(w)) return w.name||'';
    const repo=(w.git&&w.git.repo)||'';
    if(!repo) return w.name||'';
    const pinned=((app.gitRepos||{}).pinned)||[];
    const hit=pinned.find(e=>e&&e.path===repo);
    return (hit&&hit.name)||app.edBase(repo)||w.name||'';
  },

  /**
   * 창의 표시 제목 — `<타입 라벨> · <창 이름>` (FR-STB-1).
   *
   * **조립하는 자리는 여기 하나다** (FR-STB-4). 토프바와 슬롯 머리글이 각자
   * 만들던 동안 Git 창은 두 자리에서 다른 이름으로 불렸다 — 토프바는 리포명,
   * 머리글은 저장된 `Git`. 형식을 바꾸는 이번에도 자리를 둘로 남기면 같은 결함이
   * 다시 자란다.
   *
   * 이름이 라벨과 같으면 겹쳐 적지 않는다 (`Git · Git` 이 되지 않도록).
   */
  _rWinTitle(w){
    if(!w) return '';
    const label=SidebarTabs.labelForWindow(this.app,w);
    const name=this._rWinName(w);
    if(!label) return name;                 // FR-STB-6: 모르는 타입이면 이름만
    if(!name||name===label) return label;
    return label+' · '+name;
  },

  _rTopbar(){
    const a=this.app.aw();
    // FR-STB-11·12: 칸이 하나면 토프바가 제목을 낸다. 칸이 여럿이면 머리글이 그
    // 자리를 이어받으므로 토프바는 **비운다** — 되풀이하면 그 값이 어느 칸의
    // 것인지 사용자가 매번 판정해야 한다 (D-1). 모바일에는 칸이 없다 (FR-STB-14).
    const multi=!this.app.isMobile&&this.app.slotCount()>1;
    document.getElementById('window-name').textContent=multi?'':this._rWinTitle(a);
    // FR-GIT-180 · FR-EDT-50 (**UIUX_OVERHAUL_SRS FR-CHR-3 으로 개정**): Git·
    // Editor 창에서는 분할 진입점을 **비활성으로 둔다.** 종전에는 감췄다 —
    // 그러면 이웃이 왼쪽으로 밀려 같은 픽셀에 다른 동작이 온다 (§2.4).
    //
    //   이전 동작: `hidden` — Git·Editor 창에서 자리가 사라진다
    //   새  동작: `disabled` — 자리를 지키고 쓸 수 없다고만 말한다
    //   이유:     **가르는 것은 모드가 아니라 컨트롤이다** (사용자 결정
    //             2026-09-21). 쪼개는 동작(분할·슬롯 `±`)은 어느 창에서나 같은
    //             자리에 있고, 탭 `+` 는 만들 **대상 자체가 없어** 사라진다
    //
    // 단축키 경로는 이것과 무관하게 막힌다 — `_splitInner` 가 `isGitWin`·
    // `isEditorWin` 에서 되돌아간다 (V70·E6 의 뒷문장).
    const isGit=this.app.isGitWin(a);
    const noSplit=isGit||this.app.isEditorWin(a);
    for(const id of ['split-h','split-v']){
      const b=document.getElementById(id);
      if(b) b.disabled=noSplit;
    }
    // FR-EDT-54: Editor 창에는 편집기 탭만 있다 — 새 탭 버튼의 **대상이 없다.**
    // 그래서 이쪽만 종전대로 감춘다 (데스크톱의 `.pn-tab-add` 는 아예 서지
    // 않는다 — `_makeTabAdd` 를 부르지 않는다).
    const mAdd=document.getElementById('m-add-tab');
    if(mAdd) mAdd.hidden=noSplit;
    const ind=document.getElementById('m-pane-indicator');
    if(ind){
      const n=this.app.mobilePaneCount();
      if(n<=0){ind.textContent='0/0'}
      else{
        if(this.app.mPaneIdx>=n) this.app.mPaneIdx=n-1;
        if(this.app.mPaneIdx<0) this.app.mPaneIdx=0;
        ind.textContent=`${this.app.mPaneIdx+1}/${n}`;
      }
    }
    const dt=document.getElementById('m-drawer-toggle');
    // UI_KIT_SRS FR-GLY-4: 글자가 아니라 아이콘이므로 `textContent` 로 바꿀 수
    // 없다 — 그 대입은 `<svg>` 를 지운다.
    if(dt) dt.replaceChildren(UIKit.icon(this.app.drawerOpen?'x':'menu'));
    // FR-WSL-50·62: 칸 더하기·빼기. 모바일에는 칸을 만드는 길이 없다.
    // 한계에 닿은 버튼은 비활성이다 — 눌리지만 아무 일도 하지 않는 버튼은
    // 고장으로 읽힌다 (FR-GIT-180 이 세운 규약).
    const n=this.app.slotCount();
    const sa=document.getElementById('slot-add');
    if(sa){
      sa.hidden=this.app.isMobile;
      sa.disabled=n>=SLOT_MAX;
    }
    const sr=document.getElementById('slot-remove');
    if(sr){
      sr.hidden=this.app.isMobile;
      sr.disabled=n<=1;
    }
    // SLOT_MARKER_SRS FR-SMK-1·2: 마커는 `#window-name` 이 비는 그 자리에 선다 —
    // 조건이 위 `multi` 와 **같은 식**이다.
    this._rSlotMarker(n);
  },

  /**
   * SLOT_MARKER_SRS FR-SMK-1~13: 칸 마커.
   *
   * 답하는 물음은 하나다 — **"지금 어느 칸이 포커스인가"**. 사이드바에서 창을
   * 여는 모든 경로가 포커스 칸으로 가므로(WINDOW_SLOTS_SRS FR-WSL-54), 그 답이
   * 곧 **"누르면 어디가 열리는가"** 다 (SRS §1.1).
   *
   * **칸을 재지 창을 재지 않는다** (FR-SMK-8). 창의 이름·유무·타입은 칸 머리글이
   * 말한다 (FR-STB-12) — 마커가 그것을 되풀이하면 같은 값을 두 자리가 말하게 되고,
   * 사용자는 그것이 어느 칸의 것인지 매번 판정해야 한다 (D-STB-1 과 같은 이유).
   *
   * 가로 균등이다 (FR-SMK-4·5). `slotDir`·`sizes` 를 **읽지 않는다** — 축소판은
   * 상단바 높이(32px)가 세로 분할을 담지 못해 기각됐다 (D-2).
   *
   * 사각형은 **칸 수가 바뀔 때만** 다시 만든다. 매 render 마다 갈아치우면
   * mousedown↔mouseup 사이에 요소가 사라져 `click` 이 아예 만들어지지 않는다
   * (`_rSide` 머리말의 `GP-6`).
   */
  _rSlotMarker(n){
    const box=document.getElementById('slot-marker');
    if(!box) return;
    const show=!this.app.isMobile&&n>1;               // FR-SMK-2
    box.hidden=!show;
    if(!show){ box.replaceChildren(); return }
    if(box.childElementCount!==n){
      const cells=[];
      for(let i=0;i<n;i++){
        const b=document.createElement('button');
        b.className='slot-marker-cell ui-btn';        // FR-SMK-12 — 킷 등급
        b.type='button';
        b.dataset.slot=String(i);                     // FR-SMK-3
        b.addEventListener('click',()=>this.app.slotFocusTo(i));   // FR-SMK-10·11
        cells.push(b);
      }
      box.replaceChildren(...cells);
    }
    const f=this.app.slotFocused();
    for(let i=0;i<n;i++){
      const b=box.children[i];
      // FR-SMK-13: 이름은 **낱말 키로 먼저 선다.** 단축키 표를 기다리면
      // `if(d.i18nShortcut && !sc) continue` 에 걸려 이름 없이 남는다.
      b.setAttribute('aria-label',t('html.slot_marker_cell',{n:i+1}));
      // FR-SMK-6: 채움을 나르는 것은 이것 **하나**다 (D-7) — 클래스와 ARIA 둘에
      // 적으면 둘이 어긋날 수 있고, 어긋나면 보이는 것과 읽히는 것이 갈린다.
      if(i===f) b.setAttribute('aria-current','true');
      else b.removeAttribute('aria-current');
    }
  },

  /**
   * FR-RTU-11·12: 사이드의 골격 — 탭 바와 그 본문.
   *
   * **내용을 소유하지 않는다.** 탐색기는 `FileTree` 가, Changes 는 `GitPanel` 이
   * 자기 DOM 을 들고 있고 여기서는 붙이기만 한다.
   *
   * GIT_REFRESH_LIFECYCLE_SRS FR-GRF-13~16 (`GP-6`): **골격도 재사용한다.**
   *
   *   이전 동작: 매 render 마다 `.ed-side`·`.ed-side-tabs`·`.ed-side-body`·
   *             탭 버튼·진입점 여섯을 **새로 만들었다**. 캐시된 `.git-view` 는
   *             살아남지만 **다른 부모로 옮겨졌다** = 문서에서 떼었다 붙인다
   *   새  동작: `_keep` 으로 골격을 재사용하고 라벨·활성 클래스만 갱신한다
   *   이유:     옮기는 순간 값으로 되살릴 수 없는 것이 사라진다 — 커밋 메시지
   *             `textarea` 의 **커서**, 글자 선택, `:hover`, 진행 중 드래그.
   *             그리고 버튼은 요소 자체가 교체되므로 mousedown↔mouseup 사이에
   *             render 가 끼면 `click` 이 **아예 만들어지지 않는다**
   *             (`11 GP-6`; 대비가 스크롤 하나뿐이었다)
   *
   * 이 함수가 "종전대로 매번 세운다" 로 남아 있던 근거(`PANE_DOM_RECONCILE_SRS`
   * 의 "사이드 안쪽은 범위 밖")는 그 SRS 의 범위 선언이지 설계 판단이 아니었다.
   */
  _rSide(s){
    const app=this.app, slot=this._rSlot||0;
    const key='edwin:'+slot+':'+((s&&s.id)||'')+'/side';
    const el=this._keep(key,()=>{
      const e=document.createElement('div'); e.className='ed-side'; return e;
    });
    const active=app.edSideOf(s);
    const bar=this._keep(key+'/tabs',()=>{
      const b=document.createElement('div'); b.className='ed-side-tabs';
      // FR-PDR-7: 배선은 한 번. 탭 목록은 고정이므로 버튼도 한 번 만든다.
      for(const d of REPO_SIDE_TABS){
        const t=document.createElement('button');
        t.className='ui-tab ed-side-tab';
        t.dataset.side=d.id; t.textContent=d.label;
        if(d.title) t.title=d.title;
        // `s` 를 가두지 않는다 — 이 골격은 창 id 로 키를 갖지만 그 객체는
        // 채택마다 새로 온다. 지금 그 id 의 창을 찾아 넘긴다.
        t.addEventListener('click',()=>{
          const w=app.ws.windows.find(x=>x&&x.id===((s&&s.id)||''));
          app.edSetSide(w||s,d.id);
        });
        b.appendChild(t);
      }
      return b;
    });
    // FR-M9-22: 설 수 없는 탭은 **숨긴다** — 없앴다 만들면 그 위의 손이 클릭을
    // 잃는다 (FR-GRF-14, 새로고침 버튼과 같은 처리다).
    const allowed=new Set(app.edSideTabs(s).map(d=>d.id));
    for(const t of bar.children)
      if(t.dataset&&t.dataset.side){
        t.hidden=!allowed.has(t.dataset.side);
        t.classList.toggle('active',t.dataset.side===active);
      }
    /**
     * GIT_CHANGES_CONTROLS_SRS FR-GCC-10 / D-7·D-8: 새로고침은 **창의 최상단**,
     * 탭 줄의 오른쪽 여백에 선다.
     *
     * 종전 자리는 브랜치 줄 안이었고, 목록을 다시 읽고 싶은 손이 세 번째 줄까지
     * 내려가야 했다. 진입점 줄에 넣어 봤더니 그쪽은 여섯 칸이 폭을 나눠 갖는
     * 자리라 일곱 번째가 **다음 줄로 밀렸다**(실측) — 탭 줄은 탭 둘뿐이라 오른쪽이
     * 비어 있고, 최상단이라는 뜻에도 그쪽이 더 맞는다.
     *
     * `Changes` 탭에서만 **보인다**: 새로고침하는 대상이 git 이고, Explorer 에서는
     * 그 자리가 뜻을 잃는다 (FR-RTU-22 와 같은 근거). 요소는 재사용하고 숨김만
     * 갈아 끼운다 (FR-GRF-14) — 버튼을 없앴다 만들면 그 위의 손이 클릭을 잃는다.
     */
    const rf=this._keep(key+'/refresh',()=>{
      const b=document.createElement('button');
      b.className='ui-btn ui-btn-icon ui-btn-lg ui-btn-ghost ed-side-refresh git-head-refresh';
      // 요구 ③/⑤: 글자가 아니라 아이콘이다. 크기는 `.ui-icon` 이 정한다.
      b.appendChild(UIKit.icon(GIT_REFRESH_LABEL)); b.title=GIT_REFRESH_TITLE;
      b.addEventListener('click',()=>app.gitPanelAt(app.edRootOf(s),slot).refresh());
      return b;
    });
    rf.hidden=active!==REPO_SIDE_CHANGES;
    this._place(bar,[...[...bar.children].filter(c=>c!==rf),rf]);
    const body=this._keep(key+'/body',()=>{
      const b=document.createElement('div'); b.className='ed-side-body'; return b;
    });
    const kids=[bar];
    if(active===REPO_SIDE_CHANGES){
      // FR-RTU-32: Changes 는 **사이드에만** 있다. 본문 탭이 되지 않으므로 그
      // 뷰의 DOM 을 여기로 가져온다 — 뷰를 만드는 자리는 패널 하나다.
      const p=app.gitPanelAt(app.edRootOf(s),slot);
      // FR-RTU-21·22: 나머지 여섯으로 가는 진입점. **Changes 탭에만** 둔다 —
      // Explorer 에서는 git 의 자리가 아니고, 파일 작업 중에 보일 이유가 없다.
      kids.push(this._rSideActions(key,app.edRootOf(s),slot));
      const view=p.elFor(REPO_SIDE_CHANGES);
      view.classList.add('vis');
      // FR-GRF-15: `_place` 는 이미 그 자리에 있으면 손대지 않는다. `appendChild`
      // 로 다시 붙이면 같은 부모라도 떼었다 붙이는 것이다.
      this._place(body,[view]);
    }else{
      this._place(body,[app.edTree(s,slot).mount()]);
    }
    kids.push(body);
    this._place(el,kids);
    return el;
  },

  /**
   * FR-RTU-21: 진입점 여섯. 누르면 본문에 그 뷰의 탭이 열리고, 이미 있으면 그
   * 탭으로 옮긴다 — 판정은 `openView` 한 자리다 (FR-RTU-31).
   *
   * FR-GRF-14: **요소를 재사용한다.** 여섯 개가 매 render 마다 교체되던 것이
   * `GP-6` 이 적은 "mousedown↔mouseup 사이에 render 가 끼면 click 이 아예
   * 만들어지지 않는다" 의 자리다.
   */
  _rSideActions(key,root,slot){
    const bar=this._keep(key+'/acts',()=>{
      const b=document.createElement('div'); b.className='ed-side-acts';
      for(const a of GIT_SIDE_ACTIONS){
        // FR-GLY-4·6 / FR-UIK-10: 스프라이트로 바꾸되 기존 클래스는 그대로 둔다.
        const x=document.createElement('button');
        x.className='ui-btn ui-btn-icon ui-btn-ghost ui-btn-lg ed-side-act'; x.dataset.view=a.key;
        x.appendChild(UIKit.icon(a.icon));
        x.title=a.title; x.setAttribute('aria-label',a.title);
        // 패널 **인스턴스**는 캡처하지 않는다 — 창이 사라졌다 서면 다시 만들어지고,
        // 그러면 이 버튼이 죽은 패널에 뷰를 연다. 루트와 칸만 들고 그때 조회한다
        // (`_makeSlot` 이 인덱스를 드는 것과 같은 규약).
        x.addEventListener('click',()=>this.app.gitPanelAt(root,slot).openView(a.key));
        b.appendChild(x);
      }
      return b;
    });
    return bar;
  },

  /**
   * FR-RSW-3: 폭은 워크스페이스 하나에 저장한다 — `sidebarWidth` 와 같은 규약이다
   * (§2.10). 드래그 중에는 화면만 바꾸고 확정은 mouseup 한 번이다.
   *
   * 끄는 동안 **보이는 사이드 전부**를 함께 움직인다 (D-5). 칸 둘이 나란히 Repo
   * 창을 보일 때 하나만 따라오면 확정 전까지 둘이 어긋나 보인다. 다시 그리지
   * 않는 이유는 `_rLayout` 이 매 render 마다 `.ed-win` 을 새로 만들기 때문이다 —
   * 드래그마다 트리와 편집기를 재조립할 이유가 없다 (NFR-RSW-1).
   */
  _rEdHandle(h){
    const clamp=w=>Math.max(REPO_SIDE_W_MIN,Math.min(REPO_SIDE_W_MAX,w));
    // FR-PDR-8: 핸들은 재사용되고 사이드는 매 그리기마다 새로 선다. 그때의 것을
    // **그때 찾는다** — 클로저로 잡으면 첫 그리기의 사이드를 영영 잰다.
    const ex=()=>h.previousElementSibling;
    // FR-HSZ-5: 양쪽 다 터미널이 아니다 — 사이드(탐색기·Changes)와 편집기이므로
    // `C×R` 줄이 붙지 않는다.
    UIKit.drag(h,{
      axis:'x',
      start:()=>({start:ex().offsetWidth,win:h.closest('.ed-win')}),
      move:(ctx,ev)=>{
        const w=clamp(ctx.start+(ev.clientX-ctx.sx0))+'px';
        for(const el of document.querySelectorAll('.ed-win>.ed-side')) el.style.width=w;
      },
      sides:(ctx)=>{
        const sw=ex().offsetWidth;
        const tot=ctx.win?ctx.win.offsetWidth:sw;
        return [
          {px:sw,pct:tot?sw/tot*100:null},
          {px:Math.max(0,tot-sw),pct:tot?(tot-sw)/tot*100:null},
        ];
      },
      end:(ctx,ev)=>{
        this.app.edSetSideWidth(clamp(ctx.start+(ev.clientX-ctx.sx0)));
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      },
    });
  },
});
