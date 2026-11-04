/**
 * GitDiffView — 작업 트리 쪽은 편집기 문서다 (REPO_FIX 05 §3A-3, F-2 — 사용자 결정:
 * VS Code 방식).
 *
 * 편집 가능한 축(`GIT_AXIS_EDITABLE`)에서 Diff 뷰의 오른쪽은 03 의 문서 레지스트리가
 * 가진 그 파일의 모델이다. Diff 뷰는 그 문서의 **뷰 하나**로 들고 난다 — dirty·저장·
 * 인코딩·경합 검사·저장 대기는 문서에 있고 여기에는 없다.
 *
 *   이전 동작: URI 없는 자체 모델로 편집하고 stamp·인코딩 없이 UTF-8 로 썼다 — 같은
 *             파일을 연 편집기와 서로의 입력이 보이지 않았고, 비 UTF-8 파일은 저장에서
 *             깨졌으며, `Cmd+S` 는 모델을 갈 때마다 `addCommand` 로 쌓였다
 *   새  동작: 파일 하나에 문서 하나(FR-SVS-50 의 확장)
 *   이유:     N4·X2, #2·#4
 *
 * 문서 뷰는 GitDiffView 자신이 아니라 **대상마다의 작은 객체**(`_docViewOf`)다 — 레지스트리가
 * 부르는 자리(라벨·경로 이동·읽기 전용·경합 확인·저장 실패)만 갖는다. 내용은 수정본 편집기가 그 문서
 * 버퍼의 칸으로 붙어 나눈다 (CODEMIRROR_MIGRATION_SRS FR-CMR-54).
 */
