/**
 * Dongminal — 렌더러의 노드·pane·탭 (`Renderer.prototype` 증강)
 *
 * `renderer.js` 에서 **구간 이동**했다 (STRUCTURE_CLEANUP_SRS FR-STR-44).
 *
 * 레이아웃 트리를 실제 DOM 으로 옮기는 자리다 — 노드(FR-PDR-5) · pane · 탭 ·
 * 탭 조립 · 분할과 그 손잡이.
 *
 * 로드 순서: `renderer.js` **뒤**.
 */

Object.assign(Renderer.prototype, {

  // FR-PDR-5: `path` 는 트리에서의 자리다. split 에는 id 가 없고, SSE 로 다시
  // 받은 layout 은 객체 동일성도 끊긴다 — 자리와 모양(방향·자식 수)이 그것을
  // 대신하는 키다 (D-5).
  _buildNode(n,path){
    if(!n) return null;
    if(n.type==='pane') return this._buildPane(n,path);
    if(n.type==='split'&&n.children) return this._buildSp(n,path);
    return null;
  },

  // 탭 하나가 탭 바에 **보이는 이름**이다. 단일 자리인 이유는 CONVENIENCE_SRS
  // FR-TAN-17 이다 — 전경 프로세스에서 파생한 이름이 붙을 때, 탭 바와 사이드바와
  // dmctl list-workspace 가 서로 다른 것을 말하면 안 된다.
  //
  // 판정과 파생은 `tabName` 한 곳에 있다 (helpers.js) — dmctl 이 같은 규칙을
  // Go 로 다시 쓰므로, 브라우저 안에서만이라도 자리가 둘이면 안 된다.
  _tabDisplayName(tab){
    // FR-DRV-11: 렌더 탭임을 알리는 표시. **여기서 붙인다** — `tabName` 은 dmctl 이
    // 같은 규칙을 Go 로 다시 쓰는 자리이며(helpers.js), 그쪽이 모르는 표시를 그
    // 함수에 넣으면 두 구현이 어긋난다.
    // REPO_FIX 03 §3A-7: ● 는 매 렌더 **파생**이다 — 탭 레코드에 두지 않는다.
    return (this.app.tabDirty(this._rWin,tab)?'● ':'')+(tab.render?DOC_RENDER_TAB_MARK:'')+tabName(tab,this.app.fgNames);
  },

  // 활성 탭의 **본문**을 pane body 에 붙인다. 타입별로 실체가 다르다 — git 은
  // 싱글턴 패널의 view DOM, editor 는 FileEditor 인스턴스, terminal 은 PTY 를 든
  // Tool 의 DOM 이다.
  //
  // 분기를 함수로 뽑아 둔 이유는 ORCHESTRATION_V2_SRS FR-RVZ-6 의 네 번째 타입
  // ('run' — Run 대시보드)이 여기 들어오기 때문이다. 병렬 중 이 파일을 여럿이
  // 만지지 않도록 자리를 미리 갈라 둔다 (PARALLEL_DELIVERY_PLAN Step 0-4).
  // `slot` 은 지금 그리는 슬롯이다 (`_rSlot`). 도구·편집기 인스턴스는 슬롯마다
  // 서므로 (FR-WSL-20·23), 붙일 실체를 고를 때 그것을 딛는다.
  _mountTabBody(body,at){
    const slot=this._rSlot||0;
    let el=null,term=null;
    if(!at){
      this._hideOthers(body,null);
      return;
    }
    if(at.type===TAB_TYPE_GIT){
      // 패널은 **(루트, 칸)마다** 있다 (FR-SVS-40·42 + FR-RTU-60). 루트는 **이 탭이
      // 있는 창**의 것이다 — 그리는 중인 창이 활성 창이 아닐 수 있다(슬롯).
      const root=this.app.isEditorWin(this._rWin)?this.app.edRootOf(this._rWin):'';
      el=this.app.gitPanelAt(root,slot).elFor(at.gitView);
    }else if(at.type==='editor'){
      const key=this.app.slotKey(at.id,slot);
      let editor=this.app.fileEditors.get(key);
      // DOC_RENDER_VIEW_SRS D-1: 타입은 하나이고 **실체가 둘**이다.
      if(!editor){
        editor=at.render
          ? new DocRender(at.id,at.name,at.filePath)
          : new FileEditor(at.id,at.name,at.filePath);
        this.app.fileEditors.set(key,editor);
      }
      el=editor.el;
    }else if(at.type==='run'){
      // FR-RVZ-6: 네 번째 타입. 루트 DOM 은 탭마다 캐시된다 (NFR-RVZ-2).
      el=this.app.runViewEl(at,slot);
    }else{
      // 슬롯 1 의 인스턴스는 그 슬롯이 처음 이 도구를 그릴 때 선다 (FR-WSL-20).
      const p=at.toolId?this.app.mkTool(at.toolId,at.name||'',slot):null;
      if(p){ el=p.el; term=p }
    }
    if(!el) { this._hideOthers(body,null); return }
    let moved=false;
    if(el.parentNode!==body){
      // FR-PDR-10: **여기가 유일한 이동이다.** 그리고 이동한 것만 사후 처리를
      // 받는다 — 자리를 지킨 위젯에는 어떤 스크롤 API 도 닿지 않는다.
      // FR-M9-28: **떼기 전에** 잰 것을 쓴다. 여기서 읽으면 이미 떨어진 뒤다.
      if(term) this._moved.push(this._termScrollOf(term));
      body.appendChild(el);
      moved=true;
    }
    el.classList.add('vis');
    // FR-VSR-3: 편집기 탭의 시선은 **붙은 뒤에** 되돌린다. 이동하지 않은 경로에서는
    // 부르지 않는다 — 화면을 만지는 쪽의 조건은 좁아야 한다 (FR-PDR-10 의 규약).
    if(moved&&at.type==='editor'){
      const view=this.app.fileEditors.get(this.app.slotKey(at.id,slot));
      if(view&&view.restoreView) view.restoreView();
    }
    /**
     * FR-M11-17 (M11-B14): 에이전트 대화의 자리는 **여기서 되돌리지 않는다.**
     *
     *   이전 동작: 편집기 옆에서 곧바로 `restoreView()` 를 불렀다 — **이 시점의
     *              pane 은 아직 문서에 없다** (`_buildPane` 은 만들어 돌려줄 뿐이다).
     *              편집기는 Monaco 인스턴스가 값을 들고 있어 붙기 전에도 서지만,
     *              에이전트의 자리는 DOM `scrollTop` 이라 **조용히 무시된다**
     *              (실측 2026-09-15: 창을 오갈 때 `scrollHeight:0`·`clientHeight:0`
     *              에서 복원이 돌았고 결과가 0 이었다)
     *   새  동작: 되돌릴 것을 적어 두고 `_restoreScroll()` 이 비운다
     *   이유:     그 자리가 이미 *"요소가 문서에 붙은 뒤"* 의 자리다 (FR-SCR-2).
     *             **규약은 있었고 이 한 자리만 그 밖에 있었다**
     */
    this._mounted.add(el);
    this._hideOthers(body,el);
  },

  /**
   * FR-PDR-3: 이 자리에 남아 있는 **옛 탭의 위젯**을 거둔다.
   *
   * `vis` 만 걷고 자리에 두면 되돌아올 때 옮기지 않아도 되지만, 그 클래스로
   * 숨겨진다는 보장이 위젯마다 다르다 — Git 뷰는 자기 수명 관리(`panel-life`)가
   * 따로 `vis` 를 만지고, 종전에는 `.pn-body` 가 매번 새로 만들어져 옛 뷰가
   * 저절로 문서에서 떨어졌다. 그 전제를 없애자 숨지 않은 뷰가 **본문 위를 덮어
   * 클릭을 가로챘다** (e2e: `.git-view.git-submodules` 가 Branches 의 행을 가림).
   *
   * 그래서 종전과 같게 뗀다. 이 SRS 가 지키려는 것은 "탭이 그대로일 때 움직이지
   * 않는 것" 이고, 탭이 실제로 바뀌는 순간의 이동은 FR-PDR-10~12 가 받는다.
   *
   * 드롭 표시는 위젯이 아니라 이 자리의 장식이다 (`app-dnd` 가 만들어 다시 쓴다).
   */
  _hideOthers(body,keep){
    for(const c of [...body.children]){
      if(c===keep||c.classList.contains('pn-drop-indicator')||c.classList.contains('pn-dim-hint')) continue;
      c.classList.remove('vis');
      c.remove();
    }
  },

  _buildPane(n,path){
    const app=this.app;
    const slot=this._rSlot||0;
    // FR-PDR-2: 같은 pane 이 같은 칸에 다시 오면 그 요소를 그대로 쓴다. 같은 창이
    // 두 칸에 설 때 pane id 가 같으므로(FR-WSL-14) 칸이 키에 함께 든다.
    const key='pane:'+slot+':'+n.id;
    const el=this._keep(key,()=>this._makePane());
    // FR-PDR-8: 핸들러가 읽는 지금의 문맥. 재사용되는 요소에 값을 클로저로
    // 가두면 두 번째 그리기부터 낡은 pane·낡은 칸을 가리킨다.
    el._ctx={node:n,slot};
    el.dataset.paneid=n.id;
    // FR-SVS-1: 이 pane 이 **이 칸에서** 보이는 탭.
    const shown=app.paneTab(n,slot);
    // FR-WSL-35: 포커스로 그리는 것은 포커스 칸 하나다.
    const focused=n.id===app.focused&&slot===app.slotFocused();
    const at=(n.tabs||[]).find(t=>t.id===shown);
    el.classList.toggle('focused',focused);
    // FR-ATV-1: 알람 표식은 포커스 여부와 **무관하게** 그려진다. 여기 남아 있던
    // 옛 FR-PAN-9 의 포커스 예외가 `_attnRefresh` 의 토글을 다음 render() 마다
    // 도로 떼고 있었다 — 포커스 칸에서 뜬 알람의 링이 보이지 않던 자리다.
    // 두 표식은 서로 다른 픽셀에 앉으므로 겹쳐도 서로를 가리지 않는다 (FR-ATV-2).
    el.classList.toggle('attn',!!at&&!!app.attnHas(at.toolId));
    this._rTabs(el.firstChild,n,shown,key);
    this._mountTabBody(el.lastChild,at);
    return el;
  },

  /**
   * FR-PDR-4: 탭 바를 다시 짓지 않는다. 남은 탭은 그 요소 그대로 두고 라벨과
   * 클래스만 고치며, 사라진 것만 거두고 새것만 만든다.
   */
  _rTabs(tabs,n,shown,key){
    const app=this.app;
    const kids=[];
    for(const tab of(n.tabs||[])){
      const tkey=key+'/tab:'+tab.id;
      let t=this._keep(tkey,()=>this._makeTab());
      /**
       * 이름 변경은 라벨을 **input 으로 갈아 끼운다** (`renameTab` 의
       * `el.replaceWith(input)`). 그 경로는 확정 뒤의 다시 그리기가 DOM 을 새로
       * 만들어 그 자리를 되돌리는 것에 기대고 있었다 — 재사용하는 지금은 라벨이
       * 영영 돌아오지 않고, 그다음 갱신이 없는 요소를 만진다 (e2e: V-TAN-5·6,
       * `tab can be renamed via double-click`).
       *
       * 그 탭만 다시 만든다. 되돌릴 상태가 없는 요소이므로 값이 싸다.
       */
      if(!t.querySelector('.pn-tab-label')){
        this._dom.delete(tkey);
        t=this._keep(tkey,()=>this._makeTab());
      }
      t._ctx={tab};
      t.dataset.tabId=tab.id;
      if(tab.toolId) t.dataset.toolid=tab.toolId; else delete t.dataset.toolid;
      const isGit=tab.type===TAB_TYPE_GIT;
      if(isGit) t.dataset.gitView=tab.gitView; else delete t.dataset.gitView;
      // FR-ATV-1·3: 보고 있는 탭도 알람을 그린다. 활성 배경은 활성 색에 머물고
      // 밑줄만 맥박하므로(`.pn-tab.active.attn`) 알람이 활성 표시를 빼앗지 않는다.
      const active=tab.id===shown;
      const attn=app.attnHas(tab.toolId);
      // FR-RTU-41: 미리보기 탭은 기울임이다 — "이 자리는 곧 대체된다".
      t.className='pn-tab'+(active?' active':'')+(attn?' attn':'')+(isGit?' git':'')
        +(tab.preview?' '+REPO_PREVIEW_CLASS:'');
      // FR-A11Y-16: 선택은 클래스와 **같은 것**을 말한다 (TC-A11Y-6b).
      t.setAttribute('aria-selected',active?'true':'false');
      const name=this._tabDisplayName(tab);
      const lab=t.querySelector('.pn-tab-label');
      if(lab.textContent!==name) lab.textContent=name;
      // TAB_WIDTH_SRS FR-TBW-6 / D-5: **언제나** 붙인다 — 잘리지 않는 폭에서는
      // 보이지 않을 뿐이므로 해가 없다.
      t.title=tab.preview?REPO_PREVIEW_TITLE:name;
      kids.push(t);
    }
    // D-A11Y-11: 탭은 `tablist` 안에, 동작은 그 **밖**에 — tablist 의 자식은 tab
    // 뿐이어야 한다.
    const scroll=tabs.firstChild;
    const acts=tabs.lastChild;
    const list=scroll.firstChild;
    this._place(list,kids);
    const aw=app.aw();
    const closed=app.isGitWin(aw)||app.isEditorWin(aw);
    /**
     * UIUX_OVERHAUL_SRS FR-CHR-2·3: 고정 구. **가르는 것은 모드가 아니라
     * 컨트롤이다.**
     *
     *   `+`      FR-GIT-180·FR-EDT-54 — 닫힌 창에는 만들 **대상이 없다**. 사라진다
     *   분할 둘  FR-CHR-3 — 쪼개는 동작은 어느 창에서나 같은 자리다. `disabled`
     */
    const actKids=[];
    if(!closed) actKids.push(this._keep(key+'/add',()=>this._makeTabAdd()));
    for(const dir of ['horizontal','vertical']){
      const b=this._keep(key+'/split-'+dir,()=>this._makeSplitBtn(dir));
      b.disabled=closed;
      actKids.push(b);
    }
    // FR-CHR-10 (D-6): **`⋯` 는 없다.** 담고 있던 둘(칸 `±` · `Runs`)이 전역
    // 동작이라 상단바로 갔다 — 이 줄이 드는 것은 이 pane 에 관여하는 것뿐이다.
    this._place(acts,actKids);
    // `Tab` 에 닿는 탭은 하나다 — 포커스가 줄 안에 있으면 그 탭, 아니면 활성 탭.
    const ae=document.activeElement;
    UIKit.rove(kids,kids.includes(ae)?ae:kids.find(t=>t.classList.contains('active')));
    // UX-24: 탭이 늘거나 줄면 넘침을 다시 판정한다 (`_makePane` 의 표식).
    const pn=tabs.parentNode;
    if(pn&&pn._markTabOverflow) pn._markTabOverflow();
  },

  // 탭 요소 하나와 그 배선. **여기서만 배선한다** (FR-PDR-7) — 지금 어느 pane 의
  // 어느 탭인지는 `_ctx` 가 답한다 (FR-PDR-8).
  _makeTab(){
    const app=this.app;
    const t=document.createElement('div');
    // D-A11Y-10: `×` 는 포인터 전용 표식이다 — `tab` 안의 컨트롤은 접근성 트리에
    // 설 수 없다. 키보드는 탭에서 `Delete` 로 닫는다 (`_makePane` 의 roving).
    t.innerHTML='<span class="pn-tab-label"></span>'
      +'<span class="pn-tab-x" aria-hidden="true" title="'+TAB_CLOSE_TITLE+'">'+UIKit.iconHTML('x','ui-icon-sm')+'</span>';
    t.setAttribute('role','tab');
    t.tabIndex=-1;
    t.draggable=true;
    const ctx=()=>{
      const pn=t.closest('.pn');
      const c=(pn&&pn._ctx)||{};
      return {pane:c.node||null,slot:c.slot||0,tab:(t._ctx&&t._ctx.tab)||null};
    };
    const clearMarks=()=>{
      const bar=t.parentNode;
      if(bar) bar.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
    };
    t.addEventListener('click',e=>{
      e.stopPropagation();
      const c=ctx(); if(!c.pane||!c.tab) return;
      if(e.target.classList.contains('pn-tab-x')) app.closeTab(c.pane.id,c.tab.id,null,{slot:c.slot});
      else app.switchTab(c.pane.id,c.tab.id,c.slot);
    });
    /**
     * CONTEXT_MENU_UNIFY_SRS FR-CMU-8 (`FUI-08`): 탭의 컨텍스트 메뉴. 항목마다
     * 이미 있는 길을 부른다 — 더블클릭·`×`·`+` 와 같은 함수다. 못 하는 것은
     * 감추지 않고 사유를 든다 (FR-CMU-1).
     */
    t.addEventListener('contextmenu',e=>{
      const c=ctx(); if(!c.pane||!c.tab) return;
      e.preventDefault(); e.stopPropagation();
      const aw=app.aw();
      const noNew=app.isGitWin(aw)||app.isEditorWin(aw);
      const label=t.querySelector('.pn-tab-label');
      UIKit.menu([
        {id:'new',label:TAB_MENU_NEW,disabled:noNew?TAB_MENU_NEW_NO:false,onClick:()=>app.addTab(c.pane.id,'terminal')},
        {id:'rename',label:TAB_MENU_RENAME,disabled:c.tab.type===TAB_TYPE_GIT?TAB_MENU_RENAME_GIT_NO:false,
          onClick:()=>{if(c.tab.preview) app.pinPreviewTab(c.tab); if(label) app.renameTab(c.tab,label)}},
        {id:'close',label:TAB_MENU_CLOSE,onClick:()=>app.closeTab(c.pane.id,c.tab.id,null,{slot:c.slot})},
      ],{at:{x:e.clientX,y:e.clientY},cls:'tab-menu'});
    });
    // FR-RTU-42: 탭 자체의 더블클릭이 고정한다.
    t.addEventListener('dblclick',e=>{
      const c=ctx(); if(!c.tab||!c.tab.preview) return;
      e.stopPropagation();
      app.pinPreviewTab(c.tab);
    });
    // 탭은 `renameTab` 이다 — 창의 `rename` 과 달리 빈 문자열에 뜻이 있다
    // (FR-TAN-21). git 뷰 탭의 이름은 뷰에서 파생하므로 고쳐도 다음 그리기가
    // 되돌린다 — 그래서 그 타입에서는 아무 일도 하지 않는다 (FR-RTU-33).
    t.querySelector('.pn-tab-label').addEventListener('dblclick',e=>{
      const c=ctx(); if(!c.tab||c.tab.type===TAB_TYPE_GIT) return;
      e.stopPropagation();
      if(c.tab.preview){app.pinPreviewTab(c.tab);return}
      app.renameTab(c.tab,e.target);
    });
    t.addEventListener('dragstart',e=>{
      const c=ctx(); if(!c.pane||!c.tab) return;
      app.drag={type:'tab',srcPaneId:c.pane.id,tabId:c.tab.id};
      e.dataTransfer.effectAllowed='move';
      e.stopPropagation();
      TIMERS.defer(()=>t.classList.add('dragging'),{label:'drag-class'});
    });
    t.addEventListener('dragend',()=>{
      app.drag=null; t.classList.remove('dragging'); clearMarks();
      document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none');
    });
    t.addEventListener('dragover',e=>{
      if(!app.drag||app.drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      clearMarks();
      const rect=t.getBoundingClientRect();
      t.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');
      document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none');
    });
    t.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      if(!app.drag||app.drag.type!=='tab')return;
      const c=ctx(); if(!c.pane||!c.tab) return;
      const{srcPaneId,tabId}=app.drag;
      app.drag=null;
      clearMarks();
      const s=app.aw(); if(!s)return;
      const rect=t.getBoundingClientRect();
      const insBefore=e.clientX<rect.left+rect.width/2;
      if(srcPaneId===c.pane.id){
        const pn=findPane(s.layout,c.pane.id); if(!pn)return;
        const si=pn.tabs.findIndex(tt=>tt.id===tabId);
        const di=pn.tabs.findIndex(tt=>tt.id===c.tab.id);
        if(si<0||di<0||si===di)return;
        const[moved]=pn.tabs.splice(si,1);
        let ins=pn.tabs.findIndex(tt=>tt.id===c.tab.id);
        if(!insBefore)ins++;
        pn.tabs.splice(ins,0,moved);
        app.paneTabSet(pn,tabId,c.slot);
        app.save();
        app.render();
      }else{
        app.moveTabToPane(srcPaneId,tabId,c.pane.id,c.tab.id,insBefore);
      }
    });
    return t;
  },

  /**
   * UIUX_OVERHAUL_SRS FR-CHR-2: 탭줄의 분할 진입점.
   *
   * **상단바의 `Split H`·`Split V` 와 같은 동작을 부른다** — `app.split(dir)` 하나를
   * 지나므로 두 자리가 갈릴 수 없다. 단축키(`splitH`·`splitV`)도 같은 함수다.
   *
   * 아이콘은 방향을 그대로 말한다: 가로 분할은 칸이 **옆으로** 서므로 `columns`,
   * 세로 분할은 **위아래**로 서므로 `rows` 다 (`.sp[data-d="horizontal"]` 가
   * `flex-direction:row` 인 것과 같은 말이다).
   *
   * 툴팁은 카탈로그를 지나고 단축키 표기가 `{key}` 에 든다 (FR-B-7) —
   * `I18N.applyShortcuts(document)` 가 설정 변경 뒤에 이 요소도 다시 채운다.
   */
  _makeSplitBtn(dir){
    const app=this.app, h=dir==='horizontal';
    const b=document.createElement('button');
    b.className='ui-btn ui-btn-icon ui-btn-ghost pn-act pn-split';
    b.appendChild(UIKit.icon(h?'columns':'rows',{size:'sm'}));
    /**
     * **이름은 단축키를 기다리지 않는다.** `I18N.apply` 는 `data-i18n-shortcut` 이
     * 붙은 요소를 **단축키 표가 아직 없으면 통째로 건너뛴다**(`i18n.js` 의
     * `if(d.i18nShortcut&&!sc) continue`). 게다가 `apply(root)` 는 `root` 의
     * **자손만** 훑으므로 `I18N.apply(b)` 는 `b` 자신을 한 번도 채우지 않는다 —
     * 첫 화면에서는 뒤따르는 전역 `apply(document)` 가 가려 주지만, Git 창처럼
     * **나중에 서는 pane** 의 버튼은 이름 없이 남는다 (실측: `tooltips` C3·C4·
     * C7·C8·C9·C15 와 `ui-kit-icons` UIK5 가 그렇게 빨개졌다).
     *
     * 그래서 **이름은 지금 세우고**(단축키가 없는 낱말 키를 쓴다) 툴팁만 표가 온
     * 뒤에 채워지게 둔다. `applyShortcuts(document)` 가 설정 변경 때 이 요소도
     * 다시 채운다 (FR-B-7).
     */
    const sk=h?'splitH':'splitV';
    const kl=()=>displayKey((typeof shortcuts==='object'&&shortcuts[sk])||'');
    b.setAttribute('aria-label',t(h?'html.btn_split_h':'html.btn_split_v'));
    b.title=t(h?'html.split_h_title':'html.split_v_title',{key:kl()});
    b.dataset.i18nTitle=h?'html.split_h_title':'html.split_v_title';
    b.dataset.i18nShortcut=sk;
    b.addEventListener('click',e=>{
      e.stopPropagation();
      const pn=b.closest('.pn');
      const node=pn&&pn._ctx&&pn._ctx.node;
      // FR-EXR-42 와 같은 규약 — 자리는 활성 pane 이 아니라 **이 버튼이 속한
      // pane** 이다.
      app.split(dir,node?{targetPane:node.id}:{});
    });
    return b;
  },

  _makeTabAdd(){
    const app=this.app;
    const add=document.createElement('button'); add.className='ui-btn ui-btn-icon ui-btn-ghost pn-tab-add';
    add.appendChild(UIKit.icon('plus',{size:'sm'}));
    add.title=TAB_ADD_TITLE;
    add.addEventListener('click',e=>{
      e.stopPropagation();
      const pn=add.closest('.pn');
      if(pn&&pn._ctx&&pn._ctx.node) app.addTab(pn._ctx.node.id);
    });
    // M8_UNIFIED_SRS FR-AGT-1: `+` 의 컨텍스트 메뉴가 에이전트 탭을 낸다 — 클릭은
    // 종전대로 터미널이다. 목록은 등록부에서 파생한다 (FR-U-1).
    add.addEventListener('contextmenu',e=>{
      e.preventDefault(); e.stopPropagation();
      const pn=add.closest('.pn');
      if(!(pn&&pn._ctx&&pn._ctx.node)) return;
      const pid=pn._ctx.node.id;
      UIKit.menu([
        {id:'new',label:TAB_MENU_NEW,onClick:()=>app.addTab(pid,'terminal')},
      ],{at:{x:e.clientX,y:e.clientY},cls:'tab-menu'});
    });
    return add;
  },

  // pane 의 껍데기와 그 배선. 탭 바와 본문 상자는 이 요소의 수명 동안 같은
  // 것이며, 본문에 붙은 위젯이 움직이지 않는 것이 이 SRS 의 전부다.
  _makePane(){
    const app=this.app;
    const el=document.createElement('div');
    el.className='pn';
    /**
     * UIUX_OVERHAUL_SRS FR-CHR-2: **탭줄이 크롬이 된다.** 오른쪽 끝에 고정 구가
     * 서고, 그 구는 탭과 함께 스크롤하지 않는다.
     *
     *   .pn-tabs            줄 자신 — 포커스 표식(`box-shadow`)의 임자
     *     .pn-tabs-scroll   구르는 것은 **이쪽**이다. 넘침 표식·마스크도 여기
     *       .pn-tablist     탭만 담는다 (D-A11Y-11)
     *     .pn-acts          고정 구 — `+` · 분할 둘
     *
     * **마스크가 구조를 정했다.** `[data-overflow]` 의 `mask-image` 는 자손까지
     * 걸리므로 고정 구를 스크롤러 **안**에 `position:sticky` 로 두면 그것이
     * 흐려진다. 밖으로 내면 마스크는 탭에만 걸리고 구는 또렷하다.
     */
    const tabs=document.createElement('div'); tabs.className='pn-tabs';
    const scroll=document.createElement('div'); scroll.className='pn-tabs-scroll';
    const list=document.createElement('div'); list.className='pn-tablist';
    list.setAttribute('role','tablist');
    scroll.appendChild(list);
    const acts=document.createElement('div'); acts.className='pn-acts';
    tabs.appendChild(scroll); tabs.appendChild(acts);
    const body=document.createElement('div'); body.className='pn-body';
    // FR-B-6 (UX-11): 다른 화면이 쥔 칸의 안내. `.pn-dimmed` 일 때만 CSS 가 보인다.
    const dim=document.createElement('div'); dim.className='pn-dim-hint'; dim.textContent=CLICK_TO_FOCUS_HINT;
    body.appendChild(dim);
    el.appendChild(tabs); el.appendChild(body);
    const node=()=>(el._ctx&&el._ctx.node)||null;
    const slotOf=()=>(el._ctx&&el._ctx.slot)||0;
    /**
     * FR-A11Y-16 / D-A11Y-11·12: 키보드 계약은 `UIKit.roving` 이 갖는다. Enter 는
     * 탭의 클릭이고 Delete 는 `×` 의 클릭이다 — 두 길이 같은 함수를 지난다.
     * 활성이 아닌 탭을 고르면 포커스를 넘긴다 (마우스와 같다).
     */
    UIKit.roving(list,{
      horizontal:true,
      items:()=>[...list.querySelectorAll('.pn-tab')],
      activate:t=>{
        if(!t.classList.contains('active')) app.focusHandoff=true;
        t.click();
      },
      remove:t=>{const x=t.querySelector('.pn-tab-x');if(x)x.click()},
    });
    /**
     * FR-EXR-40~44: 탭 바의 **빈 여백** 더블클릭이 새 탭을 연다.
     *
     * FR-EXR-41: 탭에서 올라온 이벤트는 그 탭의 것이다 — `:914`(고정)·`:922`
     * (이름 변경)가 이미 쓰고 있고, 여백으로 읽으면 **이름을 고치려다 새 탭이
     * 열린다.**
     *
     * FR-EXR-42: 자리는 활성 pane 이 아니라 **이 여백이 속한 pane** 이다
     * (`addTabFocused` 는 `this.focused` 를 쓴다).
     *
     * FR-EXR-44: Editor·Git 창에서는 `addTab` 이 스스로 거절한다 — `+` 를 두지
     * 않는 조건과 같은 불변식이며(FR-GIT-179·FR-EDT-54) 여기 다시 적지 않는다.
     */
    scroll.addEventListener('dblclick',e=>{
      if(e.target.closest('.pn-tab'))return;
      const n=node(); if(!n)return;
      e.stopPropagation();
      app.addTab(n.id,'terminal');
    });
    /**
     * 로드맵 M7 `UX-24`: 탭이 넘치면 **그 사실이 보인다.** 스크롤바를 감춘 채
     * (`.pn-tabs::-webkit-scrollbar{height:0}`) 아무 표시가 없어 화면 밖의 탭을
     * 찾을 계기가 없었다. 넘친 쪽을 속성으로 적고 CSS 가 가장자리를 흐린다;
     * 세로 휠은 가로로 구른다 — 가로 휠이 없는 마우스가 대부분이다.
     */
    const markOverflow=()=>{
      const left=scroll.scrollLeft>0;
      const right=scroll.scrollLeft+scroll.clientWidth<scroll.scrollWidth-1;
      const v=left&&right?'both':left?'left':right?'right':'';
      if(v) scroll.dataset.overflow=v; else delete scroll.dataset.overflow;
    };
    scroll.addEventListener('scroll',markOverflow,{passive:true});
    scroll.addEventListener('wheel',e=>{
      if(e.deltaX||!e.deltaY||scroll.scrollWidth<=scroll.clientWidth)return;
      e.preventDefault();
      scroll.scrollLeft+=e.deltaY;
    },{passive:false});
    /**
     * FR-PRF-30: **만든 관측자를 잡는다.**
     *
     *   이전 동작: `new ResizeObserver(markOverflow).observe(tabs)` — 어디에도
     *             저장되지 않아 `disconnect()` 할 길이 자체가 없었다
     *   새  동작: 골격에 얹고 `_domGC()` 가 골격을 거둘 때 함께 끊는다
     *   이유:     같은 파일군의 다른 여덟 자리는 전부 참조를 든다 —
     *             **이 한 자리만 규약 밖**이었고, 그러면 다음 사람이 어느 쪽이
     *             규칙인지 알 수 없다 (`AUDIT-fe-ui.md` M-6)
     *
     * `_markTabOverflow` 를 같은 방식으로 이미 얹고 있으므로 자리가 하나다.
     */
    if(typeof ResizeObserver!=='undefined'){
      el._tabOverflowRo=new ResizeObserver(markOverflow);
      el._tabOverflowRo.observe(scroll);
    }
    el._markTabOverflow=markOverflow;
    tabs.addEventListener('dragover',e=>{
      if(!app.drag||app.drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      const n=node();
      if(n&&app.drag.srcPaneId!==n.id) tabs.classList.add('drag-target');
    });
    tabs.addEventListener('dragleave',e=>{
      if(!tabs.contains(e.relatedTarget)) tabs.classList.remove('drag-target');
    });
    tabs.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      tabs.classList.remove('drag-target');
      tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
      if(!app.drag||app.drag.type!=='tab')return;
      const n=node(); if(!n) return;
      const{srcPaneId,tabId}=app.drag;
      app.drag=null;
      const s=app.aw(); if(!s)return;
      if(srcPaneId===n.id){
        const pn=findPane(s.layout,n.id); if(!pn)return;
        const si=pn.tabs.findIndex(t=>t.id===tabId); if(si<0)return;
        const[moved]=pn.tabs.splice(si,1);
        pn.tabs.push(moved);
        app.paneTabSet(pn,tabId,slotOf());
        app.save();
        app.render();
      }else{
        app.moveTabToPane(srcPaneId,tabId,n.id,null,false);
      }
    });
    body.addEventListener('dragover',e=>{
      if(!app.drag||app.drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      tabs.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
      app.showBodyDropIndicator(body,app.getDragZone(body,e));
    });
    body.addEventListener('dragleave',e=>{
      if(!body.contains(e.relatedTarget)) app.clearBodyDropIndicator(body);
    });
    body.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      if(!app.drag||app.drag.type!=='tab')return;
      const n=node(); if(!n) return;
      const zone=app.getDragZone(body,e);
      const{srcPaneId,tabId}=app.drag;
      app.drag=null;
      app.clearBodyDropIndicator(body);
      if(zone==='center'){
        if(srcPaneId===n.id)return;
        app.moveTabToPane(srcPaneId,tabId,n.id,null,false);
      }else{
        app.splitPaneWithTab(srcPaneId,tabId,n.id,zone);
      }
    });
    el.addEventListener('mousedown',()=>{
      const n=node(); if(!n) return;
      /**
       * FR-SVS-63 (§2.13): **칸이 먼저, pane 이 그 다음이다.**
       *
       *   이전 동작: pane 이 먼저 포커스를 정했고, 그 대상이 **이전 칸의 창**이었다
       *   새  동작: 누른 pane 이 있는 칸으로 포커스를 옮긴 뒤 그 pane 을 정한다
       *   이유:     이 리스너는 칸의 것보다 **먼저** 돈다(버블은 안에서 밖으로).
       *             `setFocus` 는 창을 인자로 받지 않으므로 대상이 늘 그 순간의
       *             활성 창이고, 순서가 뒤집혀 있으면 이전 칸의 창이 누른 칸의
       *             pane id 를 자기 `focusedPane` 으로 받는다 — 그 창으로
       *             돌아갈 때 보던 분할 칸을 잃었다 (실측)
       *
       * 가드는 칸 리스너(`_makeSlot`)와 **같은 판정**이다. 같은 칸이면 부르지
       * 않으므로 단일 슬롯 모드와 칸 안의 클릭은 종전과 한 글자도 다르지 않다.
       * 그리기는 여전히 미룬다 (FR-SVS-61).
       */
      if(app.slotFocused()!==slotOf()) app.slotFocusTo(slotOf(),{deferRender:true});
      app.setFocus(n.id);
      // FR-MTI-25: 모바일에서 키보드를 올리는 유일한 경로. render 는 focus 하지
      // 않으므로 여기서 하지 않으면 모바일에서 입력을 시작할 길이 없다.
      if(app.isMobile){
        const pn=findPane(app.aw()?.layout,n.id);
        const tab=pn&&(pn.tabs||[]).find(t=>t.id===app.paneTab(pn,slotOf()));
        if(tab&&tab.type!=='editor'){
          const p=app.toolAny(tab.toolId);
          if(p) p.focus();
        }
      }
    });
    return el;
  },

  _buildSp(n,path){
    const slot=this._rSlot||0, win=(this._rWin&&this._rWin.id)||'';
    // 모양이 바뀌면 키가 달라진다 — 그 서브트리만 새로 서고 옛것은 거둬진다.
    const key='sp:'+slot+':'+win+':'+path+':'+n.direction+':'+n.children.length;
    const el=this._keep(key,()=>{
      const e=document.createElement('div'); e.className='sp'; return e;
    });
    el.dataset.d=n.direction;
    // 크기 확정(`_handle` 의 end)이 **지금의** 노드에 적히도록 매번 갱신한다.
    el._node=n;
    const kids=[];
    for(let i=0;i<n.children.length;i++){
      const sc=this._keep(key+'/sc'+i,()=>{
        const c=document.createElement('div'); c.className='sc'; return c;
      });
      if(n.sizes&&n.sizes[i]!=null) sc.style.flex=n.sizes[i];
      const built=this._buildNode(n.children[i],path+'.'+i);
      this._place(sc,built?[built]:[]);
      kids.push(sc);
      if(i<n.children.length-1){
        kids.push(this._keep(key+'/sh'+i,()=>{
          const h=document.createElement('div'); h.className='sh';
          this._handle(h,el);                    // FR-PDR-7: 배선은 만들 때 한 번
          return h;
        }));
      }
    }
    this._place(el,kids);
    return el;
  },

  _handle(h,sp){
    /**
     * UI_KIT_SRS FR-HSZ-1·10: 여섯 핸들이 `UIKit.drag` 한 골격을 쓴다.
     *
     * 이 핸들은 양쪽이 **둘 다 터미널일 수 있는** 유일한 자리다 (분할 칸).
     * `termIn` 이 각 칸에서 그것을 찾고, 없으면 `C×R` 줄이 붙지 않는다.
     */
    const dirOf=()=>sp.dataset.d;
    UIKit.drag(h,{
      axis:dirOf()==='horizontal'?'x':'y',
      start:()=>{
        const prev=h.previousElementSibling, next=h.nextElementSibling;
        const horiz=dirOf()==='horizontal';
        return {
          prev,next,horiz,
          tot:horiz?prev.offsetWidth+next.offsetWidth:prev.offsetHeight+next.offsetHeight,
          p0:horiz?prev.offsetWidth:prev.offsetHeight,
        };
      },
      move:(ctx,ev)=>{
        const {prev,next,horiz,tot,p0}=ctx;
        const n=p0+(horiz?ev.clientX-ctx.sx0:ev.clientY-ctx.sy0);
        if(n<60||tot-n<60) return;
        prev.style.flex=`${n/tot}`;next.style.flex=`${(tot-n)/tot}`;
      },
      sides:(ctx)=>{
        const {prev,next,horiz,tot,p0}=ctx;
        const pw=horiz?prev.offsetWidth:prev.offsetHeight;
        const nw=tot-pw, d=pw-p0;
        const cell=(el,delta)=>UIKit.grid(this.app.termIn(el),horiz?'x':'y',horiz?delta:0,horiz?0:delta);
        return [
          {px:pw,cell:cell(prev,d),pct:tot?pw/tot*100:null},
          {px:nw,cell:cell(next,-d),pct:tot?nw/tot*100:null},
        ];
      },
      end:()=>{
        const nd=sp._node;
        if(nd){nd.sizes=[];for(const c of sp.children){if(c.classList.contains('sc'))nd.sizes.push(parseFloat(c.style.flex)||1)}this.app.save()}
        for(const p of this.app.tools.values())if(p.el.classList.contains('vis'))p.doFit();
      },
    });
  },
});
