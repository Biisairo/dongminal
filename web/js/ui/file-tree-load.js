/**
 * FileTreeLoad — 탐색기의 조회와 git 색 (FR-EDT-59·63·65 · FR-SVS-20~22).
 *
 * `FileTree` 의 부품이다 (REFACTOR3_FE_REST5_SRS FR-FR5-31 — 옛 `Object.assign(FileTree.prototype, …)`). 상태(펼침·선택·
 * 조작·관측 통로)는 종전대로 탐색기 인스턴스에 있고, 이 부품은 그것을 `this.tree` 로 읽고 쓴다. 제 이름은 `this.X`, 탐색기와 다른 부품의 이름은 `this.tree.X`·`this.tree.<부품>.X` 로
 * 부른다 — 시험·e2e 가 부품 인스턴스에 갈아 끼운 것을 부품끼리도 본다. 이 부품의 이름은 `FileTree` 원형에 없다 (REFACTOR3_FE_DELEG_SRS).
 *
 * 서버에서 한 겹을 받고(`load`) 무시된 이름을 가리며(`loadIgnored`), git 관측을 받아 색과 접기 표식을 입힌다(`pollGit`·`_applyGit`·
 * `_rollup`). 옛 자리는 `file-tree-paint.js` 다.
 */
class FileTreeLoad {
  constructor(tree){
    this.tree=tree;
  }

  /**
   * 한 겹만 읽는다 (FR-EDT-59). 실패는 그 폴더의 캐시에만 남으므로 트리의 나머지는
   * 그대로다 (FR-EDT-63).
   */
  load(dir,opts){
    /**
     * REPO_FIX 04 §3A-1 (T-1.1): 진행 중 로드가 있으면 새 요청을 **버리지 않고**
     * "끝난 뒤 한 번 더" 로 합친다(대기 1건). 적용은 출발 세대가 아직 현재일 때만 —
     * 낙관 반영(`store.bump`) 전에 출발한 응답은 버린다.
     *
     *   이전 동작: busy 면 요청을 버렸고 세대가 없었다 — 뒤 요청이 사라지고 늦은 옛
     *             응답이 낙관 반영을 덮었다 (#31, N2)
     *   새  동작: coalesce + 세대
     *
     * 이어 받기(offset>0)는 재조회와 합치지 않는다. 재조회가 진행·대기 중이면 버린다 —
     * 재조회가 적재분만큼 다시 채운다 (FR-FSP-12).
     */
    const off=(opts&&opts.offset)|0;
    const q=this.tree.store.loadQ;
    if(off) return q.has(dir)?Promise.resolve():this._loadOnce(dir,off);
    const cur=q.get(dir);
    if(cur){cur.again=true;return cur.done}
    const entry={again:false,done:Promise.resolve()};
    q.set(dir,entry);
    entry.done=(async()=>{
      // 낙관 반영으로 버려진 응답은 다시 읽는다 — 버리기만 하면 그 폴더가 목록 없이 남는다.
      try{ do{ entry.again=false; if(await this._loadOnce(dir,0)==='stale') entry.again=true }while(entry.again) }
      finally{ q.delete(dir) }
    })();
    return entry.done;
  }

