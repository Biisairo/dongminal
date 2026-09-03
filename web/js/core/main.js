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
(async()=>{try{const r=await fetch('/api/settings');if(r.ok){const saved=await r.json();
  if(saved.shortcuts) Object.assign(shortcuts,saved.shortcuts);
  if(saved.statusBar) Object.assign(statusBar,saved.statusBar);
  if(saved.statsInterval) statsInterval=saved.statsInterval;
  // FR-GIT-23: 0 은 그 계층을 끈다는 뜻이므로 truthy 검사로는 안 된다.
  if(saved.gitSignatureInterval!==undefined) gitSignatureInterval=saved.gitSignatureInterval;
  if(saved.gitStatusInterval!==undefined) gitStatusInterval=saved.gitStatusInterval;
  if(saved.layoutPresets) layoutPresets=saved.layoutPresets;
  if(saved.defaultPreset!==undefined) defaultPreset=saved.defaultPreset;
  if(saved.customTheme){customTheme=saved.customTheme;applyThemeObj(customTheme)}
  else if(saved.themeName&&THEMES[saved.themeName]){currentThemeName=saved.themeName;applyThemeObj(THEMES[currentThemeName])}
  // PAGE_TITLE_SRS FR-PGT-10: 저장된 제목을 브라우저 탭에 올린다. 없으면
  // `<title>` 이 가진 기본 이름 그대로다.
  if(saved.pageTitle!==undefined){pageTitle=saved.pageTitle;app._applyPageTitle()}
  // 설정 변경은 감지 계층의 재평가 시점이다 (FR-GIT-23).
  app.gitPanel._reschedule();
}}catch{}})();

app.init();
if(!(defaultPreset>=0&&layoutPresets[defaultPreset]))document.getElementById('add-preset').style.display='none';
document.getElementById('add-window').addEventListener('click',async(e)=>{
  // 안쪽 박스를 눌렀으면 샌드박스 창이다. 바깥은 종전대로 일반 창.
  let sandbox='',workdir='';
  if(e.target.closest('#add-sandbox-window')){
    let list=[];
    try{const r=await fetch('/api/sandbox/profiles');if(r.ok) list=await r.json()}catch{}
    if(!list.length){
      // 런타임이 없으면 고를 것이 없다. 그 사실을 말해 주지 않으면 버튼이
      // 고장난 것으로 보인다 (FR-SBX-20).
      app._notify('샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)이 설치되어 실행 중인지 확인하세요.');
      return;
    }
    // 고를 것도 물을 것도 없으면 그대로 연다 — 선택지가 없는 선택은 절차만
    // 늘린다. 작업 폴더를 받는 프로파일이 하나라도 있으면 매번 묻는다
    // (FR-SBX-40).
    const mustAsk=list.length>1||list.some(p=>p.workspace);
    // 지금 있는 자리는 **버튼으로만** 낸다 — 자동으로 채우지 않는다.
    const here=mustAsk?await app._focusedCwd().catch(()=>null):null;
    const picked=mustAsk
      ? await app._pickSandbox(list,here)
      : {profile:list[0].name,workdir:''};
    if(!picked||!picked.profile) return;
    sandbox=picked.profile;
    workdir=picked.workdir||'';
    app._sbxRemember(workdir);
  }
  // 샌드박스 창은 실패가 흔하다(런타임 미실행·이미지 없음). 사유를 보이지 않으면
  // "눌러도 아무 일이 없다" 로만 남는다 (FR-SBX-20).
  app.addWindow(sandbox?{sandbox,cwd:workdir||undefined}:undefined)
    .catch(err=>app._notify('창을 열지 못했습니다 — '+((err&&err.message)||err)));
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
