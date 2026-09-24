/**
 * 편집기 문서 — 로드·refresh·경로 이동·dirty (REPO_FIX 03 §3A-5·3A-7)
 *
 * 레지스트리(`_edDocs`)와 문서의 자리는 `app-editor-open.js` 의 `edDoc`·`edDocDrop`
 * 이다. 여기 있는 것은 **디스크 내용을 모델에 넣는 일** 전부다 — 첫 뷰가 무엇이든
 * (FileEditor·DocRender·git Diff 뷰) 문서가 모델을 만들고, 외부 변경은 문서 단위로
 * 한 번 읽어 모든 뷰에 알린다. 비동기 응답은 적용 직전 토큰으로 재확인한다
 * (`doc-token.js`).
 */
Object.assign(App.prototype, {

  // 그 경로의 문서 — 만들지 않는다. 계층 밖(ui/)이 레지스트리를 보는 유일한 길이다.
  edDocAt(filePath){ return (this._edDocs&&this._edDocs.get(filePath))||null },

  /**
   * 문서의 모델. 없으면 디스크에서 `decode=1` 로 읽어 만든다(한 문서에 한 번 —
   * 겹친 요청은 같은 약속을 받는다). 응답이 왔을 때 문서가 해제·이동됐거나 그 사이
   * 누가 모델을 만들었으면 만들지 않는다 — 고아 모델이 남지 않는다 (#9).
   */
  edDocLoad(filePath){
    const d=this.edDoc(filePath);
    if(d.model) return Promise.resolve(d.model);
    if(d.loading) return d.loading;
    const tok=docTokenOf(d,filePath);
    d.loading=(async()=>{
      try{
        await loadMonaco();
        const r=await this._edDocRead(filePath,d.encoding);
        if(!r.ok) throw new Error('HTTP '+r.status);
        if(!docTokenValid(tok,this._edDocs)) return d.model||null;
        this._edDocCreate(d,filePath,r);
        return d.model;
      }finally{ d.loading=null }
    })();
    return d.loading;
  },

  // 파일 읽기 — 언제나 판별·변환(`decode=1`). 문서의 인코딩이 정해졌으면 그것으로
  // 강제한다(refresh·live-reload 가 인코딩을 유지한다, §3A-1).
  _edDocRead(filePath,enc){
    const query={path:filePath,decode:'1'};
    if(enc) query.encoding=enc;
    return apiGet('/api/file/read',{query,parse:false});
  },

  // 응답 헤더의 표식·인코딩을 문서에 옮긴다.
  _edDocMeta(d,r){
    const h=r.headers;
    if(!h) return;
    d.stamp=h.get(FILE_STAMP_HEADER)||'';
    const enc=h.get('X-File-Encoding');
    if(enc){
      d.encoding=enc;
      d.bom=h.get('X-File-BOM')==='1';
      d.decodable=h.get('X-File-Decodable')!=='0';
    }
  },

  _edDocCreate(d,filePath,r){
    const uri=monaco.Uri.file(filePath);
    const prev=monaco.editor.getModel(uri);
    // 어느 문서에도 속하지 않는 같은 URI 모델은 고아다 — 다음 열기가 그것을 집으면
    // 낡은 내용·표식 없는 모델을 쓴다 (#9). 버리고 방금 읽은 내용으로 새로 만든다.
    if(prev&&![...this._edDocs.values()].some(x=>x.model===prev)){try{prev.dispose()}catch{}}
    d.model=monaco.editor.createModel(r.text,monacoLang(filePath),uri);
    this._edDocWatch(d);
    this._edDocMeta(d,r);
    d.gen++;
    d.savedAltVer=d.model.getAlternativeVersionId();
    d.dirty=false;
    // 모델을 직접 그리지 않는 뷰(DocRender)에 알린다.
    for(const v of d.views) if(v&&v.onDocModel) v.onDocModel(d.model);
  },

  /**
   * 문서 단위 refresh — 디스크를 한 번 읽어 모델을 갱신하고 모든 뷰에 알린다
   * (E-7.1). dirty 면 읽지 않는다(FR-EXC-3). 응답이 올 때 그 사이 편집·이동·해제가
   * 있었으면 적용하지 않는다(E-3.2) — 저장 왕복 중의 refresh 가 저장 전 내용으로
   * 되돌리지 않는다. 읽기 실패(밖에서 지워졌다)는 화면을 비우지 않는다(FR-EXC-10).
   *
   *   이전 동작: 첫 뷰의 refresh 만 불렀고(DocRender 가 첫 뷰면 소스가 낡았다),
   *             응답 도착 후 재확인이 없었다
   *   새  동작: 문서가 읽고 토큰으로 재확인한 뒤 모든 뷰에 알린다
   *   이유:     #3 #46
   */
  edDocRefresh(filePath){
    const d=this._edDocs&&this._edDocs.get(filePath);
    if(!d||!d.model||d.dirty||d.loading) return Promise.resolve(false);
    const tok=docTokenOf(d,filePath);
    return this._edDocRead(filePath,d.encoding).then(r=>{
      if(!r.ok||!docTokenValid(tok,this._edDocs)) return false;
      this._edDocReplace(d,r);
      return true;
    }).catch(e=>{console.error('[edDoc] refresh error:',e);return false});
  },

  // 디스크 내용을 모델에 넣는다. 내용이 같으면 넣지 않는다 — `setValue` 는 커서와
  // undo 를 버린다(FR-LSP-26b). 칸마다의 시선은 담았다가 되돌린다(FR-ELR-30).
  _edDocReplace(d,r){
    this._edDocMeta(d,r);
    if(d.model.getValue()!==r.text){
      const gazes=this._edDocGazes(d);
      d.model.setValue(r.text);
      for(const g of gazes) this._edDocRestoreGaze(g);
    }
    d.gen++;
    d.savedAltVer=d.model.getAlternativeVersionId();
    this.edDocDirtySync(d);
  },

  // dirty 는 **모델**의 변화에서 잰다 — 편집기 뷰가 없는(DocRender 만 연) 문서도,
  // undo 도 같은 길이다.
  _edDocWatch(d){
    if(d.modelSub){try{d.modelSub.dispose()}catch{}}
    d.modelSub=d.model?d.model.onDidChangeContent(()=>this.edDocDirtySync(d)):null;
  },

  // git Diff 뷰는 편집기 대신 `gazeEditor`(작업 트리 쪽 에디터)를 든다 (REPO_FIX 05 §3A-3).
  _edDocGazes(d){
    const out=[];
    for(const v of d.views){
      const ed=v&&(v._editor||v.gazeEditor);
      if(ed) out.push({ed,sel:ed.getSelection(),top:ed.getScrollTop(),left:ed.getScrollLeft()});
    }
    return out;
  },

  // FR-ELR-31: 짧아져 그 줄이 사라졌으면 가장 가까운 자리로 — 자르는 일은 모델이 한다.
  _edDocRestoreGaze(g){
    const model=g.ed.getModel();
    if(model&&g.sel){
      const a=model.validatePosition({lineNumber:g.sel.selectionStartLineNumber,column:g.sel.selectionStartColumn});
      const b=model.validatePosition({lineNumber:g.sel.positionLineNumber,column:g.sel.positionColumn});
      g.ed.setSelection({selectionStartLineNumber:a.lineNumber,selectionStartColumn:a.column,
        positionLineNumber:b.lineNumber,positionColumn:b.column});
    }
    g.ed.setScrollTop(g.top);
    g.ed.setScrollLeft(g.left);
  },

  /**
   * §3A-7 (E-6.3): dirty = 모델 판(alternativeVersionId) ≠ 저장 시점 판. undo 로
   * 되돌리면 dirty 가 풀린다. 바뀌었으면 그 문서의 모든 뷰 라벨을 고친다.
   */
  edDocDirtySync(d){
    const now=!!(d.model&&d.model.getAlternativeVersionId()!==d.savedAltVer);
    if(now===d.dirty) return;
    d.dirty=now;
    for(const v of d.views) if(v&&v._updateTabLabel) v._updateTabLabel();
  },

  /**
   * §3A-2: 다른 인코딩으로 다시 열기 — 디스크에서 그 인코딩으로 다시 디코드한다.
   * dirty 면 먼저 묻는다(편집을 버린다). 422 encoding_undecodable 이면 문서는 그대로
   * 두고 사유를 보인다.
   */
  async edDocReopen(filePath,enc){
    const d=this.edDocAt(filePath);
    if(!d||!d.model) return false;
    if(d.dirty&&!await this._edEncConfirm(ENC_REOPEN_DIRTY)) return false;
    const tok=docTokenOf(d,filePath);
    const r=await this._edDocRead(filePath,enc);
    if(r.status===422){this._edDocNote(d,t('editor.enc_undecodable',{enc:ENC_LABEL[enc]||enc}));return false}
    if(!r.ok||!docTokenValid(tok,this._edDocs)) return false;
    this._edDocMeta(d,r);
    if(d.model.getValue()!==r.text){
      const gazes=this._edDocGazes(d);
      d.model.setValue(r.text);
      for(const g of gazes) this._edDocRestoreGaze(g);
    }
    d.gen++;
    d.savedAltVer=d.model.getAlternativeVersionId();
    this.edDocDirtySync(d);
    for(const v of d.views){
      if(v&&v._editor) v._editor.updateOptions({readOnly:d.decodable===false});
      else if(v&&v.onDocReadOnly) v.onDocReadOnly(d.decodable===false);
    }
    this.updateStatusBar();
    return true;
  },

  /**
   * §3A-2: UTF-8 로 변환해 저장 — 문서 내용을 `utf-8`·BOM 없음으로 쓴다(경합 검사는
   * 일반 저장과 같다). 확인을 받고, 실패하면 문서의 인코딩을 되돌린다.
   */
  async edDocConvertUtf8(filePath){
    const d=this.edDocAt(filePath);
    if(!d||!d.model||d.decodable===false||(d.encoding==='utf-8'&&!d.bom)) return false;
    if(!await this._edEncConfirm(ENC_CONVERT_CONFIRM)) return false;
    const ui=[...d.views].find(x=>x&&x._noteSaveFailed)||null;
    if(d.savePromise) await d.savePromise;
    const prev={encoding:d.encoding,bom:d.bom};
    d.encoding='utf-8'; d.bom=false;
    const ok=await this._edDocSaveOnce(filePath,d,ui,{force:true});
    if(!ok){d.encoding=prev.encoding;d.bom=prev.bom}
    this.updateStatusBar();
    return ok;
  },

  /**
   * 문서 저장 — 편집기 탭과 git Diff 뷰가 같은 길을 탄다 (REPO_FIX 05 §3A-3 F-2.2).
   * `ui` 는 저장을 부른 뷰다 — 경합 확인·거절 사유를 그 자리에 보인다
   * (`_confirmConflict`·`_noteUnmappable`·`_noteSaveFailed`).
   *
   * REPO_FIX 03 §3A-8 (E-9.3): 저장 진행 중의 저장 요청은 무음으로 버리지 않는다 —
   * 진행 중 저장이 끝나기를 기다린 뒤 그때 dirty 면 한 번 더 저장한다. 대기는 문서
   * 단위 1건이다.
   *
   *   이전 동작: 저장이 FileEditor 안에 있었고, Diff 뷰는 표식·인코딩 없이 따로 썼다
   *   새  동작: 문서 하나에 저장 하나
   *   이유:     같은 파일에 버퍼가 둘이면 dirty·저장·인코딩·경합이 두 벌이다 (N4)
   */
  edDocSave(filePath,ui){
    const d=this.edDocAt(filePath);
    if(!d) return Promise.resolve(false);
    if(d.savePromise){
      if(!d.saveQueued){
        d.saveQueued=d.savePromise.then(ok=>{
          d.saveQueued=null;
          return d.dirty?this.edDocSave(filePath,ui):ok;
        });
      }
      return d.saveQueued;
    }
    const p=this._edDocSaveOnce(filePath,d,ui);
    d.savePromise=p;
    p.finally(()=>{if(d.savePromise===p)d.savePromise=null});
    return p;
  },

  // 저장 하나. **성공 여부를 돌려준다** (FR-EXC-12). `force` 는 dirty 가 아니어도
  // 쓴다 — UTF-8 로 변환해 저장이 그 길이다(03 §3A-2).
  async _edDocSaveOnce(filePath,d,ui,o){
    if(!d.model||(!d.dirty&&!(o&&o.force))) return false;
    // 어느 인코딩으로도 풀리지 않은 문서는 저장하지 않는다(읽기 전용, 03 §3A-1).
    if(d.decodable===false) return false;
    const content=d.model.getValue();
    // FR-EXC-14 / 03 §3A-7: 담아 간 판을 기준으로 삼는다 — 왕복 중 편집이 있으면
    // dirty 가 남는다.
    const sentVer=d.model.getAlternativeVersionId();
    try{
      let r=await this.edDocWrite(filePath,content,d.stamp,d);
      // FR-EXC-5·7·9: 409 는 우리가 읽은 뒤 디스크가 바뀌었다는 뜻이다.
      if(r.status===409){
        if(!ui||!await ui._confirmConflict()) return false;
        r=await this.edDocWrite(filePath,content,'',d);
      }
      if(r.status===422&&r.data&&r.data.error==='encoding_unmappable'){
        if(ui) ui._noteUnmappable(r.data,d);
        return false;
      }
      if(!r.ok){
        if(ui) ui._noteSaveFailed(r);
        return false;
      }
      // 저장 중 문서가 옮겨지거나 해제됐으면 그 문서에 적용하지 않는다(03 §3A-5).
      if(this.edDocAt(filePath)===d){
        d.stamp=(r.data&&r.data.stamp)||'';
        d.savedAltVer=sentVer;
        this.edDocDirtySync(d);
      }
      // 파일 저장은 즉시 신호다 (FR-GIT-18) — 작업 트리가 방금 바뀌었다.
      this.gitSignal('write');
      return true;
    }catch(e){
      console.error('[edDoc] save error:',e);
      if(ui) ui._noteSaveFailed(null);
      return false;
    }
  },

  // 쓰기 한 번. 표식이 비면 필드를 싣지 않는다 — 서버의 관대함(FR-EXC-6a)을
  // 부르는 것이 곧 "검사하지 말라" 이므로, 그 뜻을 한 자리에 모아 둔다.
  // REPO_FIX 03 §3A-2: 문서의 인코딩·BOM 으로 되돌려 쓴다. 판별을 모르면(옛 서버)
  // 싣지 않는다 — 서버가 UTF-8 원문 그대로 쓴다.
  edDocWrite(filePath,content,stamp,d){
    const body={path:filePath,content};
    if(stamp) body.stamp=stamp;
    if(d&&d.encoding){body.encoding=d.encoding;body.bom=!!d.bom}
    return apiPost('/api/file/write',body);
  },

  /**
   * FR-EXC-9: 경합의 확인창. 참이면 덮어쓴다. 편집기 탭과 Diff 뷰가 함께 쓴다.
   *
   * **`디스크 것으로 덮기` 는 두지 않는다** (비목표 3) — 편집본을 확인 없이 버리는
   * 길을 한 걸음 확인창에 둘 수 없다 (FR-COS-1·FR-RTU-103). 초기 포커스는
   * `덮어쓰기` 다 (FR-EXC-9a / FR-PDA-1).
   */
  edConfirmConflict(name,filePath){
    return new Promise(resolve=>{
      let done=false;
      const settle=v=>{if(!done){done=true;resolve(v)}};
      const body=document.createElement('div');
      const nm=document.createElement('div');
      nm.className='fe-conflict-path';
      nm.textContent=name;
      nm.title=filePath;
      const msg=document.createElement('div');
      msg.className='fe-conflict-msg';
      msg.textContent=FILE_CONFLICT_MSG;
      body.appendChild(nm); body.appendChild(msg);
      // 두 버튼 모두 `keepOpen` 이다 — 기본 순서(close 먼저)면 덮어쓰기를 눌러도
      // `onClose` 가 취소로 먼저 접수한다. `Esc`·바깥 클릭은 쓰지 않은 것이다 (FR-PDA-3).
      const m=UIKit.modal({
        cls:'fe-conflict',title:FILE_CONFLICT_TITLE,width:'min(460px,90vw)',body,
        actions:[
          {label:FILE_CONFLICT_CANCEL,kind:'ghost',cls:'fe-conflict-cancel',
            keepOpen:true,onClick:()=>{settle(false);m.close()}},
          {label:FILE_CONFLICT_GO,kind:'danger',cls:'fe-conflict-go',
            keepOpen:true,onClick:()=>{settle(true);m.close()}},
        ],
        onClose:()=>settle(false),
      });
      document.body.appendChild(m.el);
    });
  },

  /**
   * REPO_FIX 05 §3A-3 (F-2.4): dirty 문서의 마지막 뷰가 다른 대상으로 옮겨 가려 한다 —
   * 저장('save')·버리기(true)·취소(false).
   */
  edDocLeaveConfirm(){
    return this._confirmClose(DOC_LEAVE_MSG,{saveBtn:true,saveLabel:DOC_LEAVE_SAVE,okLabel:DOC_LEAVE_DISCARD});
  },

  // 문서를 보는 편집기 하나에 알림을 띄운다.
  _edDocNote(d,text,action){
    for(const v of d.views) if(v&&v._editor&&v.note){v.note(text,action?FE_NOTE_ACTION_MS:0,action);return}
  },

  _edEncConfirm(msg){
    return new Promise(resolve=>{
      let done=false;
      const settle=v=>{if(!done){done=true;resolve(v)}};
      const body=document.createElement('div');
      body.className='fe-enc-msg';
      body.textContent=msg;
      const m=UIKit.modal({
        cls:'fe-enc-confirm',title:ENC_TITLE,width:'min(460px,90vw)',body,
        actions:[
          {label:ENC_CANCEL,kind:'ghost',cls:'fe-enc-cancel',keepOpen:true,onClick:()=>{settle(false);m.close()}},
          {label:ENC_OK,kind:'danger',cls:'fe-enc-go',keepOpen:true,onClick:()=>{settle(true);m.close()}},
        ],
        onClose:()=>settle(false),
      });
      document.body.appendChild(m.el);
    });
  },

  /**
   * §3A-5 (E-5): 이름변경·이동의 **유일한** 문서 API — 04 탐색기와 탭 재지정이
   * 부른다. `from` 이 폴더면 그 아래 문서 전부. 새 경로 URI 의 새 모델로 옮기고
   * undo 이력은 버린다. 내용·dirty·인코딩·표식은 보존한다. 대응 경로에 이미 문서가
   * 있으면 그 항목은 옮기지 않고 충돌로 돌려준다.
   *
   *   이전 동작: 탭·뷰 경로만 바뀌고 레지스트리 키·모델 URI·변경 표시는 옛 경로에
   *             남아 LSP·DocRender·재열기가 옛 경로를 가리켰다(undo 는 남았다)
   *   새  동작: 새 URI 모델, undo 소실, 내용·dirty 보존
   *   이유:     모델 URI 가 경로의 유일한 진실 공급원이다(사용자 결정 E-5.1 ①, #10)
   */
  edDocMove(from,to){
    const out={moved:[],conflicts:[]};
    if(!this._edDocs||!from||!to||from===to) return out;
    const moves=[];
    for(const [p,d] of this._edDocs){
      if(p===from||pathUnder(from,p)) moves.push([p,to+p.slice(from.length),d]);
    }
    for(const [p,np,d] of moves){
      if(this._edDocs.has(np)){out.conflicts.push(np);continue}
      const old=d.model;
      if(old&&typeof monaco!=='undefined'){
        const uri=monaco.Uri.file(np);
        const stray=monaco.editor.getModel(uri);
        if(stray){try{stray.dispose()}catch{}}
        const wasDirty=d.dirty;
        d.model=monaco.editor.createModel(old.getValue(),monacoLang(np),uri);
        this._edDocWatch(d);
        // 옮기기 전 dirty 였으면 저장 전까지 dirty 다 — 판 기준이 새 모델에 없다.
        d.savedAltVer=wasDirty?-1:d.model.getAlternativeVersionId();
        d.dirty=wasDirty;
        d.gen++;
      }
      if(d.dd){d.dd.dispose();d.dd=null}
      this._edDocs.delete(p);
      this._edDocs.set(np,d);
      for(const v of d.views){
        if(!v) continue;
        v.filePath=np;
        if(v._editor&&d.model){
          if(v._ddDrop) v._ddDrop();
          v._editor.setModel(d.model);
          if(v._ddInit) v._ddInit();
        }
        if(v.onDocMoved) v.onDocMoved(np,d.model);
      }
      if(old){
        if(this.lspClearDiagnostics) this.lspClearDiagnostics(old);
        try{old.dispose()}catch{}
      }
      this.lspDocClosed(p);
      out.moved.push([p,np]);
    }
    return out;
  },
});