  async _loadOnce(dir,off){
    const gen=this.tree.store.gen.get(dir)||0;
    this.tree._busy.add(dir); this.tree._paintAll();
    /**
     * FS_LIST_PAGING_SRS FR-FSP-12·14: `opts.offset` 이 있으면 **이어 붙인다.**
     *
     *   더 보기      offset = 적재분        → 다음 쪽을 뒤에 잇는다
     *   재조회       offset = 0 · keep=적재분 → 받아 둔 만큼을 다시 채운다
     */
    const u=FS_LIST_API+'?root='+encodeURIComponent(this.tree.root)+'&path='+encodeURIComponent(dir)
      +(off?'&offset='+off:'');
    const r=await apiGet(u);
    const d=r.data;
    this.tree._busy.delete(dir);
    if((this.tree.store.gen.get(dir)||0)!==gen){this.tree._paintAll();return 'stale'}
    if(!r.ok){
      // 이어 받기가 실패하면 **적재분은 그대로 둔다** (FR-FSP-13).
      if(off){
        const cur=this.tree._kids.get(dir);
        if(cur){ cur.moreErr=true; cur.moreBusy=false; this.tree._paintAll(); return }
      }
      /**
       * REPO_FIX 04 §3A-2 (T-2.2): 일시 오류(전송 실패·5xx)는 멀쩡한 목록을 오류로
       * 덮지 않는다 — 목록을 두고 그 폴더 행에 "갱신 실패" 표식을 단다. 4xx(권한·
       * 부재)는 목록을 오류로 바꾼다. 어느 쪽이든 관측은 failed — 다음 회차에 다시
       * 읽는다(백오프).
       */
      const prev=this.tree._kids.get(dir);
      if((r.status===0||r.status>=500)&&prev&&!prev.err) prev.stale=true;
      else this.tree._kids.set(dir,{entries:[],truncated:false,total:0,err:(d&&d.code)||EDITOR_TREE_ERR});
      ftObsLoaded(this.tree.store.obs,dir,false,'',String(r.status),Date.now(),editorGitBackoffMs());
    }else{
      const got=Array.isArray(d.entries)?d.entries:[];
      const prev=off?((this.tree._kids.get(dir)||{}).entries||[]):[];
      this.tree._kids.set(dir,{
        // 순서는 서버가 정한다 (D-20) — 이어 붙일 때도 다시 정렬하지 않는다 (FR-FSP-20).
        entries:off?prev.concat(got):got,
        truncated:!!d.truncated, total:(typeof d.total==='number')?d.total:got.length,
        // 첫 쪽의 크기는 **서버가 말해 준 것**이다 (FR-FSP-15).
        page0:off?((this.tree._kids.get(dir)||{}).page0||got.length):got.length,
        err:'', moreBusy:false, moreErr:false,
      });
      // FR-FSL-10: 방금 읽은 목록과 **같은 관측**의 스탬프를 기억한다 — ok 상태다.
      if(!off) ftObsLoaded(this.tree.store.obs,dir,true,(typeof d.stamp==='string'&&d.stamp)||'','',Date.now(),0);
    }
    this.tree._paintAll();
    // FR-ETR-5: 겹을 읽은 **뒤에** 그 겹의 이름들로 한 번 묻는다.
    this.loadIgnored(dir);
  }

  /**
   * FR-ETR-5·6: 한 겹의 무시 여부를 묻는다.
   *
   * **무시된 폴더의 하위는 묻지 않는다.** `gitignore(5)` 가 "제외된 부모 아래의
   * 파일은 다시 포함될 수 없다" 고 못박으므로 그 생략은 판정을 바꾸지 않는다
   * (D-2). 이것이 없으면 `node_modules` 를 펼칠 때마다 프로세스가 뜬다.
   */
  async loadIgnored(dir){
    if(this.tree._ignOff||!this.tree.root) return;
    const st=this.tree._kids.get(dir);
    if(!st||!st.entries.length) return;
    // 부모가 무시면 이 겹 전부가 무시다 — 서버에 묻지 않는다.
    if(this._isIgnored(dir)){
      this.tree._ign.set(dir,new Set(st.entries.map(e=>e&&e.name).filter(Boolean)));
      this.tree._paintAll();
      return;
    }
    const names=st.entries.map(e=>e&&e.name).filter(Boolean);
    let r=null,d=null;
    r=await apiPost(FS_IGNORED_API,{root:this.tree.root,dir,names});
    d=r.data;
    if(r.status===0) return;   // 전송 실패는 판정이 아니다 — 다음 기회에 다시 묻는다
    // FR-ETR-4: 4xx 는 "이 경로로는 물을 수 없다" 는 서버의 답이다. 굳히지
    // 않으면 겹을 펼칠 때마다 영영 묻는다 (`pollGit` 의 `_gitOff` 와 같은 관례).
    if(!r.ok){
      if(r.status>=400&&r.status<500){this.tree._ignOff=true;this.tree._ign.clear();this.tree._paintAll()}
      return;
    }
    // API_ANSWER_NOT_ABSENCE_SRS FR-ANA-2·4: 200 이지만 **판정할 수 없다** 는 답이다
    // (저장소가 아니거나 git 이 없다). 종전에는 이것이 404 로 와서 위의 4xx 갈래가
    // 굳혔다 — 굳히는 일은 그대로 하고, 신호만 상태 코드에서 이 필드로 옮겼다.
    if(d&&d.isRepo===false){this.tree._ignOff=true;this.tree._ign.clear();this.tree._paintAll();return}
    if(!d||!Array.isArray(d.ignored)) return;
    this.tree._ign.set(dir,new Set(d.ignored));
    this.tree._paintAll();
  }

