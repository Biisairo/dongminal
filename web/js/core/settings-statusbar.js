/**
 * StatusbarSection — Settings ▸ Status Bar (REFACTOR3_FE_SETTINGS_SRS 8b). 상태바에 **무엇을 보일지**의 스위치들이다.
 *
 * 행은 `STATUS_ITEMS` 표에서 만든다. 한 번 만들고 다시 칠하지 않는다 — 설정을 열 때·다른 창의 변경을 받을 때도
 * 그대로다(§6 「찾은 것」, 동작을 바꾸지 않으므로 `paint()` 를 두지 않는다).
 */
class StatusbarSection extends SettingsSection {
  constructor(app){ super(app,'statusbar') }

  init(){ this._render() }

  _render(){
    const el=document.getElementById('sb-settings');if(!el)return;
    el.innerHTML='';
    /**
     * POLL_INTERVAL_SETTINGS_SRS FR-PIS-22: **`갱신 주기` 행이 여기서 빠졌다.**
     *
     * `Polling` 탭으로 옮겼다 (D-2) — 같은 값의 손잡이가 두 자리에 있으면 어느
     * 쪽이 진실인지 화면이 말하지 않는다. 이 패널에 남는 것은 **무엇을 보일지**
     * 뿐이고, **얼마나 자주 물을지**는 주기의 것이다.
     *
     * `_startStatsPoll` 을 다시 부르던 자리도 함께 사라졌다: 주기를 함수로 주므로
     * (FR-PIS-13) 재무장 한 줄이 그 일을 하고, 그쪽은 **발화하지 않는다**.
     */
    // Item toggles
    const app=this.app;
    for(const[k,v]of Object.entries(STATUS_ITEMS)){
      const row=document.createElement('div');row.className='sbs-row';row.dataset.item=k;
      const label=document.createElement('span');label.textContent=v.label;
      // FR-CMP-20·21: 알약은 킷의 것이다. 종전에는 입력을 숨기고(`opacity:0`)
      // 형제 `<span class="slider">` 가 알약을 그렸다 — 그 대역이 있으면 킷의
      // `:checked` 파생이 닿지 않는다. 입력이 스스로 그리므로 대역을 걷는다.
      const inp=document.createElement('input');
      inp.type='checkbox'; inp.className='ui-switch'; inp.checked=!!statusBar[k];
      this.listen(inp,'change',()=>{statusBar[k]=inp.checked;app.saveSettings();app.updateStatusBar()});
      row.appendChild(label);row.appendChild(inp);
      el.appendChild(row);
    }
  }
}
