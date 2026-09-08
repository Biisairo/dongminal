/**
 * Remote Terminal — bootstrap entry point
 */
const app=new App();
window.app=app;
window.__dongminalDebug={
  sendDropCount(){let n=0;app.tools&&app.tools.forEach(p=>{n+=p._sendDropCount||0});return n},
  sendQueueLength(){let n=0;app.tools&&app.tools.forEach(p=>{n+=(p._sendQueue&&p._sendQueue.length)||0});return n}
};

// Restore saved theme from server
// BOOT_SCREEN_SRS FR-BTS-13: 이 프로미스가 걷힘 조건의 한쪽이다 — **테마가
// 결정되는 시점**이고, 결정에는 실패도 포함된다 (그때는 선주입한 색이 그대로다).
const themeReady=(async()=>{try{
  const r=await fetch('/api/settings');
  // SETTINGS_LIVE (2026-09-08): 키를 여기서 나열하지 않는다. 얹는 규약은
  // `_settingsApply` 한 자리이며, 부팅·SSE 방송·소프트 리로드가 같은 길을
  // 지난다 — 종전에는 이 자리와 `app-settings.js` 의 IIFE 가 키를 각자 나열해,
  // 다른 창에서 바뀐 값을 받아 얹을 자리가 아예 없었다.
  if(r.ok) app._settingsApply(await r.json(),{boot:true});
}catch{}
  // FR-BTS-11: 설정이 왔든 오지 않았든, 남은 것은 워크스페이스다.
  BootScreen.step('워크스페이스를 복원합니다');
})();

/**
 * FR-BTS-13: 부팅 화면은 **둘 다 끝나야** 걷힌다 — 테마 결정과 워크스페이스 준비.
 *
 * `allSettled` 인 것은 실패도 끝이기 때문이다: 설정을 못 읽거나 `init` 이 예외로
 * 끝나도 사용자는 화면을 봐야 한다. 영영 오지 않는 경우의 방어는 상한이 따로
 * 맡는다 (FR-BTS-14, boot-screen.js).
 */
Promise.allSettled([themeReady,app.init()]).then(()=>BootScreen.done());
if(!(defaultPreset>=0&&layoutPresets[defaultPreset]))document.getElementById('add-preset').style.display='none';
document.getElementById('add-window').addEventListener('click',async(e)=>{
  // 안쪽 박스를 눌렀으면 샌드박스 창이다. 바깥은 종전대로 일반 창.
  let sandbox='',workdir='',work='';
  if(e.target.closest('#add-sandbox-window')){
    /**
     * UX_BATCH5_SRS FR-SRT-5: **런타임 상태를 먼저 묻는다.**
     *
     *   이전 동작: 프로파일 목록이 비면 "설치되어 실행 중인지 확인하세요" 한 줄
     *   새  동작: `missing` 과 `stopped` 를 갈라 각각의 다음 걸음을 준다
     *   이유:     둘은 사용자가 할 일이 다르다(설치 / 실행). 그리고 **데몬이 죽어도
     *             프로파일 목록은 정상으로 온다** — `Wire` 가 바이너리 유무만 보기
     *             때문이다(§2.3 실측). 그래서 옛 안내는 실제로 닿지도 않았고,
     *             실패는 창을 만드는 순간까지 미뤄졌다
     *
     * 조회에 실패하면 `null` 이고 그때는 갈래를 가르지 않는다 — 서버에 닿지 못하는
     * 것은 런타임의 문제가 아니다.
     */
    const rt=await app._sbxRuntime();
    if(rt&&rt.state!==SBX_RT_OK){
      // 기동이 끝나 ok 가 됐을 때만 참이다 — 그때는 하려던 일을 그대로 잇는다
      // (FR-SRT-7). 사용자가 버튼을 다시 누르게 하지 않는다.
      const go=await app._sbxRuntimeModal(rt);
      if(!go) return;
    }
    let list=[];
    try{const r=await fetch('/api/sandbox/profiles');if(r.ok) list=await r.json()}catch{}
    if(!list.length){
      // 런타임은 살아 있는데 고를 것이 없는 경우다 — 상태 갈래가 위에서 끝났으므로
      // 여기 남는 것은 정의가 비었거나 조회가 실패한 때다 (FR-SBX-20).
      app._notify('샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)이 설치되어 실행 중인지 확인하세요.');
      return;
    }
    // SANDBOX_PICK_COPY_SRS FR-SPK-1 / D-SPK-1: **언제나 묻는다.**
    //
    // 옛 조건은 `list.length>1 || list.some(p=>p.workspace)` 였다. 그런데
    // `sandbox.json` 이 없으면 프로파일은 scratch 하나이고 그것은 작업 폴더를
    // 받지 않았으므로, 조건이 **거짓이 되어 창이 뜨지 않았다**(실측). 사용자
    // 눈에는 작업 폴더를 고를 길도, 프로파일을 늘릴 길도 없었다.
    // 지금은 scratch 도 폴더를 받는다 — 복사로 (FR-SPK-10).
    // 지금 있는 자리는 **버튼으로만** 낸다 — 자동으로 채우지 않는다 (FR-SPK-4).
    const here=await app._focusedCwd().catch(()=>null);
    const picked=await app._pickSandbox(list,here);
    if(!picked||!picked.profile) return;
    sandbox=picked.profile;
    workdir=picked.workdir||'';
    work=picked.work||'';
    // FR-SPK-9: 비어 있는 값은 기억하지 않는다 — 최근 목록에 빈 줄이 쌓인다.
    if(workdir) app._sbxRemember(workdir);
  }
  // NFR-SPK-2: 복사는 상한 안에서도 수십 초가 걸릴 수 있다. 그동안 화면이
  // 아무 말도 하지 않으면 사용자는 고장으로 읽는다.
  const done=(sandbox&&work===SANDBOX_WORK_COPY&&workdir)
    ? app._sbxProgress(SANDBOX_COPY_PROGRESS) : null;
  // 샌드박스 창은 실패가 흔하다(런타임 미실행·이미지 없음). 사유를 보이지 않으면
  // "눌러도 아무 일이 없다" 로만 남는다 (FR-SBX-20). 복사 상한을 넘긴 거부도
  // 이 길로 온다 (FR-SPK-14).
  app.addWindow(sandbox?{sandbox,cwd:workdir||undefined,sandboxWork:work}:undefined)
    .catch(err=>app._notify('창을 열지 못했습니다 — '+((err&&err.message)||err)))
    .finally(()=>{if(done)done()});
});
document.getElementById('add-preset').addEventListener('click',()=>{
  if(defaultPreset>=0&&layoutPresets[defaultPreset]) app._loadPreset(defaultPreset);
  else app.addWindow();
});