  // FR-ETR-7: 이 경로가 무시되었는가. 판정은 **그 겹의 답**에 있다 — 부모가
  // 무시면 loadIgnored 가 자식 전부를 그 겹의 Set 에 넣어 두었다.
  _isIgnored(p){
    if(p===this.tree.root) return false;
    const s=this.tree._ign.get(this.tree.painter._parent(p));
    return !!(s&&s.has(this.tree.painter._base(p)));
  }

  /**
   * FR-FSP-14: 그 겹을 **받아 둔 만큼** 다시 읽는다.
   *
   * 첫 쪽만 받고 나머지를 버리면 폴링 한 번이 사용자의 "더 보기" 를 되돌린다.
   * 한 요청의 상한은 그대로이므로 받아 둔 쪽 수만큼 이어 받는다 — 쪽이 하나인
   * 보통의 겹에서는 지금까지와 **똑같이 한 번**이다.
   */
  async reload(dir){
    const had=(this.tree._kids.get(dir)||{}).entries||[];
    await this.load(dir);
    const st=this.tree._kids.get(dir);
    if(!st||st.err) return;
    while(st.truncated&&st.entries.length<had.length){
      const before=st.entries.length;
      await this.load(dir,{offset:before});
      if(this.tree._kids.get(dir)!==st||st.entries.length<=before) break;
    }
  }

  // FR-EDT-64: **펼쳐져 있는 폴더만** 다시 읽는다. 펼침은 보존된다.
  refresh(){
    this.reload(this.tree.root);
    for(const p of this.tree._open) this.reload(p);
  }

  // ── 겹의 변경 감지 (NOTES_LIVE_EXPLORER_SRS 묶음 L / FR-FSL-6~14) ──

  /**
   * FR-FSL-7·9: 겹들이 바뀌었는지 한 번에 묻고 **달라진 겹만** 다시 읽는다.
   * REPO_FIX 04 §3A-2 (T-3.1): 질의는 store 가 한다 — 그 루트의 모든 뷰가 펼친 폴더의
   * 합집합이다. 뷰는 부르기만 한다(같은 틱의 둘째 뷰는 store 의 busy 에 걸린다 — 첫
   * 질의가 이미 그 뷰의 펼침을 담았다).
   */
  pollStamp(){ return this.tree.store.pollStamp() }

  // ── git 색 (FR-EDT-69~78) ──

