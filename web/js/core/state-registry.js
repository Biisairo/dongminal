// @ts-check
/**
 * 상태 등록부 — **다섯 상태의 갱신 경로가 한 화면에 나란히 선다**
 * (EVENT_TIMER_HUB_SRS 묶음 H · FR-HUB-1~3).
 *
 * 세 번째 클래스가 아니다. 여기 있는 것은 **선언 데이터**이고, 런타임 주체는
 * `TimerHub` 와 `EventBus` 둘뿐이다 (INV-1·2).
 *
 * **이 파일이 생기기 전의 모양** (SRS §2.3): 같은 다섯이 세 곳에 손으로 나열돼
 * 있었다 — `app-cmd.js` 의 `onopen` 한 줄, `app-reload.js` 의 `_softStep` 다섯
 * 줄, `onmessage` 의 if-체인. 새 상태를 더하면 셋을 다 고쳐야 했고, 하나를
 * 빠뜨리면 조용히 안 갱신됐다. 그 빠뜨림이 실제로 일어났다 — `w.editor.refresh()`
 * 가 `typeof` 가드에 삼켜져 탐색기만 낡은 채 남았다 (FR-WBR-95).
 *
 * **선언을 각 상태 파일에 흩는 안을 검토해 버렸다** (D-5). 그러면 "세 곳 나열" 은
 * 낫지만 재검증 정책과 `merge` 를 비교하려면 여전히 다섯 파일을 열어야 한다 —
 * §2.5 의 결함(`background`·`focus` 만 경쟁 방어가 없었다)을 여태 아무도 못 본
 * 이유가 정확히 그것이다. **빈 칸은 나란히 놓아야 보인다.**
 *
 * 구현 본체(`restore`)는 기존 다섯 파일에 남는다. 옮긴 것은 선언뿐이다.
 *
 * **`merge` 가 두 종류인 것이 이 파일의 값어치다.**
 *
 *   touched  증분이 개별 id 를 만진다. 비행 중에 만져진 id 는 뒤늦게 도착한
 *            스냅샷이 덮지 못한다 (FR-RSF-3).
 *   latest   증분이 없다 — 방송은 "다시 받으라" 는 신호이거나 전체 판이다.
 *            막아야 하는 것은 **스냅샷끼리의 추월**뿐이다.
 *
 * 이 구분은 나란히 놓았을 때만 보인다. SRS §2.5 는 처음에 `background` 와
 * `focus` 에 방어가 "빠졌다" 고 진단했는데, 다섯을 한 화면에 놓고 보니 그 둘은
 * 증분 자체가 없어 `touched` 가 성립하지 않는 상태였다. **진단이 틀렸던 것도
 * 나란히 놓아서 알았다.**
 */
