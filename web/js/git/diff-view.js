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
  if(s.kind===GIT_SUBMODULE_KIND) return s.oid?s.oid.slice(0,GIT_COMMIT_ABBREV):'';
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
 * CodeMirror 의 merge 뷰 한 개를 감싼다 (FR-GIT-43 · CODEMIRROR_MIGRATION_SRS 묶음 G) — diff
 * 하이라이트를 자체 구현하지 않는다. 넓으면 `MergeView`(나란히), 좁으면 `unifiedMergeView` 편집기
 * 하나(인라인)다 (FR-CMR-50·51).
 *
 * Changes 탭의 미리보기와 Diff 탭은 같은 것을 다른 크기로 보이는 것이므로 이
 * 클래스를 두 번 인스턴스화한다 (§3.2).
 *
 * 인스턴스는 탭·리포 전환에서 반드시 정리된다 (FR-GIT-56) — 편집기는 DOM 을 떼는 것으로
 * 해제되지 않고, 남으면 문서 버퍼의 칸과 리스너가 누적된다.
 */
class GitDiffView {
  constructor(opts){
    const o=opts||{};
    this._breakpoint=o.inlineBreakpoint||GIT_DIFF_INLINE_BREAKPOINT;
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
    // UX_BATCH12_SRS FR-RTB-6 ⑤: 저장하려는 손짓 자체를 알린다 — 수정이 없어도 고정의 계기다.
    this.onSaveIntent=o.onSaveIntent||null;
    // DIFF_HUNK_BAR_SRS D-4: **이 클래스가 여는 것은 훅 하나다.** 에디터가 서거나
    // 사라졌다는 사실은 여기가 알고, 그 위에 무엇을 붙일지는 부르는 쪽이 안다 —
    // hunk 관측을 이 안에 넣으면 "탭도 관측도 모른다" 는 원칙이 깨진다.
    this.onEditor=o.onEditor||null;
    this._absOf=o.absPath||null;
    this._seq=0; this._dead=false;
    // `_cm`: 선 편집기 — `{kind:'split'|'unified', mv?, a?, b, scroller, cmpA?, cmpB, host, wrap}`.
    // `_orig`·`_mod` 는 쪽의 표지다 (`lspPathOf`·e2e 어댑터).
    this._cm=null; this._orig=null; this._mod=null;
    this._el=document.createElement('div');
    this._el.className='git-diff-view';
    this._el.innerHTML='<div class="ui-notice git-diff-note"></div><div class="git-diff-host"></div>';
    this._note=this._el.querySelector('.git-diff-note');
    this._host=this._el.querySelector('.git-diff-host');
    // REPO_FIX 05 §3A-3 (F-2.6): 저장 키는 FileEditor 와 같은 계층(FR-EKB-5)에서
    // 인스턴스당 한 번 건다 — 포커스가 이 뷰 안에 있을 때만 이 뷰의 문서를 저장한다.
    // 검색·코드 탐색 키도 여기서 판정한다 — 편집기 칸의 `_onKeyCapture` 와 같다. 글자를 치는 자리 안의 키는
    // 전역 배선이 앱 단축키를 돌리지 않는다 (input-binding.js 의 `inText`).
    this._el.addEventListener('keydown',e=>{
      if(window.app&&window.app.edTrySearchKey(e)) return;
      this._viewKey(e);
    },true);
    // 작업 트리 쪽이 편집기 문서면 그 문서의 뷰(`diff-view-doc.js`), 아니면 null.
    this._dv=null; this._buf=null;
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
    if(!this._cm) this._setNote(GIT_LOADING_HINT);
    // 편집기 묶음의 로드 실패는 밖으로 던지지 않는다 — Git 창의 나머지가 계속 동작해야
    // 한다 (FR-GIT-55).
    const loaded=await loadCodeMirror().then(()=>true,e=>{
      console.error('[GitDiffView] editor load failed:',e); return false;
    });
    if(this._stale(seq,token)) return;
    if(!loaded){this.clear(GIT_DIFF_EDITOR_FAIL);return}
    // REPO_FIX 05 §3A-3: 편집 가능한 축은 편집기 문서를 먼저 얻고(03 의 문서 로드),
    // 그 인코딩으로 원본 쪽을 받는다. 두 단계 모두 뒤에서 다시 재확인한다.
    const dv=await this._docJoin(target,seq,token);
    if(dv===false) return;
    const bail=()=>this._docLeaveIfIdle(dv);
    const d=await this._fetch(target,this._docEncOf(dv));
    if(this._stale(seq,token)){bail();return}
    if(!d.ok){bail();this._refused=!!d.refused; this.clear(d.msg);return}
    // 서버가 되돌려준 요청값도 확인한다 — 같은 세대 안에서도 응답 순서가 뒤바뀔
    // 수 있다 (FR-GIT-54).
    const q=d.body.requested||{};
    if(q.repo!==target.repo||q.axis!==target.axis||q.path!==target.path){bail();return}
    // 리비전까지 본다 — 머지 커밋에서 비교 부모를 바꿨을 때 이전 응답이 화면에
    // 닿아서는 안 된다 (FR-GIT-54·145).
    if((q.oid||'')!==(target.oid||'')||(q.parentOid||'')!==(target.parentOid||'')){bail();return}
    const a=d.body.original||{},b=d.body.modified||{};
    const mime=d.body.imageMime||'';
    /**
     * M9_SRS FR-M9-20: **그림으로 볼 수 있으면 그림으로 보인다.**
     *
     * 갈래가 둘이다. 그릴 수 없는 종류(이진 그림)는 여기서 끝나고, 그릴 수 있는
     * 그림(SVG)은 텍스트 diff 를 그린 뒤 **전환**을 얹는다 — SVG 는 이미지이면서
     * 문서인 유일한 형식이고 두 물음이 다 선다 (D-M9-12).
     *
     * `_refused` 를 세우지 않는다. 폴링이 다시 받으면 그때 `<img>` 의 주소도 함께
     * 새로 서고, 그것이 "바깥에서 바뀐 그림" 이 화면에 오는 유일한 길이다.
     */
    if(mime&&!GIT_DIFF_DRAWABLE.has(a.kind)){
      bail(); this._drawImage(target,mime,a,b); return;
    }
    // 한쪽이라도 본문이 없으면 에디터를 만들지 않고 서버가 준 사유를 보인다
    // (FR-GIT-46·47·48).
    if(!GIT_DIFF_DRAWABLE.has(a.kind)||!GIT_DIFF_DRAWABLE.has(b.kind)){
      // 그릴 수 없는 종류(바이너리·상한 초과)다. 다시 물어도 같은 답이므로
      // 폴링이 이것을 매 회차 다시 받지 않는다 (FR-GLV-6).
      bail();
      this._refused=true;
      this.clear(d.body.note||GIT_DIFF_LOAD_FAIL,gitBlobMetaLines(a,b)); return;
    }
    if(mime&&this._imgMode){bail();this._drawImage(target,mime,a,b); return}
    this._draw(target.path,a.content||'',b.content||'',d.body.note||'',target,dv);
    if(mime) this._addImageToggle(target,mime,a,b);
  }