  /**
   * FR-EDT-69·71: 근거는 `status` 하나다.
   *
   * **루트 판정은 서버가 한다** (GIT_DIR_ENTRY_SRS FR-DIR-5·30 / D-DIR-6). 옛
   * 코드는 `d.repo!==this.root` 로 직접 비교했는데, 서버의 `repo` 는 git 이 심볼릭
   * 링크를 푼 값이고 `this.root` 는 사용자가 추가한 원본이라 macOS 의 `/tmp` 아래
   * Editor 는 그 비교가 **반드시** 어긋났다 — 그리고 어긋나는 순간 `_gitOff` 가
   * 굳어 그 창의 색은 새로고침 전까지 영영 돌아오지 않았다 (§2.5 실측).
   *
   * FR-DIR-40: 루트가 저장소의 **안**이어도 색을 입힌다. 그때 상태 경로의 기준은
   * 저장소 루트이므로 접두(`_repoPrefix`)를 함께 기억한다 (FR-DIR-41).
   *
   * FR-DIR-31: 실패의 수명은 사유마다 다르다.
   *
   *   503                     굳힌다 — git 자체가 없다. 다시 물어도 같다
   *   404 · 그 밖의 4xx       늦춘다 — `git init` 이 뒤집을 수 있는 사유다
   *   전송 실패 · 5xx         이번 회차만 건너뛴다
   */
  async pollGit(opts){
    if(this.tree._gitOff||!this.tree.root) return;
    // 비행 중에 온 즉시 계기는 버리지 않고 "끝나면 한 번 더" 로 남긴다 — 주기 물음이
    // 안전망(30초)으로 내려간 뒤에는 버리면 그 변화를 다음 안전망까지 놓친다.
    if(this.tree._gitBusy){ if(opts&&opts.now) this.tree.store.gitAgain=true; return }
    // 백오프 중이면 건너뛴다. 창 활성화 같은 즉시 계기는 그것을 무시한다
    // (FR-DIR-32) — 사용자가 방금 한 일의 결과를 늦춰 보일 이유가 없다.
    const now=Date.now();
    if(!(opts&&opts.now)&&this.tree._gitRetryAt&&now<this.tree._gitRetryAt) return;
    this.tree._gitBusy=true;
    // OPTIMIZE_REFACTOR_SRS FR-OPT-4-1: 같은 root 의 물음은 GitStatusHub 가 한 벌로
    // 나눠 쓴다 (FEU-5). 요청은 clientId 를 실어 서버 감시의 임대를 쥔다 (IPC-8).
    // 즉시 계기는 방금 한 일(저장·조작·활성화) **뒤의** 답이어야 하므로 캐시를 넘는다 —
    // 그 뒤에 묻는 소비자(열린 문서들)는 이 요청을 나눠 쓴다.
    const hub=this.tree.app.git.gitStatusHub();
    if(opts&&opts.now) hub.invalidate();
    const r=await hub.ask(this.tree.root);
    this.tree._gitBusy=false;
    this._applyGit(r,now,Date.now());
    if(this.tree.store.gitAgain){ this.tree.store.gitAgain=false; return this.pollGit({now:true}) }
  }

  /**
   * OPTIMIZE_REFACTOR_SRS FR-OPT-4-1: **스탬프 틱에서 git 색을 캐시로 다시 칠한다.**
   *
   * 주기 status 는 안전망(`gitStatusInterval`)으로 내렸다. 그래도 색과 목록이 한
   * 틱에 움직여야 한다 (FR-EDT-77 · FR-FSL-7) — 그래서 스탬프를 묻는 틱마다 hub 가
   * 가진 마지막 관측(패널이 넘긴 것 포함, FEU-M1)으로 칠한다. 요청은 없다. 같은
   * 관측이면 `gitKey` 가 걸러 칠하지 않는다.
   */
  paintGitCached(){
    if(this.tree._gitOff||!this.tree.root) return;
    const got=this.tree.app.git.gitStatusHub().peek(this.tree.root);
    if(!got) return;
    // 안전망의 시계는 **그 관측의 시각**으로 간다 — 오래된 캐시를 지금 칠했다고
    // 지금 관측한 것이 되지 않는다.
    this._applyGit({ok:true,status:200,data:got.data},Date.now(),got.at);
  }

  /**
   * 이 틱에 status 를 물어야 하는가.
   *
   * 관측이 한 번도 성공하지 않았으면(또는 실패한 뒤면) 매 틱 묻는다 — 일시 실패의 회복과
   * 비저장소의 백오프(FR-DIR-31)다. 성공한 뒤에는 채널의 `git:<root>` 토픽이 변화를 민다 —
   * 주기로 다시 묻지 않는다 (PERF_OPTIMIZATION_SRS M1 C4 · D-9).
   */
  gitDue(){
    return !this.tree.store.gitOkAt;
  }

