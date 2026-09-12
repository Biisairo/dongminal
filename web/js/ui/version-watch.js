/**
 * Remote Terminal — 새 버전 자동 새로고침 (RELOAD_CONTINUITY_SRS 묶음 P)
 *
 * 서버를 재시작해도 열려 있는 페이지는 옛 JS 를 계속 돌린다. WebSocket 만
 * 재연결되고 문서는 그대로이기 때문이다. 실제로 그 때문에 교정을 반영하지 않은
 * 화면으로 세 차례 검증을 했다 — 로드 시점이 32분 전이었다.
 *
 * 판이 달라졌으면 **곧바로 다시 연다** (FR-RLC-1). 배너를 띄우고 기다리던 이전 판은
 * 사용자가 그것을 누르지 않으면 이 파일이 막으려던 상태 — 옛 JS 로 계속 도는 화면 —
 * 를 그대로 남겼다.
 *
 * **계기는 주기가 아니라 서버의 인사다** (FR-RLC-2). 자산은 바이너리에 박혀 있어
 * (`web/embed.go`) 그것이 바뀌는 길은 프로세스 교체뿐이고, 프로세스가 바뀌면 SSE 는
 * 반드시 끊긴다 — 그래서 **구독이 열리는 순간**이 곧 물어볼 순간이며, 서버가 그때
 * 자기 판을 실어 보낸다. 주기 폴링은 같은 일을 두 벌로 하는 것이라 없앴다.
 *
 * 보조 계기 하나가 남는다 — 탭이 다시 보이는 순간. 인사가 닿지 못하는 상태(구독이
 * 죽은 채 사용자가 돌아온 경우)의 길이며, 그때만 `index.html` 을 받아 견준다.
 *
 * **dirty 편집기가 있으면 물러난다** (D-2 개정 2026-09-11 · 로드맵 `FUI-03`).
 * 이 파일이 막으려는 것은 "옛 JS 로 계속 도는 **방치된** 화면" 인데, 저장하지 않은
 * 편집이 있다는 것은 사용자가 그 화면을 **지금 쓰고 있다**는 뜻이다. 그때는 배너로
 * 알리고, dirty 가 풀린 뒤 다음 계기에 이어 간다.
 *
 * 잃는 것: clean 인 편집기 탭의 내용. 터미널 스크롤백은
 * 서버가 들고 있고, 활성 창·포커스 pane·슬롯 배치·사이드바의 복귀 자리는
 * sessionStorage 로 새로고침을 건넌다 (묶음 Q).
 */