const STATE_REGISTRY=[
  {
    id:'tool.attention',
    restore:'_attnRestore',
    merge:'touched',      // 증분이 id 를 만진다 — 스냅샷이 그것을 덮으면 안 된다
    flight:'attn',
    part:'attention',
    events:{
      tool_attention:'_onToolAttention',
      tool_attention_clear:'_onToolAttentionClear',
    },
    revalidateOn:['sse:open','softreload'],
  },
  {
    id:'tool.activity',
    restore:'_activityRestore',
    merge:'touched',
    flight:'activity',
    part:'activity',
    events:{tool_activity:'_onToolActivity',tool_subagent_activity:'_onToolSubagentActivity'},
    revalidateOn:['sse:open','softreload'],
    // 이 상태만 주기를 갖는다. 서버가 활동 변화를 전부 밀지는 않기 때문이다
    // (AGENT_ACTIVITY_PANEL_SRS) — 주기는 사용자가 정한다.
    every:(app)=>app.agentsPollMs,
    // FR-AAP-19 · OPTIMIZE_REFACTOR_SRS FR-OPT-4-6: 읽는 곳이 있을 때만 돈다 — 패널,
    // 그리고 알림의 detail (`_attnDetail`).
    when:(app)=>app._agentsPanelShown()||app._attn.size>0,
  },
  {
    /**
     * OPTIMIZE_REFACTOR_SRS FR-OPT-4-5 (RESTORE_FLIGHT FR-RSF-3 경로 개정) — **복원이
     * 워크스페이스 적용 경로에 있다.**
     *
     *   이전 동작: 구독이 열릴 때마다 `_fgRestore` 가 전경 이름 하나를 얻으려고
     *             `/api/state` 전체를 받았다 — 재연결이면 `_onWorkspaceChanged` 가
     *             같은 것을 한 번 더 받았고, 첫 연결이면 부팅이 방금 받은 것이다
     *   새  동작: 첫 화면은 `init` 이 받은 도구 목록으로, 재연결·소프트 리로드는
     *             `_onWorkspaceChanged` 가 받은 목록으로 이름을 얹는다. 그 요청이
     *             `fg` 비행을 연다 — 비행 중에 만진 id 는 스냅샷이 덮지 않는다
     *   이유:     같은 목록을 두 번 받을 이유가 없다 (IPC-6 · FEC-10)
     */
    id:'tool.foreground',
    merge:'touched',
    flight:'fg',
    events:{tool_foreground:'_onToolForeground'},
  },
  {
    /**
     * ACTIVITY_RUNS_REFRESH_SRS FR-ARR-1~3 — 멤버 상태·생존은 서버가 물을 때 계산하므로
     * `run_changed` 로 오지 않는다. 패널이 열린 동안 활동 주기로 다시 받는다.
     * `run_changed` 구독은 대시보드도 다시 받으므로 `app-ws-sync.js` 에 남는다 (D-ARR-3).
     * FR-ARR-6: 새로고침하면 패널이 열린 채로 복원되어 「열 때 받기」를 거치지 않는다 — 구독이 열릴 때 받는다.
     */
    id:'run.list',
    restore:'_runsListRestore',
    merge:'latest',
    revalidateOn:['sse:open','softreload'],
    every:(app)=>app.agentsPollMs,
    when:(app)=>app._agentsPanelShown(),
  },
  {
    /**
     * RUN_VIEW_LIVE_SRS FR-RLV-7 (D-RLV-1 이 FR-RVZ-16 의 "폴링하지 않는다" 를 거뒀다) — 열린
     * Run 탭의 안전망. 신호가 없는 변화(사용률 숫자, 조용한 죽음)를 활동 주기 안에 고친다.
     */
    id:'run.views',
    restore:'_runViewsRestore',
    merge:'latest',
    every:(app)=>app.agentsPollMs,
    when:(app)=>app._runViewsOpen(),
  },
  {
    id:'tool.background',
    restore:'_bgRefresh',
    // **`touched` 가 아니다.** `tools_background_changed` 는 증분을 나르지 않고
    // "목록을 다시 받으라" 는 신호다 (FR-BGV-1). 만진 id 라는 개념이 없으므로
    // 보호할 것도 없다 — 막아야 하는 것은 스냅샷끼리의 추월뿐이다.
    merge:'latest',
    flight:'background',
    part:'background',
    events:{tools_background_changed:'_bgRefresh'},
    revalidateOn:['sse:open','softreload'],
    // UX_BATCH12 FR-LIV-7: 행의 Run 표지와 cwd 는 조회 때 계산된다 — 신호가 없는 변화를
    // 패널이 열린 동안 활동 주기로 고친다 (`run.list` 와 같은 모양).
    every:(app)=>app.agentsPollMs,
    when:(app)=>app._agentsPanelShown(),
  },
  {
    /**
     * SETTINGS_LIVE (2026-09-08 접수) — **설정도 상태다.**
     *
     * 접수한 말은 "설정값이 바뀌었을 때 다른 브라우저창은 바로 갱신이 안된다"
     * 이고, 원인은 설정에 갱신 경로가 **없었다**는 것이다: 부팅에서 한 번 읽고
     * 끝이었다. 여기 한 줄을 더하면 다른 넷과 같은 규약을 그대로 받는다 —
     * 구독이 열릴 때 재검증하고, 소프트 리로드에서 다시 받고, 방송이 오면 얹는다.
     *
     * `merge:'latest'` 인 것은 `background` 와 같은 근거다 — 방송이 증분을
     * 나르지 않고 "다시 받으라" 는 신호다. 만진 id 라는 개념이 없다.
     *
     * `every` 는 없다. 설정은 사용자가 바꿀 때만 바뀌고, 그 순간을 서버가 안다.
     */
    id:'settings',
    restore:'_settingsRestore',
    merge:'latest',
    flight:'settings',
    part:'settings',
    // FR-OPT-4-5 (FEC-10): 첫 연결의 재검증은 건너뛴다 — 부팅(`main.js`)이 방금 받았다.
    // 부팅 조회와 구독 사이의 짧은 틈에 바뀐 값은 다음 방송·재연결이 준다.
    bootCovered:true,
    events:{settings_changed:'_onSettingsChanged'},
    revalidateOn:['sse:open','softreload'],
  },
  {
    /**
     * UPDATE_NOTICE_SRS FR-UPD-9a — **배지도 상태다.**
     *
     * `every` 가 없다. 하루에 한 번 바뀌는 값에 주기를 붙이면 `_pollStats` 의
     * 3초마다 묻게 되고 그건 28,800배의 낭비다 (D-UPD-4). 대신 값이 바뀌면
     * 서버가 `update_changed` 로 민다 (FR-UPD-8a).
     *
     * `revalidateOn:['sse:open']` 이 페이지 로드와 재연결의 재조회를 그대로
     * 준다. **서버 쪽 확인을 거는 것은 이쪽이 아니다** — 그건 서버의 SSE 연결
     * 훅이고(FR-UPD-2 ②), 여기서 하는 일은 캐시를 읽는 것뿐이다.
     *
     * `merge:'latest'` 는 `background`·`settings` 와 같은 근거다 — 방송이
     * 증분을 나르지 않고 "다시 받으라" 는 신호다.
     */
    id:'update',
    restore:'_updateRestore',
    merge:'latest',
    flight:'update',
    part:'update',
    events:{update_changed:'_updateRestore'},
    revalidateOn:['sse:open','softreload'],
  },
  {
    /**
     * GIT_PUSH_OBSERVE_SRS — **서버가 밀어 준다.**
     *
     * `every` 가 없다. 종전에는 브라우저가 signature 를 500ms 마다 물어 변화를
     * 스스로 찾았고, 60초에 180번(sig 120 + status 60)이 나갔다. 이제 서버가
     * 그것을 확인하고 바뀌었을 때만 알린다 (FR-GPO-1).
     *
     * 안전망 폴링은 여기 없고 `GitObserver` 의 `_applyCadence` 가 갖는다 —
     * 그 계층은 백오프(FR-RMS-22)·소실 고정 주기(FR-RMS-6)·활성 저장소 판정
     * (`_pollOk`)을 함께 쥐고 있어서, 주기만 떼어 올 수 없다.
     *
     * `restore` 도 그쪽 손잡이를 부른다. 재검증 계기는 하나뿐이다 —
     * 구독이 열린 순간, 끊겨 있던 동안의 변화는 방송으로 오지 않았다
     * (FR-GPO-23).
     */
    id:'git.observe',
    restore:'_gitObserveRestore',
    merge:'latest',
    events:{git_changed:'_onGitChanged'},
    revalidateOn:['sse:open'],
  },
  {
    /**
     * EDITOR_LIVE_RELOAD_SRS 묶음 W·C — **서버가 밀어 준다.** 보이는 디렉터리의 변화가
     * `fs_changed` 로 온다. 등록의 수명은 SSE 구독이므로(FR-ELR-52) 구독이 열리면
     * 지금의 집합을 다시 등록한다. 안전망은 편집기 틱(`_edTick`)이다 (FR-ELR-61).
     */
    id:'fs.watch',
    restore:'_edWatchRestore',
    merge:'latest',
    events:{fs_changed:'_onFsChanged'},
    revalidateOn:['sse:open'],
  },
  {
    /**
     * OPTIMIZE_REFACTOR_SRS FR-OPT-4-4 (FR-GIT-101a 개정) — **서버가 밀어 준다.**
     *
     * 작업의 시작·끝을 서버가 `git_jobs_changed` 로 알린다. `every` 는 없다 — 상태바
     * 틱이 `/api/stats?jobs=1` 로 같은 목록을 안전망으로 싣는다. Git 패널이 없으면
     * `restore` 가 묻지 않는다 (`_gitJobsWanted`).
     */
    id:'git.jobs',
    restore:'_pollGitJobs',
    merge:'latest',
    flight:'gitJobs',
    events:{git_jobs_changed:'_pollGitJobs'},
    revalidateOn:['sse:open','softreload'],
  },
  {
    id:'window.focus',
    restore:'_focusRestore',
    // 전체 소유권 맵이 온다. 증분이 아니므로 통째로 갈아치우면 되고 자기 에코
    // 필터가 필요 없다 (FR-XDF-14 — 멱등). 여기서도 추월만 막는다.
    merge:'latest',
    flight:'focus',
    part:'focus',
    events:{window_focus:'_onWindowFocus'},
    revalidateOn:['sse:open','softreload'],
  },
  {
    /**
     * PEER_NETWORK_SRS FR-PNW-81·82 — 짝·승인 대기. `every` 가 없다 — 바뀌면 서버가
     * `peers_changed` 로 민다. 끊겨 있던 동안 생긴 대기는 재연결의 스냅샷이 준다.
     */
    id:'peers',
    restore:'_peersRestore',
    merge:'latest',
    flight:'peers',
    part:'peers',
    events:{peers_changed:'_onPeersChanged'},
    revalidateOn:['sse:open','softreload'],
  },
  {
    /**
     * UX_BATCH12 FR-LIV-4 — 열린 설정 패널이 다른 곳의 저장을 따라간다. 패널이 닫혀 있으면
     * 아무것도 하지 않는다 — 열 때 읽는다.
     */
    id:'settings.live',
    events:{access_changed:'_onAccessChanged',sandbox_changed:'_onSandboxChanged'},
  },
];