Object.assign(GitDiffView.prototype, {
  // 편집 가능한 축의 절대경로. 그 밖 축은 '' — 양쪽 모두 자체 문서(읽기 전용)다.
  _shareAbs(target){
    const axis=(target&&target.axis)||'';
    if(!GIT_AXIS_EDITABLE.has(axis)||!window.app||!window.app.edDoc) return '';
    return this._absPath(target);
  },

  /**
   * 대상의 문서 뷰에 들고 모델을 기다린다. 공유하지 않는 축이거나 문서를 얻지
   * 못했으면 null(자체 모델로 읽기 전용), 기다리는 사이 낡았으면 false(그만둔다).
   */
  async _docJoin(target,seq,token){
    const abs=this._shareAbs(target);
    if(!abs) return null;
    let dv=this._dv;
    if(!dv||dv.filePath!==abs){
      dv=this._docViewOf(abs);
      window.app.edDoc(abs).views.add(dv);
    }
    const buf=await window.app.edDocLoad(abs).catch(e=>{
      console.error('[GitDiffView] doc load failed:',e); return null;
    });
    if(this._stale(seq,token)){this._docLeaveIfIdle(dv);return false}
    if(!buf){this._docLeaveIfIdle(dv);return null}
    return dv;
  },

  // 그리지 못한 채 끝난 입장은 곧바로 나간다 — 뷰 없는 문서가 남지 않는다.
  _docLeaveIfIdle(dv){
    if(dv&&dv!==this._dv) window.app.edDocDrop(dv.filePath,dv);
  },

  _docLeave(){
    const dv=this._dv; this._dv=null;
    if(dv) window.app.edDocDrop(dv.filePath,dv);
    // EDITOR_LIVE_RELOAD_SRS FR-ELR-65·66: Diff 문서의 부모 디렉터리도 감시 집합에 든다.
    if(dv) window.app.edWatchSync();
  },

  // 새 칸을 붙인 뒤에 부른다 — 앞 문서의 마지막 뷰였으면 그 버퍼가 여기서 버려진다.
  _docSwitch(dv){
    if(this._dv===dv) return;
    this._docLeave();
    this._dv=dv;
    window.app.edWatchSync();
  },

  _docRec(){
    const dv=this._dv;
    const d=dv&&window.app&&window.app.edDocAt(dv.filePath);
    return d&&d.views.has(dv)?d:null;
  },

  _docBufOf(dv){
    const d=dv&&window.app.edDocAt(dv.filePath);
    return (d&&d.views.has(dv)&&d.buf)||null;
  },

  _docEncOf(dv){
    const d=dv&&window.app.edDocAt(dv.filePath);
    return (d&&d.encoding)||'';
  },

  // 지금 그린 문서의 경로 — 라이브 리로드가 이 문서도 묻는다(`_edVisibleDocPaths`).
  docPath(){ return this._docRec()?this._dv.filePath:'' },

  // 지금 그린 문서의 인코딩 — utf-16 이면 hunk 를 쓸 수 없다 (§3A-3 인코딩).
  docEncoding(){ const d=this._docRec(); return (d&&d.encoding)||'' },

  _docViewOf(abs){
    const me=this;
    const dv={
      filePath:abs,
      // 문서의 dirty 가 바뀌었다 — 누가 쳤든(편집기 탭이어도) 이 뷰의 라벨이 따라온다.
      _updateTabLabel(){ if(me._dv===dv&&me.onDirty) me.onDirty(me.dirty) },
      // 03 `edDocMove`: 버퍼는 그대로이고 경로만 옮겨 간다 (§3A-3 경로 이동).
      onDocMoved(np){ if(me._dv===dv) me._editTarget=np },
      onDocReadOnly(ro){ if(me._dv===dv) me._bindEdit() },
      _confirmConflict(){ return window.app.edConfirmConflict(pathBase(dv.filePath),dv.filePath) },
      _noteUnmappable(u,d){ me._docUnmappable(u,d) },
      _noteSaveFailed(r){ me._docSaveFailed(r) },
    };
    return dv;
  },

  /**
   * 편집 가능 여부를 문서에서 정한다. 문서가 없으면(공유하지 않는 축·로드 실패)
   * 읽기 전용이다. 문서가 어느 인코딩으로도 풀리지 않았으면 읽기 전용 + 사유다.
   */
  _bindEdit(){
    const d=this._docRec();
    this._editable=!!d;
    this._editTarget=d?this._dv.filePath:'';
    const undecodable=!!(d&&d.decodable===false);
    const c=this._cm;
    if(c) c.b.dispatch({effects:c.cmpB.ro.reconfigure(CM.EditorState.readOnly.of(!d||undecodable))});
    if(undecodable) this._setNote(FILE_UNDECODABLE_NOTE);
    // CODEMIRROR_MIGRATION_SRS §11.6 L1: 수정본이 디스크의 파일인 축에서만 LSP 를 붙인다 (`lspPathOf`).
    if(c){
      const path=this.lspPathOf(c.b);
      edCmLspAttach(c.b,c.cmpB,path,()=>this._cm===c&&this.lspPathOf(c.b)===path);
    }
  },

  // FR-EKB-5 / FR-ESV-1·2: 판정은 app 이 한 벌로 갖는 단축키 표이고, 수행은 이 뷰다.
  _viewKey(e){
    if(!this._editable) return false;
    for(const [action,fn] of Object.entries(ED_VIEW_ACTIONS)){
      if(!matchShortcut(e,shortcuts[action])) continue;
      e.preventDefault();
      e.stopImmediatePropagation();
      this[fn]();
      return true;
    }
    return false;
  },

  // 저장은 문서 저장이다(03 — 인코딩·BOM·stamp·409·저장 대기). FR-RTU-55: 성공하면
  // 관측을 곧바로 갱신한다.
  async save(){
    if(!this._editable||!this._dv) return false;
    const ok=await window.app.edDocSave(this._dv.filePath,this._dv);
    if(ok&&this.onSaved) this.onSaved();
    return ok;
  },

  // 03 §3A-2: 문서 인코딩으로 쓸 수 없는 글자가 있다 — 그 자리로 옮기고 변환 저장을 권한다.
  _docUnmappable(u,d){
    const line=Number(u.line)||1,col=Number(u.col)||1;
    const c=this._cm;
    if(c){
      const pos=edCmPos(c.b.state.doc,line,col);
      c.b.dispatch({selection:{anchor:pos},effects:CM.EditorView.scrollIntoView(pos,{y:'center'})});
    }
    const enc=d&&d.encoding?(ENC_LABEL[d.encoding]||d.encoding):'';
    const path=this._dv?this._dv.filePath:'';
    this._setNote(t('editor.enc_unmappable',{line,col,char:u.char||'',enc}),null,
      [{label:ENC_CONVERT,run:()=>window.app.edDocConvertUtf8(path)}]);
  },

  // 서버가 준 사유의 첫 줄을 싣는다 — 없으면 지어내지 않는다 (FileEditor 와 같은 규약).
  _docSaveFailed(r){
    const why=r?(r.text||'').trim().split('\n')[0].slice(0,200):'';
    this._setNote(why?GIT_DIFF_SAVE_FAIL+': '+why:GIT_DIFF_SAVE_FAIL);
  },
});