  // ── 그림 보기 (M9_SRS FR-M9-20 · D-M9-12·13) ──────────────

  /** 한쪽의 바이트를 가리키는 주소. `<img src>` 가 이것을 그대로 건다. */
  _blobURL(target,side){
    let u=GIT_BLOB_API+'?repo='+encodeURIComponent(target.repo)+
      '&axis='+encodeURIComponent(target.axis)+'&path='+encodeURIComponent(target.path)+
      '&side='+encodeURIComponent(side);
    if(target.origPath) u+='&origPath='+encodeURIComponent(target.origPath);
    if(target.oid) u+='&oid='+encodeURIComponent(target.oid);
    if(target.parentOid) u+='&parentOid='+encodeURIComponent(target.parentOid);
    return u;
  }

  /**
   * 두 판을 그린다.
   *
   * **`<img>` 로만 그린다** — SVG 도 그렇다 (D-M9-13 / FR-DRV-14·23). 인라인
   * `<svg>` 로 넣으면 그 안의 스크립트가 돈다.
   *
   * 크기(px)와 용량을 각 판에 적는 것이 이 화면의 절반이다 — 같은 그림처럼 보이는
   * 두 판을 가르는 것이 대개 그 둘이다.
   */
  _drawImage(target,mime,a,b){
    this._dropEditor();
    this._setNote('');
    const mode=this._imgMode||GIT_IMG_MODE_SIDE;
    this._imgMode=mode;
    this._host.textContent='';
    const wrap=document.createElement('div');
    wrap.className='git-img-diff mode-'+mode;
    wrap.appendChild(this._imgBar(target,mime,a,b));
    const body=document.createElement('div');
    body.className='git-img-body ui-scroll';
    for(const side of [GIT_IMG_SIDE_ORIGINAL,GIT_IMG_SIDE_MODIFIED]){
      body.appendChild(this._imgPane(target,side,side===GIT_IMG_SIDE_ORIGINAL?a:b));
    }
    wrap.appendChild(body);
    this._host.appendChild(wrap);
  }