/**
 * 선언을 배선으로 바꾼다. **세 곳 나열이 여기서 파생된다** (FR-HUB-3).
 *
 * 새 상태를 더할 때 고치는 곳이 셋에서 하나가 되고, `typeof` 가드가 조용히
 * 삼킬 자리 자체가 없어진다.
 */
function wireStateRegistry(app){
  const bus=app.bus;
  const call=(name,args)=>{
    const fn=app[name];
    // 이름이 사라졌으면 **소리를 낸다.** 종전의 `&&` 가드는 같은 상황을 조용히
    // 삼켰고, 그래서 한 상태만 갱신되지 않는 채로 배포됐다 (FR-WBR-95).
    if(typeof fn!=='function'){ console.error('[state]',name,'이 없다'); return }
    return fn.call(app,args);
  };

  for(const d of STATE_REGISTRY){
    for(const [topic,handler] of Object.entries(d.events||{})){
      bus.subscribe(topic,a=>call(handler,a),{owner:'state:'+d.id});
    }
    if(d.every){
      app.timers.every({
        id:d.id, owner:'state:'+d.id,
        every:()=>d.every(app),
        when:d.when?()=>d.when(app):undefined,
        run:()=>call(d.restore),
      });
    }
  }
  /**
   * 재검증은 **계기마다 한 번** 모은다 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-5).
   *
   *   이전 동작: 상태마다 자기 GET 을 냈다 — 구독이 열릴 때 7건
   *   새  동작: `part` 를 가진 상태는 `/api/snapshot` 하나를 나눠 받는다
   *   이유:     재연결마다 왕복 여럿이 한꺼번에 나갔다 (IPC-6 · FEC-11)
   *
   * 비행·병합 규약은 그대로다. 복원은 여전히 **부를 때** 자기 비행을 열고(요청이
   * 떠나기 전이다) 응답이 오면 자기 조각을 자기 규약으로 얹는다 — 바뀐 것은 요청을
   * 누가 내는가뿐이다. `sse:open` 의 첫 연결(`gen===1`)에서는 부팅이 방금 받은
   * 상태(`bootCovered`)를 건너뛴다 (FEC-10).
   */
  const topics=new Set();
  for(const d of STATE_REGISTRY) for(const w of d.revalidateOn||[]) topics.add(w);
  for(const topic of topics){
    bus.subscribe(topic,a=>{
      const first=topic==='sse:open'&&!!a&&a.gen===1;
      const due=STATE_REGISTRY.filter(d=>(d.revalidateOn||[]).includes(topic)&&!(first&&d.bootCovered));
      const parts=due.filter(d=>d.part).map(d=>d.part);
      const snap=parts.length?apiGet('/api/snapshot',{query:{parts:parts.join(',')}}):null;
      for(const d of due) call(d.restore,d.part?stateSnapshotPart(snap,d.part):undefined);
    },{owner:'state'});
  }
}

