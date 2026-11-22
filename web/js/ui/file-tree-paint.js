/**
 * FileTree — 조회와 그리기 (SPLIT_REFACTOR_SRS 묶음 C).
 *
 * 서버에서 한 겹을 받아(`load`) git 색을 입히고(`pollGit`) 무시된 이름을 가려
 * (`loadIgnored`), 펼침 상태를 평평한 목록으로 접은 뒤(`_items`) 그린다(`paint`).
 *
 * 이 파일이 대답하는 질문은 **"지금 무엇이 보이는가"** 다. 그것을 바꾸는 일
 * (생성·이름변경·삭제)은 file-tree-edit.js, 파일을 주고받는 일은 file-tree-xfer.js 다.
 *
 * 이 파일은 그리기 부품 `FileTreePaint`(탐색기의 `painter`) 다 — 평평한 목록(`_items`)·행 요소·입력 행·실패 표시.
 * 조회와 git 색은 `file-tree-load.js`(`FileTreeLoad`), 선택·클릭·펼침은 `file-tree-select.js`(`FileTreeSelect`) 로 갈랐다
 * (REFACTOR3_FE_REST5_SRS FR-FR5-31 — 옛 `Object.assign(FileTree.prototype, …)` 한 덩이 971줄). 상태는 종전대로 탐색기
 * 인스턴스에 있고 부품은 그것을 `this.tree` 로 읽고 쓴다. 탐색기의 이름은 전부 `this.tree.X` 로 부른다 — 시험·e2e 가 인스턴스에
 * 갈아 끼운 것을 부품도 본다. 파일 끝의 위임자 표가 이 부품의 이름을 `FileTree` 원형에 둔다.
 */
class FileTreePaint {
  constructor(tree){
    this.tree=tree;
  }

  // ── 그리기 (FR-EDT-66·68) ──

