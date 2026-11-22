/**
 * WsSaveController — 워크스페이스 저장 기계 (REFACTOR3_FE_REST5_SRS FR-FR5-22). 옛 자리는 `app.js` 의 `class App` 이다.
 *
 * 직렬화 · 같은 본문 건너뛰기 · PUT · 409 채택 · 백오프 · 비행 뒤의 유예 처리. 저장이 함께 쓰는 필드(`wsETag`·`_saveInflight`·
 * `_saveChain`·`_savePending`·`_saveHoldUntil`·`_saveConflicts`·`_wsLastSent`·`_wsSavedIds`·`_wsSavedTabs`·`_wsDeferRev`·
 * `_wsApplyPending`)는 종전대로 App 에 있다 — 적용기(`ws-sync-controller.js`)와 시험·e2e 가 App 에서 읽고 쓴다.
 * 다른 주인의 이름은 소유 경로(`this.app.wsSync._applyRemoteWorkspace`)로, 자기 이름은 `this.X` 로 부른다 — 시험이 소유 인스턴스에
 * 갈아 끼운 것을 이 경로도 본다 (INV-R5-2 · REFACTOR3_FE_DELEG_SRS D-DLG-1).
 */
class WsSaveController extends Controller {
  /**
   * 응답의 `ETag`. 대소문자 두 벌을 여기 한 번만 적는다 — 종전에는 세 자리가
   * 각자 `get('ETag')||get('Etag')` 를 썼다.
   */
  _etagOf(res){
    const h=res&&res.headers;
    return (h&&(h.get('ETag')||h.get('Etag')))||null;
  }

  // FR-WSC-12: 원격이 아는 창 id 를 갈아 끼운다. 저장 성공과 원격 채택이 그
  // 사실을 바꾸는 유일한 두 순간이다.
  //
  // FR-OPL-2: **탭 id 도 함께 적는다.** 창만 기억하면 창은 살아 있고 그 안의
  // 탭만 사라지는 갈래(`git-head-mobile` V10-13 의 탭 7→1)를 가릴 수 없다.
  // 탭 id 는 전역 유일(UUIDv4)이므로 창별로 나누지 않는다 (FR-OPL-3).
  _wsMarkSaved(windows){
    const seen=this._wsIdsOf(windows);
    this.app._wsSavedIds=seen.windows;
    this.app._wsSavedTabs=seen.tabs;
  }

  // 창·탭 id 집합. 저장은 직렬화 시점의 것을 떠 두고 성공한 뒤에 적는다.
  _wsIdsOf(windows){
    const tabs=new Set();
    for(const w of (windows||[]))
      for(const p of panesOf(w&&w.layout))
        for(const tab of (p.tabs||[])) if(tab&&tab.id) tabs.add(tab.id);
    return {windows:new Set((windows||[]).map(w=>w&&w.id).filter(Boolean)),tabs};
  }

  // FR-OPL-1: 채택기가 미관측 로컬 변경을 가릴 때 쓰는 기억 한 쌍.
  _wsSeen(){
    return {windows:this.app._wsSavedIds||new Set(),tabs:this.app._wsSavedTabs||new Set()};
  }

