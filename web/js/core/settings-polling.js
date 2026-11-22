/**
 * PollingSection — Settings ▸ Polling (REFACTOR3_FE_SETTINGS_SRS 8b). 주기 표 `POLL_SETTINGS`(`poll-settings.js`)를 감싼다.
 *
 * POLL_INTERVAL_SETTINGS_SRS FR-PIS-20·24: 행을 **여기서** 만드는 이유는 표가 진실이기 때문이다 (FR-PIS-6).
 * index.html 에 손으로 다섯을 적으면 주기를 더할 때 고칠 자리가 둘이 된다. 골격은 다른 탭과 같은 `.ds-row` 이고
 * 컨트롤은 기존 두 자리가 쓰던 `.sbs-select` 그대로다 — 새 클래스를 만들지 않는다. 행이 고르는 값의 종류가
 * 표마다 달라 `FormRow` 로 맞추지 않는다(FR-FES-4).
 */
class PollingSection extends SettingsSection {
  constructor(app){ super(app,'polling') }

  init(){
    const box=document.getElementById('poll-settings');
    if(!box||box.dataset.built==='1') return;
    const app=this.app;
    for(const spec of POLL_SETTINGS){
      const row=document.createElement('div');
      row.className='ds-row';
      const label=document.createElement('span');
      label.textContent=spec.label;
      const sel=document.createElement('select');
      sel.id=spec.id; sel.className='sbs-select';
      for(const [v,text] of spec.opts){
        const o=document.createElement('option');
        o.value=String(v); o.textContent=text;
        sel.appendChild(o);
      }
      this.listen(sel,'change',()=>{
        // FR-PIS-8: 값의 판정은 표 한 자리다 (`settingValue`, FR-OPT-11-4).
        spec.set(settingValue(parseInt(sel.value,10),SETTINGS_BY_KEY[spec.key]));
        app.settings.apply.saveSettings();
        // 값이 바뀐 즉시 도는 타이머에 닿는다 — 저장 왕복을 기다리면 사용자는
        // 설정이 듣지 않는 것으로 읽는다 (FR-WBR-10·11 과 같은 근거).
        if(spec.key==='gitStatusInterval'){
          if(app.gitPanel&&app.gitPanel.poll._reschedule) app.gitPanel.poll._reschedule();
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
    this.paint();
  }

  // 표의 값을 화면에 얹는다. `_settingsApply` 가 `_paintSettingControls` 로 이것을 부르므로 다른 창에서
  // 바뀐 값이 SSE 로 왔을 때 열려 있는 설정창이 옛 값을 든 채 남지 않는다.
  paint(){
    for(const spec of POLL_SETTINGS){
      const sel=document.getElementById(spec.id);
      if(sel) sel.value=String(spec.get());
    }
  }
}