  /**
   * 보이는 행을 평평한 목록으로 편다. 중첩 DOM 이 아니라 패딩으로 들여쓴다 —
   * Git 패널의 트리와 같은 규약이고(FR-GIT-211) reconcile 이 성립하는 형태다.
   */
  _items(){
    const out=[];
    const ed=this.tree._edit;
    // FR-EDT-92: 실패는 **그 자리**에 붙는다. 붙을 행이 지금 보이지 않으면 뿌리
    // 위에 붙인다 — 어디에도 못 붙어 사라지면 사용자는 조작이 성공한 줄 안다.
    let errPut=false;
    const err=depth=>{
      if(!this.tree._err||errPut) return null;
      errPut=true;
      const msg=this.tree._err.more?t('editor.tree_fail_more',{msg:this.tree._err.msg,n:this.tree._err.more}):this.tree._err.msg;
      return {t:'operr',depth,msg,
        k:'oe',s:rptKey('oe',depth,msg)};
    };
    const errAt=(anchor,depth)=>{
      if(!this.tree._err||errPut||this.tree._err.anchor!==anchor) return;
      const it=err(depth); if(it) out.push(it);
    };
    // FR-EDT-81·82: 인라인 입력. 만들기는 대상 폴더의 **첫 자리**에, 이름 변경은
    // 그 행 **자리 그대로** 선다.
    const input=depth=>({t:'in',depth,mode:ed.mode,isDir:!!ed.isDir,init:ed.init,
      k:'in',s:rptKey('in',ed.mode,depth,ed.isDir?1:0)});
    const walk=(dir,depth)=>{
      const st=this.tree._kids.get(dir);
      if(!st) return;
      if(ed&&ed.mode==='create'&&ed.dir===dir){
        out.push(input(depth));
        errAt('input',depth);
      }
      for(const e of st.entries){
        if(!e||!e.name) continue;
        const p=this.tree._join(dir,e.name);
        // FR-EDT-60: `dir` 은 Lstat 기준이라 링크는 언제나 false 이고, 대상 종류는
        // `linkDir` 이 알린다. 셋을 여기 한 번만 가른다.
        const kind=e.link?'link':(e.dir?'dir':'file');
        const sub=this.tree._kids.get(p);
        const it={t:'row',path:p,name:e.name,kind,depth,
          linkDir:!!e.linkDir,
          open:kind==='dir'&&this.tree._open.has(p),
          busy:this.tree._busy.has(p),
          err:(sub&&sub.err)||'',
          // §3A-2 (T-2.2): 일시 오류로 갱신에 실패했다 — 목록은 이전 것이다.
          stale:!!(sub&&sub.stale),
          // §3A-5 (T-7.4): 다시 그려져도 드롭 강조가 남는다.
          drop:this.tree._dropDir===p,
          sel:this.tree._selHas(p)||this.tree._sel===p,
          st:this.tree._stOf(p,kind),
          ignored:this.tree._isIgnored(p),
          partial:kind!=='dir'&&this.tree._isPartial(p),chip:kind==='dir'?this.tree.app.claudeFolderChip(this.tree.root,p):null}; // CLAUDE_ACCOUNTS_SRS FR-CAC-97
        it.k='r:'+p;
        // 근거는 이 행이 읽는 값 **전부**다 — 좁히면 갱신이 조용히 멈춘다 (FR-RPT-2).
        it.s=[kind,depth,it.open?1:0,it.busy?1:0,it.err,it.sel?1:0,it.st,it.linkDir?1:0,
          it.partial?1:0,it.ignored?1:0,it.stale?1:0,it.drop?1:0,it.chip?it.chip.text+'\x02'+it.chip.color:'']
          .join(RPT_SEP);
        if(ed&&ed.mode==='rename'&&ed.path===p){
          out.push(input(depth));
          errAt('input',depth);
        }else{
          out.push(it);
        }
        errAt(p,depth);
        if(it.open) walk(p,depth+1);
      }
      // FR-EDT-65: 잘린 폴더. 조회가 실패한 것이 아니므로 행 뒤에 사실만 덧붙인다.
      if(st.truncated){
        out.push({t:'more',path:dir,depth,n:st.entries.length,total:st.total||st.entries.length,
          busy:!!st.moreBusy,err:!!st.moreErr,
          k:'m:'+dir,
          // 서명에 상태를 실어야 `reconcileList` 가 같은 행을 다시 그린다 —
          // 빠뜨리면 "받는 중…" 이 화면에 서지 않는다.
          s:rptKey('m',st.entries.length,st.total||0,depth,''+(st.moreBusy?1:0)+(st.moreErr?1:0))});
      }
    };
    // 뿌리에는 행이 없으므로(이름은 머리가 보인다) 뿌리의 실패는 여기 실어 보인다.
    const rs=this.tree._kids.get(this.tree.root);
    if(rs&&rs.err) out.push({t:'err',depth:0,msg:rs.err,k:'e:root',s:rptKey('e',rs.err)});
    else if(rs&&rs.stale) out.push({t:'err',depth:0,msg:EDITOR_TREE_STALE,k:'e:root',s:rptKey('e','stale')});
    walk(this.tree.root,0);
    // §3A-3: 붙을 행이 보이지 않으면 **가장 가까운 보이는 조상** 행 뒤, 그것도 없으면
    // 맨 앞(루트)이다.
    if(this.tree._err&&!errPut){
      for(let a=this.tree._parent(this.tree._err.anchor);a&&a!==this.tree.root&&pathUnder(this.tree.root,a);a=this.tree._parent(a)){
        const i=out.findIndex(x=>x.t==='row'&&x.path===a);
        if(i>=0){const it=err(out[i].depth+1); if(it) out.splice(i+1,0,it); break}
        if(this.tree._parent(a)===a) break;
      }
    }
    const rest=err(0); if(rest) out.unshift(rest);
    return out;
  }