  /**
   * 워크스페이스를 서버에 쓴다.
   *
   * STATE_FILE_DURABILITY_SRS FR-SFD-22: **부팅에 실패한 판은 저장하지 않는다.**
   *
   * 서버가 `If-Match` 를 요구하므로(FR-SFD-20) ETag 를 얻지 못한 부팅은 이미
   * 428 로 막힌다. 그러나 **로드는 성공하고 그 뒤에 초기화가 실패하는** 갈래가
   * 남는다 — 그때 ETag 는 유효하고, `catch` 가 화면을 세우려고 만든 빈 창이
   * 그 유효한 조건을 달고 나간다. 그것이 `FE-2`(P0)의 손실이다.
   *
   *   이전 동작: 부팅 실패 여부와 무관하게 저장했다
   *   새  동작: 실패한 부팅의 판은 쓰지 않는다 (화면에는 그대로 남는다)
   *   이유:     `catch` 가 만든 창은 **사용자에게 보여 주기 위한 것**이지
   *             디스크에 쓸 것이 아니다
   */
  save(){
    if(this.app._bootFailed) return;
    this.app._savePending=true;
    if(this.app._saveChain) return this.app._saveChain;
    this.app._saveInflight=true;
    const run=async()=>{
      while(this.app._savePending){
        // FR-WSC-7·9: 충돌 뒤에는 잠시 미룬다. 미루는 것이지 버리는 것이 아니다.
        const hold=(this.app._saveHoldUntil||0)-Date.now();
        if(hold>0) await this.app.timers.sleep(hold,{owner:'app',label:'hold'});
        this.app._savePending=false;
        try{
          // OPTIMIZE_REFACTOR_SRS FR-OPT-5-1 (FEC-2): 직렬화는 **한 번**이다. 이
          // 문자열이 그대로 본문이고, 아래 같은 본문 판정의 키다.
          const body=wsSaveBody(this.app.ws);
          // FR-OPT-5-1 (FEC-1): 같은 본문 판정은 `await` 앞이어야 한다 — 그래야 아래
          // 비행이 동기로 끝나 `_saveChain` 을 붙들지 않는다 (REFACTOR3_FE_REST3_SRS INV-R3-2).
          if(wsSaveSame(this.app._wsLastSent,body,this.app.wsETag)) continue;
          // **재시도하지 않는다** (FR-WSC-1). 사용자가 그 사이 새로 조작했으면
          // 그것은 다음 저장으로 나간다 (FR-WSC-5) — 포기하는 것은 이번 본문이며
          // 사용자의 다음 의도가 아니다.
          if(await this._savePut(body)) break;
        }catch(err){console.warn('[save] PUT failed',err)}
      }
      this.app._saveChain=null;
      this.app._saveInflight=false;
      this._saveFlushDeferred();
    };
    // 같은 본문이면 비행이 await 없이 끝난다(FR-OPT-5-1) — 그때 끝난 약속을
    // 비행으로 붙들면 다음 저장이 모두 그것을 돌려받고 나가지 않는다.
    const chain=run();
    if(this.app._saveInflight) this.app._saveChain=chain;
    return chain;
  }

  /**
   * 본문 하나를 PUT 한다. 충돌(409·428)이면 원격을 채택하고 참을 돌려준다 — 그때 비행은 멈춘다.
   * 창·탭 기억은 **직렬화 시점의 것**을 떠 두고 성공한 뒤에 적는다.
   */
  async _savePut(body){
    const seen=this._wsIdsOf(this.app.ws.windows);
    const headers={};
    if(this.app.wsETag) headers['If-Match']=this.app.wsETag;
    const res=await apiPut('/api/workspace',body,{headers});
    // STATE_FILE_DURABILITY_SRS FR-SFD-20: **428 은 409 와 같이 다룬다.**
    //
    // 428 은 "조건을 아예 보내지 않았다" 이고 409 는 "조건이 어긋났다" 인데,
    // 우리가 **할 일은 같다** — 남이 무엇을 바꿨는지 모르므로 재조회부터
    // 다시 하고 이 저장은 포기한다 (FR-WSC-1 / I-1). 밀어붙이면 그것이 곧
    // 남의 변경을 지우는 일이다.
    if(res.status===409||res.status===428){
      /**
       * WORKSPACE_SAVE_CONFLICT_SRS FR-WSC-1: **이 저장을 포기한다.**
       *
       * 종전에는 원격의 `git`·`editors` 만 채택하고 `windows` 는 우리 것을
       * 그대로 다시 밀어붙였다 (`continue`). 그것이 **다른 화면이 만든 창을
       * 지우는 경로**였다 — 재현으로 확정했다 (그 SRS §2.5):
       *
       *   A 가 창 추가 → 서버 2 | B 가 저장 → 서버 1  (A 의 창이 사라진다)
       *
       * 우리는 우리가 무엇을 바꾸려 했는지는 알지만 **남이 무엇을 바꿨는지는
       * 모른다.** 그 상태에서 우리 본문을 밀어붙이는 일은 남의 변경을 지우는
       * 일이다. 그래서 원격이 이긴다 (I-1 / D-1) — 남의 창이 사라지는 것은
       * 되돌릴 수 없고, 내 폭 조정이 사라지는 것은 다시 하면 된다.
       */
      await this._saveAdoptRemote();
      return true;
    }
    if(res.ok){
      const et=this._etagOf(res);
      if(et) this.app.wsETag=et;
      // FR-WSC-12: 이 본문이 서버에 남았다 — 여기 실린 창은 이제 원격이
      // 아는 창이다.
      this.app._wsSavedIds=seen.windows;
      this.app._wsSavedTabs=seen.tabs;
      this.app._wsLastSent={body,etag:this.app.wsETag};
      // FR-WSC-6: 성공하면 연속 충돌 수를 되돌린다.
      this.app._saveConflicts=0;
      this.app._saveHoldUntil=0;
    }
    return false;
  }

