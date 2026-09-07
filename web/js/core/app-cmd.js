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
  // **경쟁 해소는 `EventBus` 가 갖는다** (FR-BUS-6). 아래 다섯은 위임 껍데기다
  // (FR-HUB-7) — 부르는 이름이 셋(`fg`·`attn`·`activity`)에 이미 박혀 있고
  // e2e 도 그것을 본다.
  //
  // 버스로 옮긴 값어치는 **적용 범위**다. 종전에는 이 방어가 셋에만 있었고
  // `background` 와 `focus` 는 같은 경쟁에 열려 있었다 (SRS §2.5). 소유자가
  // 하나가 되면 다섯 전부가 같은 규약을 받는다.
  _restoreBegin(key){ return this.bus.beginSnapshot(key) },
  _restoreLive(key,t){ return this.bus.isLive(key,t) },
  _restoreNote(key,id){ this.bus.noteTouched(key,id) },
  // FR-RSF-5: 전체 초기화는 만진 id 로 표현되지 않는다. 그 비행은 통째로 버린다.
  _restoreVoid(key){ this.bus.voidSnapshot(key) },
  _restoreEnd(key,t){ this.bus.endSnapshot(key,t) },

  /**
   * 외부 CLI(dmctl) → 서버 → SSE 브로드캐스트 수신 → `_execRemote` 재사용.
   *
   * **채널과 라우팅은 `EventBus` 가 갖는다** (EVENT_TIMER_HUB_SRS 묶음 B).
   * 여기 남는 것은 **배선**뿐이다 — 어떤 action 이 무엇을 부르는가.
   *
   * 종전에는 이 자리에 149줄이 있었다: EventSource 생성, 백오프 재시도, 강제
   * 재연결, 침묵 감시, 깨어남 리스너 셋, 그리고 `m.action` 을 13번 비교하는
   * if-체인. 그 구조에서는 한 action 에 구독자가 둘일 수 없었고(두 곳이 알아야
   * 하면 한쪽이 다른 쪽을 직접 부르는 배선이 생겼다), 어떤 이벤트가 몇 번 왔는지
   * 볼 자리가 없었으며, 구독을 뗄 방법이 없었다 (SRS §2.6).
   *
   * **게이팅 순서를 보존한다** (FR-BUS-5). 아래 구독된 action 들은 종전 코드에서
   * `execClientId` 검사 **앞**에 있었으므로, 지명받지 못한 클라이언트에도 도달해야
   * 한다. 버스는 "구독자가 있으면 지명을 보지 않는다" 로 그것을 지킨다.
   */
  _subscribeCommands(){
    const bus=this.bus;

    // ── 라우팅 (FR-BUS-4) — 종전 13분기 if-체인 ──
    //
    // RELOAD_CONTINUITY_SRS FR-RLC-20·24: 구독이 열릴 때 서버가 건네는 자기 판.
    // 자산이 바뀌는 길은 프로세스 교체뿐이고 그때 이 구독이 끊기므로, **이 인사가
    // 곧 "자산이 바뀌었을 수 있다" 의 신호**다. 판정은 version-watch 의 것이다.
    bus.subscribe('server_hello',a=>{
      const v=a&&a.assetVersion;
      if(v&&window.__dmAssetVersion) window.__dmAssetVersion(String(v));
    },{owner:'app'});

    // EDITOR_LSP_SRS FR-LSP-32: 언어 서버가 밀어 준 진단. 요청 없이 오므로 이
    // 길이 필요하다 — 폴링으로 바꾸면 타이핑을 멈춘 뒤 밑줄이 늦게 서거나,
    // 멈추지 않았는데도 계속 묻게 된다.
    bus.subscribe(LSP_DIAG_ACTION,a=>this._lspOnDiagnostics(a),{owner:'app'});

    bus.subscribe('workspace_changed',a=>this._onWorkspaceChanged(a&&a.rev),{owner:'app'});

    // FR-RVZ-16: Run 이 바뀌었다. 열려 있는 그 Run 의 탭만 /graph 를 다시 부른다 —
    // 폴링하지 않으며, 열린 Run 탭이 없으면 아무 요청도 나가지 않는다.
    bus.subscribe('run_changed',a=>this._onRunChanged(a),{owner:'app'});

    /**
     * ── 다섯 상태는 **등록부에서 파생된다** (FR-HUB-3) ──
     *
     * 여기 있던 것: `tool_attention`·`tool_attention_clear`·`tool_activity`·
     * `tool_foreground`·`tools_background_changed`·`window_focus` 구독 여섯과,
     * `sse:open` 에 이어 붙은 복원 다섯.
     *
     * 같은 목록이 `app-reload.js` 에 또 있었고 그 둘이 어긋날 수 있었다. 이제
     * 한 곳(`state-registry.js`)이 정하고 여기는 그것을 부르기만 한다 — 새 상태를
     * 더할 때 이 파일은 바뀌지 않는다.
     */
    wireStateRegistry(this);

    // 구독자가 없는 action 은 여기로 온다. 서버가 지명한 실행자만 수행하며
    // (FR-SXE-3), 지명이 없으면 게이팅하지 않는다 (FR-SXE-5 의 열화 경로).
    bus.setFallback((action,args)=>this._execRemote(action,args));

    // FR-RCS-6 · FR-RLC-26: 잠에서 깬 기기와 되돌아온 네트워크는 백오프를 기다릴
    // 이유가 없다. 원격(Tailscale) 사용에서 끊김의 대부분이 이 둘이므로, 즉시
    // 되붙는 것이 체감 복구 시간을 30초에서 0으로 줄인다. 리스너는 버스에 하나다
    // (FR-BUS-8) — 종전에는 같은 신호를 네 곳이 각자 듣고 각자 해석했다.
    bus.startLifecycle();

    // FR-XDF-8: clientId 를 실어 서버가 구독↔Client 를 결선한다. 이 결선이 구독
    // 해제 시 소유권 해제(FR-XDF-9)의 선행 조건이다.
    bus.connect('/api/commands/sse?clientId='+encodeURIComponent(this.clientId));

    // FR-SRL-3: 강제 재연결의 손잡이. 백오프 대기 중이면 그것을 취소하고 지금
    // 붙는다 — 사용자가 부른 것이므로 기다릴 이유가 없다.
    this._sseKick=()=>bus.reconnect();
  },

  /**
   * FR-WSC-15: 유예한 알림의 **rev 를 기억한다.** 무엇을 미뤘는지 모르면 비행이
   * 끝날 때 그것을 버릴지 말지 판단할 수 없고, 판단하지 못한 채 버린 것이
   * §2.10 의 영구 발산이었다. 여러 번 유예되면 가장 새로운 것을 남긴다.
   *
   * FR-WSC-17: rev 를 모르는 호출(`_onWorkspaceChanged()`)은 **버리지 않는다** —
   * 모르는 것을 낡았다고 단정하면 그 손실이 그대로 돌아온다.
   */
  _wsDefer(rev){
    this._wsApplyPending=true;
    const r=(typeof rev==='number')?rev:Infinity;
    if(this._wsDeferRev===undefined||r>this._wsDeferRev) this._wsDeferRev=r;
  },

  async _onWorkspaceChanged(rev){
    // While a local save is in flight, the SSE we just received is almost
    // certainly an echo of our own PUT (the PUT response with the new ETag
    // hasn't returned yet, so wsETag is still stale and would erroneously
    // pass the rev check). Defer until save settles.
    //
    // **"거의 확실히" 는 언제나가 아니다** (WORKSPACE_SAVE_CONFLICT_SRS §2.10).
    // 그래서 유예는 rev 를 남기고, 비행의 끝이 그 rev 로 판정한다 (FR-WSC-15·16).
    if(this._saveInflight){ this._wsDefer(rev); return }
    if(this._wsApplyInflight){ this._wsDefer(rev); return }
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
        // 창구다 (`openGitWindow` 는 로컬 배열에만 넣고 저장은 뒤따른다).
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
    // FR-WSC-12: 이 스냅샷에 실린 창이 곧 **원격이 아는 창**이다. 아래에서
    // 마이그레이션·재조정이 `sv.windows` 를 고치므로 그 전에 적어 둔다.
    this._wsMarkSaved(sv.windows);
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
    // 재조정이 같은 루트의 창을 새 id 로 만들었을 수 있다 — 그때 활성 창을
    // **루트로** 다시 찾는다. 아래 폴백보다 먼저여야 한다: 폴백은 id 가 없으면
    // 일반 창을 고르므로, 여기서 잇지 않으면 방금 연 Repo 창을 잃는다.
    this._edKeepActive(sv);
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
    // REPO_SIDE_WIDTH_SRS FR-RSW-5: 다른 브라우저가 개정 이전 모양을 보내올 수
    // 있다 — 옮긴 키를 지우는 자리는 첫 로드와 여기 둘이다.
    if(this._edMigrateSideWidth()) edChanged=true;
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
        this._edOpenFile(filePath,{name:name||pathBase(filePath)});
        return;
      }
      if(location) this._focusLocation(location);
      const rid=this.focused;
      if(rid) this.addTab(rid,'editor',{name:name||pathBase(filePath),filePath});
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
      // FR-WBR-22: `dmctl` 은 더 이상 호출자 도구를 자동으로 싣지 않는다 —
      // 새 창은 홈에서 뜬다. `cwdTool` 은 다른 호출자가 명시로 줄 때만 온다
      // (FR-CWD-3 은 남는다).
      // FR-WBR-23: `--cwd` 가 오면 그 경로다. `--workdir` 은 샌드박스 창의
      // 컨테이너 안 자리라 다른 인자이며, 둘이 함께 오면 앞의 것이 이긴다.
      this._mkWindow({name:args.name,keepFocus:!!args.keepFocus,cwdTool:args.cwdTool,
        sandbox:args.sandbox,cwd:args.cwd||args.workdir}).then((c)=>{
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
        // UX_BATCH6_SRS FR-RUN-6: `force` 는 확인창을 건너뛴다. 서버가 이미
        // 에이전트에게 종료를 청하고 기다린 뒤이며, 사용자의 결정은 그 명령을
        // 부른 순간에 있었다.
        this.closeTab(tgt.paneId, tgt.tabId, tgt.windowId, args.force?{force:true}:undefined);
        return;
      }
      /**
       * UX_BATCH6_SRS FR-RUN-6b: **자리를 찾지 못하면 아무것도 닫지 않는다.**
       *
       *   이전 동작: 아래 공통 경로로 떨어져 `_focusLocation` 이 실패하고,
       *             그대로 `executeAction('closeTab')` 이 **포커스 탭**을 닫았다
       *   새  동작: 사유를 남기고 끝낸다
       *   이유:     지목한 자리를 못 찾은 명령이 **엉뚱한 탭을 지우는** 것은
       *             어떤 경우에도 옳지 않다. 이미 닫힌 탭을 한 번 더 닫으라는
       *             요청이 사용자의 터미널을 없애는 것을 실측했다 (e2e
       *             `skill-contract` 의 "사용자 공간이 전후로 같다" 가 잡았다)
       *
       * `_resolveLocation` 과 `_focusLocation` 은 같은 규칙을 쓰므로, 앞이
       * 실패했으면 뒤도 실패한다 — 이 갈래에서 잃을 정상 동작이 없다.
       */
      console.warn('[cmd] closeTab: 대상 없음',args.location);
      return;
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

  /**
   * UX_BATCH6_SRS FR-RUN-6a: **탭 uuid 를 먼저 본다.**
   *
   *   이전 동작: 좌표(`W1.P1.T1`)만 해석했다
   *   새  동작: uuid 면 그 탭을 찾고, 아니면 종전대로 좌표로 읽는다
   *   이유:     좌표는 **자리**라 앞의 탭이 닫히면 뒤의 것이 밀린다. 여러 탭을
   *             한 번에 닫는 명령(Run 정리, FR-RUN-6)이 좌표를 미리 계산해
   *             보내면 두 번째부터 **엉뚱한 탭**을 가리킨다. uuid 는 그 성질이
   *             없고, 그것이 uuid 를 둔 이유다 (FR-IDU-1)
   *
   * `/api/commands` 는 종전대로 uuid 를 좌표로 바꿔 보낸다 — 그 경로는 바뀌지
   * 않는다. 여기서 uuid 를 함께 받는 것은 **서버가 직접 방송하는** 명령을 위한
   * 것이다.
   */
  _resolveLocation(loc){
    if(!loc) return null;
    const m=String(loc).toUpperCase().trim().match(/^W?(\d+)(?:[.\s]+P?(\d+))?(?:[.\s]+T?(\d+))?$/);
    // 좌표 모양이 아니면 uuid 다. **좌표를 먼저 본다** — 옛 워크스페이스의 짧은
    // 숫자 id 가 좌표로도 읽히는 경우에 뜻이 갈리지 않게 한다.
    if(!m) return this._findTabById(String(loc));
    const si=parseInt(m[1],10)-1;
    const pi=m[2]?parseInt(m[2],10)-1:0;
    const ti=m[3]?parseInt(m[3],10)-1:0;
    const sess=this.ws.windows[si]; if(!sess) return null;
    const panes=[]; this._collectPanes(sess.layout,panes);
    const pn=panes[pi]; if(!pn) return null;
    const tab=pn.tabs[ti]; if(!tab) return null;
    return {windowId:sess.id,paneId:pn.id,tabId:tab.id,win:sess,pane:pn,tab:tab};
  },

  // 탭 uuid 로 그 자리를 찾는다. 없으면 null 이다 (FR-RUN-6a).
  _findTabById(id){
    for(const win of this.ws.windows){
      const panes=[]; this._collectPanes(win.layout,panes);
      for(const pn of panes){
        for(const tab of (pn.tabs||[])){
          if(tab.id!==id) continue;
          return {windowId:win.id,paneId:pn.id,tabId:tab.id,win,pane:pn,tab};
        }
      }
    }
    return null;
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

/**
 * SSE 의 내부 상태를 붙잡던 이름들 (FR-HUB-7).
 *
 * 채널은 `EventBus` 로 갔지만 이 이름들은 남는다 — `app-reload.js` 의 소프트리로드
 * 1단계가 `_sse.readyState` 로 생존을 보고, e2e 여섯이 `_sse`·`_cmdES`·`_sseGen`·
 * `_sseSeen` 을 직접 만진다 (`version-autoreload` 는 `_sseSeen` 에 **쓴다** —
 * 침묵을 흉내내는 유일한 방법이다).
 *
 * 위임 껍데기가 메서드에만 적용된다고 보면 이 자리를 놓친다. **바깥은 상태
 * 필드에도 손을 뻗는다** — `APP_STATE_EXTRACT_SRS` §2.3 이 같은 함정을 실측으로
 * 기록했다.
 */
Object.defineProperties(App.prototype,{
  // 종전 코드에서 `_sse` 와 `_cmdES` 는 같은 EventSource 를 가리켰다.
  _sse:   {get(){ return this.bus?this.bus._es:null }, configurable:true},
  _cmdES: {get(){ return this.bus?this.bus._es:null }, configurable:true},
  _sseGen:{get(){ return this.bus?this.bus.gen():0 }, configurable:true},
  _sseSeen:{
    get(){ return this.bus?this.bus.lastSeen():0 },
    set(v){ if(this.bus) this.bus._seen=v },
    configurable:true,
  },
});
