/**
 * Dongminal — History 의 **질의** (FE_MODULE_BOUNDARY_SRS FR-FMB-32).
 *
 * 서버에 무엇을 묻고 그 답을 어떻게 이어 붙이는가 — 적재 · 무한 스크롤의 다음
 * 쪽 · 검색 (FR-GIT-129, 검증 V49) · jump (FR-GIT-131) · 경로 필터.
 *
 * `_get` 이 자기 얇은 겹을 지나는 것에 시한이 붙어 있다 (FR-GRF-6) — `gitFetch`
 * 만 고쳤으면 이 경로는 그대로였다. V-GRF-4 가 그 45초 상한을 잰다.
 */
Object.assign(GitHistory.prototype, {
  // ── 질의 ──

  async _get(path,params){
    const q=new URLSearchParams();
    for(const k of Object.keys(params)){
      const v=params[k];
      if(v===''||v==null) continue;
      q.set(k,String(v));
    }
    // GIT_REFRESH_LIFECYCLE_SRS FR-GRF-6 (`GP-5`): **시한이 있다.**
    //
    //   이전 동작: 시한 없이 물었다. `_doLoad` 의 `finally` 가 잠금을 풀지만
    //             그 `finally` 는 **응답이 와야** 실행된다 — 응답도 거부도 오지
    //             않는 연결(터널 끊김·프록시 중단)에서 커밋 목록이 영구히 멎었고,
    //             그때 좌측 refs 만 계속 움직여 "한쪽만 살아 있는" 모양이 됐다
    //   새  동작: `GIT_STATUS_FETCH_TIMEOUT_MS` 뒤에 끊긴다. `status:0` 은 이미
    //             실패 경로가 있고 그것이 사유를 보인다 (FR-GIT-132)
    //   이유:     `FR-SVS-39c` 가 지키려던 것은 "거부" 였고 "무응답" 이 아니었다
    //
    // 이 함수는 `/api/git/log`·`refs`·`show` 가 모두 지나는 한 자리다.
    const r=await apiGet(path+'?'+q.toString(),{timeout:GIT_STATUS_FETCH_TIMEOUT_MS});
    if(!r.ok) return null;
    return r.data;
  },

  // 응답이 내 요청의 짝인지 본다 (FR-GIT-133·145). isStale 과 두 겹이다 — 세대만
  // 보면 같은 리포에서 필터를 바꿨을 때 뒤늦게 온 이전 응답을 자기 것으로 읽는다.
  _sameReq(got,sent){
    for(const k of Object.keys(sent))
      if(String(got[k]===undefined?'':got[k])!==String(sent[k])) return false;
    return true;
  },

  /**
   * FR-SVS-39d: 받는 도중에 온 **전체 다시 받기**는 버리지 않는다 — 끝난 뒤 한 번
   * 더 받는다.
   *
   * 단순히 `_loadP` 를 돌려주면 그 요청은 **앞선 요청의 결과**를 받는데, 그것은
   * 요청 이전의 저장소다. 폴링이 새 커밋을 잡아 `reload()` 를 불렀는데 첫 로드가
   * 아직 오는 중이면 새 커밋은 화면에 오지 않고, 다음 계기는 없다 — 저장소는 이미
   * 그 상태라 관측이 다시 움직이지 않는다 (TC-SVS-60 · Windows 러너 실측: 첫 로드가
   * 느린 곳에서 결정적으로 났다). 추가 로드(`more`)는 대상이 아니다 — 그것은 같은
   * 목록의 뒷장이다.
   */
  _load(more){
    if(this._loading){ if(!more) this._again=true; return this._loadP }
    this._loadP=this._doLoad(more).then(()=>this._drain(),()=>this._drain());
    return this._loadP;
  },

  // 미룬 다시 받기 하나, 또는 받는 사이에 관측이 지나간 경우 (FR-GVR-8a: 기준선이
  // 이 로드 중에 도착했으면 `_reloadStaleViews` 는 아직 모른다고 보고 지나갔다).
  // 리포가 바뀌었거나 뷰가 내려갔으면 뜻이 없다 — `_adopt` 가 새 리포를 처음부터
  // 받는다.
  _drain(){
    if(!this._again&&!this.staleFor(this.panel._lastSig)) return;
    this._again=false;
    if(!this._el||this.panel.repo!==this._repo) return;
    return this._load(false);
  },

  async _doLoad(more){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    const sent={
      repo,ref:this._ref||'',
      // 추가 로드의 skip 은 실제로 받은 개수다 — 요청한 limit 으로 세면 상한
      // 클램프가 걸린 페이지에서 목록이 어긋난다 (계약 §2.5).
      skip:more?this._commits.length:0,
      limit:more?GIT_LOG_PAGE:GIT_LOG_INITIAL,
      order:this._order,
      author:this._filters.author||'',since:this._filters.since||'',
      until:this._filters.until||'',path:this._filters.path||'',
      // FR-HSU-5: 저장소 전체 확장은 `--grep` 갈래다 (D-13). 작성자로 전체를
      // 찾는 일은 옵션의 `Author` 가 정확히 한다.
      grep:this._grep,
      // 꺼졌을 때도 보낸다 — requested 로 되돌아와야 늦게 온 응답이 어느 토글의
      // 것인지 _sameReq 가 가른다.
      reflog:this._reflog,
    };
    // 받는 동안은 모른다 — 낡음 판정(`staleFor`)이 이전 목록의 값으로 이 로드를
    // 또 부르지 않게 한다. 뒷장(`more`)은 같은 목록이라 값을 바꾸지 않는다.
    if(!more) this._loadedSig=null;
    this._loading=true; this._err=null;
    this._paintBar(); this._paintFoot();
    /**
     * FR-SVS-39c: 응답이 어떻게 끝나든 **잠금은 푼다.**
     *
     * `_load` 는 `if(this._loading) return this._loadP` 로 시작한다. 낡은 응답을
     * 버리면서 잠금까지 들고 나가면 그 뒤의 모든 로드가 삼켜져 **커밋 목록이 영영
     * 멎는다** — 그때도 왼쪽 refs 는 `_loadRefs()` 라는 별도 경로라 계속 갱신되므로,
     * 화면에는 "한쪽만 살아 있는" 모양으로 나타난다 (접수한 관찰).
     */
    let d=null;
    try{ d=await this._get('/api/git/log',sent) }
    finally{ this._loading=false }
    if(this.panel.isStale(tok)) return;
    if(!d||!d.requested||!this._sameReq(d.requested,sent)){
      // FR-GIT-132: 사유를 보이고 **이미 로드된 목록을 지우지 않는다.**
      this._err=GIT_HIST_LOAD_FAIL; this.paint(); return;
    }
    // FR-GDT-21: 빈 저장소라는 사실. 응답마다 새로 정해진다.
    this._initial=!!d.initial;
    const got=Array.isArray(d.commits)?d.commits:[];
    // limit 은 실효값이다 — 요청값으로 끝을 판정하면 상한 클램프에서 어긋난다.
    const eff=d.limit||sent.limit;
    this._commits=more?this._commits.concat(got):got;
    this._end=got.length<eff;
    // FR-GVR-8a: 이 목록은 서버가 `git log` 직후에 읽은 저장소의 것이다.
    if(!more) this._loadedSig=(typeof d.signature==='string'&&d.signature)||null;
    this._rebuild();
    this.paint();
  },

  /**
   * FR-GVR-8a: 이 목록이 관측보다 **낡았는가.** 목록이 받아진 시각의 signature 와
   * 관측의 signature 가 다르면 그 사이에 저장소가 움직였다. 둘 중 하나를 모르면
   * (받는 중이거나 관측이 아직 없으면) 판정하지 않는다.
   */
  staleFor(sig){
    return !!this._loadedSig&&!!sig&&this._loadedSig!==sig;
  },

  // ref 를 바꾼 쓰기 뒤에 사이드바를 다시 채운다 (FR-GIT-160). 목록은 _adopt 에서만
  // 받으므로 이것이 없으면 checkout 한 브랜치가 사이드바에 나타나지 않는다.
  reloadRefs(){
    if(this._el&&this.panel.repo===this._repo) this._loadRefs();
  },

  /**
   * FR-GIT-267: 비교 기준으로 표시한 커밋을 바에 적는다. 표시가 보이지 않으면
   * 사용자는 자기가 무엇을 골랐는지 모른 채 Compare with 를 연다.
   *
   * `_note` 를 쓴다 — 그것이 이미 "목록을 지우지 않고 사실을 보이는" 자리이고
   * (FR-GIT-132), 같은 뜻의 자리를 두 벌로 만들면 한쪽만 고쳐진다.
   */
  noteCompareMark(label){
    if(!this._el) return;
    this._note=label?GIT_CO_COMPARE_MARKED.replace('%s',label):'';
    this._paintBar();
  },

  async _loadRefs(){
    const repo=this._repo; if(!repo) return;
    const tok=this.panel.token();
    const d=await this._get('/api/git/refs',{repo});
    if(this.panel.isStale(tok)) return;
    if(!d||!d.requested||d.requested.repo!==repo) return;
    this._refs=Array.isArray(d.refs)?d.refs:[];
    this.paint();
  },

  async _loadDetail(){
    const repo=this._repo,oid=this._open; if(!repo||!oid) return;
    const tok=this.panel.token();
    const sent={repo,oid,parent:this._parentIdx};
    this._detail=null; this._detailErr=null;
    this._ver++; this._paintRows();
    const d=await this._get('/api/git/commit',sent);
    // FR-GIT-145: 리포가 바뀌었거나 대상이 바뀌었으면 버린다.
    if(this.panel.isStale(tok)) return;
    if(this._open!==oid||this._parentIdx!==sent.parent) return;
    if(!d||!d.requested||!this._sameReq(d.requested,sent)){
      this._detailErr=GIT_HIST_DETAIL_FAIL;
    }else this._detail=d;
    this._ver++; this._paintRows();
  },

  /**
   * FR-GIT-238: 새로고침이 부르는 **공개** 진입점. 목록과 refs 를 함께 다시 받는다 —
   * refs 만 받으면 커밋 목록의 HEAD 표식이 낡는다 (FR-GIT-233 과 같은 자리).
   *
   * `_reload` 를 밖에서 부르지 않기 위해 있다. 경계를 넘는 호출은 다음 변경에서
   * 조용히 깨진다.
   *
   * **스크롤과 펼친 상세가 맨 위로 돌아간다** — "전부 다시 받는다" 의 값이며
   * 사용자가 그것을 골랐다 (GIT_REVIEW4_SRS §3.6 결정 표).
   */
  reload(){
    if(!this._el||this.panel.repo!==this._repo) return;
    return Promise.all([this._loadRefs(),this._reload()]);
  },

  // 목록을 처음부터 다시 받는다. 실패해도 이전 목록은 화면에 남는다.
  _reload(){
    this._open=null; this._detail=null; this._detailErr=null;
    this._jumped=null; this._note='';
    return this._load(false);
  },

  /**
   * FR-GIT-275: 그 경로의 커밋만 보인다 (File history).
   *
   * **새 조회를 만들지 않는다** — path 필터가 이미 있으므로(FR-GIT-129) 그것을
   * 채워 다시 받는 것이 전부다. 입력에도 값을 넣는 이유는 사용자가 왜 목록이
   * 좁아졌는지 보고 지울 수 있어야 하기 때문이다.
   */
  filterPath(path){
    if(!path) return;
    // **_adopt 의 reset 이 필터를 지운다.** 아직 이 리포를 받지 않았다면 여기서
    // 받아들이되 거르지 않은 목록을 먼저 받지는 않는다 — 두 요청이 겹치면 나중에
    // 온 쪽이 이겨 필터가 무시된 목록이 남는다.
    if(this.panel.repo!==this._repo){
      this._repo=this.panel.repo;
      this.reset();
      if(!this._repo) return;
      this._ref=this._savedRef();
      this._loadRefs();
    }
    this._filters.path=path;
    this._barRepo=null;   // _paintBar 가 입력값을 필터에서 다시 채운다
    this._err=null;
    return this._reload();
  },

  // ── 검색 (FR-GIT-129, 검증 V49) ──

  /**
   * FR-HSU-3·4·14: 치는 동안은 **불러온 범위**를 즉시 거르고, 손이 멎으면 한 번만
   * 저장소 전체로 넓힌다. 사용자가 모드를 고르는 손잡이는 없다 (D-6).
   */
  _search(v){
    this._q=v;
    this._rebuild();
    this._paintBar(); this._paintFoot(); this._paintRows();
    TIMERS.cancel(this._qT);
    this._qT=TIMERS.after(GIT_SEARCH_DEBOUNCE_MS,()=>{this._qT=null;this._expand()},
      {owner:this,label:'hist-search'});
  },

  /**
   * 손이 멎었다. 둘을 한다 — 리비전으로 해석해 보고(FR-HSU-6), 아직 그 말로 묻지
   * 않았으면 저장소 전체로 넓힌다(FR-HSU-4).
   *
   * 넓히기가 **한 번**인 근거가 `_grep===q` 다 (FR-HSU-14): 같은 물음을 다시
   * 보내지 않으므로, 글자를 지웠다 같은 말로 되돌아와도 왕복이 생기지 않는다.
   */
  async _expand(){
    if(!this._el||!this._repo) return;
    const q=this._q.trim();
    await this._revLookup(q);
    if(!this._el||this._q.trim()!==q) return;
    /**
     * **리비전으로 해석된 말은 넓히지 않는다.**
     *
     * `--grep` 은 커밋 **메시지**를 찾는다 (D-13). 해시나 ref 이름을 그 갈래로
     * 보내면 서버는 0건을 돌려주고, 그 0건이 목록을 비워 방금 뜬 리비전 줄이
     * 가리키는 커밋조차 목록에서 사라진다 — 누를 곳으로 갈 수 없게 된다
     * (실측: 로드 범위 밖 해시로 이동하는 e2e 가 여기서 멎었다).
     *
     * 리비전 줄이 곧 그 물음의 답이므로 넓힐 이유도 없다.
     */
    if(this._rev) return;
    if(this._grep===q) return;
    this._grep=q;
    this._err=null;
    this._expanding=true; this._paintFoot();
    try{ await this._reload() }
    finally{
      this._expanding=false;
      if(this._el) this._paintFoot();
    }
  },

  /**
   * FR-HSU-6 / D-12: **리비전 해석은 검색을 대신하지 않고 얹힌다.**
   *
   * rev-parse 전용 라우트가 없다 — `/api/git/log?ref=<rev>&limit=1` 이 해석과
   * 검증을 함께 하고, 없는 리비전은 404 라 `_get` 이 null 을 준다. 그러므로
   * "없다" 는 오류가 아니며 사유를 화면에 적지 않는다.
   */
  async _revLookup(q){
    if(!q||!this._repo){this._rev=null;this._paintRev();return}
    const tok=this.panel.token();
    const d=await this._get('/api/git/log',{repo:this._repo,ref:q,limit:1});
    if(this.panel.isStale(tok)||!this._el) return;
    // 늦게 온 응답이 지금 치고 있는 말을 덮지 않는다.
    if(this._q.trim()!==q) return;
    const c=(d&&Array.isArray(d.commits)&&d.commits.length)?d.commits[0]:null;
    this._rev=c||null;
    this._paintRev();
  },

  // 로드 범위 검색이 걸러낸 목록으로 레인을 다시 잡는다. 걸러낸 목록의 부모는
  // 목록 밖에 있을 수 있으므로 그래프는 그 범위 안에서만 뜻을 갖는다.
  _rebuild(){
    // 확장이 끝난 뒤에는 목록 자체가 그 물음의 답이다 — 그 위에 다시 거르면
    // 서버가 찾아 준 것을 클라이언트의 좁은 규칙이 도로 걸러낸다.
    const q=(this._grep===this._q.trim())?'':this._q.trim().toLowerCase();
    this._view=q?this._commits.filter(c=>this._match(c,q)):this._commits;
    // buildLaneGraph 의 입력은 {hash,parents} 이고 응답은 {oid,parents} 다 —
    // 명시적으로 옮긴다 (계약 §3.1.1).
    this._graph=clampLanes(
      buildLaneGraph(this._view.map(c=>({hash:c.oid,parents:c.parents||[]}))),
      this.app.isMobile?GIT_LANE_MAX_MOBILE:GIT_LANE_MAX_DESKTOP);
    this._ver++;
  },

  _match(c,q){
    return (c.subject||'').toLowerCase().includes(q)||
      (c.authorName||'').toLowerCase().includes(q)||
      (c.authorMail||'').toLowerCase().includes(q)||
      (c.oid||'').startsWith(q);
  },

  // ── jump (FR-GIT-131) ──

  /**
   * FR-HSU-7: 그 커밋으로 간다. 로드 범위 밖이면 나올 때까지 받는다 — `_jump` 의
   * 로직은 남고, 대상을 **입력이 아니라 oid** 로 받는 것만 달라졌다.
   */
  async _jumpTo(oid){
    if(!oid||!this._repo) return;
    const tok=this.panel.token();
    this._note=GIT_JUMP_SEARCHING; this._err=null; this._paintBar();
    // 상한을 둔다 — 없는 것을 끝없이 받아 오지 않는다.
    for(let p=0;p<GIT_JUMP_MAX_PAGES;p++){
      if(this._commits.some(c=>c.oid===oid)) break;
      if(this._end||this._err) break;
      await this._load(true);
      if(this.panel.isStale(tok)) return;
    }
    const i=this._view.findIndex(c=>c.oid===oid);
    if(i<0){this._note=GIT_JUMP_NOT_FOUND;this._paintBar();return}
    this._note='';
    this._goto(oid);
  },

  // 목록 안의 커밋으로 스크롤한다. 찾은 행은 잠깐 강조한다 — 스크롤만 하면 어느
  // 줄로 갔는지 알 수 없다.
  _goto(oid){
    const i=this._view.findIndex(c=>c.oid===oid);
    if(i<0) return;
    this._jumped=oid; this._ver++;
    const items=this._items();
    const idx=items.findIndex(it=>it.i===i);
    this._list.scrollTop=Math.max(0,idx*this._rowH());
    this._paintBar(); this._paintRows();
    TIMERS.cancel(this._flashT);
    this._flashT=TIMERS.after(GIT_JUMP_FLASH_MS,()=>{
      this._flashT=null;
      if(this._jumped!==oid) return;
      this._jumped=null; this._ver++; this._paintRows();
    },{owner:this,label:'jump-flash'});
  },
});