  /**
   * FR-WSC-1·2: 409·428 — 이 저장을 포기하고 원격의 판을 채택한다. 다음 저장은
   * 백오프 뒤에 나간다 (FR-WSC-7·9).
   */
  async _saveAdoptRemote(){
    // FR-WSC-6: **비행을 넘어 이어지는** 수다. 409 는 재시도하지 않으므로
    // (FR-WSC-1) 한 비행에 한 번뿐이고, 비행 안의 지역 변수로 세면 늘
    // 1 이 되어 상한에 닿지 않는다 — 잦음을 재려면 연속이어야 한다.
    const conflicts=(this.app._saveConflicts=(this.app._saveConflicts||0)+1);
    try{
      const gr=await apiGet('/api/workspace');
      if(gr.ok){
        this.app.wsETag=this._etagOf(gr);
        this._adoptRemote(gr.data);
      }
    }catch(e){ ErrorLog.push('workspace',(e&&e.message)||e) }
    this._saveBackoff(conflicts);
  }

  /** 409 채택의 본문 — git → editors → 창 순서다. */
  _adoptRemote(rem){
    // git.pinned 는 서버가 권위로 쓴다 (FR-GIT-11). 409 재시도가 우리
    // 본문으로 덮으면 핀이 사라진다 — 서버의 git 을 채택한다.
    if(rem&&rem.git){
      const mine=this.app.ws.git||{};
      this.app.ws.git=wsGitAdopt(mine,rem.git);
      // FR-OPT-4-3: 핀이 바뀌었으면 배지 목록을 받는다 — 목록의 주기는 안전망뿐이다.
      if(JSON.stringify(mine.pinned||[])!==JSON.stringify(rem.git.pinned||[])) this.app.git.sync.gitReposKick();
    }
    // FR-EDT-21: `editors` 도 서버가 권위다. `git` 과 달리
    // **클라이언트가 소유하는 하위 키가 없으므로** 병합 없이 서버
    // 값을 통째로 쓴다. 목록이 바뀌었으면 창도 따라와야 한다.
    if(rem&&rem.editors&&this.app.editor.edOn()){
      this.app.ws.editors=rem.editors;
      // WORKBENCH_REVIEW_SRS FR-WBR-30: **목록만** 갈아끼운다.
      //
      //   이전 동작: `_edApplyServer({home,list})` 를 직접 불렀다 —
      //             `notes` 가 빠져 이 경로를 한 번 지나면 메모장
      //             행과 창이 사라졌다 (FR-NOT-11 이 없으면 지운다)
      //   새  동작: `_edPatchList` 하나로 간다
      //   이유:     그 함수가 있는 이유가 바로 이것이다 — "아는 값은
      //             그대로, 목록만". 여기가 그 규약을 우회한 넷째
      //             자리였다
      this.app.editor.sync._edPatchList(rem.editors.list);
      this.app.editor.sync._edReconcile();
    }
    /**
     * FR-WSC-2: **창까지 채택한다.** 위의 둘(git·editors)만 받고
     * `windows` 를 우리 것으로 두었던 것이 §2.5 의 손실이었다.
     *
     * 적용기는 이미 있는 것을 쓴다 (D-2) — 낡은 모양의 마이그레이션,
     * 편집기 탭 정리, Editor 창 재조정이 그 안에 있다. 두 번째
     * 적용기를 만들면 그 둘이 갈라진다.
     *
     * 도구 목록은 **모른다고 말한다** (세 번째 인자 `false`).
     * `/api/workspace` 는 도구를 싣지 않으므로 안다고 하면 빈 목록이
     * 사실이 되어 살아 있는 도구·pane·창이 차례로 지워진다
     * (FR-TLU-5·6 이 그 함정을 적고 있다).
     *
     * FR-WSC-12·14: **원격이 본 적 없는 창은 지우지 않는다** (§2.9).
     *
     * OPTIMISTIC_LAYOUT_SRS FR-OPL-11 로 개정: 그 병합을 여기서
     * 하지 않는다.
     *
     *   이전 동작: 이 자리가 `_wsSavedIds` 로 미관측 창을 가려
     *             `rem.windows` 에 얹은 뒤 적용기를 불렀다
     *   새  동작: **적용기가 한다.** 여기는 부르기만 한다
     *   이유:     같은 판정이 SSE 채택 경로(`_onWorkspaceChanged`)
     *             에는 없었고, 흔들림이 오는 자리는 그쪽이었다
     *             (`11 §5` 의 3·4·5·6·7). 판정이 두 벌이면 한쪽만
     *             고쳐진다 — 적용기는 두 경로가 반드시 지나는 목이다.
     *             그리고 적용기의 것은 **탭까지** 본다
     *
     * 저장 예약(`FR-WSC-13`)도 적용기가 한다 — 병합이 일어났는지를
     * 아는 자리가 거기다 (FR-OPL-9).
     */
    if(rem&&rem.windows) this.app.wsSync._applyRemoteWorkspace(rem,[],false);
  }