  // `at` 은 이 관측의 시각이다 — 성공하면 안전망의 시계(`gitOkAt`)가 그것으로 간다.
  _applyGit(r,now,at){
    const d=r.data;
    // 성공하지 못한 답은 관측이 아니다 — 안전망 시계를 걷어 다음 틱이 다시 묻게 한다.
    const okAt=this.tree.store.gitOkAt||0;
    this.tree.store.gitOkAt=0;
    if(r.status===0) return;
    if(!r.ok){
      // 503 은 git 자체가 없다는 답이다 — 그대로 두면 3초마다 영영 묻는다. Git
      // 패널이 503 을 `_gitOff` 로 굳히는 것과 같은 관례다 (`git-repos-list.js`).
      if(r.status===503){this.tree._gitOff=true;this._setStatus(null);return}
      // 404(`not_repo`)를 비롯한 4xx 는 **지금은** 저장소가 아니라는 답일 뿐이다.
      if(r.status>=400&&r.status<500){this._gitBack(now);this._setStatus(null)}
      return;
    }
    // 200 인데 본문을 읽지 못한 것은 답이 아니다 — 중간의 프록시일 수 있다.
    if(!d) return;
    // API_ANSWER_NOT_ABSENCE_SRS FR-ANA-1: **저장소가 아니라는 답이 이제 200 으로
    // 온다.** 종전의 404 갈래와 같은 처리로 보낸다 — 굳히지 않고 늦춘다
    // (FR-DIR-31): `git init` 이 뒤집을 수 있는 사유이기 때문이다.
    //
    // 아래 `if(!repo)` 도 같은 자리로 가므로 이 줄이 없어도 동작은 같다. 그런데도
    // 두는 이유는 **계약을 읽는 쪽이 계약의 이름을 부르게** 하기 위해서다 — 빈
    // `repo` 로 판정하면 서버가 그 필드를 채우는 날 조용히 갈린다.
    if(d.isRepo===false){this._gitBack(now);this._setStatus(null);return}
    const repo=d.repo||'';
    // 옛 서버는 `rootMatch` 를 주지 않는다. 그때는 문자열 비교로 물러나되,
    // 그 결과를 굳히지는 않는다.
    const match=(typeof d.rootMatch==='boolean')?d.rootMatch:(repo===this.tree.root);
    if(!repo){this._gitBack(now);this._setStatus(null);return}
    // FR-DIR-41·42: 저장소 루트로부터 이 트리 루트까지의 접두. 정규화를 아는 것은
    // 서버뿐이므로 **서버가 준 두 값 사이에서만** 계산한다.
    const resolved=(!match&&typeof d.requestedResolved==='string')?d.requestedResolved:'';
    const prefix=match?'':this._prefixOf(repo,resolved);
    if(prefix===null){this._gitBack(now);this._setStatus(null);return}
    this.tree._gitRetryAt=0;
    this.tree._repoPrefix=prefix;
    this.tree.store.gitOkAt=Math.max(okAt,at);
    this.tree.store.gitRepo=repo;
    this.tree.store.gitMark=d.mark||'';
    /**
     * REPO_FIX 04 §3A-6 (T-8.1): 관측이 같으면(저장소·접두·서버 mark) 상태 맵·rollup·
     * 전체 재칠을 하지 않는다. 판정은 서버의 관측 식별자 하나로만 한다(§3A-0 X5).
     *   이전 동작: 매 응답마다 전부 다시 계산하고 다시 칠했다(수천 행에서 폴링마다)
     */
    const key=d.mark?rptKey(repo,prefix,d.mark):'';
    if(key&&key===this.tree.store.gitKey) return;
    this._setStatus(d.status);
    this.tree.store.gitKey=key;
  }

  // FR-DIR-31: 굳히는 대신 늦춘다. 다음 관측까지의 시각을 기억할 뿐이며,
  // `_gitOff` 와 달리 되돌아올 수 있는 상태다.
  _gitBack(now){ this.tree._gitRetryAt=(now||Date.now())+editorGitBackoffMs() }

  /**
   * FR-DIR-41: 저장소 루트(`repo`)에서 이 트리 루트(`resolved`)까지의 접두를 낸다.
   *
   *   repo     /Users/me/app
   *   resolved /Users/me/app/src   →  "src/"
   *
   * 루트가 저장소 밖이면 `null` 이다 — 색의 근거가 없다는 뜻이며 호출자가 그것을
   * 백오프로 다룬다. `/appx` 가 `/app` 의 하위로 오인되지 않도록 경계는 구분자로
   * 본다.
   */
  _prefixOf(repo,resolved){ return gitRepoPrefix(repo,resolved) }

