/**
 * 폴링 주기 설정 — **주기가 한 화면에 나란히 선다** (POLL_INTERVAL_SETTINGS_SRS).
 *
 * 접수한 말은 "polling 이 한쪽에 모여있잖아? setting 에서 이 값을 조절할 수
 * 있도록" 이다. 앞부분은 이미 참이었다 — 주기의 진실은 `STATE_REGISTRY` 의 선언과
 * `constants-git.js` 의 상수 몇으로 모여 있었다. 참이 아니던 것은 뒷부분이다:
 * 다섯 중 둘만 화면에서 바꿀 수 있었고, 그 둘조차 서로 다른 탭에 있었다.
 *
 * **표 하나가 전부를 진다** (FR-PIS-6·7·10). 값을 읽는 자리·쓰는 자리·선택지·
 * 설명이 한 행에 있으므로, 주기를 더할 때 고치는 곳이 이 배열 하나다. 흩어 두면
 * `saveSettings` 의 키 목록과 `_settingsApply` 와 화면이 세 벌이 되고, 그중
 * 하나를 빠뜨린 실패는 다른 브라우저 창을 열어 보기 전까지 아무도 모른다.
 *
 * 로드 순서 계약: constants-git.js·constants.js **뒤**(기본값 상수를 읽는다),
 * app-settings.js **앞**(`_settingsApply` 가 이 표를 지난다).
 */

/**
 * 주기 하나의 서술자.
 *
 *   key       서버 설정의 키이자 `saveSettings` 가 싣는 이름
 *   id        `Polling` 탭에 서는 `<select>` 의 id
 *   label     사용자가 보는 이름
 *   hint      **무엇을 얼마나 자주 묻는지** (FR-PIS-21). 값 이름이 아니라 화면의 말이다
 *   def()     기본값. 값이 깨졌을 때 돌아갈 자리이기도 하다 (FR-PIS-11)
 *   get/set   전역 변수의 읽기·쓰기. 변수는 파일이 저마다 달라 이름만으로는 닿지 않는다
 *   opts      선택지 [ms, 라벨]. 주기마다 다르다 (D-6)
 *   off       `0`(끔)을 값으로 받는가. 안전망 하나뿐이다 (FR-PIS-9)
 */
const POLL_SETTINGS=[
  {
    key:'agentsPollInterval', id:'pi-agents', label:'에이전트 활동',
    hint:'실행 중인 도구의 활동 스냅샷 — 에이전트 패널의 카드와 탭의 활동 표시',
    def:()=>AGENTS_POLL_DEFAULT,
    get:()=>agentsPollInterval, set:v=>{agentsPollInterval=v},
    opts:[[2000,'2초'],[3000,'3초'],[5000,'5초'],[10000,'10초'],[30000,'30초']],
  },
  {
    key:'statsInterval', id:'pi-stats', label:'시스템 통계',
    hint:'하단 상태바의 CPU·메모리·지연',
    def:()=>STATS_INTERVAL_DEFAULT,
    get:()=>statsInterval, set:v=>{statsInterval=v},
    opts:[[1000,'1초'],[2000,'2초'],[3000,'3초'],[5000,'5초'],[10000,'10초'],[30000,'30초']],
  },
  {
    key:'gitStatusInterval', id:'pi-gitstatus', label:'git 상태 안전망',
    hint:'평소 git 변화는 서버가 곧바로 알립니다. 이것은 그 알림이 놓친 것을 줍는 그물이라 드물어도 됩니다.',
    def:()=>GIT_STATUS_POLL_MS,
    get:()=>gitStatusInterval, set:v=>{gitStatusInterval=v},
    // FR-PIS-9: `0` 이 뜻을 갖는 유일한 자리 — 본줄이 따로 있으므로 꺼도 멎지 않는다.
    //
    // GIT_WATCH_LEASE_SRS FR-GWL-11·12: 그 진술이 오래 **거짓**이었다. 서버 감시의
    // 임대가 이 폴링에 매달려 있어서, 끄면 본줄인 push 까지 죽었다 (GP-1). 임대를
    // SSE 구독으로 옮겨 참으로 만들었고, 그러면서 `1분`·`2분` 을 뺐다 — 놓친 것을
    // 줍는 그물이 1~2분에 한 번이면 그물이 아니고, 그 사이는 push 가 이미 덮는다.
    // 짧게 두거나 끄거나 둘 중 하나다.
    off:true,
    opts:[[10000,'10초'],[30000,'30초'],[0,'끔']],
  },
  {
    key:'gitReposInterval', id:'pi-gitrepos', label:'저장소 목록·탐색기',
    hint:'사이드바의 변경 개수 배지, 탐색기의 파일 목록과 git 색',
    def:()=>GIT_REPOS_POLL_MS,
    get:()=>gitReposInterval, set:v=>{gitReposInterval=v},
    opts:[[1000,'1초'],[2000,'2초'],[3000,'3초'],[5000,'5초'],[10000,'10초'],[30000,'30초']],
  },
  {
    key:'gitConsoleInterval', id:'pi-gitconsole', label:'git 콘솔',
    hint:'Git 의 명령 기록. 그 탭을 보고 있는 동안에만 묻습니다.',
    def:()=>GIT_CON_POLL_MS,
    get:()=>gitConsoleInterval, set:v=>{gitConsoleInterval=v},
    opts:[[1000,'1초'],[2000,'2초'],[5000,'5초'],[10000,'10초']],
  },
];

