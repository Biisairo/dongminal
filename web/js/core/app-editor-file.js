/**
 * Dongminal — Editor 의 **파일 조작** (FE_MODULE_BOUNDARY_SRS FR-FMB-20).
 *
 * 파일을 열고 · 오리고 · 옮기고 · 지운다. 삭제 확인이 여기 함께 있는 이유는
 * **되돌릴 수 없는 것을 세는 자리**(`edCountTree`)와 그 수를 보여 주는 자리가
 * 같은 한 가지 일이기 때문이다.
 */
Object.assign(App.prototype, {
  /**
   * FR-EDT-94·96: 편집기 탭은 Editor 창에서만 열린다.
   *
   * 대상 창을 고르는 기준은 **`opts.anchor`** 이고 없으면 파일 경로 자신이다
   * (FR-EDT-96). Git 의 Open File 만 그것을 달리 준다 — 파일이 아니라 **활성 리포
   * 경로**로 골라야 하기 때문이다 (FR-EDT-97·98). 연결된 Editor 가 없으면 root
   * 에디터로 간다. 그 창의 탐색기가 파일을 가리키지 못하는 것은 정상이다
   * (FR-EDT-99) — 탐색기는 루트의 트리이지 열린 탭의 목록이 아니다.
   */
  async edOpenFile(filePath,opts){
    if(!filePath||!this.edOn()) return null;
    // FR-EDT-101: 이미 열려 있으면 **그 탭이 있는 창**이 대상이다. 폴백 창의
    // pane 을 먼저 만들면 탭은 원래 창으로 가고 빈 pane 만 남는다 (FR-EDT-52).
    const open=this._findEditorTab(filePath);
    const anchor=(opts||{}).anchor||filePath;
    const w=(open&&this.isEditorWin(open.win))?open.win
      :(this._edLinkedWindow(anchor)||this.edWindowFor(this._edHome()));
    if(!w) return null;
    const rid=(open&&open.win===w)?open.pane.id:this.edEnsurePane(w);
    if(!rid) return null;
    // FR-EXR-59: 미리보기가 **아닌** 열기는 명시적인 손짓이다 — 편집기가 포커스를
    // 갖는다 (FR-EXR-58 의 예외). 미리보기는 훑어보는 손짓이므로 탐색기가 쥔
    // 포커스를 그대로 둔다. 표명은 render 후 재포커스가 소비한다 (renderer.js).
    if(!(opts||{}).preview) this.edFocusWanted=true;
    // addTab 의 editor 분기가 중복 방지와 refresh 를 이미 한다.
    // FR-RTU-40: `preview` 는 그대로 넘긴다 — 미리보기 탭을 만들지 대체할지는
    // addTab 한 자리가 정한다.
    await this.addTab(rid,'editor',
      {filePath,name:(opts||{}).name,windowId:w.id,preview:!!(opts||{}).preview});
    // FR-EDT-102: 열면 그 창으로 전환된다. 열었는데 보이지 않으면 사용자는
    // 실패로 읽는다. 사이드바 탭은 FR-EDT-8 로 따라온다.
    this.switchWindow(w.id);
    // FR-RTU-83: 모바일이 사이드에 서 있으면 본문은 그려지지 않는다. 같은 근거의
    // 나머지 절반이다 — 창을 옮기는 것만으로는 그 칸이 보이지 않는다.
    this.mobileShowPane(rid,{render:true});
    // FR-EGS-10: 검색 결과로 열렸으면 그 줄로 간다. 이미 열려 있던 탭이어도
    // 옮긴다 — 사용자가 고른 것은 파일이 아니라 그 줄이다.
    const ln=(opts||{}).line;
    if(ln){
      const t=this._findEditorTab(filePath);
      const v=t&&this.fileEditors.get(t.tab.id);
      if(v&&v.revealLine) v.revealLine(ln,(opts||{}).col);
    }
    // 연 파일이 **탐색기에서도** 보이게 한다. 파일 검색·전체 검색으로 열면 그
    // 파일이 트리 어디에 있는지가 답의 일부인데, 탐색기를 그대로 두면 사용자가
    // 경로를 눈으로 따라가며 폴더를 하나씩 펼쳐야 한다. 여는 경로가 여럿이므로
    // (검색 둘·git 변경파일·dmctl open) 각 부름터가 아니라 이 자리에 둔다.
    const tree=this._edTreeFor(w);
    if(tree&&tree.revealPath) tree.revealPath(filePath);
    /**
     * UX_BATCH6_SRS FR-DSP-1c: **탐색기가 아직 없으면 기억해 둔다.**
     *
     *   이전 동작: `_edTreeFor` 가 null 이면 그대로 끝났다. 사이드의 기본이
     *             Explorer 였으므로 트리는 늘 있었다
     *   새  동작: 사이드가 Changes 인 창에서는 트리가 만들어지지 않으므로
     *             (`edTree` 는 그릴 때만 불린다) 경로를 적어 두고, 그 자리에
     *             갔을 때 드러낸다
     *   이유:     FR-DSP-1 로 기본이 Changes 가 되면서 **연 파일이 탐색기에서
     *             드러나는 일이 통째로 사라졌다** — 검색·`dmctl open`·변경 클릭이
     *             모두 이 자리를 지난다. e2e `editor-nested-root` N4 가 잡았다
     *
     * 창마다 하나다 — 마지막에 연 파일이 드러날 자리이며, 그 앞의 것은 이미
     * 뜻을 잃었다.
     */
    if(!tree) (this._edReveal||(this._edReveal=new Map())).set(w.id,filePath);
    return w.id;
  },

  // ── 파일 조작의 뒷단 (FR-EDT-79~93) ──

  /**
   * FR-WBR-71: "무엇을 복사했는가" 는 **앱이 든다.**
   *
   * dongminal 의 창은 브라우저 창이 아니라 화면 안의 레코드이므로, 여기 두면
   * 모든 창·분할 칸·탐색기가 한 자리를 공유한다 — 왼쪽 탐색기에서 복사해
   * 오른쪽에 붙여넣는 것이 곧 이 선택이다.
   *
   * **새로고침이면 비운다.** `localStorage` 나 워크스페이스에 두지 않는 이유는
   * 무기한 사는 상태가 "언젠가 복사한 것" 을 메뉴에 남기기 때문이다 (D-WBR-16).
   *
   * OS 클립보드는 **쓸 수 없다** (FR-WBR-72) — 웹은 파일을 클립보드에 올릴 수
   * 없고 `navigator.clipboard` 는 secure context 밖에서 아예 없다.
   */
  /**
   * 탐색기 클립보드. `move` 가 참이면 **잘라내기**다 (`FUI-11`).
   *
   * 종류를 클립보드가 든다 — 붙여넣는 쪽이 그때 판단할 근거가 없기 때문이다.
   * 복사와 잘라내기는 **붙여넣는 순간에** 갈리고, 그 전까지는 같은 자리에 같은
   * 대상이 놓인다.
   */
  edClipSet(root,path,move){this._edClip=(root&&path)?{root,path,move:!!move}:null},

  edClipGet(){return this._edClip||null},

  /**
   * 조작 종단 셋의 단일 호출 자리. 실패는 **코드와 사람의 말**로 돌려준다
   * (FR-EDT-92·117).
   *
   * 던지지 않는다 — 호출자는 실패에서 낙관적 반영을 되돌려야 하므로 흐름이
   * 갈리는 것이 아니라 값이 갈려야 한다.
   */
  async edFs(url,body){
    const r=await apiPost(url,body);
    if(r.status===0) return {ok:false,code:'',msg:EDITOR_FS_ERR_UNKNOWN};
    const d=r.data;
    // 성공 응답의 본문을 함께 넘긴다 — 복사는 **서버가 정한 이름**을 응답으로만
    // 알 수 있다 (FR-WBR-62). 다른 호출자는 `data` 를 보지 않는다.
    if(r.ok&&d&&d.ok) return {ok:true,code:'',msg:'',data:d};
    const code=(d&&d.code)||'';
    return {ok:false,code,msg:EDITOR_FS_ERR_MSG[code]||(d&&d.message)||EDITOR_FS_ERR_UNKNOWN};
  },

  /**
   * FR-EDT-83 의 "그 안의 항목 수". 근거는 `list` 뿐이다 — 서버에 세는 종단이
   * 없다 (FR-EDT-108 은 크기도 수도 주지 않는다).
   *
   * 링크는 따라가지 않는다 (`dir` 은 Lstat 기준이라 링크는 언제나 false 다) —
   * 따라가면 링크 밖의 항목을 지운다고 말하는 것이 된다. 세지 못한 가지나 상한
   * 초과는 `more` 로 알린다: 정확한 수보다 **모른다는 사실**이 중요하다.
   */
  async edCountTree(root,dir){
    const q=[dir]; let n=0,more=false;
    while(q.length){
      const d=q.shift();
      const res=await apiGet(FS_LIST_API,{query:{root,path:d}});
      const j=res.ok?res.data:null;
      if(!j||!Array.isArray(j.entries)){more=true;continue}
      n+=j.entries.length;
      if(j.truncated) more=true;
      for(const e of j.entries){
        if(e&&e.dir&&!e.link) q.push(pathJoin(d,e.name));
      }
      if(n>=EDITOR_DEL_COUNT_MAX){more=true;break}
    }
    return {n,more};
  },

  /**
   * FR-EDT-83: 파괴적 확인. `_confirmClose` 와 같은 껍데기를 쓰되 **문자열이 아니라
   * 줄의 배열**을 받는다 — 파일 이름이 그대로 들어가는 자리라 innerHTML 로 조립할
   * 수 없다.
   *
   * 기본 선택지는 안전한 쪽이다 (FR-GIT-97 과 같은 규약) — 초기 포커스가 취소이고
   * `Enter`·`Esc`·바깥 클릭이 모두 취소다.
   */
  _edConfirm(lines,okLabel){
    return new Promise(resolve=>{
      const ov=document.createElement('div');
      ov.className='confirm-overlay ed-confirm';
      const box=document.createElement('div'); box.className='confirm-box';
      const msg=document.createElement('div'); msg.className='confirm-msg';
      for(const t of lines){
        const l=document.createElement('div'); l.className='ed-confirm-line';
        l.textContent=t; msg.appendChild(l);
      }
      const btns=document.createElement('div'); btns.className='confirm-btns';
      const ok=document.createElement('button'); ok.className='confirm-ok'; ok.textContent=okLabel;
      ok.title=TIP_DEL_OK;
      const no=document.createElement('button'); no.className='confirm-cancel'; no.textContent=EDITOR_DEL_CANCEL;
      no.title=TIP_DEL_CANCEL;
      btns.appendChild(ok); btns.appendChild(no);
      box.appendChild(msg); box.appendChild(btns); ov.appendChild(box);
      document.body.appendChild(ov);
      const done=v=>{ov.remove();document.removeEventListener('keydown',onKey,true);resolve(v)};
      const onKey=e=>{
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();done(false)}
      };
      document.addEventListener('keydown',onKey,true);
      ok.addEventListener('click',()=>done(true));
      no.addEventListener('click',()=>done(false));
      ov.addEventListener('click',e=>{if(e.target===ov)done(false)});
      // FR-PDA-1: 기본 포커스는 목적 버튼 — 이 창은 삭제하려고 열렸다.
      // `Enter` 는 그 포커스를 브라우저가 누르는 것이며 (FR-PDA-2) 여기서
      // 가로채지 않는다. 탈출구는 `Esc` 다 (위 `onKey`).
      ok.focus();
    });
  },

  // FR-EDT-83·84 의 문장을 조립하는 한 자리. 폴더면 재귀와 항목 수를, dirty 탭이
  // 있으면 그 사실을 밝힌다.
  /**
   * FR-EMS-21 (U-5): `path` 는 **하나이거나 여럿**이다. 여럿이면 수를 먼저 밝힌다 —
   * 무엇을 잃는지 세어 주지 않는 확인창은 확인이 아니다 (FR-EDT-83 의 근거).
   */
  edConfirmDelete(path,isDir,count,dirty){
    const many=Array.isArray(path)?path:[path];
    if(many.length>1) return this._edConfirmDeleteMany(many,isDir,count,dirty);
    return this._edConfirmDeleteOne(many[0],isDir,count,dirty);
  },

  _edConfirmDeleteMany(paths,isDir,count,dirty){
    const lines=[EDITOR_DEL_MANY.replace('%n',paths.length)
      .replace('%s',paths.map(p=>pathBase(p)||p).join(', '))];
    if(isDir&&count){
      const n=count.more?EDITOR_DEL_COUNT_MORE.replace('%n',count.n||0):String(count.n||0);
      lines.push(EDITOR_DEL_MANY_TREE.replace('%n',n));
    }
    lines.push(EDITOR_DEL_PERMANENT);
    if(dirty&&dirty.length){
      lines.push(EDITOR_DEL_DIRTY.replace('%n',dirty.length).replace('%s',dirty.join(', ')));
    }
    return this._edConfirm(lines,EDITOR_DEL_OK);
  },

  _edConfirmDeleteOne(path,isDir,count,dirty){
    const name=pathBase(path)||path;
    const lines=[];
    if(isDir){
      const n=count&&count.more
        ?EDITOR_DEL_COUNT_MORE.replace('%n',(count&&count.n)||0)
        :String((count&&count.n)||0);
      lines.push(EDITOR_DEL_DIR.replace('%s',name).replace('%n',n));
    }else{
      lines.push(EDITOR_DEL_FILE.replace('%s',name));
    }
    lines.push(EDITOR_DEL_PERMANENT);
    if(dirty&&dirty.length){
      lines.push(EDITOR_DEL_DIRTY.replace('%n',dirty.length).replace('%s',dirty.join(', ')));
    }
    return this._edConfirm(lines,EDITOR_DEL_OK);
  },

  // ── 목록 조작 (FR-EDT-12·25·26·27·28) ──
});