  /**
   * 상태 응답을 경로→문자 맵 셋으로 옮긴다 (GIT_DIR_ENTRY_SRS FR-DIR-10).
   *
   *   `_st`      파일 자신의 상태
   *   `_dirOwn`  **디렉터리 항목** 자신의 상태 — 서브모듈과 중첩 저장소
   *   `_dirSt`   하위를 접어 올린 상태 (FR-EDT-73)
   *
   * FR-EDT-72: staged 와 unstaged 를 함께 가진 파일은 **unstaged 쪽 문자**를 쓴다 —
   * 나중에 놓는 쪽이 이긴다. 충돌은 그 위에 온다 (먼저 손봐야 하는 상태다).
   *
   * FR-DIR-43: 키는 **트리 루트 기준**으로 옮긴다. 루트가 저장소 안일 때 status 의
   * 경로는 저장소 루트 기준이므로 접두를 벗기고, 접두 밖의 경로는 버린다 — 트리에
   * 없는 경로가 접어 올림에 새어 들면 루트 폴더가 근거 없는 색을 얻는다.
   */
  _setStatus(st){
    // §3A-6: 비저장소·소실·오류로 색을 걷으면 직전 관측 키도 버린다.
    this.tree.store.gitKey='';
    this.tree._gitOn=!!st;
    const files=new Map(),dirs=new Map();
    const put=(arr,ch)=>{
      for(const e of arr||[]){
        const c=ch(e);
        // '.' 는 porcelain 의 "변화 없음" 이다 — 상태가 아니다.
        if(!e||!e.path||!c||c==='.') continue;
        const k=this._stKey(e.path);
        if(k===null) continue;
        // FR-DIR-1: 파일인지 디렉터리인지는 **서버가 확정한다** (D-DIR-1).
        (e.dir?dirs:files).set(k,c);
      }
    };
    // FR-RST-22: 문자를 뽑는 규칙은 Git 패널과 **한 출처**다. 종전에는 같은
    // 규칙이 두 화면에 따로 적혀 있었다 — 주석이 "같아야 한다" 고 밝히면서도.
    put(st&&st.staged,e=>gitStateChar('staged',e));
    put(st&&st.changes,e=>gitStateChar('changes',e));
    put(st&&st.untracked,()=>gitStateChar('untracked'));
    put(st&&st.conflicts,()=>gitStateChar('conflicts'));
    this.tree._st=files;
    this.tree._dirOwn=dirs;
    // FR-GIT-190: staged 와 unstaged 를 함께 가진 파일. **Git 패널이 이것을
    // 상태색보다 앞세워 `--attn` 으로 칠하므로 탐색기도 같아야 한다** — 같은
    // 사실을 두 화면이 다른 색으로 말하지 않는다 (FR-STC-1 의 근거).
    // FR-EDT-72 는 **문자**의 규칙이고 이것은 **색**의 규칙이라 서로 다르다.
    // FR-DIR-14: 서브모듈도 양쪽을 함께 가질 수 있으므로 같은 규칙을 받는다.
    this.tree._partial=new Set();
    for(const e of (st&&st.staged)||[]){
      if(!e||!e.path||!e.staged||!e.unstaged) continue;
      const k=this._stKey(e.path);
      if(k!==null) this.tree._partial.add(k);
    }
    // FR-DIR-13: 접어 올림은 디렉터리 항목도 대상으로 삼는다 — 서브모듈이 바뀌면
    // 그것을 담은 폴더도 하위에 변경이 있다는 사실을 말해야 한다.
    this.tree._dirSt=this._rollup(new Map([...files,...dirs]));
    this.tree._paintAll();
  }

  /**
   * status 의 경로(저장소 루트 기준)를 트리 루트 기준으로 옮긴다.
   *
   * 트리 밖이면 `null` 이다 — 버려야 할 경로라는 뜻이며, 빈 문자열(루트 자신)과
   * 구분되어야 하므로 거짓값을 겸하는 `''` 를 쓰지 않는다.
   */
  _stKey(p){
    const pre=this.tree._repoPrefix||'';
    if(!pre) return p;
    if(!p.startsWith(pre)) return null;
    return p.slice(pre.length);
  }

