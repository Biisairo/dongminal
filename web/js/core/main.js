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
    // 하나뿐이면 묻지 않는다. 선택지가 없는 선택은 절차만 늘린다.
    const picked=list.length===1
      ? {profile:list[0].name,workdir:''}
      : await app._pickSandbox(list);
    if(!picked||!picked.profile) return;
    sandbox=picked.profile;
    workdir=picked.workdir||'';
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
// 떠나면 터미널 세션과의 연결을 잃는다 — 도구가 하나라도 있으면 되묻는다.
//
// RELOAD_CONTINUITY_SRS FR-RLC-5a: **앱이 스스로 여는 새로고침은 예외다.** 이 가드는
// 사용자의 실수를 막는 장치이고, 새 버전을 받으려 다시 여는 것은 실수가 아니다 —
// 거기서 물으면 자동 갱신이 자동이 아니게 된다 (사용자가 화면을 보고 있지 않으면
// 대화만 떠 있고 갱신은 영영 오지 않는다). 그 밖의 모든 떠남에는 그대로 걸린다.
window.addEventListener('beforeunload',e=>{
  if(window.__dmReloading) return;
  if(app.tools.size>0) e.preventDefault();
});
