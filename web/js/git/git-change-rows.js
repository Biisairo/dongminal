/**
 * GitChangeRows — Git 패널 Changes 탭의 행 부품: 그룹 · 평평한/트리 보기 · 행 · 이어 그리기
 * (FR-GIT-34~42 · REFACTOR3_FE_GITPANEL_SRS 7f). 목록 끝을 지켜보는 관측기(`_io`)를 소유한다.
 * 접힘(`_collapsed`·`_dirCollapsed`)·그린 수(`_shown`)·선택은 패널의 것이다.
 */
class GitChangeRows extends GitPart {

  _paintGroup(el,g,entries){
    const box=el.querySelector('.git-group[data-group="'+g.key+'"]'); if(!box) return;
    // 비어 있으면 서지 않는 그룹 (`hideEmpty`). 골격에서 빼지 않고 감추는 이유는
    // 접힘·무한 스크롤·트리 보기가 전부 이 상자를 딛기 때문이다 — 다시 만들면
    // 그 상태가 회차마다 날아간다 (FR-RPT-3 과 같은 근거).
    // FR-LAY-3: `.gone` 을 `[hidden]` 으로 옮겼다.
    box.hidden=!!g.hideEmpty&&!entries.length;
    const cnt=box.querySelector('.git-group-count');
    /**
     * FR-GDT-24: **서버가 잘랐으면 그 사실을 보인다.**
     *
     * 잘린 그룹에서 `entries.length` 는 상한이지 저장소의 사실이 아니다 — 그
     * 숫자만 보이면 사용자는 파일이 없어진 것으로 읽는다. 원래 개수는 서버가
     * `status.truncated` 로 실어 준다 (FR-GDT-23).
     *
     * 두 출신이 섞이는 그룹(`working`)에서는 그 둘 중 하나만 잘려도 목록이
     * 잘린 것이므로, 원본 키 전부를 본다.
     */
    const st=this.p._status&&this.p._status.status;
    const cut=gitGroupTruncated(st,g.key);
    /**
     * WORDING_COLOR_SRS FR-WRD-80: 개수는 **배지 하나로** 말한다.
     *   이전 동작: `(3)` — 괄호 표기였고, 같은 앱의 다른 세 자리(사이드바 알약 ·
     *             Runs·Background 모달 머리)는 `.ui-badge` 였다
     *   새  동작: 킷의 배지에 수만 담는다. 잘림의 `+` 와 툴팁은 그대로다
     *   이유:     같은 수치가 네 서식으로 나오고 있었다 (`AUDIT-uiux.md` §1.4).
     *             B3 이 모달 머리 둘을 배지로 옮겼고 이 자리가 마지막이다
     */
    cnt.textContent=String(entries.length)+(cut?'+':'');
    // UI_POLISH_SRS FR-UIP-7: 0 은 말하지 않는다.
    cnt.hidden=!entries.length&&!cut;
    cnt.classList.toggle('git-group-cut',!!cut);
    // FR-CMG-11: 합계만으로는 **지울 것이 있는지** 보이지 않는다. 두 출신이 섞이는
    // 그룹에서만 내역을 적는다 — 갈리지 않는 그룹에 같은 말을 두면 뜻이 없다.
    if(GIT_GROUP_SRC[g.key]){
      const m=entries.filter(e=>e.untracked).length;
      cnt.title=GIT_GROUP_COUNT_TITLE(entries.length-m,m);
    }
    // 잘렸다는 사실이 개수의 뜻을 바꾼다 — 그 설명이 이깁니다.
    if(cut) cnt.title=GIT_GROUP_TRUNCATED.replace('%n',String(cut));
    // 빈 그룹에 일괄 동작은 뜻이 없다 — **버튼마다** 건다 (FR-WBR-53). 하나만
    // 찾으면 둘째가 빈 그룹에서도 눌린다.
    for(const b of box.querySelectorAll('.git-group-bulk')) b.disabled=!entries.length;
    const collapsed=this.p._collapsed.has(g.key)||!entries.length;
    box.classList.toggle('collapsed',collapsed);
    UIKit.caret(box.querySelector('.git-group-caret'),!collapsed);
    const rows=box.querySelector('.git-group-rows');
    if(collapsed){rows.innerHTML=''; return}
    const limit=this.p._shown.get(g.key)||GIT_FILE_ROW_CHUNK;
    // 그릴 행을 먼저 **기술**하고, 요소는 reconcileList 가 필요한 것만 만든다
    // (FR-GIT-227 / FR-RPT-3) — 목록을 비우고 다시 만들면 hover·더블클릭·우클릭이
    // 매 회차 끊긴다. 평평한 보기와 트리 보기가 같은 기술을 낸다.
    const items=[];
    const drawn=this.p._treeMode()
      ?this._emitTree(items,g.key,entries,limit)
      :this._emitFlat(items,g.key,entries,limit);
    if(drawn<entries.length) items.push({t:'more',group:g.key,n:entries.length-drawn});
    reconcileList(rows,items,{
      key:it=>it.t+':'+(it.t==='file'?it.e.path:it.t==='dir'?it.path:''),
      sig:it=>this._itemSig(it),
      build:it=>this._itemEl(it),
    });
  }

