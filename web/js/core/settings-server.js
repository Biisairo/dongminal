/**
 * Dongminal — 설정창의 **Server 구역** (HOT_REBIND_SRS FR-HRB-40·43·44).
 *
 * 포트와 expose 를 서버를 끄지 않고 바꾼다. 바꾸기는 루프백 화면에서만 된다 (FR-HRB-21) —
 * 같은 망의 화면은 값을 볼 수만 있다. 포트가 바뀌면 이 화면은 새 주소로 이사하고(FR-HRB-26),
 * 새 주소의 화면이 새 값을 보인다 (FR-HRB-44).
 *
 * REFACTOR3_FE_SETTINGS_SRS 8c: 읽은 값(`_srv`)과 이사 중 표시(`_srvMoving`)는 이 섹션이 든다. SSE `server_moving`
 * (`state-registry.js`)은 App 의 위임자 `_onServerMoving` 을 지난다.
 */

/** server.json 값의 출처(`GET /api/server/bind` 의 source) → 문구 키. */
const SRV_SOURCE_KEY={file:'srv.src_file',default:'srv.src_default'};

class ServerSection extends SettingsSection {
  constructor(app){ super(app,'server') }

  _srvPaint(v=this._srv){
    if(!v||!document.getElementById('srv-now')) return;
    const h=v.host.includes(':')?'['+v.host+']':v.host;
    document.getElementById('srv-now').textContent=h+':'+v.port;
    const src=v.source||{};
    const srcText=(k)=>t(SRV_SOURCE_KEY[k]||SRV_SOURCE_KEY.default);
    document.getElementById('srv-source').textContent=t('srv.source',{host:srcText(src.host),port:srcText(src.port)});
    document.getElementById('srv-port').value=String(v.port);
    document.getElementById('srv-expose').checked=!!v.expose;
    document.getElementById('srv-apply').disabled=!v.local;
    document.getElementById('srv-local').hidden=!!v.local;
  }

  _loadServerPanel(){
    return statusRun(document.getElementById('srv-status'),{fail:t('srv.read_fail')},async()=>{
      const r=await apiGet('/api/server/bind');
      if(r.ok&&r.data){ this._srv=r.data; this._srvPaint() }
      return r;
    });
  }

  /** 바뀐 값만 담는다. 바뀐 것이 없으면 null. */
  _srvChanges(){
    const v=this._srv;
    if(!v) return null;
    const body={};
    const port=parseInt(document.getElementById('srv-port').value,10);
    if(String(port)!==String(v.port)) body.port=port;
    const expose=document.getElementById('srv-expose').checked;
    if(expose!==!!v.expose) body.expose=expose;
    return Object.keys(body).length?body:null;
  }

  async _srvApply(){
    const v=this._srv;
    const body=this._srvChanges();
    if(!v||!v.local||!body) return;
    const msg=t(body.port!=null?'srv.confirm_move':'srv.confirm_expose',{port:body.port??v.port});
    const ok=await UIKit.ask({msg,escValue:false,actions:[
      {label:t('srv.apply'),kind:'danger',cls:'confirm-ok',tip:t('srv.apply_tip'),value:true,default:true},
      {label:t('core.cancel'),cls:'confirm-cancel',tip:t('srv.cancel_tip'),value:false},
    ]});
    if(!ok) return;
    const st=document.getElementById('srv-status');
    await statusRun(st,{pending:t('srv.applying'),ok:t('core.saved'),fail:t('srv.apply_fail')},async()=>{
      const r=await apiPost('/api/server/bind',body);
      if(!r.ok||!r.data) return r;
      if(String(r.data.port)!==String(v.port)){ this._onServerMoving({port:r.data.port}); return r }
      this._srv={...v,...r.data};
      this._srvPaint();
      return r;
    });
    if(this._srv&&this._srv.warning) st.textContent=this._srv.warning;
  }

  /** SSE `server_moving` — 이 화면도 새 주소로 간다. 적용 응답과 겹쳐 와도 한 번만 간다. */
  _onServerMoving(a){
    if(this._srvMoving||!a||!a.port) return;
    this._srvMoving=true;
    this._serverMoveTo(String(a.port));
  }

  _serverMoveTo(port){ return serverMoveNow(port) }

  init(){
    const btn=document.getElementById('srv-apply');
    if(!btn) return;
    this.listen(btn,'click',()=>this._srvApply());
  }

  onTab(){ return this._loadServerPanel() }

  /** REFACTOR3_FE_FIX_SRS FR-FFX-10: 포트·노출을 바꾸고 적용하지 않았다 — 저장 단추가 없는 패널이라 판정이 여기 있다. */
  dirty(){ return !!this._srvChanges() }
}
