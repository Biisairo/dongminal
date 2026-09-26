/**
 * Renderer — pane 의 탭·고정 구 버튼과 껍데기의 끌어 놓기·포커스 배선
 * (OPTIMIZE_REFACTOR_SRS FR-OPT-12-4 · FEU-26). `renderer-pane.js` 가 부른다. 증강 분할이다 —
 * 계약은 `Renderer` 한 클래스에 남는다.
 *
 * 핸들러는 `node()`·`slotOf()` 로 **지금의** 문맥을 읽는다 (FR-PDR-8) — 재사용되는 요소에 값을
 * 가두면 두 번째 그리기부터 낡은 pane 을 가리킨다.
 */
Object.assign(Renderer.prototype, {
  // 탭 요소 하나와 그 배선. **여기서만 배선한다** (FR-PDR-7) — 지금 어느 pane 의
  // 어느 탭인지는 `_ctx` 가 답한다 (FR-PDR-8).
  _makeTab(){
    const app=this.app;
    const el=document.createElement('div');
    // D-A11Y-10: `×` 는 포인터 전용 표식이다 — `tab` 안의 컨트롤은 접근성 트리에
    // 설 수 없다. 키보드는 탭에서 `Delete` 로 닫는다 (`_makePane` 의 roving).
    el.innerHTML='<span class="pn-tab-label"></span>'
      +'<span class="pn-tab-x" aria-hidden="true" title="'+TAB_CLOSE_TITLE+'">'+UIKit.iconHTML('x','ui-icon-sm')+'</span>';
    el.setAttribute('role','tab');
    el.tabIndex=-1;
    el.draggable=true;
    const ctx=()=>{
      const pn=el.closest('.pn');
      const c=(pn&&pn._ctx)||{};
      return {pane:c.node||null,slot:c.slot||0,tab:(el._ctx&&el._ctx.tab)||null};
    };
    const clearMarks=()=>{
      const bar=el.parentNode;
      if(bar) bar.querySelectorAll('.pn-tab').forEach(r=>r.classList.remove('drag-left','drag-right'));
    };
    el.addEventListener('click',e=>{
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
    el.addEventListener('contextmenu',e=>{
      const c=ctx(); if(!c.pane||!c.tab) return;
      e.preventDefault(); e.stopPropagation();
      const aw=app.aw();
      const noNew=app.isGitWin(aw)||app.isEditorWin(aw);
      const label=el.querySelector('.pn-tab-label');
      UIKit.menu([
        {id:'new',label:TAB_MENU_NEW,disabled:noNew?TAB_MENU_NEW_NO:false,onClick:()=>app.addTab(c.pane.id,'terminal')},
        {id:'rename',label:TAB_MENU_RENAME,disabled:c.tab.type===TAB_TYPE_GIT?TAB_MENU_RENAME_GIT_NO:false,
          onClick:()=>{if(c.tab.preview) app.pinPreviewTab(c.tab); if(label) app.renameTab(c.tab,label)}},
        {id:'close',label:TAB_MENU_CLOSE,onClick:()=>app.closeTab(c.pane.id,c.tab.id,null,{slot:c.slot})},
      ],{at:{x:e.clientX,y:e.clientY},cls:'tab-menu'});
    });
    // FR-RTU-42: 탭 자체의 더블클릭이 고정한다.
    el.addEventListener('dblclick',e=>{
      const c=ctx(); if(!c.tab||!c.tab.preview) return;
      e.stopPropagation();
      app.pinPreviewTab(c.tab);
    });
    // 탭은 `renameTab` 이다 — 창의 `rename` 과 달리 빈 문자열에 뜻이 있다
    // (FR-TAN-21). git 뷰 탭의 이름은 뷰에서 파생하므로 고쳐도 다음 그리기가
    // 되돌린다 — 그래서 그 타입에서는 아무 일도 하지 않는다 (FR-RTU-33).
    el.querySelector('.pn-tab-label').addEventListener('dblclick',e=>{
      const c=ctx(); if(!c.tab||c.tab.type===TAB_TYPE_GIT) return;
      e.stopPropagation();
      if(c.tab.preview){app.pinPreviewTab(c.tab);return}
      app.renameTab(c.tab,e.target);
    });
    el.addEventListener('dragstart',e=>{
      const c=ctx(); if(!c.pane||!c.tab) return;
      app.drag={type:'tab',srcPaneId:c.pane.id,tabId:c.tab.id};
      e.dataTransfer.effectAllowed='move';
      e.stopPropagation();
      TIMERS.defer(()=>el.classList.add('dragging'),{label:'drag-class'});
    });
    el.addEventListener('dragend',()=>{
      app.drag=null; el.classList.remove('dragging'); clearMarks();
      document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none');
    });
    el.addEventListener('dragover',e=>{
      if(!app.drag||app.drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      clearMarks();
      const rect=el.getBoundingClientRect();
      el.classList.add(e.clientX<rect.left+rect.width/2?'drag-left':'drag-right');
      document.querySelectorAll('.pn-drop-indicator').forEach(ind=>ind.style.display='none');
    });
    el.addEventListener('drop',e=>{
      e.preventDefault(); e.stopPropagation();
      if(!app.drag||app.drag.type!=='tab')return;
      const c=ctx(); if(!c.pane||!c.tab) return;
      const{srcPaneId,tabId}=app.drag;
      app.drag=null;
      clearMarks();
      const s=app.aw(); if(!s)return;
      const rect=el.getBoundingClientRect();
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
    return el;
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
    const sk=h?'splitH':'splitV';
    const kl=()=>displayKey((typeof shortcuts==='object'&&shortcuts[sk])||'');
    const b=UIKit.button({icon:h?'columns':'rows',iconSize:'sm',kind:'ghost',cls:'pn-act pn-split',
      title:t(h?'html.split_h_title':'html.split_v_title',{key:kl()})});
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
    b.setAttribute('aria-label',t(h?'html.btn_split_h':'html.btn_split_v'));
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
    const add=UIKit.button({icon:'plus',iconSize:'sm',title:TAB_ADD_TITLE,kind:'ghost',cls:'pn-tab-add'});
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

  // 탭 줄에 놓기: 같은 pane 이면 끝으로 옮기고, 다른 pane 이면 그리로 옮긴다.
  _wireTabsDrop(tabs,node,slotOf){
    const app=this.app;
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
      this._clearTabMarks(tabs);
      if(!app.drag||app.drag.type!=='tab')return;
      const n=node(); if(!n) return;
      const{srcPaneId,tabId}=app.drag;
      app.drag=null;
      const s=app.aw(); if(!s)return;
      if(srcPaneId===n.id){
        const pn=findPane(s.layout,n.id); if(!pn)return;
        const si=pn.tabs.findIndex(tab=>tab.id===tabId); if(si<0)return;
        const[moved]=pn.tabs.splice(si,1);
        pn.tabs.push(moved);
        app.paneTabSet(pn,tabId,slotOf());
        app.save();
        app.render();
      }else{
        app.moveTabToPane(srcPaneId,tabId,n.id,null,false);
      }
    });
  },

  // 본문에 놓기: 가운데는 옮기기, 가장자리는 분할.
  _wireBodyDrop(body,tabs,node){
    const app=this.app;
    body.addEventListener('dragover',e=>{
      if(!app.drag||app.drag.type!=='tab')return;
      e.preventDefault(); e.stopPropagation();
      this._clearTabMarks(tabs);
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
  },

  /**
   * 탭 사이 삽입 표식을 걷는다. 표식이 선 탭만 찾는다 — 본문 dragover 는 마우스가 움직일
   * 때마다 오므로 탭 전부를 훑지 않는다 (FEU-26).
   */
  _clearTabMarks(tabs){
    for(const r of tabs.querySelectorAll('.pn-tab.drag-left,.pn-tab.drag-right')) r.classList.remove('drag-left','drag-right');
  },

  _wirePaneFocus(el,node,slotOf){
    const app=this.app;
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
        const tab=pn&&(pn.tabs||[]).find(x=>x.id===app.paneTab(pn,slotOf()));
        if(tab&&tab.type!=='editor'){
          const p=app.toolAny(tab.toolId);
          if(p) p.focus();
        }
      }
    });
  },
});
