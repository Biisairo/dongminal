/**
 * Dongminal — 설정창의 **프로필 패널** (PROFILE_NAME_SRS FR-PFN-10~13).
 *
 * 이 기기의 이름을 정하는 유일한 자리다. `#번호` 와 지문은 서버가 노드 신원에서 계산해
 * 주며 바꿀 수 없다. 이름 규칙의 판정은 서버가 한다 — 거절 사유를 상태 줄에 그대로 보인다.
 *
 * REFACTOR3_FE_SETTINGS_SRS 8c: 패널 상태(`_pfSaving`)는 이 섹션이 든다. 설정 밖(`edges-controller.js`)과 저장 단추
 * 판정이 부르는 `_pfFollow`·`_pfCollect` 는 App 에 위임자가 있다.
 */
class ProfileSection extends SettingsSection {
  constructor(app){ super(app,'profile') }

  // `keepName` 이면 이름 칸은 건드리지 않는다 — 사용자가 고치던 글자다(FR-FLK-6).
  _pfPaint(v,keepName){
    if(!keepName) document.getElementById('pf-name').value=v.name||'';
    document.getElementById('pf-tag').textContent=v.tag?'#'+v.tag:'';
    const fp=document.getElementById('pf-fp');
    fp.replaceChildren(...edgeFpGroups(v.fingerprint).map(g=>{
      const s=document.createElement('span');
      s.className=g.key?'fp-g key':'fp-g';
      s.textContent=g.text;
      return s;
    }));
  }

  _pfCollect(){ return {name:document.getElementById('pf-name').value.trim()} }

  /** FR-PFN-20: 탭 제목의 이름을 지금 값으로 맞춘다. */
  _pfApply(v){
    if(v&&v.name&&v.name!==profileName){ profileName=v.name; this.app._applyPageTitle() }
  }

  /**
   * QUALITY_FLAKY_SRS FR-FLK-6: 읽기는 하나만 난다 — 설정을 열 때(`onOpen`)와 탭을 고를 때(`onTab`)가 겹치면 같은 읽기를
   * 돌려준다(서버 패널의 `_reread` 와 같은 규칙, FR-FFX-11).
   */
  _loadProfilePanel(){
    if(!this._pfReading) this._pfReading=this._pfRead().finally(()=>{ this._pfReading=null });
    return this._pfReading;
  }

  /**
   * QUALITY_FLAKY_SRS FR-FLK-6: 읽는 사이에 사용자가 이름을 고쳤으면 그 글자를 덮지 않는다.
   *   이전: 답이 오면 이름 칸을 읽은 값으로 칠했다 — 설정을 열자마자 친 이름이 늦게 온 답에 지워졌다
   *   새:   번호·지문만 칠하고, 읽은 값을 기준으로 둔다 — 고친 이름은 저장하지 않은 수정으로 남아 뒤의 방송이 안내한다.
   *         그 사이에 선 안내도 거두지 않는다
   */
  async _pfRead(){
    const asked=this._pfCollect();
    await statusRun(document.getElementById('pf-status'),{fail:t('edge.read_fail')},async()=>{
      const r=await apiGet('/api/profile');
      if(r.ok&&r.data){
        const edited=this._pfCollect().name!==asked.name;
        this._pfPaint(r.data,edited);
        this._pfApply(r.data);
        this.app._liveMark('profile',r,{name:(r.data.name||'').trim()},edited);
      }
      return r;
    });
  }

  async _profileSave(){
    // FR-PFN-14: 저장이 끝나기 전에 온 방송은 이 저장의 메아리일 수 있다 — 안내하지 않는다.
    this._pfSaving=true;
    await statusRun(document.getElementById('pf-status'),
      {pending:t('core.saving'),ok:t('core.saved'),fail:t('core.save_fail')},async()=>{
        // FR-PFN-13: 읽을 때의 지문을 싣는다. 낡았으면 409 이고 저장하지 않는다.
        const r=await apiPut('/api/profile',this._pfCollect(),this.app._liveOpts('profile'));
        if(this.app._liveStale('profile',r,()=>this._loadProfilePanel())) return r;
        if(r.ok&&r.data){
          this._pfPaint(r.data);
          this._pfApply(r.data);
          this.app._liveMark('profile',r,this._pfCollect());
        }
        return r;
      });
    this._pfSaving=false;
  }

  /**
   * FR-PFN-14: 노드 설정이 바뀌었다는 방송 뒤의 `GET /api/edges` 답을 받는다. 두 종단의 ETag 는
   * 같은 노드 설정의 지문이다. 다시 읽으면 그 읽기를 돌려준다.
   */
  _pfFollow(r){
    if(this._pfSaving) return;
    let reading;
    this.app._liveChanged('profile',r,this._pfCollect(),()=>{ reading=this._loadProfilePanel() });
    return reading;
  }

  init(){
    const save=document.getElementById('pf-save');
    if(!save) return;
    this.listen(save,'click',()=>this._profileSave());
    // UX_AUDIT_FIX_SRS FR-UXF-54: 지문의 원문을 복사한다. 결과는 상태 줄이 말한다.
    const copy=document.getElementById('pf-fp-copy');
    if(copy) this.listen(copy,'click',async()=>{
      const raw=document.getElementById('pf-fp').textContent;
      if(!raw) return;
      const ok=await ClipboardWriter.write(raw);
      const st=document.getElementById('pf-status');
      st.classList.toggle('err',!ok);
      st.textContent=ok?t('html.profile_fp_copied'):t('html.profile_fp_copy_fail');
    });
  }

  onTab(){ return this._loadProfilePanel() }

  /**
   * SETTINGS_TAB_ORDER_SRS FR-STO-2: 처음 열리는 탭이 Profile 이다 — 탭을 누르지 않아도 읽는다.
   * 설정을 열 때 `SettingsController.onOpen` 이 부른다(REFACTOR3_FE_ESC_SRS FR-FEE-9).
   */
  onOpen(){
    if(document.querySelector('#modal .mtab.active[data-tab="profile"]')) this._loadProfilePanel();
  }
}
