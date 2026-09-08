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
    events:{tool_activity:'_onToolActivity'},
    revalidateOn:['sse:open','softreload'],
    // 이 상태만 주기를 갖는다. 서버가 활동 변화를 전부 밀지는 않기 때문이다
    // (AGENT_ACTIVITY_PANEL_SRS) — 주기는 사용자가 정한다.
    every:(app)=>app.agentsPollMs,
  },
  {
    id:'tool.foreground',
    restore:'_fgRestore',
    merge:'touched',
    flight:'fg',
    events:{tool_foreground:'_onToolForeground'},
    revalidateOn:['sse:open','softreload'],
  },
  {
    id:'tool.background',
    restore:'_bgRefresh',
    // **`touched` 가 아니다.** `tools_background_changed` 는 증분을 나르지 않고
    // "목록을 다시 받으라" 는 신호다 (FR-BGV-1). 만진 id 라는 개념이 없으므로
    // 보호할 것도 없다 — 막아야 하는 것은 스냅샷끼리의 추월뿐이다.
    merge:'latest',
    flight:'background',
    events:{tools_background_changed:'_bgRefresh'},
    revalidateOn:['sse:open','softreload'],
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
    events:{settings_changed:'_settingsRestore'},
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
    id:'window.focus',
    restore:'_focusRestore',
    // 전체 소유권 맵이 온다. 증분이 아니므로 통째로 갈아치우면 되고 자기 에코
    // 필터가 필요 없다 (FR-XDF-14 — 멱등). 여기서도 추월만 막는다.
    merge:'latest',
    flight:'focus',
    events:{window_focus:'_onWindowFocus'},
    revalidateOn:['sse:open','softreload'],
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
    for(const when of d.revalidateOn||[]){
      bus.subscribe(when,()=>call(d.restore),{owner:'state:'+d.id});
    }
    if(d.every){
      app.timers.every({
        id:d.id, owner:'state:'+d.id,
        every:()=>d.every(app),
        run:()=>call(d.restore),
      });
    }
  }
}

// 재검증 계기가 `softreload` 인 상태들. `app-reload.js` 가 이것을 순회한다.
function stateRegistryIds(){ return STATE_REGISTRY.map(d=>d.id) }
