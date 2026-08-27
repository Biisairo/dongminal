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
  // 설정 변경은 감지 계층의 재평가 시점이다 (FR-GIT-23).
  app.gitPanel._reschedule();
}}catch{}})();

app.init();
if(!(defaultPreset>=0&&layoutPresets[defaultPreset]))document.getElementById('add-preset').style.display='none';
document.getElementById('add-window').addEventListener('click',()=>app.addWindow());
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
window.addEventListener('beforeunload',e=>{if(app.tools.size>0)e.preventDefault()});
