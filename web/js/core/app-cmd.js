/**
 * Remote Terminal — App 원격 커맨드·워크스페이스 동기화 (PACKAGE_RESTRUCTURE_SRS FR-APP-2)
 *
 * class App 본문에서 옮겨온 메서드 7개. 본문은 수정하지 않았다 (FR-APP-3).
 * app.js 이후 main.js 이전에 로드된다 (FR-APP-5).
 */
Object.assign(App.prototype, {
  /**
   * FR-RSF-1: 복원 비행(飛行) 규약 — 요청이 떠난 시점부터 응답을 적용할 때까지.
   *
   * 복원은 서버 스냅숏을 받아 로컬 상태와 정합한다. 그런데 그 상태는 SSE 와
   * 사용자 조작이 **증분으로** 갱신한다. 요청과 응답 사이에 도착한 갱신은
   * 스냅숏에 없으므로, 응답을 그대로 적용하면 두 방향으로 잃는다 — 새 항목은
   * 지워지고(A) 없앤 항목은 되살아난다(B).
   *
   * 규칙은 하나다. **비행 중에 만진 id 는 스냅숏보다 새로우므로 추가도 삭제도
   * 하지 않는다.** 이 한 규칙이 두 방향을 다 막는다.
   *
   * 비행을 집합의 **동일성**으로 식별하는 이유는 추월 때문이다. `_activityRestore`
   * 는 `agentsPollMs`(기본 5초)마다 불리므로 앞 응답이 늦으면 새 비행이 시작되는데,
   * 그때 앞 응답이 새 비행의 빈 집합을 보고 전부 적용하면 결함이 그대로 돌아온다.
   *
   * FG_RESTORE_RACE_SRS 는 이 규약을 주석으로 선언만 하고 손으로 옮겨 적다
   * 한 방향을 놓쳤다. 그래서 함수로 둔다 — 옮겨 적을 자리가 없다.
   */
  _restoreBegin(key){
    const t=new Set();
    (this._restoreFlight||(this._restoreFlight={}))[key]=t;
    return t;
  },
  _restoreLive(key,t){ return !!this._restoreFlight && this._restoreFlight[key]===t },
  _restoreNote(key,id){
    const t=this._restoreFlight&&this._restoreFlight[key];
    if(t&&id) t.add(id);
  },
  // FR-RSF-5: 전체 초기화는 만진 id 로 표현되지 않는다. 그 비행은 통째로 버린다.
  _restoreVoid(key){ if(this._restoreFlight) this._restoreFlight[key]=null },
  _restoreEnd(key,t){ if(this._restoreLive(key,t)) this._restoreFlight[key]=null },

  // 외부 CLI(dmctl) → 서버 → SSE 브로드캐스트 수신 → executeAction 재사용
  _subscribeCommands(){
    // FR-RCS-6: 백오프에 상한은 두되 **포기하지 않는다.** 이 구독이 끊긴 채로
    // 남으면 워크스페이스 변경이 도달하지 않고, 그러면 `_applyRemoteWorkspace`
    // 의 죽은 도구 정리가 돌지 않아 없어진 도구를 향한 재접속이 영원히 계속된다.
    let retry=SSE_RETRY_MIN_MS, pending=null;
    const schedule=()=>{
      if(pending) return;
      pending=setTimeout(()=>{pending=null;connect()},retry);
      retry=Math.min(retry*2, SSE_RETRY_MAX_MS);
    };
    // FR-SRL-3: 강제 재연결의 손잡이. 백오프 대기 중이면 그것을 취소하고 지금
    // 붙는다 — 사용자가 부른 것이므로 기다릴 이유가 없다.
    this._sseKick=()=>reconnect();
    const connect=()=>{
      try{
        // FR-XDF-8: clientId 를 실어 서버가 구독↔Client 를 결선한다. 이 결선이
        // 구독 해제 시 소유권 해제(FR-XDF-9)의 선행 조건이다.
        const es=new EventSource('/api/commands/sse?clientId='+encodeURIComponent(this.clientId));
        // FR-SRL-3: 내부 새로고침이 구독의 **상태를 보고** 죽었으면 다시 연다.
        // 클로저 안에 갇혀 있으면 밖에서 볼 수도 되살릴 수도 없다 (§2.2).
        this._sse=es;
        // FR-RLC-25: 이 구독이 몇 번째로 열린 것인가, 그리고 마지막으로 무엇이
        // 온 것이 언제인가. 뒤의 값이 생존 판정의 유일한 근거다 (D-7).
        this._sseGen=(this._sseGen||0)+1;
        this._sseSeen=Date.now();
        es.onopen=()=>{this._sseSeen=Date.now();retry=SSE_RETRY_MIN_MS;this._attnRestore();this._activityRestore();this._bgRefresh();this._focusRestore();this._fgRestore()};
        es.onmessage=(e)=>{
          // FR-RLC-28: **모든** 수신이 생존의 증거다. 인사만 세면 다른 이벤트가
          // 활발히 오는 동안에도 인사 하나가 늦으면 끊게 된다.
          this._sseSeen=Date.now();
          try{
            const m=JSON.parse(e.data);
            // RELOAD_CONTINUITY_SRS FR-RLC-20·24: 구독이 열릴 때 서버가 건네는
            // 자기 판. 자산이 바뀌는 길은 프로세스 교체뿐이고 그때 이 구독이
            // 끊기므로, **이 인사가 곧 "자산이 바뀌었을 수 있다" 의 신호**다.
            // 판정은 version-watch 의 것이다 — 여기서는 값만 넘긴다.
            if(m.action==='server_hello'){
              const v=m.args&&m.args.assetVersion;
              if(v&&window.__dmAssetVersion) window.__dmAssetVersion(String(v));
              return;
            }
            if(m.action==='workspace_changed'){
              this._onWorkspaceChanged(m.args&&m.args.rev);
              return;
            }
            if(m.action==='tool_attention'){
              this._onToolAttention(m.args||{});
              return;
            }
            if(m.action==='tool_attention_clear'){
              this._onToolAttentionClear(m.args||{});
              return;
            }
            // FR-RVZ-16: Run 이 바뀌었다. 열려 있는 그 Run 의 탭만 /graph 를
            // 다시 부른다 — 폴링하지 않으며, 열린 Run 탭이 없으면 아무 요청도
            // 나가지 않는다.
            if(m.action==='run_changed'){
              this._onRunChanged(m.args||{});
              return;
            }
            // UX_REVISION_SRS FR-BGV-1: 서버가 백그라운드 도구를 늘리거나 줄였다.
            // 목록만 다시 받는다 — 워크스페이스는 바뀌지 않았으므로 다시 그리지
            // 않는다 (`_bgRefresh` 가 배지까지 갱신한다).
            if(m.action==='tools_background_changed'){
              this._bgRefresh();
              return;
            }
            if(m.action==='tool_activity'){
              this._onToolActivity(m.args||{});
              return;
            }
            // FR-TAN-8/9: 전경 프로세스 이름이 **바뀌었을 때만** 온다. 서버가
            // 이미 중복을 걸렀으므로 여기서 또 거르지 않는다.
            if(m.action==='tool_foreground'){
              this._onToolForeground(m.args||{});
              return;
            }
            // FR-XDF-6: 전체 소유권 맵이 온다. 증분이 아니므로 통째로 갈아치우면
            // 되고, 자기 에코 필터가 필요 없다 (FR-XDF-14 — 멱등).
            if(m.action==='window_focus'){
              this._windowFocusOwner=(m.args&&m.args.owners)||{};
              this._applyFocusOverlay();
              return;
            }
            // FR-SXE-3: 서버가 실행자를 지명한 명령은 그 클라이언트만 수행한다.
            // 어떤 action 을 게이팅할지는 서버만 정하므로 여기서 종류를 보지
            // 않는다. 지명이 없으면(구독자에 clientId 가 없는 경우) 게이팅하지
            // 않는다 — FR-SXE-5 의 열화 경로다.
            if(m.execClientId&&m.execClientId!==this.clientId) return;
            // REMOTE_COMMAND_RESULT_SRS: reqId 는 broadcast payload 의 top-level
            // 이므로 args 에 합쳐 _execRemote 로 전달 (echo correlation).
            const args=m.args||{};
            if(m.reqId) args.reqId=m.reqId;
            this._execRemote(m.action, args);
          }catch(err){console.error('[cmd] parse',err)}
        };
        es.onerror=()=>{
          try{es.close()}catch{}
          schedule();
        };
        this._cmdES=es;
      }catch(e){console.error('[cmd] connect',e); schedule()}
    };
    // 지금 붙어 있는 구독을 버리고 새로 연다. 백오프 대기 중이면 그것도 접는다.
    const reconnect=()=>{
      if(pending){clearTimeout(pending);pending=null}
      retry=SSE_RETRY_MIN_MS;
      try{if(this._sse)this._sse.close()}catch{}
      connect();
    };

    /**
     * FR-RLC-25: **침묵을 잰다.**
     *
     * 서버는 인사를 `sseHelloEvery`(15초)마다 보내므로(FR-RLC-20a), 상한을 넘도록
     * 아무것도 오지 않았다면 이 구독은 죽은 것이다 — `readyState` 가 무어라 하든.
     * 잠에서 깬 기기의 half-open 소켓이 정확히 그 자리이며, 그 상태에서 멎는 것은
     * 판 소식만이 아니다 (FR-RLC-20b).
     */
    const reviveIfSilent=()=>{
      if(!this._sse) return false;
      if(Date.now()-(this._sseSeen||0)<=SSE_SILENCE_MS) return false;
      reconnect();
      return true;
    };
    setInterval(reviveIfSilent, SSE_SILENCE_CHECK_MS);

    // FR-RCS-6: 잠에서 깬 기기와 되돌아온 네트워크는 백오프를 기다릴 이유가 없다.
    // 원격(Tailscale) 사용에서 끊김의 대부분이 이 둘이므로, 여기서 즉시 되붙는
    // 것이 체감 복구 시간을 30초에서 0으로 줄인다.
    const wake=()=>{
      // 2 = EventSource.CLOSED. 살아 있거나 연결 중이면 **침묵부터 본다** —
      // FR-RLC-26: 상한을 기다리면 사용자는 화면을 보고 있는데도 그 시간만큼
      // 옛 화면을 본다. 살아 있고 조용하지도 않으면 건드리지 않는다 (중복 구독은
      // 명령을 두 번 실행시킨다).
      if(this._cmdES && this._cmdES.readyState!==2){ reviveIfSilent(); return }
      reconnect();
    };
    window.addEventListener('online',wake);
    window.addEventListener('focus',wake);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)wake()});
    connect();
  },

  async _onWorkspaceChanged(rev){
    // While a local save is in flight, the SSE we just received is almost
    // certainly an echo of our own PUT (the PUT response with the new ETag
    // hasn't returned yet, so wsETag is still stale and would erroneously
    // pass the rev check). Defer until save settles.
    if(this._saveInflight){ this._wsApplyPending=true; return }
    if(this._wsApplyInflight){ this._wsApplyPending=true; return }
    const cur=this.wsETag?parseInt(this.wsETag,10):-1;
    if(typeof rev==='number' && rev<=cur) return;
    this._wsApplyInflight=true;
    try{
      do{
        this._wsApplyPending=false;
        const r=await fetch('/api/state');
        if(!r.ok) break;
        const et=r.headers.get('ETag')||r.headers.get('Etag');
        const st=await r.json();
        const sv=st&&st.workspace;
        const sp=(st&&st.tools)||[];
        // FR-TLU-1: 서버가 목록을 **모른다**고 말했는가. 옛 서버는 이 필드를
        // 보내지 않으므로, 없으면 아는 것으로 본다 (열화 경로).
        const known=!(st&&st.toolsKnown===false);
        if(!sv||!sv.windows) break;
        // UX_REVISION_SRS FR-GRR-4: **낡은 스냅샷을 적용하지 않는다.**
        //
        // 진입 시점의 가드(`_saveInflight`·rev 비교)는 요청을 **보내기 전**의
        // 판단이다. 응답을 기다리는 사이에 우리 PUT 이 끝나면 이 스냅샷은 과거가
        // 되고, 그것을 적용하면 방금 만든 것이 사라진다 — Git 창을 연 직후가 그
        // 창구다 (`_mkGitWindow` 는 로컬 배열에만 넣고 저장은 뒤따른다).
        // 적용 **직전에** 다시 본다. `_gitReposRefresh` 의 세대 검사와 같은 정신이다.
        const now=this.wsETag?parseInt(this.wsETag,10):-1;
        const got=et?parseInt(et,10):-1;
        if(got>=0&&now>=0&&got<now) continue;
        this._applyRemoteWorkspace(sv, sp, known);
        if(et) this.wsETag=et;
      }while(this._wsApplyPending);
    }catch(err){console.error('[ws] sync',err)}
    finally{this._wsApplyInflight=false}
  },

  // ── 전경 프로세스 이름 (CONVENIENCE_SRS 묶음 N) ──

  // FR-TAN-8: 값이 바뀐 도구 하나가 SSE 로 왔다. name 이 빈 문자열이면 전경
  // 프로그램이 끝난 것이며 탭 이름은 기본값으로 돌아간다 (FR-TAN-12).
  _onToolForeground({toolId,name}={}){
    if(!toolId) return;
    this._restoreNote('fg',toolId);
    const m=this._fgMap();
    if(name) m.set(toolId,name); else m.delete(toolId);
    this._fgRepaint(toolId);
  },

  _fgMap(){ return this._fgNames||(this._fgNames=new Map()) },

  /**
   * 합류/재연결 시의 스냅샷 복원 (`_attnRestore` 와 같은 규약). SSE 는 **변화**
   * 만 나르므로, 합류 시점에 이미 떠 있던 전경 프로그램은 이것으로만 보인다.
   *
   * FR-RSF-2·3: **비행 중에 만진 id 는 스냅숏이 건드리지 않는다.** 응답은 요청
   * 시점의 서버 상태이고, 그 사이 SSE 로 전경 이름이 붙거나 지워질 수 있다 —
   * 이 함수는 SSE 가 열리는 바로 그 순간에 불린다(`es.onopen`).
   *
   * FR-FGR-1 의 `before`(요청 전 키 집합)가 여기 있었다. 그것은 새 이름이
   * 지워지는 쪽만 막았고, **끝난 프로그램의 이름이 낡은 스냅숏으로 되살아나는
   * 쪽은 그대로였다** (RESTORE_FLIGHT_SRS §1.1). 규약을 함수로 옮긴 것도 같은
   * 이유다 — 주석으로 선언하고 손으로 옮겨 적으니 한 방향을 놓쳤다.
   */
  _fgRestore(){
    const t=this._restoreBegin('fg');
    fetch('/api/state').then(r=>r.ok?r.json():null).then(j=>{
      if(!this._restoreLive('fg',t)) return;
      // FR-TLU-7: 도구 목록을 모르는 스냅숏으로는 이름을 지우지 않는다 — 빈
      // 목록을 사실로 받으면 붙어 있던 전경 이름이 전부 걷힌다.
      if(j&&j.toolsKnown!==false) this._fgApply(j.tools||[],t);
      this._restoreEnd('fg',t);
    }).catch(()=>{});
  },

  // `/api/state` 의 도구 목록(`fgName` 포함)을 런타임 Map 에 반영한다. 목록에
  // 없는 도구의 이름은 지운다 — 죽은 도구의 이름이 남으면 안 된다.
  //
  // `touched` 는 비행 중에 갱신된 id 의 집합이다 (FR-RSF-3). 그 id 는 스냅숏보다
  // 새로우므로 **추가도 삭제도 하지 않는다.** 주지 않으면 스냅숏이 전부를 정한다 —
  // `_applyRemoteWorkspace` 처럼 비행이 아닌 동기 경로가 그렇게 부른다 (FR-RSF-7).
  _fgApply(tools,touched){
    const m=this._fgMap();
    const seen=new Set();
    let changed=false;
    for(const p of tools||[]){
      if(!p||!p.id) continue;
      seen.add(p.id);
      if(touched&&touched.has(p.id)) continue;
      const n=p.fgName||'';
      if((m.get(p.id)||'')===n) continue;
      if(n) m.set(p.id,n); else m.delete(p.id);
      changed=true;
    }
    for(const id of Array.from(m.keys())){
      if(touched&&touched.has(id)) continue;
      if(!seen.has(id)){m.delete(id);changed=true}
    }
    if(changed) this._fgRepaint();
  },

  /**
   * 탭 라벨만 제자리에서 고쳐 쓴다. `render()` 를 부르지 않는 이유는 FR-RPT-3
   * 과 같다 — 파생 이름은 프로그램이 뜨고 질 때마다 바뀌므로, 그때마다 레이아웃
   * 을 다시 만들면 터미널이 재부착·재fit 되고 스크롤백 복원이 매번 돈다.
   *
   * toolId 를 주면 그 도구의 탭만, 안 주면 전부 (설정 토글 — FR-TAN-20).
   */
  _fgRepaint(toolId){
    for(const s of this.ws.windows){
      if(!s||!s.layout) continue;
      for(const pn of this._flattenPanes(s.layout)){
        for(const tab of (pn.tabs||[])){
          if(toolId&&tab.toolId!==toolId) continue;
          if(!toolId&&!tab.toolId) continue;
          const el=document.querySelector('.pn-tab[data-tab-id="'+CSS.escape(tab.id)+'"] .pn-tab-label');
          if(el) el.textContent=this.renderer._tabDisplayName(tab);
        }
      }
    }
    // FR-NAM-5·6: 도구 이름을 부르는 다른 표면도 따라간다. 열려 있을 때만 그린다 —
    // 닫힌 것을 그리면 되살아난다. 둘 다 reconcile 이라 값이 그대로면 DOM 은
    // 손대지 않는다 (FR-RPT-3).
    if(this._agentsRender) this._agentsRender();
    if(this._bgModalOpen) this._bgModalRender();
  },

  /**
   * TOOL_LIST_UNKNOWN_SRS FR-TLU-5~8: `toolsKnown` 이 거짓이면 **도구 목록을
   * 모르는 것**이지 도구가 없는 것이 아니다 (SRS §2.2).
   *
   * 데몬에 다시 붙는 짧은 창에 `/api/state` 는 빈 목록을 준다. 그것을 사실로
   * 받으면 아래 세 줄이 차례로 살아 있는 도구 전부, 그것을 담은 pane, pane 이
   * 없어진 창을 지운다 — 다음 스냅숏이 전부 되살리고, 되살아난 도구가 새 소켓을
   * 연다. 실측된 "10개 동시 종료 → 10개 순차 재연결"이 그 사이클이다.
   *
   * 분기를 조건문으로 흩뿌리는 대신 **살아 있음의 판정 하나**(`live`)로 모은다
   * (D-4). 모를 때 그 판정은 "어떤 도구도 죽었다고 말할 수 없다"이며, 그것을
   * 딛는 두 곳 — 죽은 도구 청소와 `clean` — 이 함께 아무 일도 하지 않는다.
   */
  _applyRemoteWorkspace(sv, serverPanes, toolsKnown){
    const known=toolsKnown!==false;
    // 전경 이름도 도구 목록에서 나온다 — 모르는 목록으로 지우면 탭 라벨이
    // 되돌아간다 (FR-TLU-7).
    if(known) this._fgApply(serverPanes);
    // FR-EDT-42·103: 마이그레이션과 재조정이 창을 고쳤으면 그 결과를 서버에
    // 되쓴다 — 되쓰지 않으면 다음 동기화가 같은 일을 되풀이한다.
    let edChanged=false;
    // 서버가 **알려 준** 도구들. 모르면 알려 준 것이 없는 것이며, 만들 것도 없다.
    const serverIds=known?(serverPanes||[]).map(p=>p.id):[];
    // FR-TLU-5·6: 살아 있음의 판정. 모를 때 전부 참인 이유는 §2.2 다 — 빈 목록을
    // 사실로 받으면 도구·pane·창이 차례로 지워진다.
    const live=known?new Set(serverIds):TOOLS_ALL_LIVE;
    const nameOf=new Map((serverPanes||[]).map(p=>[p.id,p.name]));
    for(const id of serverIds){
      if(!this.tools.has(id)) this._mkTool(id, nameOf.get(id)||id);
    }
    // FR-ATL-7: 서버가 모르는 도구는 죽은 도구다. 이름을 지우는 `_fgApply` 와
    // 같은 규약으로 알람도 함께 거둔다.
    //
    // FR-TLU-10: 비교는 **`_slotBase(key)`** 로 한다. 칸 1 이상의 인스턴스는
    // 키가 `id@1` 이므로 순수 toolId 집합과 직접 대면 언제나 "없는 도구"가 되고,
    // 살아 있는 칸 도구가 `workspace_changed` 마다 파괴된다. `_slotReap` 이 같은
    // 판정을 이미 이렇게 한다 (app-slots.js, FR-SVS-60 과 같은 자리).
    let attnDropped=false;
    for(const [key,p] of Array.from(this.tools.entries())){
      const id=this._slotBase(key);
      if(!live.has(id)){ try{p.destroy()}catch{} this.tools.delete(key); if(this._attnDrop(id)) attnDropped=true }
    }
    if(attnDropped) this._attnRefresh();
    for(const s of sv.windows){
      if(!s||!s.id) continue;
      s.layout=clean(s.layout, live);
      if(s.layout) normalizeLayout(s.layout);
    }
    // FR-EDT-49 / D-13: 이 필터가 `workspace_changed` 경로다. `git pin` 하나에도
    // 이 이벤트가 오므로(§2.4) 예외가 없으면 pane 없는 Editor 창이 다음 핀 한
    // 번에 사라진다.
    sv.windows=sv.windows.filter(s=>s&&(s.layout||this._isEditorWin(s)));
    // FR-GIT-186: 다른 브라우저 창이 개정 이전 모양을 보내올 수 있다.
    this._migrateGitWindow(sv.windows);
    // FR-EDT-103·106: 상시 불변식이다 — 다른 브라우저가 만든 편집기 탭도 여기서
    // 걷힌다.
    if(this._migrateEditorTabs(sv.windows)){
      sv.windows=sv.windows.filter(s=>s&&(s.layout||this._isEditorWin(s)));
      edChanged=true;
    }
    // FR-EDT-20·43: **재조정보다 목록이 먼저다.** 목록은 서버 권위이고
    // `editors.list` 는 워크스페이스에 살므로 이 스냅샷이 최신값을 싣고 있다.
    // 갱신하지 않으면 재조정이 낡은 `_editors` 를 딛어, 다른 브라우저가(또는
    // git 핀 연동이) 만든 행의 창이 생기지 않고 지워진 행의 창이 남는다.
    if(this._editors&&sv.editors) this._edPatchList(sv.editors.list);
    if(this._edReconcile(sv.windows)) edChanged=true;
    // FR-EDT-45: 활성 창의 폴백은 Editor 창이 아니다 (app.js 의 같은 자리와 한 쌍).
    if(!sv.windows.find(s=>s.id===sv.activeWindow))
      sv.activeWindow=(sv.windows.find(s=>!this._isEditorWin(s))||sv.windows[0])?.id||null;
    // Preserve per-window viewport state: activeWindow and each window's
    // focusedPane. Remote structural changes (splits/tabs) are applied
    // but this window stays on its own window/pane.
    const localActive=this.ws.activeWindow;
    const localFocus=new Map();
    for(const s of this.ws.windows){
      if(s.focusedPane) localFocus.set(s.id, s.focusedPane);
    }
    // UX_REVISION_SRS FR-GRR-2: 활성 리포도 **이 브라우저가 보고 있는 것**이다
    // (FR-GIT-29 로 Git 창에 붙어 있다). activeWindow·focusedPane 과 같은 범주인데
    // 보존 목록에서 빠져 있어, 리포를 전환한 직후 워크스페이스 동기화가 오면
    // 이전 리포로 되돌아갔다 — 그 화면이 무엇을 가리키는지가 조용히 바뀐다.
    const localGit=this._gitWindow();
    const localRepo=(localGit&&localGit.git&&localGit.git.repo)||null;
    this.ws=sv;
    if(localActive && this.ws.windows.some(s=>s.id===localActive)){
      this.ws.activeWindow=localActive;
    }
    // Restore each window's focusedPane if the pane still exists.
    for(const s of this.ws.windows){
      const rid=localFocus.get(s.id);
      if(rid && s.layout && findPane(s.layout, rid)) s.focusedPane=rid;
    }
    // FR-GRR-2: 로컬이 보던 리포가 이긴다. 로컬에 값이 없으면(첫 로드) 서버 것을
    // 그대로 쓴다 — 복원은 그 경로다.
    if(localRepo){
      const gw=this._gitWindow();
      if(gw){ if(!gw.git) gw.git={}; gw.git.repo=localRepo }
    }
    if('displayMode' in this.ws) delete this.ws.displayMode;
    if('mobileBreakpoint' in this.ws) delete this.ws.mobileBreakpoint;
    if(this.ws.sidebarWidth){
      const w=Math.max(100,Math.min(400,this.ws.sidebarWidth));
      document.documentElement.style.setProperty('--sb-w',w+'px');
      try{localStorage.setItem('sidebarWidth',w)}catch{}
    }
    const a=this._aw();
    if(a&&a.layout){
      const saved=a.focusedPane;
      const f=(saved&&findPane(a.layout,saved))?{id:saved}:firstPane(a.layout);
      if(f) this._setFocus(f.id, a);
    }
    // FR-SVS-7·14: 칸별 시선은 `activeWindow`·`focusedPane` 과 같은 범주다 —
    // 구조 변경은 받아들이면서 보는 자리는 로컬이 이긴다. 맵은 `_slots` 에
    // 있으므로 살아남고, 포커스 칸의 시선을 새 워크스페이스에 다시 얹는다.
    this._slotTabsToWs();
    if(edChanged) this._save();
    this.render();
  },

  // REMOTE_COMMAND_RESULT_SRS FR-RCR-6: 생성 명령의 새 엔터티 id 를 reqId 와 묶어
  // 서버에 echo. best-effort — 실패해도 서버 timeout 이 백스톱 (DC-RCR-3).
  _echoResult(reqId, result){
    fetch('/api/command-result',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        reqId,
        newWindows:result.newWindows||[],
        newPanes:result.newPanes||[],
        newTabs:result.newTabs||[],
      }),
    }).catch(()=>{});
  },

  _execRemote(action, args){
    args=args||{};
    if(action==='focus'){
      // Multi-window: only apply focus if the source pane is in this window's
      // *active* window. If the pane belongs to a window that another
      // window is viewing, this window stays put.
      if(args.sourcePane && !this._isToolInActiveWindow(args.sourcePane)){
        return;
      }
      this._focusLocation(args.location); return
    }
    if(action==='openEditorTab'){
      const{name,filePath,location}=args;
      if(!filePath){console.warn('[cmd] openEditorTab: filePath required');return}
      // FR-EDT-94·96: 편집기 탭은 Editor 창에서만 열린다. 대상은 **그 경로에
      // 연결된 Editor** 이고 없으면 root 에디터다 (FR-EDT-95) — 기준 경로가 파일
      // 자신이므로 anchor 를 따로 주지 않는다. `location` 은 따라가지 않는다:
      // 어느 창에 열지는 루트가 정하지 사용자가 서 있던 자리가 정하지 않는다.
      if(this._edOn()){
        this._edOpenFile(filePath,{name:name||filePath.split('/').pop()});
        return;
      }
      if(location) this._focusLocation(location);
      const rid=this.focused;
      if(rid) this.addTab(rid,'editor',{name:name||filePath.split('/').pop(),filePath});
      return;
    }
    // RENAME_TAB_SESSION_SRS FR-RNS-1/2: 순수 데이터 변경 — 포커스 무영향.
    if(action==='renameTab'||action==='renameWindow'){
      // FR-TAN-22: `rename-tab --auto` 는 이름 없이 온다 — 자동으로 되돌리는
      // 것이 그 명령의 전부다. 창 이름에는 출처가 없으므로 해당 없다.
      const toAuto=action==='renameTab'&&!!args.auto;
      if(!args.location||(!args.name&&!toAuto)){console.warn('[cmd] '+action+': location/name 필수');return}
      const tgt=this._resolveLocation(args.location);
      if(!tgt){console.warn('[cmd] '+action+': 대상 없음',args.location);return}
      if(toAuto){ this._tabToAuto(tgt.tab); this._save(); this.render(); return }
      const name=String(args.name).slice(0,64);
      // FR-TAN-2: 에이전트가 준 이름도 사용자가 준 이름과 같은 자격이다 —
      // 역할명이 다음 조회에 지워지면 안 된다.
      if(action==='renameTab'){ tgt.tab.name=name; this._tabToManual(tgt.tab) }
      else tgt.win.name=name;
      this._save(); this.render();
      return;
    }
    // REMOTE_SESSION_TAB_CREATE_SRS FR-RST-5: newWindow/newTab 은 name/keepFocus
    // 를 전달하기 위해 명시 분기. 의미는 _mkWindow/addTab 내부에서 보장.
    if(action==='newWindow'){
      // FR-CWD-4: 호출한 셸의 도구가 오면 그것이 cwd 의 기준이다 — 브라우저
      // 포커스가 어디에 있든 조정자 자신의 경로에서 창이 열린다.
      this._mkWindow({name:args.name,keepFocus:!!args.keepFocus,cwdTool:args.cwdTool,sandbox:args.sandbox}).then((c)=>{
        this.render();
        if(args.reqId&&c) this._echoResult(args.reqId,{newWindows:[c.win],newPanes:[c.pane],newTabs:[c.tab]});
      });
      return;
    }
    if(action==='newTab'){
      const opts={name:args.name,keepFocus:!!args.keepFocus};
      let rid=null;
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt) return;
        if(opts.keepFocus){
          opts.windowId=tgt.windowId;
          rid=tgt.paneId;
        }else{
          this._focusLocation(args.location);
          rid=this.focused;
        }
      }else{
        rid=this.focused;
      }
      if(rid) this.addTab(rid,'terminal',opts).then((tab)=>{
        if(args.reqId&&tab) this._echoResult(args.reqId,{newTabs:[tab]});
      });
      return;
    }
    const isSplit=(action==='splitH'||action==='splitV');
    if(isSplit){
      const opts={count:args.count,keepFocus:!!args.keepFocus};
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt) return;
        opts.targetWindow=tgt.windowId;
        opts.targetPane=tgt.paneId;
      }
      const dir=action==='splitH'?'horizontal':'vertical';
      this.split(dir,opts).then((c)=>{
        if(args.reqId&&c) this._echoResult(args.reqId,{newPanes:c.panes,newTabs:c.tabs});
      });
      return;
    }
    const keepFocus=!!args.keepFocus;
    // location 지정 closeTab 은 활성/비활성 창 구분 없이 포커스를 건드리지 않고 직접 close.
    // keepFocus 인자는 호환을 위해 받지만, location 이 있으면 항상 포커스 유지로 취급한다.
    // FR-BG-2: detach 명령 — 도구를 백그라운드로 보내고 탭을 닫는다.
    if(action==='detachTab'){
      const loc=this._findToolLocation(args.toolId);
      if(!loc){console.warn('[cmd] detachTab: 도구 위치 없음',args.toolId);return}
      if(!toolBackgroundCapable(loc.tab.type)){
        console.warn('[cmd] detachTab: 백그라운드 미지원 도구',loc.tab.type);return;
      }
      this.closeTab(loc.pane.id,loc.tab.id,loc.win.id,{keepTool:true});
      return;
    }
    if(action==='restoreTool'){
      // FR-BGR-2: location 은 탭 uuid → 서버가 좌표로 변환한 값이다. 복귀는
      // Pane 단위이므로 T 성분은 쓰지 않는다 (newTab/splitH 와 같은 해석).
      const opts={};
      if(args.location){
        const tgt=this._resolveLocation(args.location);
        if(!tgt){console.warn('[cmd] restoreTool: 대상 없음',args.location);return}
        opts.windowId=tgt.windowId; opts.paneId=tgt.paneId;
      }
      this._restoreTool(args.toolId,opts);
      return;
    }
    if(action==='closeTab' && args.location){
      const tgt=this._resolveLocation(args.location);
      if(tgt && tgt.paneId && tgt.tabId){
        this.closeTab(tgt.paneId, tgt.tabId, tgt.windowId);
        return;
      }
    }
    let savedWindow=null, savedFocused=null;
    if(args.location && keepFocus){
      savedWindow=this.ws.activeWindow;
      savedFocused=this.focused;
    }
    if(args.location) this._focusLocation(args.location);
    const result=this.executeAction(action);
    Promise.resolve(result).then(()=>{
      if(savedWindow==null) return;
      if(this.ws.activeWindow!==savedWindow && this.ws.windows.some(x=>x.id===savedWindow)){
        const cur=this._aw(); if(cur) cur.focusedPane=this.focused;
        this.ws.activeWindow=savedWindow;
        try{sessionStorage.setItem('activeWindow', savedWindow)}catch{}
        this._focusWindow(savedWindow);
      }
      const a=this._aw();
      if(a&&savedFocused&&findPane(a.layout,savedFocused)){
        this._setFocus(savedFocused, a);
      }
      this._save(); this.render();
    });
  },

  _resolveLocation(loc){
    if(!loc) return null;
    const m=String(loc).toUpperCase().trim().match(/^W?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m) return null;
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.windows[si]; if(!sess) return null;
    const panes=[]; this._collectPanes(sess.layout,panes);
    const pn=panes[pi]; if(!pn) return null;
    const tab=pn.tabs[ti]; if(!tab) return null;
    return {windowId:sess.id,paneId:pn.id,tabId:tab.id,win:sess,pane:pn,tab:tab};
  },

  // "4.1.1", "W4.P1.T1", "4", "4.2" 등을 지원. 1-base positional (window.pane.tab).
  _focusLocation(loc){
    if(!loc){console.warn('[cmd] focus: location 누락');return}
    const m=String(loc).toUpperCase().trim().match(/^W?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    if(!m){console.warn('[cmd] focus: 형식 오류',loc);return}
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.windows[si];
    if(!sess){console.warn('[cmd] focus: window #'+(si+1)+' 없음');return}
    const panes=[]; this._collectPanes(sess.layout, panes);
    const pn=panes[pi];
    if(!pn){console.warn('[cmd] focus: pane #'+(pi+1)+' 없음');return}
    const tab=pn.tabs[ti];
    if(!tab){console.warn('[cmd] focus: tab #'+(ti+1)+' 없음');return}
    if(this.ws.activeWindow!==sess.id){
      const cur=this._aw(); if(cur) cur.focusedPane=this.focused;
      this.ws.activeWindow=sess.id;
      try{sessionStorage.setItem('activeWindow', sess.id)}catch{}
    }
    this.paneTabSet(pn,tab.id);
    this._setFocus(pn.id, sess);
    this._focusWindow(sess.id);
    this._save(); this.render();
  },
});