  paint(){
    reconcileList(this.tree.list,this.tree._items(),{
      key:it=>it.k, sig:it=>it.s, build:it=>this.tree._el(it),
    });
    // FR-EXR-3: 루트의 선택은 **머리**가 보인다 — 뿌리에는 행이 없다(위 `_items`).
    this.tree.head.classList.toggle('sel',this.tree._sel===this.tree.root);
    // D-A11Y-11: 앵커가 행이면 그 행을 가리킨다. 루트·없음이면 가리키는 것이 없다.
    const sel=this.tree.list.querySelector('.ed-row.sel');
    if(sel&&sel.id) this.tree.list.setAttribute('aria-activedescendant',sel.id);
    else this.tree.list.removeAttribute('aria-activedescendant');
    this.tree._focusInput();
  }

  // 행의 id — 인스턴스 접두 + 경로. 공백이 id 에 설 수 없으므로 인코딩한다.
  _rowId(p){ return this.tree._uid+'-'+encodeURIComponent(p) }

  /**
   * FR-EDT-82: 이름 변경은 **확장자 앞까지** 미리 선택한다 — 바꾸려는 것은 거의
   * 언제나 확장자가 아니다.
   *
   * 요소는 reconcile 이 보존하므로(키·서명이 그대로다) 포커스는 **만들어진 직후
   * 한 번**만 준다. 매 paint 마다 주면 폴링이 캐럿을 계속 되돌린다.
   */
  _focusInput(){
    if(!this.tree._focusEdit) return;
    const el=this.tree.list.querySelector('.ed-input');
    if(!el) return;
    this.tree._focusEdit=false;
    el.focus();
    const v=el.value, i=v.lastIndexOf('.');
    el.setSelectionRange(0,(!this.tree._edit.isDir&&i>0)?i:v.length);
  }

  _pad(el,depth){ el.style.paddingLeft=(GIT_TREE_PAD0+depth*GIT_TREE_INDENT)+'px' }

