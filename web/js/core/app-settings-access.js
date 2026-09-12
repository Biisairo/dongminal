/**
 * Dongminal — 설정창의 **접속 허용 목록(ACL) 패널** (FE_MODULE_BOUNDARY_SRS FR-FMB-10).
 *
 * 누가 이 서버에 닿을 수 있는가 (`ACCESS_ALLOWLIST_SRS`). 주소 판정(v4·CIDR)이
 * 여기 함께 있는 이유는 **저장 전에 "지금 나를 잠그는가" 를 물어야** 하기
 * 때문이다 (FR-ACL-24) — 그 판정과 그 확인은 같은 한 가지 일이다.
 */
Object.assign(App.prototype, {
  /**
   * ACCESS_ALLOWLIST_SRS 묶음 E — 접속 허용 목록 패널.
   *
   * 이 화면이 잠글 수 있는 것은 **원격 브라우저뿐**이다. 서버가 도는 컴퓨터는
   * 목록과 무관하게 통과하므로(FR-ACL-5) 되돌릴 길이 언제나 남는다. 그래서
   * 저장을 서버가 막지 않고, 여기서 한 걸음 확인만 받는다 (FR-ACL-24).
   */
  _aclRow(e,opts){
    opts=opts||{};
    const row=document.createElement('div');
    row.className='acl-row';
    row.dataset.id=(e&&e.id)||'';
    const on=document.createElement('label');
    on.className='sbx-flag';
    on.title='이 줄을 적용합니다';
    const cb=document.createElement('input');
    cb.type='checkbox';
    cb.checked=e?e.enabled!==false:true;
    on.appendChild(cb);
    const val=document.createElement('input');
    val.type='text';val.className='acl-value';
    val.placeholder=opts.placeholder||'100.117.248.111 · 192.168.0.0/24 · macmini';
    val.value=(e&&e.value)||'';
    const lab=document.createElement('input');
    lab.type='text';lab.className='acl-label';
    lab.placeholder='이름표';
    lab.value=(e&&e.label)||'';
    const st=document.createElement('span');
    st.className='acl-state';
    // FR-ACL-16: 해석 실패가 조용히 지나가면 사용자는 규칙이 걸린 줄 안다.
    // 축②(`plain`)에는 이 칸이 비어 있다 — 별명은 해석하지 않는다 (FR-ACL-34).
    if(opts.plain){/* 해석 상태 없음 */}
    else if(e&&e.error){st.textContent='해석 실패';st.classList.add('err');st.title=e.error}
    else if(e&&e.resolved&&e.resolved.length){st.textContent=e.resolved.join(', ');st.title='해석된 주소'}
    const del=UIKit.button({icon:'x',title:'Remove this entry',kind:'ghost',size:'sm',cls:'sbx-del'});
    del.addEventListener('click',()=>row.remove());
    row.append(on,val,lab,st,del);
    return row;
  },

  _aclRowsIn(sel){
    const out=[];
    for(const row of document.querySelectorAll(sel+' .acl-row')){
      const value=row.querySelector('.acl-value').value.trim();
      // 추가만 하고 두고 간 빈 줄은 조용히 버린다 (마운트 줄과 같은 규약).
      if(!value) continue;
      out.push({
        id:row.dataset.id||(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random()),
        value,
        label:row.querySelector('.acl-label').value.trim(),
        enabled:row.querySelector('input[type=checkbox]').checked,
      });
    }
    return out;
  },

  // FR-ACL-36: `PUT` 은 전체 교체다 — 두 목록을 **함께** 보낸다. 한쪽만 보내면
  // 다른 쪽이 지워진다.
  _aclCollect(){
    return {
      enabled:document.getElementById('acl-enabled').checked,
      entries:this._aclRowsIn('#acl-list'),
      hosts:this._aclRowsIn('#acl-host-list'),
    };
  },

  _aclV4(s){
    const p=String(s).split('.');
    if(p.length!==4) return null;
    let n=0;
    for(const x of p){
      const v=Number(x);
      if(!Number.isInteger(v)||v<0||v>255||x==='') return null;
      n=n*256+v;
    }
    return n>>>0;
  },

  _aclCidrHas(cidr,ip){
    const i=cidr.indexOf('/');
    if(i<0) return false;
    const bits=Number(cidr.slice(i+1));
    const a=this._aclV4(cidr.slice(0,i)),b=this._aclV4(ip);
    if(a===null||b===null||!Number.isInteger(bits)||bits<0||bits>32) return false;
    if(bits===0) return true;
    const mask=(-1<<(32-bits))>>>0;
    return ((a&mask)>>>0)===((b&mask)>>>0);
  },

  /**
   * 저장하려는 목록이 지금 이 브라우저를 통과시키는가.
   *
   * **모르면 통과로 친다.** 이 판정은 경고를 낼지 말지를 정할 뿐이고, 확신 없이
   * 경고를 띄우면 사용자가 경고를 읽지 않게 된다. 아직 해석되지 않은 새 호스트명·
   * IPv6 대역이 그 "모르는" 경우다.
   */
  _aclCoversYou(cfg,you,known){
    if(!you) return true;
    for(const e of cfg.entries){
      if(!e.enabled) continue;
      if(e.value===you) return true;
      if(e.value.indexOf('/')>=0){
        if(this._aclCidrHas(e.value,you)) return true;
        // 판정할 수 없는 것은 **IPv6 대역**뿐이다. IPv4 대역이라면 상대가
        // IPv6 주소여도 결론은 확실하다 — 포함하지 않는다.
        if(this._aclV4(e.value.slice(0,e.value.indexOf('/')))===null) return true;
        continue;
      }
      const v=(known||[]).find(x=>x.value===e.value);
      if(v&&v.resolved&&v.resolved.indexOf(you)>=0) return true;
      if(!v&&!/^[0-9.]+$/.test(e.value)&&e.value.indexOf(':')<0) return true; // 해석 전인 새 이름
    }
    return false;
  },

  _aclHostRow(e){
    return this._aclRow(e,{placeholder:'macmini-office',plain:true});
  },

  async _loadAccessPanel(){
    const box=document.getElementById('acl-list');
    const hostBox=document.getElementById('acl-host-list');
    const status=document.getElementById('acl-status');
    if(!box) return;
    box.innerHTML='';status.textContent='';status.classList.remove('err');
    if(hostBox) hostBox.innerHTML='';
    try{
      const r=await apiGet('/api/access');
      if(!r.ok){
        status.textContent=r.text.trim()||'허용 목록을 읽지 못했습니다';
        status.classList.add('err');
        return;
      }
      const v=r.data||{};
      this._aclKnown=v.entries||[];
      this._aclYou=v.you||'';
      document.getElementById('acl-enabled').checked=!!v.enabled;
      const you=document.getElementById('acl-you');
      you.textContent=v.you||'(알 수 없음)';
      you.title=(v.self&&v.self.length)?('이 서버의 주소: '+v.self.join(', ')):'';
      for(const e of this._aclKnown) box.appendChild(this._aclRow(e));
      // FR-ACL-35: 서버가 자기를 무엇으로 아는지, 지금 어떤 이름으로 불렸는지.
      // 이 둘을 볼 수 없어서 U-18 의 원인을 아무도 짚지 못했다.
      const hn=document.getElementById('acl-hostname');
      if(hn) hn.textContent=v.hostname||'(알 수 없음)';
      const hnow=document.getElementById('acl-host-now');
      if(hnow) hnow.textContent=v.host||'(알 수 없음)';
      if(hostBox) for(const e of (v.hosts||[])) hostBox.appendChild(this._aclHostRow(e));
    }catch(e){
      status.textContent='허용 목록을 읽지 못했습니다 — '+((e&&e.message)||e);
      status.classList.add('err');
    }
  },

  async _aclSave(cfg){
    const status=document.getElementById('acl-status');
    status.classList.remove('err');status.textContent='저장 중…';
    try{
      const r=await apiPut('/api/access',cfg);
      if(!r.ok){
        // 거부 사유가 그대로 온다 — 어느 줄이 잘못됐는지 모르면 고칠 수 없다.
        status.textContent=r.text.trim()||'저장하지 못했습니다';
        status.classList.add('err');
        return;
      }
      // 재로드가 상태줄을 비우므로 문구는 그 **뒤에** 쓴다. 순서가 바뀌면
      // 저장에 성공해도 화면에는 아무 말도 남지 않는다.
      await this._loadAccessPanel();
      status.textContent='저장했습니다';
    }catch(e){
      status.textContent='저장하지 못했습니다 — '+((e&&e.message)||e);
      status.classList.add('err');
    }
  },

  _initAccessPanel(){
    const add=document.getElementById('acl-add');
    const save=document.getElementById('acl-save');
    if(!add||!save) return;
    add.addEventListener('click',()=>
      document.getElementById('acl-list').appendChild(this._aclRow()));
    const hostAdd=document.getElementById('acl-host-add');
    if(hostAdd) hostAdd.addEventListener('click',()=>
      document.getElementById('acl-host-list').appendChild(this._aclHostRow()));
    save.addEventListener('click',()=>{
      const cfg=this._aclCollect();
      if(!cfg.enabled||this._aclCoversYou(cfg,this._aclYou,this._aclKnown)){
        this._aclSave(cfg);
        return;
      }
      // FR-ACL-24: 확인은 한 걸음이다 (CONFIRM_ONE_STAGE_SRS).
      /**
       * FE-17: **마크업을 문자열로 잇지 않는다.** `_aclYou` 는 서버가 준 값이지만
       * 그 값의 재료는 **이 요청의 출발지·Host** 다 — 즉 바깥이 정한다. 서버가
       * 주었다는 사실은 안전의 근거가 되지 않는다.
       *
       * `check-html.sh` 의 머리가 적은 그대로다 — 마크업이 필요한 자리는 DOM 으로
       * 세운다. 이 자리는 게이트의 규칙(템플릿 리터럴)을 지나지 않아 **문자열
       * 이어붙이기로 남아 있었고**, 그래서 게이트도 함께 넓혔다.
       */
      const body=document.createElement('div');
      const p1=document.createElement('p');
      p1.appendChild(document.createTextNode('이 목록은 지금 접속 중인 주소 '));
      const code=document.createElement('code');
      code.textContent=this._aclYou||'';
      p1.appendChild(code);
      p1.appendChild(document.createTextNode(' 를 허용하지 않습니다.'));
      const p2=document.createElement('p');
      p2.appendChild(document.createTextNode('저장하면 '));
      const b=document.createElement('b');
      b.textContent='이 브라우저의 접속이 끊깁니다.';
      p2.appendChild(b);
      p2.appendChild(document.createTextNode(
        ' 서버가 돌고 있는 컴퓨터에서는 언제나 접속되므로 거기서 되돌릴 수 있습니다.'));
      body.appendChild(p1);
      body.appendChild(p2);
      const m=UIKit.modal({
        title:'이 브라우저가 차단됩니다',
        cls:'acl-confirm',
        width:'min(460px,90vw)',
        body,
        // title 을 주면 그것이 aria-label 이 되어 접근 이름이 라벨을 덮는다.
        // 라벨만 둔다 (open-url.js 와 같은 규약).
        actions:[
          {label:'취소'},
          {label:'그래도 저장',kind:'danger',onClick:()=>this._aclSave(cfg)},
        ],
      });
      document.body.appendChild(m.el);
    });
  },
});