  /**
   * FR-EDT-73·74: 폴더는 하위의 상태를 접어 올린다. 근거가 `status` 의 경로들이므로
   * **펼쳐지지 않은 폴더에도** 색이 나온다.
   *
   * 우선순위는 `EDITOR_TREE_ST_RANK` 하나가 정하고 표에 없는 문자(D 포함)는
   * 전파하지 않는다 (D-5).
   */
  _rollup(m){
    const out=new Map();
    for(const [p,ch] of m){
      const rk=EDITOR_TREE_ST_RANK[ch];
      if(!rk) continue;
      for(let i=p.lastIndexOf('/');i>0;i=p.lastIndexOf('/',i-1)){
        const dir=p.slice(0,i);
        const cur=out.get(dir);
        if(cur&&EDITOR_TREE_ST_RANK[cur]>=rk) break;
        out.set(dir,ch);
      }
    }
    return out;
  }

  // FR-GIT-190: 일부만 스테이지된 파일인가. 폴더에는 뜻이 없다 — 파일 하나의
  // 사실이므로 접어 올리지 않는다 (Git 패널도 행 단위로만 표시한다).
  _isPartial(p){
    const rel=this.tree._rel(p);
    return !!(rel&&this.tree._partial&&this.tree._partial.has(rel));
  }

  /**
   * 한 노드의 상태 문자.
   *
   * **FR-EDT-75 는 개정됐다** (GIT_DIR_ENTRY_SRS FR-DIR-11 / D-DIR-3) — 폴더도 자기
   * 상태를 가질 수 있다. gitlink(모드 160000)와 중첩 저장소가 그것이며, 둘 다 git 이
   * 디렉터리 하나를 상태의 단위로 보고한 것이다.
   *
   *   폴더 = 자기 항목 > 접어 올림 > 상속
   *   파일 = 자기 상태 > 상속
   *
   * 자기 항목이 접어 올림을 이기는 이유는, 접어 올림은 **하위의 요약**이고 자기
   * 항목은 **그 폴더 자신에 대한 git 의 보고**이기 때문이다.
   */
  _stOf(p,kind){
    const rel=this.tree._rel(p);
    if(!rel) return '';
    if(kind==='dir'){
      const own=(this.tree._dirOwn&&this.tree._dirOwn.get(rel))||'';
      if(own) return own;
      const roll=(this.tree._dirSt&&this.tree._dirSt.get(rel))||'';
      if(roll) return roll;
    }else{
      const own=(this.tree._st&&this.tree._st.get(rel))||'';
      if(own) return own;
    }
    return this._inherit(rel);
  }

  /**
   * FR-DIR-12: 디렉터리 항목의 색은 **하위 전체가 상속한다.**
   *
   * 상속이 없으면 사용자는 "폴더는 초록인데 안은 전부 무색" 을 본다 — 중첩 저장소
   * 안의 파일은 부모의 status 에 **결코 나오지 않기 때문**이다 (§2.1). 그 무색은
   * "변경 없음" 이 아니라 "이 저장소가 모르는 자리" 인데, 화면은 둘을 같게 말한다.
   *
   * 가장 **가까운** 조상이 이긴다 — 중첩 저장소 안에 또 다른 중첩이 있을 수 있고,
   * 그때 사용자에게 가까운 사실은 안쪽의 것이다.
   *
   * NFR-DIR-2: 훑는 것은 조상 경로뿐이라 행마다 경로 깊이만큼이다. 디렉터리 항목
   * 전체를 훑지 않는다.
   */
  _inherit(rel){
    if(!this.tree._dirOwn||!this.tree._dirOwn.size) return '';
    for(let i=rel.lastIndexOf('/');i>0;i=rel.lastIndexOf('/',i-1)){
      const ch=this.tree._dirOwn.get(rel.slice(0,i));
      if(ch) return ch;
    }
    return '';
  }
}