  // 행의 **보이는 값 전부**다 (FR-RPT-2). 하나라도 빠지면 그 값의 변화가 화면에
  // 닿지 않는다 — 좁히지 않는다.
  _itemSig(it){
    if(it.t==='dir') return [it.depth,it.label,it.collapsed?1:0].join(RPT_SEP);
    if(it.t==='more') return String(it.n);
    const e=it.e,group=it.group;
    // REPO_FIX 05 F-6.1: 항목 필드는 `GIT_ROW_FIELDS` 에서 파생한다. 이전: 필드를 손으로
    // 적어 서브모듈 상태(`sub`)·디렉터리 표식(`dir`)이 빠졌고, 그것만 바뀌면 행이 낡았다(#42).
    return [
      it.depth,...GIT_ROW_FIELDS.map(k=>e[k]==null||e[k]===false?'':String(e[k])),
      this._stateChar(group,e),
      this.p._sel.has(this.p._selKey(group,e.path))?1:0,
      (this.p.previewFile&&this.p.previewFile.group===group&&this.p.previewFile.path===e.path)?1:0,
      this.p._treeMode()?1:0,
      // ours·theirs 의 title 이 진행 중인 조작에 따라 뒤집힌다 (FR-GIT-224).
      this.p._op()||'',
    ].join(RPT_SEP);
  }

  _itemEl(it){
    if(it.t==='dir') return this._dirEl(it);
    if(it.t==='file') return this._rowEl(it.group,it.e,it.depth);
    const more=document.createElement('div');
    more.className='git-file-more'; more.dataset.group=it.group;
    more.textContent=tn('git.more_rows',it.n);
    if(this._io) this._io.observe(more);
    return more;
  }

  _emitFlat(items,group,entries,limit){
    const n=Math.min(limit,entries.length);
    for(let i=0;i<n;i++) items.push({t:'file',group,e:entries[i],depth:0});
    return n;
  }

  // 트리 보기 (FR-GIT-38). 자식이 하나뿐인 중간 디렉터리는 합쳐 보인다 —
  // 깊은 트리에서 줄 수를 줄인다.
  _emitTree(items,group,entries,limit){
    const root={dirs:new Map(),files:[]};
    for(const e of entries){
      const parts=e.path.split('/');
      let n=root;
      for(let i=0;i<parts.length-1;i++){
        let x=n.dirs.get(parts[i]);
        if(!x){x={dirs:new Map(),files:[]};n.dirs.set(parts[i],x)}
        n=x;
      }
      n.files.push(e);
    }
    const st={drawn:0,limit};
    this._emitDir(items,group,root,'',0,st);
    return st.drawn;
  }