  _imgBar(target,mime,a,b){
    const bar=document.createElement('div');
    bar.className='git-img-bar';
    for(const m of [GIT_IMG_MODE_SIDE,GIT_IMG_MODE_OVER]){
      bar.appendChild(UIKit.button({label:GIT_IMG_MODE_LABEL[m],size:'sm',
        cls:'git-img-mode'+(this._imgMode===m?' active':''),dataset:{mode:m},onClick:()=>{
          if(this._imgMode===m) return;
          this._imgMode=m;
          this._drawImage(target,mime,a,b);
        }}));
    }
    // SVG 는 텍스트 diff 도 갖는다 — 돌아갈 길을 같은 줄에 둔다.
    if(GIT_DIFF_DRAWABLE.has(a.kind)&&GIT_DIFF_DRAWABLE.has(b.kind)){
      const back=UIKit.button({label:GIT_IMG_AS_TEXT,size:'sm',cls:'git-img-as-text'});
      // **다시 받지 않는다.** `show()` 를 부르면 stale 가드의 토큰이 없어
      // 그 호출이 자기 세대에 걸러지고(실측), 무엇보다 우리가 이미 두 벌의
      // 본문을 손에 들고 있다 — 같은 것을 다시 묻는 것은 왕복 하나를 버리는 일이다.
      back.addEventListener('click',()=>{
        this._imgMode=null;
        this._draw(target.path,a.content||'',b.content||'','',target);
        this._addImageToggle(target,mime,a,b);
      });
      bar.appendChild(back);
    }
    return bar;
  }

  _imgPane(target,side,meta){
    const pane=document.createElement('div');
    pane.className='git-img-pane git-img-'+side;
    pane.dataset.side=side;
    const head=document.createElement('div');
    head.className='git-img-head'; head.textContent=GIT_IMG_SIDE_LABEL[side];
    pane.appendChild(head);
    if(meta&&meta.kind==='absent'){
      // 추가·삭제다 — 없는 쪽을 빈 그림으로 그리면 "검은 그림" 으로 읽힌다.
      const none=document.createElement('div');
      none.className='git-img-none'; none.textContent=GIT_IMG_ABSENT;
      pane.appendChild(none);
      return pane;
    }
    const img=document.createElement('img');
    img.className='git-img'; img.alt='';
    const foot=document.createElement('div');
    foot.className='git-img-meta';
    img.addEventListener('load',()=>{
      // 크기는 **브라우저가 읽은 값**이다 — 서버가 다시 세지 않는다.
      const dim=img.naturalWidth+'\u00d7'+img.naturalHeight;
      foot.textContent=meta&&meta.size?dim+GIT_META_SEP+gitFmtBytes(meta.size):dim;
    });
    img.addEventListener('error',()=>{ foot.textContent=GIT_IMG_FAIL });
    img.src=this._blobURL(target,side);
    pane.appendChild(img); pane.appendChild(foot);
    return pane;
  }

  /** 텍스트 diff 위에 "그림으로" 를 얹는다 (SVG 의 갈래). */
  _addImageToggle(target,mime,a,b){
    this._setNote('',null,[{label:GIT_IMG_AS_IMAGE,title:GIT_IMG_AS_IMAGE,
      run:()=>{ this._imgMode=GIT_IMG_MODE_SIDE; this._drawImage(target,mime,a,b) }}]);
  }

  // 본문 대신 안내를 보인다. 편집기는 함께 버린다 (FR-GIT-56).
  //
  // GIT_DIR_ENTRY_SRS FR-DIR-22: `acts` 는 그 안내에 딸린 진입점이다
  // (`[{label,title,run}]`). **무엇을 띄울지는 이 클래스가 정하지 않는다** —
  // 여기는 diff 를 그리는 자리이고, 사유와 갈 길은 부른 쪽이 안다.
  clear(message,meta,acts){
    this._seq++;
    this._setNote(message||'',meta,acts);
    this._dropEditor();
    this._host.innerHTML='';
  }