/**
 * 스냅샷 봉투에서 조각 하나의 봉투를 만든다 — 그 종단을 직접 부른 것과 같은 모양이다
 * (`core/api.js` 의 봉투). 조각이 없으면 실패 봉투다: 서버가 그 종단의 실패를 싣지 않았다.
 * `text` 는 조각의 JSON 이다 — 설정의 자기 에코 판정이 그것을 본다 (D-OPT-7).
 */
function stateSnapshotPart(snap,name){
  return snap.then(r=>{
    const d=r&&r.ok&&r.data;
    if(!d||!Object.prototype.hasOwnProperty.call(d,name)) return {ok:false,status:r?r.status:0,data:null,text:'',headers:null};
    const v=d[name];
    return {ok:true,status:200,data:v,text:JSON.stringify(v),headers:null};
  });
}

/**
 * 복원이 읽을 봉투. 등록부가 스냅샷 조각을 주었으면 그것이고, 아니면 그 종단을 직접
 * 부른다 — 방송(`tools_background_changed` 등)과 손으로 부른 새로고침이 그 길이다.
 * 방송은 인자 객체를 넘기므로 약속(then)인지로 가른다.
 */
function stateFetch(src,path){
  return (src&&typeof src.then==='function')?src:apiGet(path);
}

// 재검증 계기가 `softreload` 인 상태들. `app-reload.js` 가 이것을 순회한다.
function stateRegistryIds(){ return STATE_REGISTRY.map(d=>d.id) }