  _el(it){
    if(it.t==='more'){
      /**
       * FR-FSP-11·12: **사실만 말하고 끝내지 않는다.** 보이는 수와 전체 수를
       * 함께 말하고, 누르면 다음 쪽을 이어 받는다.
       *
       * 받는 동안의 다시 누름은 무시한다 — 요청이 두 벌로 나가면 같은 구간을
       * 두 번 받아 목록에 중복이 선다.
       */
      const d=document.createElement('div'); d.className='ed-more';
      this.tree._pad(d,it.depth);
      const tpl=it.err?EDITOR_TREE_MORE_FAIL:(it.busy?EDITOR_TREE_MORE_BUSY:EDITOR_TREE_TRUNCATED);
      d.textContent=tpl.replace('%s',it.n).replace('%t',it.total);
      if(it.err) d.classList.add('ed-more-err');
      if(it.busy) d.classList.add('ed-more-busy');
      else{
        d.classList.add('ed-more-can');
        d.addEventListener('click',()=>{
          const st=this.tree._kids.get(it.path);
          if(!st||st.moreBusy) return;
          st.moreBusy=true; st.moreErr=false; this.tree._paintAll();
          this.tree.load(it.path,{offset:st.entries.length});
        });
      }
      return d;
    }
    if(it.t==='err'){
      const d=document.createElement('div'); d.className='ed-tree-err';
      this.tree._pad(d,it.depth);
      d.textContent=EDITOR_TREE_ERR+' — '+it.msg;
      return d;
    }
    // FR-EDT-92: 조작 실패의 사유. 조회 실패(`ed-tree-err`)와 다른 종류이므로
    // 클래스를 나눈다 — 하나로 합치면 어느 실패인지 화면이 말하지 못한다.
    if(it.t==='operr'){
      const d=document.createElement('div'); d.className='ed-op-err';
      this.tree._pad(d,it.depth);
      d.appendChild(domEl('span','ed-op-err-msg',it.msg));
      // §3A-3: 사용자가 닫을 수 있다 — 다음 조작을 시작하지 않아도 걷을 길이 있다.
      d.appendChild(UIKit.button({icon:'x',title:EDITOR_TREE_ERR_CLOSE,kind:'ghost',size:'sm',cls:'ed-op-err-x'}));
      return d;
    }
    if(it.t==='in') return this.tree._elInput(it);
    const d=document.createElement('div');
    // 상태 클래스는 Git 패널과 **같은 표**에서 나온다 (GIT_ST_CLASS) — 색값의
    // 정의 자리를 늘리지 않기 위해서다 (FR-EDT-70 / D-4).
    d.className='ed-row ed-'+it.kind
      +(it.sel?' sel':'')+(it.err?' ed-err':'')
      +(it.st?' st-'+(GIT_ST_CLASS[it.st]||'other'):'')
      +(it.partial?' st-partial':'')
      // FR-ETR-7: 무시는 **상태색보다 약하다.** 클래스를 뒤에 두되 CSS 가
      // 상태색을 이기지 않게 한다 — 실제로 겹치는 자리는 없지만(무시된 파일은
      // status 에 나오지 않는다) 규칙을 적어 두지 않으면 순서가 뒤집힌다.
      +(it.ignored?' ed-ignored':'')
      +(it.stale?' ed-stale':'')+(it.drop?' ed-drop':'')
      +(this.tree._drag&&this.tree._drag===it.path?' ed-dragging':'');
    d.dataset.path=it.path; d.dataset.kind=it.kind;
    if(it.st) d.dataset.st=it.st;
    // FR-A11Y-16 / D-A11Y-11: 평평한 트리의 `treeitem`. 값은 전부 서명에 든
    // 것이므로(`_items`) 바뀌면 행이 다시 만들어져 속성도 따라온다.
    d.id=this.tree._rowId(it.path);
    d.setAttribute('role','treeitem');
    d.setAttribute('aria-level',String(it.depth+1));
    d.setAttribute('aria-selected',it.sel?'true':'false');
    if(it.kind==='dir') d.setAttribute('aria-expanded',it.open?'true':'false');
    // FR-EDT-85: 드래그 이동의 출발점. 링크도 옮길 수 있다 — 조작은 링크 **자신**을
    // 대상으로 삼는다 (D-21).
    d.draggable=true;
    this.tree._pad(d,it.depth);
    d.title=it.err?(it.path+' — '+EDITOR_TREE_ERR+' ('+it.err+')')
      :(it.stale?it.path+' — '+EDITOR_TREE_STALE:it.path);
    const tw=d.appendChild(domEl('span','ed-tw',it.kind==='dir'&&it.busy?EDITOR_TREE_TW_BUSY:''));   // UX_AUDIT_FIX_SRS FR-UXF-100: 꺾쇠는 아이콘, 열림은 `data-open`
    if(it.kind==='dir'&&!it.busy) UIKit.caret(tw,it.open);
    d.appendChild(domEl('span','ed-name',it.name)); if(it.chip) d.appendChild(claudeAcctChipEl(it.chip));
    if(it.stale) d.appendChild(UIKit.icon('triangle-alert',{size:'sm',cls:'ed-stale-mark'}));   // REPO_FIX 04 §3A-2 → FR-UXF-100: 이전 CSS `::after` 의 `⚠`
    if(it.kind==='link') d.appendChild(domEl('span','ed-mark',it.linkDir?EDITOR_TREE_LINK_DIR_SUFFIX:'')).prepend(UIKit.icon(EDITOR_TREE_LINK,{size:'sm'}));
    return d;
  }