  /**
   * 편집기를 버린다. `clear` 와 그림 보기(FR-M9-20)가 함께 쓴다 — 그림을
   * 그리는 자리도 편집기를 먼저 내려야 하고, 두 벌로 적으면 한쪽만 고쳐진다.
   *
   * 편집기를 버리기 **전에** 알린다 — 받은 쪽이 툴바를 떼야 한다 (FR-GIT-56).
   */
  _dropEditor(){
    // FR-UXB-45: 패널은 `_host` 안에 산다 — 그릇이 비워지면 캐시한 요소는 문서
    // 밖의 것이 된다. 함께 버리지 않으면 다음 찾기가 보이지 않는 패널을 연다.
    this._findPanel=null;
    if(this._cm&&this.onEditor) this.onEditor(null);
    this._cmDestroy();
    this._orig=null; this._mod=null; this._buf=null;
    // 문서 버퍼는 이 뷰의 것이 아니다 — 버리지 않고 문서 뷰에서 빠진다 (§3A-3 해제).
    this._docLeave();
    this._drawnKey=null;
  }

  // FR-GIT-51 · FR-GIT-50 · FR-DOR-3: 보기 옵션이 바뀌면 같은 내용으로 다시 세운다. 내용·dirty 는 문서에 있다.
  setSideBySide(on){ this._sideBySide=!!on; if(this._cm) this._cmBuild() }
  setIgnoreWhitespace(on){ this._ignoreWs=!!on; if(this._cm) this._cmBuild() }
  setHideUnchanged(on){ this._fold=!!on; if(this._cm) this._cmBuild() }

  // FR-CMR-51: 폭이 문턱을 넘었으면 보기를 바꾸고, 아니면 ruler 만 다시 그린다.
  layout(){
    const c=this._cm;
    if(!c) return;
    if(c.kind!==this._cmKind()){this._cmBuild();return}
    c.b.requestMeasure(c.ruler);
  }

  destroy(){ this._dead=true; this.clear('') }

  _stale(seq,token){return this._dead||seq!==this._seq||this._isStale(token)}

  async _fetch(target,enc){
    const q={repo:target.repo,axis:target.axis,path:target.path};
    // REPO_FIX 03 §3A-3: 문서의 인코딩이면 쪽마다 그것으로 디코드한다.
    if(enc) q.encoding=enc;
    if(target.origPath) q.origPath=target.origPath;
    // 커밋 축만 리비전을 싣는다 (FR-GIT-138). oid 는 필수이고, parentOid 가 비면
    // 루트 커밋이다 — 서버가 그것을 absent 로 답한다.
    if(target.oid) q.oid=target.oid;
    if(target.parentOid) q.parentOid=target.parentOid;
    // FR-GRF-6: 조회에는 시한이 있다 (gitFetch 의 기본).
    const r=await gitFetch(GIT_API.diffContent,q);
    const d=r.data;
    // 닿지 못한 것과 거부당한 것을 가른다 (UX_BATCH6_SRS FR-GLV-6). 앞은
    // 일시적일 수 있고 뒤는 다시 물어도 같은 답이 온다.
    if(r.status===0||!d) return {ok:false,msg:GIT_DIFF_LOAD_FAIL};
    if(!r.ok) return {ok:false,refused:true,msg:GIT_DIFF_ERR[d.error]||GIT_DIFF_LOAD_FAIL};
    return {ok:true,body:d};
  }

