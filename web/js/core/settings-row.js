/**
 * FormRow — 설정 탭의 단순한 행 하나 (REFACTOR3_FE_SETTINGS_SRS FR-FES-2).
 *
 * 선언 `{key, id, kind, after?, guard?}` 하나가 리스너와 칠하기를 정한다. 종전에는 체크박스 8행과 숫자 6행이 같은
 * 모양을 `_init*` 마다 손으로 되풀이했다. 값의 읽기·쓰기는 `SETTINGS_ACCESS[key]` 의 get/set 이 하고(D-FES-1),
 * 자르는 것은 `clampSetting` 한 자리다.
 *
 *   check   바꾸면 set → after → 곧바로 저장
 *   number  입력마다 자른 값으로 set → after → 미룬 저장(`_saveSettingsSoon`). 입력란의 글자는 고치지 않는다 —
 *           그때그때 고쳐 쓰면 타이핑이 튄다(`150` 을 지우고 `9` 를 치는 순간 8 이 된다, FR-FSS-19·FR-TBW-4).
 *           `blur` 에 입력란을 쓰이는 값으로 고치고 곧바로 저장한다 — 디바운스는 요청 수를 줄이는 장치이지
 *           확정을 미루는 장치가 아니다(실측 W7: 값을 바꾸고 바로 새로고침하면 입력이 통째로 날아갔다).
 *
 * after: 행마다 다른 뒤처리(섹션이 `this`). guard: 포커스를 쥔 입력란은 칠하지 않는다 — 저장의 메아리가 치는 중인
 * 글자를 덮지 않게. 종전 `ctl:'value'` 였던 탭 폭 행만 그렇다. 다른 행에 새로 더하지 않는다(D-FES-2).
 */
class FormRow {
  constructor(decl){
    this.decl=decl;
    this.el=null;
    this.app=null;
  }

  bind(section){
    const d=this.decl;
    this.app=section.app;
    this.el=document.getElementById(d.id);
    const el=this.el;
    if(!el) return this;
    const app=this.app;
    const set=v=>SETTINGS_ACCESS[d.key].set.call(app,v);
    const after=()=>{ if(d.after) d.after.call(section) };
    if(d.kind==='check'){
      section.listen(el,'change',()=>{
        set(el.checked);
        after();
        app.saveSettings();
      });
    }else if(d.kind==='number'){
      section.listen(el,'input',()=>{
        set(clampSetting(d.key,el.value));
        after();
        app._saveSettingsSoon(d.id);
      });
      section.listen(el,'blur',()=>{
        // 잘린 사실이 **보여야** 사용자가 왜 그 값인지 안다 (FR-TBW-4).
        el.value=String(this.value());
        app._saveSettingsNow(d.id);
      });
    }
    return this;
  }

  /** 지금 쓰이는 값. 블롭에 한 번도 실리지 않은 키는 표의 기본값이다. */
  value(){
    const v=SETTINGS_ACCESS[this.decl.key].get.call(this.app);
    return v??SETTINGS_BY_KEY[this.decl.key].def;
  }

  paint(){
    const el=this.el;
    if(!el) return;
    if(this.decl.kind==='check') el.checked=!!this.value();
    else if(!(this.decl.guard&&el===document.activeElement)) el.value=String(this.value());
  }
}