(function(){
  // 판은 자산 내용의 해시다 (ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-1) — 서버가
  // 서빙 시점에 문서에 넣는다. 견주는 것은 **같은가 다른가** 뿐이라 형식 자체는
  // 판정에 쓰이지 않는다.
  const self=(()=>{
    const el=document.querySelector('script[src*="core/main.js"]');
    const m=el&&(el.getAttribute('src')||'').match(/[?&]v=([0-9a-f]+)/);
    return m?m[1]:null;
  })();
  if(!self) return;

  /**
   * FR-RLC-3·3a: 자동 새로고침이 **효과가 없었으면 같은 시도를 되풀이하지 않는다.**
   *
   * 배포가 절반만 반영되거나 프록시가 옛 HTML 을 쥐고 있으면 버전 차이가 계속
   * 관측된다. 그때 매번 다시 열면 사용자는 아무것도 할 수 없다.
   *
   * 시도 횟수로는 이 고리가 닫히지 않는다 — 다시 열면 새 문서이고 그 횟수는 0
   * 부터다. 그래서 **문서보다 오래 사는 자리**에 남긴다.
   *
   * 남기는 것은 `(어디서 → 어디로)` **한 쌍**이다. "이 버전에서 시도해 봤다" 만
   * 적으면 한 번 헛돈 탭이 그 뒤 어떤 새 배포도 받지 못한다 — 상한은 두되 포기는
   * 없어야 한다 (RECONNECT_STORM_SRS FR-RCS-6 과 같은 근거).
   */
  const KEY='verReloadTried';
  const readTried=()=>{
    try{ return JSON.parse(sessionStorage.getItem(KEY)||'null') }catch{ return null }
  };
  const tried=(next)=>{
    const t=readTried();
    return !!t && t.from===self && t.to===next;
  };

  let done=false;

  const reload=(next)=>{
    if(done) return; done=true;
    // 적고 나서 연다. 순서가 뒤집히면 되풀이를 막을 근거가 남지 않는다.
    try{ sessionStorage.setItem(KEY,JSON.stringify({from:self,to:next})) }catch{}
    // FR-RLC-5a: 떠남 확인(`main.js` 의 `beforeunload`)은 **사용자의 실수**로
    // 세션을 잃는 것을 막는 장치다. 앱이 스스로 여는 새로고침은 그 대상이 아니며,
    // 물으면 자동이 아니게 된다 — 사용자가 화면을 보고 있지 않으면 대화만 떠 있고
    // 갱신은 영영 오지 않는다. 가드 자체는 남는다 (그쪽이 이 값을 읽는다).
    window.__dmReloading=true;
    // BOOT_SCREEN_REUSE_SRS FR-BTR-10 / D-BTR-7: 다시 열리는 문서의 `#boot` 와
    // 이어 붙인다. 이 표시가 없으면 요청부터 새 문서의 첫 페인트까지 옛 화면이
    // 아무 말 없이 남는다.
    BootScreen.show(BOOT_STEP_VERSION);
    location.reload();
  };

  /**
   * FR-RLC-23: 판정은 **한 자리**다. 서버의 인사도, 탭 복귀의 확인도 여기로 온다 —
   * 두 벌로 두면 한쪽만 고쳐진다.
   */
  const saw=(next)=>{
    if(done||!next||next===self) return;
    // 이 목표로 이미 한 번 열어 봤는데 여전히 여기다 — 다시 열어도 같을 것이다.
    if(tried(next)) return;
    // FR-RLC-1 개정(D-2): **저장하지 않은 편집이 있으면 물러난다.**
    //
    // 자동 새로고침의 취지는 "옛 JS 로 도는 **방치된** 화면" 을 없애는 것인데,
    // dirty 편집기가 있다는 것은 사용자가 그 화면을 지금 쓰고 있다는 뜻이다.
    // 여기서 열면 그 편집이 확인 없이 사라진다 (`FUI-03`).
    //
    // 배너는 **사라지지 않는다** — 목표 판을 기억해 두고, dirty 가 풀린 뒤의
    // 다음 계기(서버 인사·탭 복귀)에 이어 간다.
    if(anyDirty()){
      showHeldBanner(next);
      return;
    }
    reload(next);
  };

  /**
   * 편집기에 저장하지 않은 것이 있는가. 앱이 아직 서지 않았으면 **없다** —
   * 그때는 잃을 편집도 없다.
   */
  const anyDirty=()=>{
    try{ return !!(window.app&&app.edAnyDirty&&app.edAnyDirty()) }catch{ return false }
  };

  // 미룬 목표를 따로 들고 있지 않는다 — `saw` 는 서버 인사와 탭 복귀마다 다시
  // 불리므로, dirty 가 풀린 뒤의 첫 계기에서 같은 판정이 다시 돌아 이어진다.
  // 들고 있으면 그 값과 실제 서버 판이 어긋나는 순간이 생긴다.

  /**
   * 미룬 사실을 화면에 남긴다. 한 번만 세우고, 사용자가 직접 누를 길도 준다 —
   * 저장할 생각이 없는 편집이라면 기다릴 이유가 없다.
   */
  const showHeldBanner=(next)=>{
    if(document.getElementById('ver-held')) return;
    const el=document.createElement('div');
    el.id='ver-held';
    el.className='ver-held';
    const msg=document.createElement('span');
    msg.textContent=VER_HELD_MSG;
    const go=document.createElement('button');
    go.type='button';
    go.className='ui-btn ui-btn-sm ver-held-go';
    go.textContent=VER_HELD_GO;
    go.addEventListener('click',()=>reload(next));
    el.appendChild(msg); el.appendChild(go);
    document.body.appendChild(el);
  };

  // FR-RLC-24: SSE 를 아는 곳은 `app-cmd.js` 하나다. 둘을 잇는 것은 이 이름 하나이며
  // 서로의 안을 들여다보지 않는다.
  window.__dmAssetVersion=saw;

  // FR-RLC-2b: 보조 계기. 인사가 닿지 못한 채 사용자가 돌아왔을 때의 길이다.
  const check=async()=>{
    if(done) return;
    const r=await apiGet('/',{query:{_v:Date.now()},cache:'no-store',parse:false});
    if(!r.ok) return;
    const m=r.text.match(/core\/main\.js\?v=([0-9a-f]+)/);
    if(m) saw(m[1]);
  };

  document.addEventListener('visibilitychange',()=>{if(!document.hidden)check()});
})();