  _draw(path,orig,mod,note,target,dv){
    /**
     * UX_BATCH6_SRS FR-GLV-3: **내용이 그대로면 편집기를 다시 세우지 않는다.**
     *
     * 폴링이 나른 재적재(FR-GLV-1)는 대부분 같은 값을 가져온다. 그때마다 다시 세우면
     * 커서·스크롤·접힘이 매 회차 원점으로 돌아가 화면을 읽을 수 없다.
     *
     * 근거에 **대상**을 함께 넣는다. 내용만 보면 내용이 같은 다른 파일로 옮겼을 때
     * 건너뛰어, `_bindEdit` 이 앞 파일의 절대경로를 든 채로 남는다.
     *
     * REPO_FIX 05 §3A-3: 작업 트리 쪽이 문서면 그 쪽은 문서 refresh 가 갱신한다 —
     * 여기서는 원본 쪽만 바꾼다(dirty 여도 된다: 문서 버퍼를 건드리지 않는다).
     */
    const key=this._drawKey(target,path);
    const buf=this._docBufOf(dv);
    const c=this._cm;
    if(c&&this._drawnKey===key){
      if(buf&&this._dv===dv&&this._buf===buf){
        this._setNote(note);
        if(this._origText===orig) return;
        this._cmSetOrig(orig);
        if(this.onChanged) this.onChanged();
        return;
      }
      if(!buf&&!this._dv&&this._origText===orig&&c.b.state.doc.toString()===mod){
        this._setNote(note);
        return;
      }
    }
    this._drawnKey=key;
    this._setNote(note);
    this._path=path;
    this._origText=orig;
    this._modText=mod;
    this._buf=buf||null;
    // 새 칸을 버퍼에 붙인 뒤에 앞 문서에서 빠진다 — 앞 문서의 마지막 뷰였으면 그 버퍼가 여기서 버려진다.
    this._cmBuild();
    this._docSwitch(buf?dv:null);
    // REPO_TAB_UNIFY_SRS FR-RTU-50: 오른쪽이 **디스크의 파일**인 축에서만 편집을
    // 연다. 판정은 `GIT_AXIS_EDITABLE` 한 자리(`_shareAbs`)이며 여기서 다시 세지 않는다.
    this._bindEdit();
    // FR-GLV-1: **내용이 실제로 바뀐 회차에만** 알린다. 조각(hunk) 관측처럼 이
    // 본문에서 파생되는 것들이 그때만 다시 받으면 되고, 그러지 않으면 폴링마다
    // 두 번째 요청이 따라붙는다.
    if(this.onChanged) this.onChanged();
  }

  // FR-CMR-51: 지금 폭에서 설 보기.
  _cmKind(){
    return this._sideBySide&&this._host.clientWidth>=this._breakpoint?'split':'unified';
  }

