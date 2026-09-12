/**
 * Dongminal — 사이드바의 **Editor 섹션** (FE_MODULE_BOUNDARY_SRS FR-FMB-20).
 *
 * 편집기 목록을 더하고 · 빼고 · 재배열한다. 목록이 바뀌면 그 뒷일(`_edAfterChange`)이
 * 서버 저장과 화면 재조정을 함께 지나간다 — 그 자리가 하나여야 목록의 진실이 하나다.
 */
Object.assign(App.prototype, {
  // 진입점은 정적 요소이므로 리스너는 여기서 한 번만 붙인다 (`_initGitSection`
  // 과 같은 모양). **목록**에는 폴링이 없다 — 변경 계기가 SSE 와 자기 조작뿐이다.
  // 여기서 거는 폴링은 탐색기의 git 색이며 대상이 다르다 (FR-EDT-77).
  _initEditorSection(){
    // FR-RTU-5: 진입점은 하나다 — 이 한 번이 목록과 핀을 함께 만든다 (연동).
    const add=document.getElementById(REPO_ADD_ID);
    if(add) add.addEventListener('click',()=>this._edAdd());
    this._edStartGitPoll();
  },

  // FR-EDT-28: `+ Add` 는 지금 터미널의 cwd 를 미리 채운다. 얻지 못하면 빈 칸으로
  // 연다 (`_gitRepoAt` 와 같은 규약).
  async _edTermCwd(){
    const tool=this._gitTermToolId();
    if(!tool) return '';
    const r=await apiGet('/api/cwd',{query:{tool}});
    if(!r.ok) return '';
    const d=r.data;
    // FR-ETR-33: `source` 를 읽는다. 이 필드는 FR-FTR-7 이 **정확히 이 문제
    // 때문에** 넣은 것인데, 여기가 그것을 읽지 않아 서버 프로세스의 cwd 가
    // 사용자의 경로로 채워지고 있었다 (§2.4).
    if(!d||d.source!==GIT_CWD_SOURCE_TOOL) return '';
    return d.cwd||'';
  },

  async _edAdd(){
    const here=await this._edTermCwd();
    return GitDialog.open({
      id:'editor-add-dlg',ns:'eda',action:'editor_add',
      title:EDITOR_ADD_TITLE,runLabel:EDITOR_ADD_RUN,focus:'path',
      body:here?EDITOR_ADD_HERE.replace('%s',here):EDITOR_ADD_NO_TERM,
      fields:[
        {key:'path',type:GIT_DIALOG_TEXT,cls:'eda-path',value:here,
         placeholder:EDITOR_ADD_PROMPT},
      ],
      validate:v=>(v.path||'').trim()?'':EDITOR_ADD_NEED_PATH,
      run:async v=>{
        const ok=await this.edMutate('/add',{path:(v.path||'').trim()});
        return ok?{ok:true}:{ok:false,reason:EDITOR_ADD_FAIL};
      },
    });
  },

  // FR-EDT-26: 제거는 문자열 완전 일치다 — 경로를 다시 정규화하지 않는다.
  // 사라진 디렉터리의 행도 지울 수 있어야 한다.
  async edRemove(path){
    if(!path) return false;
    return this.edMutate('/remove',{path});
  },

  // FR-EDT-27: 재정렬은 전체 배열이 아니라 (src, target, before) 델타다 — 그
  // 사이에 다른 창이 행을 더했을 때 전체를 보내면 그것을 조용히 지운다.
  async edReorder(dr){
    if(!dr||!dr.src||!dr.target||dr.src===dr.target) return false;
    const path=k=>String(k||'').replace(/^ed:/,'');
    const ok=await this.edMutate('/reorder',
      {src:path(dr.src),target:path(dr.target),before:!!dr.before});
    // FR-BLP-12 와 같은 규약: 확정하지 못했으면 서버가 아는 순서로 되돌린다.
    if(!ok) await this.edRefresh();
    return ok;
  },

  /**
   * FR-EDT-20·39·43: 목록을 바꾸는 종단은 하나같이 새 목록을 돌려준다. 응답을
   * 로컬 사본에 반영하고 **그 직후 재조정을 돈다** — 행과 창은 한 상태의 두
   * 표현이므로 목록만 바뀌고 창이 그대로면 화면이 거짓을 말한다.
   */
  async edMutate(sub,body){
    if(!this.edOn()) return false;
    const r=await apiPost(EDITORS_API+sub,body);
    if(!r.ok) return false;
    const d=r.data;
    if(!d) return false;
    // 응답에는 `home` 이 없다 (FR-EDT-110) — 알고 있는 값을 그대로 쓴다.
    this._edPatchList(d.list);
    // FR-EDT-39: 연동으로 핀이 함께 바뀐다. 응답이 실어 준 값을 로컬 사본에도
    // 반영해 둔다 — 다음 PUT 이 서버가 방금 만든 핀을 지우지 않게.
    if(Array.isArray(d.pinned)) this._gitPinsApply(d.pinned);
    this._edAfterChange();
    if(Array.isArray(d.pinned)&&this.gitReposRefresh) this.gitReposRefresh();
    return true;
  },

  async edRefresh(){
    if(!await this._edLoad()){this.renderer._rSbTabs();return}
    this._edAfterChange();
  },

  // 재조정 → 활성 창 보정 → 저장 → 그리기. 목록이 바뀌는 모든 경로가 여기 하나를
  // 지난다 — 두 벌로 두면 한쪽만 고쳐진다.
  _edAfterChange(){
    this._edReconcile();
    this.save();
    // 보고 있던 Editor 창이 사라졌으면 남는 자리로 옮긴다. 옮기지 않으면
    // activeWindow 가 없는 창을 가리켜 콘텐츠 영역이 빈다.
    if(!this.ws.windows.some(s=>s.id===this.ws.activeWindow)){
      const back=this.edActivateTarget()||this.gitBackTarget();
      if(back){this.switchWindow(back.id);return}
    }
    this.render();
  },
});