// Custom toggle handler
document.getElementById('custom-toggle').addEventListener('click',()=>{
  const editor=document.getElementById('custom-editor');
  if(editor.style.display==='none'){app._showCustomEditor()}
  else{app._hideCustomEditor()}
});

window.addEventListener('resize',()=>{
  const ac=document.getElementById('attn-center');
  if(ac&&ac.classList.contains('open')) app._positionAttnCenter();
  const wasMobile=document.body.classList.contains('mobile');
  const nowMobile=app.isMobile;
  if(wasMobile!==nowMobile){app.render()}
  // FR-MTI-20: Android Chrome 은 소프트 키보드를 window resize 로 알린다
  // (interactive-widget=resizes-content). 그 연속 발화마다 즉시 fit 하면
  // SIGWINCH 가 그만큼 나가 TUI 가 프레임 전체를 다시 그린다.
  else{app._scheduleFit()}
});
// 떠나면 터미널 세션과의 연결을 잃는다. 되물을지는 **설정이 정하며 기본은 끔**이다
// (LEAVE_CONFIRM_TOGGLE_SRS FR-LVC-6·7 / D-1) — 되묻는 편이 안전하지만 그 판단은
// 사용자마다 다르고, 접수한 요구가 "묻지 않기" 였다.
//
// 세 조건은 각자 다른 것을 말한다:
//  - `confirmLeave`  — 사용자가 되묻기를 켰는가 (FR-LVC-7)
//  - `__dmReloading` — **앱이 스스로 여는 새로고침은 예외다** (RELOAD_CONTINUITY_SRS
//    FR-RLC-5a). 이 가드는 사용자의 실수를 막는 장치이고, 새 버전을 받으려 다시
//    여는 것은 실수가 아니다 — 거기서 물으면 자동 갱신이 자동이 아니게 된다
//    (사용자가 화면을 보고 있지 않으면 대화만 떠 있고 갱신은 영영 오지 않는다).
//  - `tools.size`    — 잃을 연결이 하나라도 있는가
//
// 판정은 이 자리 하나이며 스위치를 읽는 곳을 늘리지 않는다 (FR-LVC-9) — 두 벌로
// 두면 한쪽만 고쳐진다. 전역을 그때그때 읽으므로 설정을 바꾼 뒤 다시 적재할
// 필요가 없다 (FR-LVC-10).
window.addEventListener('beforeunload',e=>{
  if(!confirmLeave) return;
  if(window.__dmReloading) return;
  if(app.tools.size>0) e.preventDefault();
});