  /**
   * FR-EDT-81·82 의 인라인 입력. 만들기와 이름 변경이 **같은 요소**를 쓴다 — 받는
   * 것이 이름 하나로 같기 때문이다.
   *
   * 키 이벤트를 여기서 멈춘다 — 앱의 전역 단축키가 타이핑을 먹으면 `n` 하나에
   * 창이 열린다.
   */
  _elInput(it){
    const d=document.createElement('div');
    d.className='ed-row ed-edit'+(it.mode==='rename'?' ed-edit-rename':' ed-edit-new');
    this.tree._pad(d,it.depth);
    const tw=d.appendChild(domEl('span','ed-tw',''));
    if(it.isDir) UIKit.caret(tw,false);
    const i=document.createElement('input');
    i.className='ed-input'; i.type='text'; i.value=it.init; i.spellcheck=false; i.oninput=()=>this.tree._askName(i.value); // F-k
    i.addEventListener('keydown',e=>{
      e.stopPropagation();
      // §3A-5 (T-7.3): 끝내면 키보드 포커스가 트리 목록으로 돌아온다.
      if(e.key==='Enter'){e.preventDefault();this.tree._commitEdit(i.value);if(!this.tree._edit)this.tree.list.focus()}
      else if(e.key==='Escape'){e.preventDefault();this.tree.cancelEdit();this.tree.list.focus()}
    });
    d.appendChild(i);
    return d;
  }

  // ── 파일 조작 (FR-EDT-79~93) ──

  _base(p){ return pathBase(p) }
  // 부모는 **그 경로의 구분자**로 자른다 — `/` 만 보면 Windows 의 절대경로에서
  // 자를 자리를 찾지 못해 언제나 루트를 답한다.
  _parent(p){ const s=String(p||''); const i=Math.max(s.lastIndexOf('/'),s.lastIndexOf('\\')); return i<=0?'/':s.slice(0,i) }

  // 종류는 **부모의 캐시**가 안다 — 행을 그리는 근거와 같은 값을 쓴다.
  _kindOf(p){
    if(p===this.tree.root) return 'dir';
    const st=this.tree._kids.get(this.tree._parent(p));
    const e=st&&st.entries.find(x=>x&&x.name===this.tree._base(p));
    if(!e) return '';
    return e.link?'link':(e.dir?'dir':'file');
  }

  // FR-EDT-81: 만드는 자리. 선택이 폴더면 그 아래, 파일이면 그 부모, 없으면 루트다.
  _targetDir(){
    const k=this.tree._sel?this.tree._kindOf(this.tree._sel):'';
    if(k==='dir') return this.tree._sel;
    if(k) return this.tree._parent(this.tree._sel);
    return this.tree.root;
  }

  /**
   * REPO_FIX 04 §3A-3 (T-4.1): 실패 사유는 재조회·폴링·`_after` 에 지워지지 않는다 —
   * 지우는 것은 사용자의 다음 트리 조작 시작과 표시의 닫기 버튼뿐이다. 여러 건이면
   * "첫 사유 + 외 n건" 한 줄이다.
   *   이전 동작: `_after` 의 첫 줄이 지워 사용자가 사유를 보지 못했다 (#27)
   */
  _fail(anchor,msg){
    if(this.tree._err) this.tree._err.more=(this.tree._err.more||0)+1;
    else this.tree._err={anchor,msg,more:0};
    this.tree._paintAll();
  }
  /**
   * WORKBENCH_REVIEW_SRS FR-WBR-3: **지우면 그린다.**
   *
   *   이전 동작: 값만 비우고 다시 그리지 않았다 — 뒤이어 오는 다시 그리기가
   *             치워 주는 것에 기댔다
   *   새  동작: 비운 자리에서 곧바로 그린다
   *   이유:     지우는 계기가 셋으로 늘었다 (FR-WBR-1·2·4). 그중 **선택 변경**과
   *             **자기 하위 이동 거부**는 뒤이어 오는 다시 그리기가 없는 자리라
   *             값만 비우면 화면에 남는다. 비어 있을 때는 아무 일도 하지 않으므로
   *             기존 호출처의 비용은 늘지 않는다
   */
  _clearErr(){ if(!this.tree._err) return; this.tree._err=null; this.tree._paintAll() }
}

// 탐색기 원형의 이름 — 앱·렌더러·e2e·시험과 다른 부품이 `FileTree` 에서 부른다 (REFACTOR3_FE_REST5_SRS FR-FR5-32).
Controller.delegate(FileTree,'painter',['_items','paint','_rowId','_focusInput','_pad','_el','_elInput','_base','_parent','_kindOf','_targetDir',
  '_fail','_clearErr']);
