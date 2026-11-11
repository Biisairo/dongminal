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

  /**
   * UI_POLISH_SRS FR-UIP-21: 열린 터미널들의 cwd. 포커스 터미널(`here`)이 맨 앞이다.
   * 도구마다 한 번 묻는다 — 상한을 두어 터미널이 많아도 다이얼로그가 늦지 않게 한다.
   */
  async _edTermCwds(here){
    const ids=[];
    for(const w of this.plainWindows()) for(const p of panesOf(w.layout)) for(const tab of p.tabs||[]){
      if(tab.type===TAB_TYPE_TERMINAL&&this.toolIds.has(tab.toolId)&&!ids.includes(tab.toolId)) ids.push(tab.toolId);
    }
    const got=await Promise.all(ids.slice(0,PATH_SUGGEST_TERM_MAX).map(async tool=>{
      const r=await apiGet(CWD_API,{query:{tool}});
      const d=r.ok&&r.data;
      return d&&d.source===GIT_CWD_SOURCE_TOOL?d.cwd||'':'';
    }));
    return [...new Set([here,...got].filter(Boolean))];
  },

  /**
   * UI_POLISH_SRS FR-UIP-21: 입력 값에 맞는 후보. ① 터미널 cwd 중 입력으로 시작하는 것
   * ② 입력의 부모 디렉터리가 **등록된 루트 아래**일 때 그 안의 하위 디렉터리.
   * ②는 서버가 루트 밖을 거절하므로(`fsRootOf`) 루트 밖은 묻지 않는다.
   */
  async _edPathCandidates(v,cwds){
    const q=(v||'').trim();
    const out=cwds.filter(c=>!q||c.startsWith(q));
    const cut=Math.max(q.lastIndexOf('/'),q.lastIndexOf('\\'));
    if(cut>=0){
      const sep=q[cut], parent=q.slice(0,cut)||sep, pre=q.slice(cut+1);
      const root=this.edRoots()
        .filter(r=>parent===r||parent.startsWith(r.endsWith(sep)?r:r+sep))
        .sort((a,b)=>b.length-a.length)[0];
      if(root){
        const r=await apiGet(FS_LIST_API+'?root='+encodeURIComponent(root)+'&path='+encodeURIComponent(parent));
        const es=(r.ok&&r.data&&r.data.entries)||[];
        for(const e of es){
          if(!(e.dir||e.linkDir)||!e.name.startsWith(pre)) continue;
          // 숨은 폴더는 사용자가 `.` 을 친 뒤에만 보인다.
          if(e.name.startsWith('.')&&!pre.startsWith('.')) continue;
          out.push((parent.endsWith(sep)?parent:parent+sep)+e.name);
        }
      }
    }
    return [...new Set(out)].slice(0,PATH_SUGGEST_MAX);
  },

  async _edAdd(){
    const here=await this._edTermCwd();
    const cwds=await this._edTermCwds(here);
    // 경로는 서버가 판정한다 (SERVER_DRIVEN_ACTIONS_SRS F-m) — 추가 요청도 같은 판정으로 거절된다.
    //	이전 동작: 화면이 빈 경로만 막았고, 상대 경로·파일·없는 경로는 누른 뒤에야 알았다
    const answer=new GitInputAnswer({id:EDITOR_ACTION_ADD,
      params:v=>({path:(v.path||'').trim()}),fail:()=>EDITOR_ADD_FAIL,
      ask:async(p,stale)=>{
        const r=await apiPost(EDITORS_API+'/validate',p);
        return stale()?{stale:true}:{ok:!!(r.ok&&r.data&&r.data.actions),data:r.data};
      }});
    const shown=GitDialog.open({
      id:'editor-add-dlg',ns:'eda',action:'editor_add',
      title:EDITOR_ADD_TITLE,runLabel:EDITOR_ADD_RUN,focus:'path',
      body:here?EDITOR_ADD_HERE.replace('%s',here):EDITOR_ADD_NO_TERM,
      fields:[
        {key:'path',type:GIT_DIALOG_TEXT,cls:'eda-path',value:here,
         placeholder:EDITOR_ADD_PROMPT},
      ],
      validate:(v,d)=>answer.why(v,d),
      run:async v=>{
        const ok=await this.edMutate('/add',{path:(v.path||'').trim()});
        return ok?{ok:true}:{ok:false,reason:EDITOR_ADD_FAIL};
      },
    });
    const input=document.querySelector('#editor-add-dlg input[data-key="path"]');
    // 이미 열린 다이얼로그를 앞으로 가져온 경우(`_front`)에는 목록이 이미 붙어 있다.
    if(input&&!input.dataset.suggest){
      input.dataset.suggest='1';
      new PathSuggest(input,v=>this._edPathCandidates(v,cwds));
    }
    return shown;
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