  /**
   * 편집기를 (다시) 세운다. 원본은 `_origText`, 수정본은 문서 버퍼(`_buf`)가 있으면 그것, 없으면 `_modText` 다.
   * 다시 세우면 스크롤 비율을 지킨다 (FR-CMR-51). 수정본 쪽 실행 취소 기록은 끊긴다 (§3.16).
   */
  _cmBuild(){
    const prev=this._cm;
    const ratio=prev?this._cmScrollRatio(prev):0;
    if(prev){
      if(this.onEditor) this.onEditor(null);
      this._findPanel=null;
      this._cmDestroy();
    }
    const kind=this._cmKind();
    const opts={diff:true,readOnly:true,wordWrap:editorWordWrap,fontSize:edFontSize()};
    const ea=edCmExtensions(opts),eb=edCmExtensions(opts);
    const buf=this._buf;
    // FR-ELR-38: 칸이 붙은 버퍼를 기억한다 — 버릴 때 `_buf` 는 이미 다음 문서의 것일 수 있다.
    const c={kind,cmpA:ea.cmp,cmpB:eb.cmp,ruler:null,buf};
    const diffConfig=this._ignoreWs?{override:gitDiffIgnoreWs}:{};
    const collapse=this._fold?GIT_DIFF_COLLAPSE:undefined;
    const listen=CM.EditorView.updateListener.of((u)=>{
      if(buf&&c.b===u.view) buf.fromSink(u.view,u.transactions);
      if(c.host) c.host._update(u);
      if(u.docChanged||u.geometryChanged||u.heightChanged) u.view.requestMeasure(c.ruler);
    });
    // UX_BATCH12_SRS FR-RTB-10: 디스크의 파일을 고치는 축(문서 버퍼가 있다)의 수정본은 편집기
    // 탭처럼 수정키+클릭이 링크·정의로 간다. 읽기 전용 축과 원본 쪽은 그대로다.
    const links=buf?edCmLinks({lsp:(v,pos)=>window.app.lspClickDef(v,pos)}):[];
    const bExt=[...eb.extensions,links,listen,gitDiffHunkBar().field,
      CM.EditorView.editorAttributes.of({class:'git-diff-side-mod'})];
    const aExt=[...ea.extensions,CM.EditorView.editorAttributes.of({class:'git-diff-side-orig'})];
    const bDoc=buf?buf.doc:this._modText;
    const wrap=document.createElement('div');
    // FR-GIT-51: 나란히 보기의 표식 (옛 엔진 때 바깥 요소의 `side-by-side` 와 같다).
    wrap.className='git-diff-cm'+(kind==='split'?' side-by-side':'');
    const pane=document.createElement('div');
    pane.className='git-diff-pane';
    const rul=document.createElement('canvas');
    rul.className='git-diff-ruler';
    wrap.append(pane,rul);
    this._host.textContent='';
    this._host.appendChild(wrap);
    if(kind==='split'){
      c.mv=new CM.MergeView({a:{doc:this._origText,extensions:aExt},b:{doc:bDoc,extensions:bExt},
        parent:pane,diffConfig,collapseUnchanged:collapse});
      c.a=c.mv.a; c.b=c.mv.b; c.scroller=c.mv.dom;
    }else{
      c.b=new CM.EditorView({parent:pane,state:CM.EditorState.create({doc:bDoc,extensions:[...bExt,
        CM.unifiedMergeView({original:this._origText,diffConfig,collapseUnchanged:collapse,mergeControls:false})]})});
      c.scroller=c.b.scrollDOM;
    }
    c.scroller.classList.add('ui-scroll');
    c.wrap=wrap; c.rul=rul;
    c.ruler={key:c,read:()=>this._cmRulerRead(c),write:(m)=>this._cmRulerWrite(c,m)};
    c.resize=new ResizeObserver(()=>this.layout());
    c.resize.observe(this._host);
    c.host=gitDiffCursorHost(c.b);
    this._cm=c;
    this._orig=c.a||{side:'orig'};
    this._mod=c.b;
    GitDiffView.live.add(this);
    if(buf) buf.attach(c.b);
    edCmLangLoad(this._path).then((lang)=>{
      if(this._cm!==c||!lang) return;
      if(c.a) c.a.dispatch({effects:c.cmpA.lang.reconfigure(lang)});
      c.b.dispatch({effects:c.cmpB.lang.reconfigure(lang)});
    });
    c.b.requestMeasure(c.ruler);
    if(ratio) TIMERS.frame(()=>{ if(this._cm===c) c.scroller.scrollTop=ratio*(c.scroller.scrollHeight-c.scroller.clientHeight) },{owner:this,label:'diff-scroll'});
    if(this._editable!==undefined) this._bindEdit();
    if(this.onEditor) this.onEditor(c.host);
  }

  // UX_BATCH12_SRS FR-RTR-6: 닫는 Diff 탭의 커서·스크롤. 스크롤은 비율이다 (`_cmBuild` 의 재생성과 같은 식).
  viewState(){
    const c=this._cm;
    if(!c) return null;
    const st=c.b.state,sel=st.selection.main;
    return {anchor:sel.anchor,head:sel.head,len:st.doc.length,ratio:this._cmScrollRatio(c)};
  }

  // FR-RTR-6: 적어 둔 커서·스크롤로 간다. 칸이 아직 없으면 거짓이다. 문서가 바뀌었으면 커서는 두지 않는다.
  viewApply(vs){
    const c=this._cm;
    if(!c) return false;
    if(vs.len===c.b.state.doc.length) c.b.dispatch({selection:{anchor:vs.anchor,head:vs.head}});
    if(vs.ratio) TIMERS.frame(()=>{ if(this._cm===c) c.scroller.scrollTop=vs.ratio*(c.scroller.scrollHeight-c.scroller.clientHeight) },{owner:this,label:'diff-scroll'});
    return true;
  }

  _cmScrollRatio(c){
    const s=c.scroller,range=s.scrollHeight-s.clientHeight;
    return range>0?s.scrollTop/range:0;
  }

  _cmDestroy(){
    const c=this._cm;
    if(!c) return;
    this._cm=null;
    GitDiffView.live.delete(this);
    if(c.buf) c.buf.detach(c.b);
    c.host._dispose();
    c.resize.disconnect();
    if(c.mv) c.mv.destroy(); else c.b.destroy();
    c.wrap.remove();
  }