  // FR-WSC-7: 다음 저장을 잠시 미룬다 — 두 화면이 서로 밀어내는 동안
  // 그 사이를 벌린다. 저장을 잃지는 않는다 (FR-WSC-9): 대기 중인
  // 것이 있으면 이 지연 뒤에 나간다.
  _saveBackoff(conflicts){
    this.app._saveHoldUntil=Date.now()+wsSaveHoldMs(conflicts);
    // FR-WSC-8: 잦으면 그 사실을 남긴다.
    if(conflicts>=WS_SAVE_CONFLICT_WARN){
      console.warn('[save] workspace 저장 충돌이 '+conflicts+
        '번 이어졌다 — 다른 화면이 같은 워크스페이스를 함께 고치고 있다');
    }
  }

  // 비행이 끝났다 — 유예한 원격 알림과 대기 중인 저장을 처리한다 (FR-WSC-9·16).
  _saveFlushDeferred(){
    // Deferred workspace_changed events from during the save were almost
    // certainly echoes of our own PUT (now reflected in the updated
    // wsETag). Drop them — any genuinely newer external change will land
    // as a future SSE event with rev > our new wsETag and be applied
    // through the normal rev check.
    //
    // **409 로 포기한 경우는 다르다** (FR-WSC-3). 그때 그 미뤄 둔 알림은 우리
    // PUT 의 에코가 아니라 **남이 실제로 바꾼 것**이고, 우리는 아무것도 쓰지
    // 않았으므로 "나중에 또 온다" 는 가정이 성립하지 않는다 — 우리가 버리면
    // 그 변경은 이 화면에 영영 닿지 않는다.
    //
    // 채택은 SSE 경로에게 맡긴다 (D-2) — 낡은 스냅샷 가드(FR-GRR-4)와 도구
    // 목록 치유를 그것이 이미 갖고 있다. 비행이 끝난 **뒤에** 부른다:
    // 그 함수는 비행 중이면 스스로 미루기 때문이다 (FR-WSC-4).
    //
    // **위 가정은 §2.10 이 반증했다.** 저장 중에 온 알림이 남의 변경일 수
    // 있고(핀이 그렇다), 그것을 버리면 다시 올 것이 없어 화면과 서버가 영영
    // 갈린다. 409 로 포기한 경우의 에코는 FR-WSC-2 가 이미 채택했으므로 같은
    // 판정에 걸린다 — 그 rev 는 채택으로 갱신된 ETag 를 넘지 못한다.
    // FR-WSC-16: 유예한 rev 가 우리 ETag 보다 **새로우면 적용한다.** 낡거나
    // 같으면 그것은 우리 PUT 의 에코이므로 버린다 — 위 문단이 지키려던 것이
    // 그것이고, 그 판정을 **시점이 아니라 rev 로** 한다 (D-7).
    const deferred=this.app._wsDeferRev;
    this.app._wsApplyPending=false;
    this.app._wsDeferRev=undefined;
    const seenRev=this.app.wsETag?parseInt(this.app.wsETag,10):-1;
    if(deferred!==undefined&&!(deferred<=seenRev)){
      this.app.timers.defer(()=>this.app.wsSync._onWorkspaceChanged(deferred===Infinity?undefined:deferred),{owner:'app',label:'ws-deferred'});
    }
    // FR-WSC-9: 채택 중에 새 저장이 예약됐으면(재조정이 창을 고친 경우가 그렇다)
    // 그것을 잃지 않는다. 백오프는 다음 비행의 앞머리가 지킨다.
    if(this.app._savePending) this.app.timers.defer(()=>this.save(),{owner:'app',label:'save-pending'});
  }
}