  _emitDir(items,group,node,prefix,depth,st){
    if(st.drawn>=st.limit) return;
    for(const [name,child] of node.dirs){
      let label=name,cur=child,path=prefix+name;
      while(cur.dirs.size===1&&!cur.files.length){
        const [n2,c2]=cur.dirs.entries().next().value;
        label+='/'+n2; path+='/'+n2; cur=c2;
      }
      const collapsed=this.p._dirCollapsed.has(group+':'+path);
      items.push({t:'dir',group,path,label,depth,collapsed});
      if(!collapsed) this._emitDir(items,group,cur,path+'/',depth+1,st);
      if(st.drawn>=st.limit) return;
    }
    for(const e of node.files){
      if(st.drawn>=st.limit) return;
      st.drawn++;
      items.push({t:'file',group,e,depth});
    }
  }

  _dirEl(it){
    const key=it.group+':'+it.path;
    const d=document.createElement('div');
    d.className='git-dir'+(it.collapsed?' collapsed':'');
    d.dataset.dir=it.path;
    this._indent(d,it.depth);
    d.innerHTML='<span class="git-dir-caret"></span><span class="git-dir-name"></span>'+
      '<span class="git-file-acts"></span>';
    UIKit.caret(d.querySelector('.git-dir-caret'),!it.collapsed);
    d.querySelector('.git-dir-name').textContent=it.label;
    /**
     * FR-WBR-80: 폴더 행이 **그 그룹의** 동작을 갖는다. 파일 행과 같은 클래스를
     * 쓰는 것은 같은 어휘의 아이콘이 자리마다 다르게 보이면 같은 것으로 읽히지
     * 않기 때문이다 — 규약과 치수가 한 자리(`.git-file-act`)에 남는다.
     *
     * UX_BATCH5_SRS FR-DBA-3: **파일 행과 열을 맞춘다.**
     *
     *   이전 동작: 폴더가 가진 동작만 그렸다. 묶음이 오른쪽 정렬이므로 개수가
     *              적은 폴더 행에서는 같은 아이콘이 파일 행의 다른 열에 섰다
     *   새  동작: `GIT_ROW_ACTS` 를 돌면서 폴더가 갖지 않는 자리에는 **자리지킴**을
     *             둔다 — 순서와 폭이 파일 행과 같아진다
     *   이유:     접수한 말의 뒷문장이 "행과 열을 맞춰줘" 다
     *
     * 폴더가 가진 동작이 하나도 없으면(conflicts) 자리지킴도 두지 않는다 —
     * 맞출 버튼이 없는데 빈 칸만 서면 그것은 정렬이 아니라 여백이다.
     */
    const acts=d.querySelector('.git-file-acts');
    const own=GIT_DIR_ACTS[it.group]||[];
    for(const c of (own.length?this._actCols(own,GIT_BULK_COLS):[])){
      if(!c.act){acts.appendChild(this._actGap());continue}
      // FR-CMG-9: 폴더 아래에 두 출신이 섞일 수 있다 — 정확한 내역은 확인창이 보인다.
      // 행 클릭은 접기다 — 동작 버튼이 그것을 함께 일으키지 않는다.
      acts.appendChild(UIKit.button({icon:GIT_ACT_ICON[c.act],
        title:(GIT_DIR_ACT_TITLE_GROUP[it.group]||{})[c.act]||GIT_DIR_ACT_TITLE[c.act]||GIT_ACT_TITLE[c.act],
        kind:'ghost',size:'lg',cls:'git-file-act',dataset:{act:c.act},
        onClick:ev=>{ev.stopPropagation();this.p._dirBulk(it.group,it.path,c.act)}}));
    }
    d.addEventListener('click',()=>{
      if(this.p._dirCollapsed.has(key)) this.p._dirCollapsed.delete(key);
      else this.p._dirCollapsed.add(key);
      this.p._paint();
    });
    return d;
  }