  // 원본 쪽만 바꾼다 — 수정본(문서)은 건드리지 않는다.
  _cmSetOrig(orig){
    const c=this._cm;
    this._origText=orig;
    if(c.a){c.a.dispatch({changes:{from:0,to:c.a.state.doc.length,insert:orig}});return}
    const old=CM.getOriginalDoc(c.b.state);
    c.b.dispatch({effects:CM.originalDocChangeEffect(c.b.state,CM.ChangeSet.of({from:0,to:old.length,insert:orig},old.length))});
  }

  /** 지금 조각들 — 나란히면 merge 뷰의 것, 인라인이면 편집기 상태의 것. */
  chunks(){
    const c=this._cm;
    if(!c) return null;
    if(c.mv) return c.mv.chunks;
    const r=CM.getChunks(c.b.state);
    return r?r.chunks:null;
  }

  // FR-CMR-57 · FR-DOR-1: Diff 전체의 변경 위치를 본문 **밖** ruler 에 찍는다. 세로 자리는 스크롤 그릇의 내용
  // 높이에 대한 비율이다 (FR-CMR-71 과 같은 식).
  _cmRulerRead(c){
    const s=c.scroller;
    const top=c.b.documentTop-s.getBoundingClientRect().top+s.scrollTop;
    const items=gitDiffRulerItems(this.chunks()).map((it)=>{
      const y=edRulerY(top+c.b.lineBlockAt(it.from).top,s.scrollHeight,s.clientHeight);
      const y2=edRulerY(top+c.b.lineBlockAt(Math.min(it.to,c.b.state.doc.length)).bottom,s.scrollHeight,s.clientHeight);
      return {...it,y,h:Math.max(ED_RULER_MIN_H,y2-y)};
    });
    return {h:s.clientHeight,items};
  }

  _cmRulerWrite(c,m){
    const cv=c.rul,dpr=window.devicePixelRatio||1;
    cv.width=ED_SCROLL_W*dpr; cv.height=m.h*dpr; cv.style.height=m.h+'px';
    this._rulerItems=m.items;
    const ctx=cv.getContext('2d');
    if(!ctx) return;
    ctx.scale(dpr,dpr);
    const css=getComputedStyle(c.wrap),half=ED_SCROLL_W/2;
    for(const it of m.items){
      ctx.fillStyle=css.getPropertyValue(it.color).trim();
      ctx.fillRect(it.lane==='left'?0:half,it.y,half,it.h);
    }
  }

  // 그린 대상의 식별자. `_showTarget` 의 키와 같은 축이되 `origPath` 는 빼지
  // 않는다 — 이름이 바뀐 파일도 다른 대상이다.
  _drawKey(target,path){
    const tg=target||{};
    return [tg.repo||'',tg.axis||'',path||'',tg.origPath||'',tg.oid||'',tg.parentOid||''].join(RPT_SEP);
  }

  // 대상의 절대경로. 저장소 루트와 상대경로에서 만든다 — 서버가 그 둘을 주므로
  // 여기서 다시 물을 이유가 없다.
  _absPath(target){
    if(!target||!target.repo||!target.path) return '';
    if(this._absOf) return this._absOf(target);
    return pathJoin(target.repo,target.path);
  }

  // FR-RTU-56 / REPO_FIX 05 F-2.2: dirty 는 문서의 것이다 — 같은 파일을 보는 편집기
  // 탭에서 친 것도 여기서 보인다. `dirtyLast` 는 이 뷰가 그 문서의 마지막 뷰인가이며,
  // 닫기·대상 전환의 확인이 그것을 본다 (§3A-3).
  get dirty(){ const d=this._docRec(); return !!(d&&d.dirty) }
  get dirtyLast(){ const d=this._docRec(); return !!(d&&d.dirty&&d.views.size===1) }

  // FR-GLV-6: 서버가 **거부한** 대상인가. 폴링의 자동 재적재가 이것을 보고 멈춘다 —
  // 다시 물어도 같은 답이 오는 것을 매초 다시 묻지 않는다. 닿지 못한 것(네트워크)은
  // 여기 포함되지 않는다: 그쪽은 일시적일 수 있다.
  get refused(){ return !!this._refused }

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
      this._note.appendChild(UIKit.button({label:a.label,title:a.title,size:'sm',cls:'git-diff-note-act',
        onClick:()=>a.run()}));
    }
    this._note.classList.toggle('vis',!!(text||lines.length||list.length));
  }
}
// 살아 있는 편집기를 든 Diff 뷰 — 누수 판정(e2e `counts`)이 센다.
GitDiffView.live=new Set();
