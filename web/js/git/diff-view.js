/**
 * recovery hint 의 명령에 넣을 경로를 감싼다 (FR-GIT-92). 저장소에는 공백·따옴표·
 * 한글이 든 경로가 있고, 사용자가 그 명령을 **붙여 그대로 실행**하므로 셸이 읽는
 * 형태여야 한다.
 */
/**
 * `gitHunkSpan` 이 여기 있었다 (FR-GIT-278) — 조각 머리의 텍스트 한 조각을 만드는
 * 함수였다. 하단 조각 목록이 폐기되면서(DIFF_HUNK_BAR_SRS FR-DHB-2) 부르는 자리가
 * 없어졌다.
 *
 * **그 함수가 지킨 규약은 남는다**: 사용자의 파일 내용이 닿는 자리는 언제나
 * `textContent` 다 (NFR-DHB-3). 새 코드에서 그 자리는 Diff 탭 머리의 안내
 * 한 줄(`_hunkNote`)과 revert 확인 대화의 대상 라벨이다.
 */

function gitShQuote(p){
  const s=String(p==null?'':p);
  if(/^[A-Za-z0-9._\/@=+:,-]+$/.test(s)) return s;
  return "'"+s.replace(/'/g,"'\\''")+"'";
}

/**
 * 바이트 수를 사람이 읽는 한 조각으로 만든다. 나누는 단위는 상태바·전송량 표시와
 * 같은 1024 계열이다 — 같은 화면 안에서 두 계산법이 섞이면 값이 어긋나 보인다.
 */
function gitFmtBytes(n){
  const b=Number(n)||0;
  if(b<1024) return b+' B';
  if(b<1048576) return (b/1024).toFixed(1)+' KB';
  if(b<1073741824) return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(1)+' GB';
}

/**
 * 본문을 그리지 못하는 쪽의 메타 한 줄 (FR-GIT-46·47·48).
 *
 * LFS 포인터는 **가리키는 객체**의 oid·크기다 — 포인터 파일 자신의 134 B 는
 * 사용자가 묻는 것이 아니다. 서버가 싣지 않은 값은 만들지 않는다.
 */
function gitBlobMeta(side){
  const s=side||{};
  if(s.kind===GIT_LFS_KIND){
    const oid=s.lfsOid?GIT_LFS_OID_PREFIX+s.lfsOid.slice(0,GIT_LFS_OID_ABBREV)+'…':'';
    const size=s.lfsSize?gitFmtBytes(s.lfsSize):'';
    return [oid,size].filter(Boolean).join(GIT_META_SEP);
  }
  if(GIT_META_SIZED.has(s.kind)) return s.size?gitFmtBytes(s.size):'';
  return '';
}

/**
 * 양쪽 메타를 안내 아래 줄들로 만든다. 같으면 한 줄이다 — 같은 값을 두 번 보이면
 * 사용자는 두 쪽이 다르다고 읽는다.
 */
function gitBlobMetaLines(orig,mod){
  const a=gitBlobMeta(orig),b=gitBlobMeta(mod);
  if(a&&b&&a!==b){
    return [GIT_META_SIDE.orig+GIT_META_LABEL_SEP+a,GIT_META_SIDE.mod+GIT_META_LABEL_SEP+b];
  }
  return [a||b].filter(Boolean);
}

/**
 * Monaco DiffEditor 한 개를 감싼다 (FR-GIT-43) — diff 하이라이트를 자체
 * 구현하지 않는다.
 *
 * Changes 탭의 미리보기와 Diff 탭은 같은 것을 다른 크기로 보이는 것이므로 이
 * 클래스를 두 번 인스턴스화한다 (§3.2).
 *
 * 인스턴스는 탭·리포 전환에서 반드시 정리된다 (FR-GIT-56) — Monaco 에디터는
 * DOM 을 떼는 것으로 해제되지 않고, 남으면 모델과 리스너가 누적된다.
 */
class GitDiffView {
  constructor(opts){
    const o=opts||{};
    this._breakpoint=o.inlineBreakpoint||GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint;
    this._sideBySide=o.sideBySide!==false;
    this._ignoreWs=!!o.ignoreWhitespace;
    // FR-DOR-2: 기본은 접지 않는다. 접힌 문서의 개요 눈금은 실제 파일의 줄
    // 위치와 어긋난다.
    this._fold=!!o.hideUnchanged;
    // stale 판정의 절반은 바깥(세대·리포)이 안다. 나머지 절반은 자기 일련번호다
    // (FR-GIT-54).
    this._isStale=o.isStale||(()=>false);
    // REPO_TAB_UNIFY_SRS FR-RTU-53·55: 편집의 두 계기를 밖으로 알린다. 이 클래스는
    // 탭도 관측도 모른다 — 아는 쪽(GitPanel)이 그것을 받아 처리한다.
    this.onDirty=o.onDirty||null;
    this.onSaved=o.onSaved||null;
    // DIFF_HUNK_BAR_SRS D-4: **이 클래스가 여는 것은 훅 하나다.** 에디터가 서거나
    // 사라졌다는 사실은 여기가 알고, 그 위에 무엇을 붙일지는 부르는 쪽이 안다 —
    // hunk 관측을 이 안에 넣으면 "탭도 관측도 모른다" 는 원칙이 깨진다.
    this.onEditor=o.onEditor||null;
    this._seq=0; this._dead=false;
    this._editor=null; this._orig=null; this._mod=null;
    this._el=document.createElement('div');
    this._el.className='git-diff-view';
    this._el.innerHTML='<div class="git-diff-note"></div><div class="git-diff-host"></div>';
    this._note=this._el.querySelector('.git-diff-note');
    this._host=this._el.querySelector('.git-diff-host');
  }

  get el(){return this._el}

  // (리포, 축, 경로, 리비전) 을 받아 내용을 불러 그린다. stale 가드를 자기가 건다.
  // 리비전(oid·parentOid)은 커밋 축만 쓴다 (FR-GIT-138).
  async show(target,token){
    const seq=++this._seq;
    // FR-GLV-6: 새 시도는 거부 표식을 지우고 시작한다 — 대상이 바뀌었거나
    // 사용자가 다시 부른 것이며, 지난번의 거부가 그것을 막아서는 안 된다.
    this._refused=false;
    if(!target||!target.repo||!target.path){this.clear(GIT_PREVIEW_HINT);return}
    /**
     * FR-RPT-1 의 정신: **바깥 계기의 다시 받기는 화면에 자기 흔적을 남기지 않는다.**
     *
     * `reloadDiff` 는 관측 회차마다 부른다 (FR-GLV-1). 그때마다 "불러오는 중" 을
     * 세우면 그 글자가 폴링 주기로 나타났다 사라진다 — 접수한 말이 "diff 를 열면
     * 상단에 불러오는중이 계속 깜빡인다" 이고, 원인이 정확히 이 한 줄이다.
     *
     * 그릴 것이 이미 서 있으면 조용히 받는다. 결과는 `_draw` 가 얹고, 실패하면
     * `clear` 가 사유를 그 자리에 남긴다 — 알릴 것이 있을 때만 글자가 바뀐다.
     */
    if(!this._editor) this._setNote(GIT_LOADING_HINT);
    // Monaco 로드 실패는 밖으로 던지지 않는다 — Git 창의 나머지가 계속 동작해야
    // 한다 (FR-GIT-55).
    const loaded=await loadMonaco().then(()=>true,e=>{
      console.error('[GitDiffView] monaco load failed:',e); return false;
    });
    if(this._stale(seq,token)) return;
    if(!loaded){this.clear(GIT_DIFF_MONACO_FAIL);return}
    const d=await this._fetch(target);
    if(this._stale(seq,token)) return;
    if(!d.ok){this._refused=!!d.refused; this.clear(d.msg);return}
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔
    // 수 있다 (FR-GIT-54).
    const q=d.body.requested||{};
    if(q.repo!==target.repo||q.axis!==target.axis||q.path!==target.path) return;
    // 리비전까지 본다 — 머지 커밋에서 비교 부모를 바꿨을 때 이전 응답이 화면에
    // 닿아서는 안 된다 (FR-GIT-54·145).
    if((q.oid||'')!==(target.oid||'')||(q.parentOid||'')!==(target.parentOid||'')) return;
    const a=d.body.original||{},b=d.body.modified||{};
    // 한쪽이라도 본문이 없으면 에디터를 만들지 않고 서버가 준 사유를 보인다
    // (FR-GIT-46·47·48).
    if(!GIT_DIFF_DRAWABLE.has(a.kind)||!GIT_DIFF_DRAWABLE.has(b.kind)){
      // 그릴 수 없는 종류(바이너리·상한 초과)다. 다시 물어도 같은 답이므로
      // 폴링이 이것을 매 회차 다시 받지 않는다 (FR-GLV-6).
      this._refused=true;
      this.clear(d.body.note||GIT_DIFF_LOAD_FAIL,gitBlobMetaLines(a,b)); return;
    }
    this._draw(target.path,a.content||'',b.content||'',d.body.note||'',target);
  }

  // 본문 대신 안내를 보인다. 에디터와 모델은 함께 버린다 (FR-GIT-56).
  //
  // GIT_DIR_ENTRY_SRS FR-DIR-22: `acts` 는 그 안내에 딸린 진입점이다
  // (`[{label,title,run}]`). **무엇을 띄울지는 이 클래스가 정하지 않는다** —
  // 여기는 diff 를 그리는 자리이고, 사유와 갈 길은 부른 쪽이 안다.
  clear(message,meta,acts){
    this._seq++;
    this._setNote(message||'',meta,acts);
    // 에디터를 버리기 **전에** 알린다 — 받은 쪽이 위젯을 떼야 하고, dispose 된
    // 에디터에는 뗄 수도 없다 (FR-GIT-56).
    if(this._editor&&this.onEditor) this.onEditor(null);
    if(this._editor){this._editor.dispose();this._editor=null}
    this._dropModels(this._orig,this._mod);
    this._orig=null; this._mod=null;
    this._drawnKey=null;
    this._host.innerHTML='';
  }

  setSideBySide(on){ // FR-GIT-51
    this._sideBySide=!!on;
    if(this._editor) this._editor.updateOptions({renderSideBySide:this._sideBySide});
  }

  setIgnoreWhitespace(on){ // FR-GIT-50 의 사용자 토글
    this._ignoreWs=!!on;
    if(this._editor) this._editor.updateOptions({ignoreTrimWhitespace:this._ignoreWs});
  }

  setHideUnchanged(on){ // FR-DOR-3
    this._fold=!!on;
    if(this._editor) this._editor.updateOptions({hideUnchangedRegions:{enabled:this._fold}});
  }

  layout(){ if(this._editor) this._editor.layout() }

  destroy(){ this._dead=true; this.clear('') }

  _stale(seq,token){return this._dead||seq!==this._seq||this._isStale(token)}

  async _fetch(target){
    let u='/api/git/diff-content?repo='+encodeURIComponent(target.repo)+
      '&axis='+encodeURIComponent(target.axis)+'&path='+encodeURIComponent(target.path);
    if(target.origPath) u+='&origPath='+encodeURIComponent(target.origPath);
    // 커밋 축만 리비전을 싣는다 (FR-GIT-138). oid 는 필수이고, parentOid 가 비면
    // 루트 커밋이다 — 서버가 그것을 absent 로 답한다.
    if(target.oid) u+='&oid='+encodeURIComponent(target.oid);
    if(target.parentOid) u+='&parentOid='+encodeURIComponent(target.parentOid);
    // FR-GRF-6: 조회에는 시한이 있다.
    const r=await apiGet(u,{timeout:GIT_STATUS_FETCH_TIMEOUT_MS});
    const d=r.data;
    // 닿지 못한 것과 거부당한 것을 가른다 (UX_BATCH6_SRS FR-GLV-6). 앞은
    // 일시적일 수 있고 뒤는 다시 물어도 같은 답이 온다.
    if(r.status===0||!d) return {ok:false,msg:GIT_DIFF_LOAD_FAIL};
    if(!r.ok) return {ok:false,refused:true,msg:GIT_DIFF_ERR[d.error]||GIT_DIFF_LOAD_FAIL};
    return {ok:true,body:d};
  }

  _draw(path,orig,mod,note,target){
    /**
     * UX_BATCH6_SRS FR-GLV-3: **내용이 그대로면 모델을 갈지 않는다.**
     *
     * 폴링이 나른 재적재(FR-GLV-1)는 대부분 같은 값을 가져온다. 그때마다
     * `createModel` → `setModel` 을 지나면 커서·스크롤·접힘이 매 회차 원점으로
     * 돌아가 화면을 읽을 수 없다 — 실시간 갱신을 얻으려다 읽기를 잃는 거래다.
     *
     * 근거에 **대상**을 함께 넣는다. 내용만 보면 내용이 같은 다른 파일로 옮겼을 때
     * 건너뛰어, `_bindEdit` 이 앞 파일의 절대경로를 든 채로 남는다.
     *
     * 편집 중이면 애초에 여기 닿지 않는다 (`_showTarget` 의 dirty 가드).
     */
    const key=this._drawKey(target,path);
    if(this._editor&&this._orig&&this._mod&&!this._dirty&&this._drawnKey===key
      &&this._orig.getValue()===orig&&this._mod.getValue()===mod){
      this._setNote(note);
      return;
    }
    this._drawnKey=key;
    this._setNote(note);
    const lang=monacoLang(path);
    if(!this._editor){
      this._editor=monaco.editor.createDiffEditor(this._host,Object.assign({},GIT_DIFF_OPTIONS,{
        renderSideBySide:this._sideBySide,
        renderSideBySideInlineBreakpoint:this._breakpoint,
        ignoreTrimWhitespace:this._ignoreWs,
        hideUnchangedRegions:{enabled:this._fold},
        theme:monacoTheme(),
      }));
      // 생성은 한 번뿐이다 — 아래 setModel 이 대상마다 모델만 갈아끼운다. 그래서
      // 이 훅도 에디터의 수명에 한 번 돈다 (FR-DHB-21·22).
      if(this.onEditor) this.onEditor(this._editor.getModifiedEditor());
    }
    const prevO=this._orig,prevM=this._mod;
    this._orig=monaco.editor.createModel(orig,lang);
    this._mod=monaco.editor.createModel(mod,lang);
    this._editor.setModel({original:this._orig,modified:this._mod});
    // 이전 모델은 새 모델을 붙인 뒤에 버린다 — 먼저 버리면 에디터가 사라진 모델을
    // 읽는다 (FR-GIT-56).
    this._dropModels(prevO,prevM);
    // REPO_TAB_UNIFY_SRS FR-RTU-50: 오른쪽이 **디스크의 파일**인 축에서만 편집을
    // 연다. 판정은 `GIT_AXIS_EDITABLE` 한 자리이며 여기서 다시 세지 않는다.
    this._bindEdit(target);
    TIMERS.frame(()=>this.layout(),{owner:this,label:'diff-layout'});
    // FR-GLV-1: **내용이 실제로 바뀐 회차에만** 알린다. 조각(hunk) 관측처럼 이
    // 본문에서 파생되는 것들이 그때만 다시 받으면 되고, 그러지 않으면 폴링마다
    // 두 번째 요청이 따라붙는다.
    if(this.onChanged) this.onChanged();
  }

  // 그린 대상의 식별자. `_showTarget` 의 키와 같은 축이되 `origPath` 는 빼지
  // 않는다 — 이름이 바뀐 파일도 다른 대상이다.
  _drawKey(target,path){
    const t=target||{};
    return [t.repo||'',t.axis||'',path||'',t.origPath||'',t.oid||'',t.parentOid||''].join('\u0000');
  }

  /**
   * FR-RTU-50·52·53·54: diff 의 오른쪽을 고치고 저장하는 자리.
   *
   * **저장은 `/api/file/write` 다** — 편집기 탭이 쓰는 그 경로다 (FR-RTU-52).
   * 새 쓰기 표면을 만들면 같은 파일을 두 길로 쓰게 되고 dirty·충돌 규약이 둘로
   * 갈린다.
   */
  _bindEdit(target){
    const axis=(target&&target.axis)||'';
    const abs=this._absPath(target);
    const editable=!!(abs&&GIT_AXIS_EDITABLE.has(axis));
    this._editable=editable;
    this._editTarget=editable?abs:'';
    this._dirty=false;
    this._editor.updateOptions({readOnly:!editable,originalEditable:false});
    if(!editable) return;
    const me=this._editor.getModifiedEditor();
    // FR-RTU-54: 읽기 전용 쪽을 고치려 하면 **사유를 말한다.** 왼쪽(원본)은 어느
    // 축에서도 고칠 수 없다 — 그것은 비교 대상이지 파일이 아니다.
    this._mod.onDidChangeContent(()=>{
      if(this._dirty) return;
      this._dirty=true;
      if(this.onDirty) this.onDirty(true);
    });
    me.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>this.save());
  }

  // 대상의 절대경로. 저장소 루트와 상대경로에서 만든다 — 서버가 그 둘을 주므로
  // 여기서 다시 물을 이유가 없다.
  _absPath(target){
    if(!target||!target.repo||!target.path) return '';
    return pathJoin(target.repo,target.path);
  }

  async save(){
    if(!this._editable||!this._dirty||!this._editTarget||!this._mod) return false;
    const content=this._mod.getValue();
    const r=await apiPost('/api/file/write',{path:this._editTarget,content});
    if(!r.ok){
      this._setNote(GIT_DIFF_SAVE_FAIL);
      return false;
    }
    this._dirty=false;
    if(this.onDirty) this.onDirty(false);
    // FR-RTU-55: 방금 고친 것이 목록과 색에 곧바로 서야 한다.
    if(this.onSaved) this.onSaved();
    return true;
  }

  // FR-RTU-56: 편집 중인 diff 는 폴링이 덮지 않는다. 사용자가 친 글자가 3초마다
  // 사라지는 화면은 편집기가 아니다.
  get dirty(){ return !!this._dirty }

  // FR-GLV-6: 서버가 **거부한** 대상인가. 폴링의 자동 재적재가 이것을 보고 멈춘다 —
  // 다시 물어도 같은 답이 오는 것을 매초 다시 묻지 않는다. 닿지 못한 것(네트워크)은
  // 여기 포함되지 않는다: 그쪽은 일시적일 수 있다.
  get refused(){ return !!this._refused }

  _dropModels(){
    for(const m of arguments) if(m) m.dispose();
  }

  // 안내 한 줄과 그 아래 메타 줄들 (FR-GIT-46·47·48). 메타는 별도 요소여야
  // 사유와 값이 한 줄로 뭉치지 않는다.
  _setNote(text,meta,acts){
    this._note.textContent=text||'';
    const lines=meta||[];
    for(const line of lines){
      const el=document.createElement('span');
      el.className='git-diff-meta';
      el.textContent=line;
      this._note.appendChild(el);
    }
    const list=acts||[];
    for(const a of list){
      if(!a||!a.label||typeof a.run!=='function') continue;
      const b=document.createElement('button');
      b.className='git-diff-note-act';
      b.textContent=a.label;
      if(a.title) b.title=a.title;
      b.addEventListener('click',()=>a.run());
      this._note.appendChild(b);
    }
    this._note.classList.toggle('vis',!!(text||lines.length||list.length));
  }
}