  /**
   * FR-GIT-211: 트리의 들여쓰기와 **깊이 세로선**.
   *
   * 트리 행은 중첩 DOM 이 아니라 패딩으로 들여쓴 평평한 목록이다 — 조상 요소가
   * 없으니 선을 걸 자리도 없다. 그래서 깊이를 행에 실어 CSS 가 배경으로 그 수만큼
   * 반복해 그린다. 패딩도 CSS 가 같은 깊이에서 계산한다 (FR-OPT-1-12) — 종전에는
   * 패딩을 JS 상수(6)로, 선을 CSS 토큰(9)으로 세워 둘이 3px 어긋났다.
   */
  _indent(el,depth){
    el.style.setProperty('--git-depth',depth||0);
  }

  _rowEl(group,e,depth){
    const d=document.createElement('div');
    // 충돌 행은 따로 구분한다 (FR-GIT-37). M1 은 표시만 한다.
    d.className='git-file'+(e.conflict?' conflict':'');
    // FR-GIT-70: staged 와 unstaged 를 동시에 가진 파일은 일부만 스테이지된 것이다.
    const partial=!!(e.staged&&e.unstaged);
    if(partial) d.classList.add('partial');
    d.dataset.path=e.path; d.dataset.group=group;
    if(e.origPath) d.dataset.origPath=e.origPath;
    this._indent(d,depth);
    // FR-GIT-187·189: 선택은 행 자체다 (체크박스 없음). 선택(`sel`)과 포커스
    // (`cur`, 미리보기 대상)를 나눈다 — 같게 그리면 미리보기가 어느 행을 보이는지
    // 알 수 없다.
    if(this.p._sel.has(this.p._selKey(group,e.path))) d.classList.add('sel');
    const cur=this.p.previewFile;
    if(cur&&cur.group===group&&cur.path===e.path) d.classList.add('cur');
    // FR-GIT-190: 일부만 스테이지된 상태는 상태 문자 색으로 알린다.
    // FR-STC-1·2: 그 위에 상태별 색이 얹힌다. 문자를 클래스로도 실어 CSS 가
    // 색을 정한다 — 색표를 스타일 한 곳에 두기 위해서다 (FR-STC-3).
    const ch=this._stateChar(group,e);
    const st=document.createElement('span');
    st.className='git-file-st st-'+(GIT_ST_CLASS[ch]||'other');
    st.textContent=ch;
    const p=document.createElement('span'); p.className='git-file-path';
    this._fillPath(p,e);
    // FR-DIR-20: 디렉터리 항목은 종류까지 밝힌다 — 서브모듈과 중첩 저장소는
    // 사용자가 할 수 있는 일이 다르다.
    if(e.dir) d.classList.add('dir-entry');
    d.title=(e.origPath?e.origPath+' → '+e.path:e.path)+(e.score?' ('+e.score+'%)':'')+
      (partial?' — '+GIT_PARTIAL_TITLE:'')+
      // SUBMODULE_DIRTY_NOTICE_SRS FR-SDN-8: 서브모듈 행은 **여기서 처리될 수
      // 있는지**까지 말한다. 종전 문장은 "다른 저장소다" 만 말했고, 사용자가
      // 부딪힌 것은 "눌러도 사라지지 않는다" 였다 (SRS §1.1).
      (e.dir?' — '+this._dirTitle(e):'');
    d.appendChild(st); d.appendChild(p);
    // 행 인라인 동작 (FR-GIT-64·65·89). 그룹이 할 수 있는 것만 붙인다.
    const acts=document.createElement('span'); acts.className='git-file-acts';
    for(const c of this._actCols(GIT_ROW_ACTS[group]||[])){
      if(!c.act){acts.appendChild(this._actGap());continue}
      const a=c.act;
      // ours·theirs 는 진행 중인 조작에 따라 뜻이 뒤집힌다 (FR-GIT-224).
      // FR-CMG-5: 폐기의 뜻은 그 행의 출신이 정한다 — 새 파일의 폐기는 삭제다.
      let title=(a==='ours'||a==='theirs')
        ? (GIT_SIDE_TITLE[this.p._op()]||GIT_SIDE_TITLE[''])[a]
        : ((e.untracked&&GIT_ACT_TITLE_UNTRACKED[a])||GIT_ACT_TITLE[a]);
      /**
       * SUBMODULE_DIRTY_NOTICE_SRS FR-SDN-12·13 (D-2a): 담을 몫이 없으면 끈다 — 안쪽만 더러운
       * 서브모듈(상태 B)에서 `git add` 는 index 에 올릴 것이 없다.
       *
       * REFACTOR3_FE_REST1_SRS FR-FR1-9 (FU-17, 사용자 결정 Q3):
       *   이전 동작: 화면이 `gitSubParts(e.sub)` 로 판정했고 서버는 그 요청을 200 으로 받았다
       *   새  동작: 서버의 행 답(`rowActions`)이 끈다. 서버도 같은 함수로 409 거절한다
       *   이유:     판정이 한 벌이다 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-3·6)
       */
      const offTitle=a==='stage'?this._stageOff(e):'';
      const off=!!offTitle;
      if(off) title=offTitle;
      // `ours`·`theirs` 는 어휘이지 아이콘이 아니다 (FR-GLY-8) — 정사각이 아니다.
      const b=UIKit.button(GIT_ACT_ICON[a]
        ?{icon:GIT_ACT_ICON[a],title,kind:'ghost',size:'lg',cls:'git-file-act',dataset:{act:a},disabled:off}
        :{label:GIT_ACT_LABEL[a],title,kind:'ghost',size:'lg',cls:'git-file-act git-act-word',dataset:{act:a},disabled:off});
      b.addEventListener('click',ev=>{
        ev.stopPropagation();
        // FR-GIT-236: Open File 은 선택을 끌어오지 않는다 — `_rowTargets` 는 쓰기
        // 동작의 규약이고, 그것을 그대로 쓰면 고른 수만큼 편집기 탭이 열린다.
        this.p._run(a, a==='openFile'
          ? [this.p._target(group,e)]
          : this.p._rowTargets(a,group,e.path,e.origPath,e.untracked));
      });
      acts.appendChild(b);
    }
    d.appendChild(acts);
    /**
     * REPO_TAB_UNIFY_SRS FR-RTU-40 (사용자 지시 2026-09-04): **한 번 클릭이 연다.**
     *
     *   이전 동작: 한 번 클릭은 고르기만, 더블클릭이 본문을 열었다
     *   새  동작: 한 번 클릭이 고르고 **곧바로 본문에 diff 를 연다.**
     *             더블클릭 계기는 없다
     *   이유:     VSCode 와 동치다 (사용자 지시). 사이드의 인라인 미리보기를
     *             걷었으므로(FR-RTU-20) 클릭의 결과를 보일 자리가 본문뿐이고,
     *             더블클릭을 남기면 "한 번 눌렀는데 아무 일도 없다" 가 된다
     *
     * FR-RTU-51: 새 파일은 diff 가 아니라 편집기로 연다 — 비교할 왼쪽이 없다.
     *
     * **보조키 클릭은 열지 않는다.** Cmd·Shift 는 여러 개를 고르는 손짓이고
     * (FR-GIT-69), 고를 때마다 본문이 갈리면 무엇을 고르는 중인지 알 수 없다.
     */
    d.addEventListener('click',ev=>{
      this.p._select(group,e,ev);
      if(ev&&(ev.metaKey||ev.ctrlKey||ev.shiftKey)) return;
      // FR-RTU-51 (개정): 비교의 왼쪽이 없는 행만 편집기다 — 판정은 그룹이 아니라
      // **항목**이 준다 (`_noBaseline`).
      if(this.p._noBaseline(group,e)&&this.p._openInEditor(e)) return;
      this.p.openView('diff');
    });
    // UX_BATCH12_SRS FR-RTB-6 ③ (D-RTU-23 개정): 더블클릭은 앞선 클릭이 연 탭을 고정한다.
    d.addEventListener('dblclick',ev=>{
      if(!this.p.root||ev.metaKey||ev.ctrlKey||ev.shiftKey) return;
      if(this.p._noBaseline(group,e)){ if(!e.dir) this.app.edPinTabFor(this.p.absPath(e)); return }
      this.app.gitDiffPin(this.p.root,this.p._diffTarget(),!!this.p.commitFile);
    });
    d.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      GitMenu.open('file',this.p._target(group,e),ev);
    });
    return d;
  }

  /**
   * FR-GIT-237: 경로 표시를 디렉터리와 파일명으로 가른다.
   *
   * **합쳐진 글자는 바뀌지 않는다** — 요소를 나누는 것이지 글자를 바꾸는 것이
   * 아니다. 대비는 색과 굵기로 내고 색은 테마 변수에서 파생한다 (`style.css`).
   */
  _fillPath(p,e){
    const seg=full=>{
      const i=full.lastIndexOf('/');
      // 디렉터리가 없는 경로는 그 요소를 **만들지 않는다** — 빈 요소가 자리를
      // 먹으면 안 된다.
      if(i>=0){
        const d=document.createElement('span');
        d.className='git-file-path-dir'; d.textContent=full.slice(0,i+1);
        p.appendChild(d);
      }
      const n=document.createElement('span');
      n.className='git-file-path-name'; n.textContent=full.slice(i+1);
      p.appendChild(n);
    };
    // rename/copy 는 원본과 대상을 둘 다 보인다 (FR-GIT-36) — 같은 규칙을 두 번
    // 적용하고 화살표만 가장 약하게 둔다. 예외를 만들지 않는다.
    if(e.origPath){
      seg(e.origPath);
      const a=document.createElement('span');
      a.className='git-file-path-arrow'; a.textContent=' → ';
      p.appendChild(a);
      seg(e.path);
      return;
    }
    // 트리 보기는 디렉터리가 이미 행으로 갈려 있어 파일명만 남는다.
    seg(this.p._treeMode()?e.path.split('/').pop():e.path);
    // GIT_DIR_ENTRY_SRS FR-DIR-20: 디렉터리 항목임을 접미 `/` 로 보인다.
    // **판정은 서버의 `dir` 에서 온다** (D-DIR-1) — 경로 문자열로 판정하면
    // 판정 자리가 둘이 된다. 그래서 서버는 경로에서 슬래시를 벗겨 보내고
    // (FR-DIR-2), 표시가 필요한 여기서만 다시 붙인다.
    if(e.dir){
      const s=document.createElement('span');
      s.className='git-file-path-dirmark'; s.textContent=GIT_DIR_ENTRY_SUFFIX;
      p.appendChild(s);
    }
  }

  /**
   * FR-SDN-5·7: 디렉터리 행의 툴팁 문장.
   *
   * 판정은 `gitSubParts` 하나가 하고(FR-SDN-2), 갈래도 미리보기 안내
   * (`_dirEntryNote`)와 **같은 모양**이다 — 두 자리가 다른 구조를 가지면 상태가
   * 하나 늘 때 한쪽만 고쳐진다.
   *
   * 성분이 하나도 없으면(`S...`) 종전 문장 그대로다: 그 행이 왜 목록에 있는지
   * 알지 못하며, 모르는 것에 대해 말하지 않는다 (FR-SDN-7).
   */
  /** FR-FR1-9: 행의 Stage 가 꺼졌으면 그 사유(영어 툴팁), 켜져 있으면 ''. 답이 없는 행은 켜진다. */
  _stageOff(e){
    const a=this.p.rowActionOf(e.path,GIT_ACTION.stage);
    if(!a) return '';
    const s=actionState(a,false);
    return s.enabled?'':(GIT_STAGE_WHY_TITLE[a.why]||s.why);
  }

  _dirTitle(e){
    if(!e.sub) return GIT_DIR_ENTRY_TITLE_NESTED;
    const p=gitSubParts(e.sub);
    if(p.commit&&p.inner) return GIT_SUB_TITLE_BOTH;
    if(p.commit) return GIT_SUB_TITLE_COMMIT;
    if(p.inner) return GIT_SUB_TITLE_INNER;
    return GIT_DIR_ENTRY_TITLE_SUB;
  }

  // 상태문자의 규칙은 탐색기와 **한 출처**를 쓴다 (FR-RST-22) — 두 화면이 같은
  // 사실을 다른 문자로 말하지 않게 하는 자리다.
  /**
   * 동작 목록을 **열**로 편다 (`GIT_ACT_COLS`).
   *
   * 돌려주는 것은 열 하나마다 `{act}` 또는 `{}`(자리지킴)다. 열에 없는 동작
   * (`ours`·`theirs`)은 앞에 그대로 실린다 — 글자 버튼이라 폭이 다르고, 뒤에 두면
   * 오른쪽 세 열이 그 폭만큼 밀린다.
   *
   * 목록이 비면 빈 배열이다: 정렬할 버튼이 하나도 없으면 맞출 열도 없다
   * (FR-DBA-1 의 conflicts 폴더 행이 그 자리다).
   */
  _actCols(have,cols){
    if(!have||!have.length) return [];
    const use=cols||GIT_ACT_COLS;
    const set=new Set(have),out=[];
    const inCol=new Set([].concat(...use));
    for(const a of have) if(!inCol.has(a)) out.push({act:a});
    for(const col of use) out.push({act:col.find(a=>set.has(a))||null});
    return out;
  }

  // 클릭 대상이 아니고 읽히지도 않는다 — 열 하나의 자리만 차지한다.
  _actGap(){
    const g=document.createElement('span');
    g.className='git-act-gap'; g.setAttribute('aria-hidden','true');
    return g;
  }

  _stateChar(group,e){ return gitStateChar(group,e) }

  _toggleGroup(key){
    if(this.p._collapsed.has(key)) this.p._collapsed.delete(key); else this.p._collapsed.add(key);
    this.p._paint();
  }

  // FR-GIT-42: 목록 끝이 보일 때마다 다음 덩어리를 이어 그린다. 골격을 다시 세우면 관측기도 새로 선다.
  _watchMore(files){
    if(this._io) this._io.disconnect();
    if(typeof IntersectionObserver!=='undefined'){
      this._io=new IntersectionObserver(es=>{
        for(const e of es) if(e.isIntersecting) this._growGroup(e.target.dataset.group);
      },{root:files});
    }
  }

  _growGroup(key){
    if(!key) return;
    this.p._shown.set(key,(this.p._shown.get(key)||GIT_FILE_ROW_CHUNK)+GIT_FILE_ROW_CHUNK);
    this.p._paint();
  }

  /**
   * UX_BATCH12_SRS FR-FHL-10: 그 행이 **보이게** 한다 — 접힌 그룹·트리 폴더를 펴고, "더 보기" 뒤에
   * 있으면 그 행까지 그린 뒤 스크롤한다. 목록이 숨어 있으면 스크롤하지 못하므로 false 다.
   */
  revealRow(group,path){
    let paint=this.p._collapsed.delete(group);
    if(this.p._treeMode()){
      const parts=path.split('/');
      for(let i=1;i<parts.length;i++) if(this.p._dirCollapsed.delete(group+':'+parts.slice(0,i).join('/'))) paint=true;
    }
    const n=this.p._fileList().filter(e=>e.group===group).length;
    if(paint) this.p._paint();
    const el=this.p._els.get('changes'); if(!el) return false;
    const q='.git-group[data-group="'+group+'"] .git-file[data-path="'+CSS.escape(path)+'"]';
    let row=el.querySelector(q);
    while(!row&&(this.p._shown.get(group)||GIT_FILE_ROW_CHUNK)<n){
      this.p._shown.set(group,(this.p._shown.get(group)||GIT_FILE_ROW_CHUNK)+GIT_FILE_ROW_CHUNK);
      this.p._paint(); row=el.querySelector(q);
    }
    if(!row||!row.offsetParent) return false;
    row.scrollIntoView({block:'nearest'});
    return true;
  }
}
