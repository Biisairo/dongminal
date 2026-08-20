/**
 * Remote Terminal — bootstrap entry point
 */
const app=new App();
window.app=app;
window.__dongminalDebug={
  sendDropCount(){let n=0;app.panes&&app.panes.forEach(p=>{n+=p._sendDropCount||0});return n},
  sendQueueLength(){let n=0;app.panes&&app.panes.forEach(p=>{n+=(p._sendQueue&&p._sendQueue.length)||0});return n}
};

// Restore saved theme from server
(async()=>{try{const r=await fetch('/api/settings');if(r.ok){const saved=await r.json();
  if(saved.shortcuts) Object.assign(shortcuts,saved.shortcuts);
  if(saved.statusBar) Object.assign(statusBar,saved.statusBar);
  if(saved.statsInterval) statsInterval=saved.statsInterval;
  if(saved.layoutPresets) layoutPresets=saved.layoutPresets;
  if(saved.defaultPreset!==undefined) defaultPreset=saved.defaultPreset;
  if(saved.customTheme){customTheme=saved.customTheme;applyThemeObj(customTheme)}
  else if(saved.themeName&&THEMES[saved.themeName]){currentThemeName=saved.themeName;applyThemeObj(THEMES[currentThemeName])}
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
  else{for(const p of app.panes.values())if(p.el.classList.contains('vis'))p.doFit()}
});
window.addEventListener('beforeunload',e=>{if(app.panes.size>0)e.preventDefault()});