// ── 저장의 순수 판정 (REFACTOR3_FE_REST3_SRS FR-FR3-4) ──

/**
 * PUT 본문. activeWindow and focusedPane are per-window; strip them so
 * remote windows aren't forced to switch views (multi-window sync).
 * REPO_FIX 03 §3A-7: 탭의 `dirty` 는 파생이다 — 싣지 않는다(옛 저장본의
 * 값은 읽혀도 쓰이지 않는다: 라벨이 `tabDirty` 로 파생한다).
 *
 * 서버는 schemaVersion 미달 저장을 거부한다 (FR-EM-2a). 어떤 경로로
 * 워크스페이스가 만들어졌든 PUT 은 항상 현재 버전을 실어 보낸다.
 */
function wsSaveBody(ws){
  return JSON.stringify(Object.assign({},ws,{schemaVersion:WS_SCHEMA_VERSION}),(k,v)=>{
    if(k==='activeWindow'||k==='focusedPane'||k==='dirty') return undefined;
    return v;
  });
}

/**
 * FR-OPT-5-1 (FEC-1): **마지막으로 성공한 본문과 같으면 보내지 않는다.**
 *
 * 포커스·창 전환은 벗겨 내는 키만 바꾸므로 본문이 그대로다. 보내면 서버가
 * 쓰지는 않아도 왕복이 남는다. 그 뒤에 원격 판을 채택했으면(ETag 가
 * 바뀌었으면) 서버의 판이 우리 기억과 다를 수 있으므로 판정하지 않는다.
 */
function wsSaveSame(last,body,etag){ return !!(last&&last.body===body&&last.etag===etag) }

/**
 * 409 채택의 git 병합 — **`remGit` 을 제자리에서 고쳐** 돌려준다(채택한 git 은 받은 객체 그대로다).
 *
 * git.drafts 와 git.favorites 는 클라이언트가 주인이다
 * (O6·O13) — 통째로 채택하면 방금 입력한 커밋 메시지와 방금 고정한
 * 즐겨찾기가 재시도에서 사라진다 (FR-GIT-75·149).
 */
function wsGitAdopt(mine,remGit){
  for(const k of ['drafts','favorites'])
    if(mine[k]) remGit[k]=Object.assign({},remGit[k]||{},mine[k]);
  return remGit;
}

// FR-WSC-7: 연속 충돌 수에 비례하되 상한이 있다.
function wsSaveHoldMs(conflicts){ return Math.min(WS_SAVE_BACKOFF_MS*conflicts,WS_SAVE_BACKOFF_MAX_MS) }