const POLL_BY_KEY=Object.fromEntries(POLL_SETTINGS.map(s=>[s.key,s]));

/**
 * FR-PIS-8: 저장된 값 하나를 **쓸 수 있는 주기**로 만든다.
 *
 * 미저장·정수 아님·범위 밖은 전부 기본값으로 떨어진다. 손으로 고친
 * `settings.json` 하나가 초당 폴링을 만들지 않아야 하기 때문이며, 하한은 그
 * 주기의 선택지 최소값이다 — 화면에서 고를 수 없는 값을 파일로는 넣을 수 있다면
 * 선택지를 나눈 이유(D-6)가 사라진다.
 *
 * `0` 은 `off:true` 인 주기에서만 통과한다 (FR-PIS-9).
 */
function pollValue(raw,spec){
  const d=spec.def();
  if(raw===undefined||raw===null) return d;
  const n=Math.round(Number(raw));
  if(!Number.isFinite(n)) return d;
  if(n===0) return spec.off?0:d;
  const vals=spec.opts.map(o=>o[0]).filter(v=>v>0);
  const lo=Math.min(...vals), hi=Math.max(...vals);
  return (n>=lo&&n<=hi)?n:d;
}

Object.assign(App.prototype, {
  /**
   * FR-PIS-20·24: `Polling` 탭을 그린다. 골격은 다른 탭과 같은 `.ds-row` 이고
   * 컨트롤은 기존 두 자리가 쓰던 `.sbs-select` 그대로다 — 새 클래스를 만들지 않는다.
   *
   * 행을 **여기서** 만드는 이유는 표가 진실이기 때문이다 (FR-PIS-6). index.html 에
   * 손으로 다섯을 적으면 주기를 더할 때 고칠 자리가 둘이 된다.
   */
  initPollingSettings(){
    const box=document.getElementById('poll-settings');
    if(!box||box.dataset.built==='1') return;
    for(const spec of POLL_SETTINGS){
      const row=document.createElement('div');
      row.className='ds-row';
      const label=document.createElement('span');
      label.textContent=spec.label;
      const sel=document.createElement('select');
      sel.id=spec.id; sel.className='sbs-select';
      for(const [v,t] of spec.opts){
        const o=document.createElement('option');
        o.value=String(v); o.textContent=t;
        sel.appendChild(o);
      }
      sel.addEventListener('change',()=>{
        spec.set(pollValue(parseInt(sel.value,10),spec));
        this.saveSettings();
        // 값이 바뀐 즉시 도는 타이머에 닿는다 — 저장 왕복을 기다리면 사용자는
        // 설정이 듣지 않는 것으로 읽는다 (FR-WBR-10·11 과 같은 근거).
        if(spec.key==='gitStatusInterval'){
          if(this.gitPanel&&this.gitPanel._reschedule) this.gitPanel._reschedule();
        }
        TIMERS.refreshChanged();
      });
      row.appendChild(label); row.appendChild(sel);
      box.appendChild(row);
      const hint=document.createElement('div');
      hint.className='ds-hint';
      hint.textContent=spec.hint;
      box.appendChild(hint);
    }
    box.dataset.built='1';
    this._pollPaintRows();
  },

  // 표의 값을 화면에 얹는다. `_settingsApply` 도 이것을 부르므로 다른 창에서
  // 바뀐 값이 SSE 로 왔을 때 열려 있는 설정창이 옛 값을 든 채 남지 않는다.
  _pollPaintRows(){
    for(const spec of POLL_SETTINGS){
      const sel=document.getElementById(spec.id);
      if(sel) sel.value=String(spec.get());
    }
  },

  /**
   * FR-PIS-17 / D-9: `agentsPollMs` 의 이사. **한 번이고 조용하다.**
   *
   * 서버에 값이 있으면 서버가 이긴다 — 여러 기기가 각자 옛 값을 들고 있을 때
   * 마지막에 뜬 기기가 남의 설정을 덮으면 안 된다. 어느 쪽이든 로컬의 옛 값은
   * 지운다: 남겨 두면 다음 부팅이 같은 판단을 다시 하고, 그 사이에 서버 값이
   * 바뀌었다면 그때는 덮는다.
   */
  _pollMigrateAgents(saved){
    let old=null;
    try{ old=localStorage.getItem('agentsPollMs') }catch{}
    if(old===null) return;
    try{ localStorage.removeItem('agentsPollMs') }catch{}
    if(saved&&saved.agentsPollInterval!==undefined) return;
    const v=pollValue(parseInt(old,10),POLL_BY_KEY.agentsPollInterval);
    if(v===agentsPollInterval) return;
    agentsPollInterval=v;
    TIMERS.refreshChanged();
    this._pollPaintRows();
    this.saveSettings();
  },
});
