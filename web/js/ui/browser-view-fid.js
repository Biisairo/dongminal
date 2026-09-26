/**
 * 브라우저 탭 뷰어의 3단계 충실도 (BROWSER_TAB_SRS 묶음 F·Q, `BrowserView.prototype` 증강).
 *
 * screencast 에 없는 것 — 커서·툴팁·검증 말풍선·위젯·컨텍스트 메뉴·대화상자·파일 선택·
 * 다운로드 — 을 **이 기기에서** 다시 그린다. 페이지(격리 world)가 보낸 문자열은 신뢰하지
 * 않는 데이터다 — 전부 `textContent` 로만 넣는다 (NFR-BRT-S2).
 *
 * 로드 순서: `browser-view.js` 뒤.
 */

Object.assign(BrowserView.prototype, {
  /** 페이지 좌표(CSS)를 이 뷰어의 stage 좌표로. 그린 적이 없으면 null. */
  _stagePoint(x,y){
    const r=this._rect,m=this.meta;
    if(!r||!m||!m.deviceWidth) return null;
    return {x:r.x+x*r.w/m.deviceWidth,y:r.y+y*r.h/m.deviceHeight,sx:r.w/m.deviceWidth,sy:r.h/m.deviceHeight};
  },

  /** 격리 world 의 보고 하나 (FR-BRT-67·82·83·87·88). */
  _onReport(a){
    switch(a.t){
      case 'cursor': this.canvas.style.cursor=/^[a-z-]+$/.test(String(a.v||''))?a.v:'default'; break;
      case 'tooltip': this._tooltip(String(a.v||''),a.x,a.y); break;
      case 'copy':
        // 복사를 누른 화면만 쓴다 — 보고는 붙은 뷰어 전부에 온다 (FR-BRT-82).
        if(document.activeElement===this.input) ClipboardWriter.write(String(a.v||''));
        break;
      case 'caret': this._moveCaret(a.x,a.y); break;
      case 'menu': if(document.activeElement===this.input) this._contextMenu(a); break;
      case 'invalid': this._bubble(String(a.v||''),a.x,a.y+a.h); break;
      case 'widget': if(document.activeElement===this.input) this._widget(a); break;
      case 'extlink': if(document.activeElement===this.input) this._extLink(String(a.href||'')); break;
    }
  },

  _tooltip(text,x,y){
    if(!this._tip){this._tip=document.createElement('div');this._tip.className='brv-tip';this.stage.appendChild(this._tip)}
    const p=text&&this._stagePoint(x,y);
    if(!p){this._tip.hidden=true;return}
    this._tip.textContent=text;
    this._tip.style.left=(p.x+12)+'px';this._tip.style.top=(p.y+16)+'px';
    this._tip.hidden=false;
  },

  /** FR-BRT-83: IME 후보창이 제자리에 뜨도록 숨긴 입력을 캐럿으로 옮긴다. */
  _moveCaret(x,y){
    const p=this._stagePoint(x,y);
    if(!p) return;
    this.input.style.left=Math.max(0,p.x)+'px';this.input.style.top=Math.max(0,p.y-16)+'px';
  },

  _bubble(text,x,y){
    const p=text&&this._stagePoint(x,y);
    if(!p) return;
    const b=document.createElement('div');b.className='brv-bubble';b.textContent=text;
    b.style.left=p.x+'px';b.style.top=(p.y+4)+'px';
    this.stage.appendChild(b);
    TIMERS.after(3000,()=>b.remove(),{owner:this,label:'brv-bubble'});
  },

  /** FR-BRT-87: 페이지가 막지 않은 우클릭 — dongminal 메뉴. */
  _contextMenu(a){
    const p=this._stagePoint(a.x,a.y);
    if(!p) return;
    const b=this.stage.getBoundingClientRect();
    const items=[
      {id:'back',label:t('brv.back'),disabled:!this.state.canBack,onClick:()=>this.nav('back')},
      {id:'fwd',label:t('brv.forward'),disabled:!this.state.canForward,onClick:()=>this.nav('forward')},
      {id:'reload',label:t('brv.reload'),onClick:()=>this.nav('reload')},
    ];
    const href=String(a.href||'');
    if(href){
      items.push({sep:true},
        {id:'copyLink',label:t('brv.copy_link'),onClick:()=>ClipboardWriter.write(href)},
        {id:'newTab',label:t('brv.open_new_tab'),onClick:()=>this.app.openBrowser(href,{split:'none',profile:this.tab.profile})},
        {id:'viewer',label:t('brv.open_viewer'),onClick:()=>window.open(href,'_blank','noopener')});
    }
    const img=String(a.img||'');
    if(img){
      items.push({sep:true});
      const ir=a.imgRect;
      if(ir&&ir.w>=1&&ir.h>=1) items.push({id:'copyImgData',label:t('brv.copy_image'),onClick:()=>this._copyImage(ir,img)});
      items.push({id:'copyImg',label:t('brv.copy_image_url'),onClick:()=>ClipboardWriter.write(img)});
    }
    const sel=String(a.sel||'');
    if(sel) items.push({sep:true},{id:'copySel',label:t('brv.copy_selection'),onClick:()=>ClipboardWriter.write(sel)});
    items.push({sep:true},{id:'inspect',label:t('brv.inspect'),onClick:()=>this._send({op:'devtools'})});
    UIKit.menu(items,{at:{x:b.left+p.x,y:b.top+p.y},cls:'brv-menu'});
  },

  /**
   * FR-BRT-87: 이미지 복사 — 서버가 그 자리를 PNG 로 떠 준다. 클립보드 쓰기는 누른 그 순간에
   * 약속으로 건다(사용자 활성화를 잃지 않는다). 이미지 쓰기가 막힌 기기면 주소를 복사한다.
   */
  _copyImage(r,src){
    const png=new Promise((resolve,reject)=>{this._imgWait={resolve,reject}});
    this._send({op:'copyImage',x:r.x,y:r.y,w:r.w,h:r.h});
    const blob=png.then(b64=>new Blob([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],{type:'image/png'}));
    const fallback=()=>ClipboardWriter.write(src);
    if(!window.ClipboardItem||!navigator.clipboard||!navigator.clipboard.write){png.catch(()=>{});fallback();return}
    navigator.clipboard.write([new ClipboardItem({'image/png':blob})]).catch(fallback);
  },

  _onImage(info){
    const w=this._imgWait;this._imgWait=null;
    if(!w) return;
    if(info&&info.png) w.resolve(String(info.png));else w.reject(new Error(String((info&&info.error)||'')));
  },

  /**
   * FR-BRT-88: 네이티브 위젯은 screencast 에 없다 — 이 기기의 입력 요소로 다시 세운다.
   * 날짜·시간·색은 `showPicker()`, datalist 는 자체 목록이다. 고른 값은 페이지의 그 요소에
   * 들어가고 input·change 가 일어난다.
   */
  _widget(a){
    const p=this._stagePoint(a.x,a.y);
    if(!p) return;
    const b=this.stage.getBoundingClientRect();
    if(a.kind==='datalist'){
      const opts=Array.isArray(a.opts)?a.opts:[];
      if(!opts.length) return;
      UIKit.menu(opts.map((o,i)=>({id:'o'+i,label:String(o.label||o.value||''),
        onClick:()=>this._send({op:'widget',id:a.id,value:String(o.value||'')})})),
        {at:{x:b.left+p.x,y:b.top+p.y+a.h*p.sy},cls:'brv-menu'});
      return;
    }
    const inp=document.createElement('input');
    inp.type=String(a.kind);inp.className='brv-widget';
    for(const k of ['value','min','max','step']) if(a[k]) inp[k]=String(a[k]);
    inp.style.left=p.x+'px';inp.style.top=(p.y+a.h*p.sy)+'px';
    this.stage.appendChild(inp);
    const done=()=>{inp.remove();this.focus()};
    inp.addEventListener('change',()=>{this._send({op:'widget',id:a.id,value:inp.value});done()});
    inp.addEventListener('blur',()=>TIMERS.after(200,()=>{if(inp.isConnected) done()},{owner:this,label:'brv-widget'}));
    inp.focus();
    try{ inp.showPicker() }catch{ /* 이 브라우저는 못 연다 — 입력란이 그 자리에 선다 */ }
  },

  /** FR-BRT-67: mailto:·tel: 같은 링크 — 이 기기에서 열지 묻는다. */
  async _extLink(href){
    if(!href) return;
    const ok=await UIKit.ask({msg:t('brv.ext_link',{href}),actions:[
      {label:t('brv.open_here'),kind:'primary',value:true,default:true},{label:t('core.cancel'),value:false}],escValue:false});
    if(ok) window.open(href,'_blank','noopener');
  },

  // ── 대화상자·인증·파일 선택 (FR-BRT-81·85·86) ──

  _onDialog(d){
    if(d.closed){ if(this._dlg&&this._dlg.id===d.id){this._dlg.close();this._dlg=null} return }
    const body=document.createElement('div');body.className='brv-dialog';
    const msg=document.createElement('div');msg.className='confirm-msg';msg.textContent=String(d.message||'');
    body.appendChild(msg);
    let input=null;
    if(d.type==='prompt'){input=document.createElement('input');input.type='text';input.className='sbx-input';input.value=String(d.default||'');body.appendChild(input)}
    const answer=(accept)=>this._send({op:'dialog',id:d.id,accept,text:input?input.value:''});
    const actions=d.type==='alert'
      ?[{label:t('brv.ok'),kind:'primary',default:true,value:1,onClick:()=>answer(true)}]
      :[{label:t('core.cancel'),value:0,onClick:()=>answer(false)},{label:t('brv.ok'),kind:'primary',default:true,value:1,onClick:()=>answer(true)}];
    const m=UIKit.modal({title:t('brv.dialog_title'),body,actions,cls:'brv-dialog-modal',onClose:(v)=>{if(v===undefined) answer(false);this._dlg=null}});
    document.body.appendChild(m.el);
    if(input) input.focus();
    this._dlg={id:d.id,close:()=>m.close(null)};
  },

  _onAuth(a){
    if(a.closed){ if(this._auth&&this._auth.id===a.id){this._auth.close();this._auth=null} return }
    const body=document.createElement('div');body.className='brv-dialog';
    const msg=document.createElement('div');msg.className='confirm-msg';
    msg.textContent=t('brv.auth_msg',{origin:String(a.origin||''),realm:String(a.realm||'')});
    const user=document.createElement('input');user.type='text';user.className='sbx-input';user.setAttribute('aria-label',t('brv.auth_user'));user.placeholder=t('brv.auth_user');
    const pass=document.createElement('input');pass.type='password';pass.className='sbx-input';pass.setAttribute('aria-label',t('brv.auth_pass'));pass.placeholder=t('brv.auth_pass');
    body.append(msg,user,pass);
    const m=UIKit.modal({title:t('brv.auth_title'),body,cls:'brv-dialog-modal',actions:[
      {label:t('core.cancel'),value:0,onClick:()=>this._send({op:'auth',id:a.id,cancel:true})},
      {label:t('brv.ok'),kind:'primary',default:true,value:1,onClick:()=>this._send({op:'auth',id:a.id,user:user.value,pass:pass.value})}],
      onClose:(v)=>{if(v===undefined) this._send({op:'auth',id:a.id,cancel:true});this._auth=null}});
    document.body.appendChild(m.el);
    user.focus();
    this._auth={id:a.id,close:()=>m.close(null)};
  },

  /**
   * FR-BRT-81: 서버 파일 선택 창 — 뷰어 기기의 파일은 다루지 않는다(D-BRT-17). 폴더를 오가며
   * 고르고, 경로를 직접 적을 수도 있다. 취소하면 빈 목록이다.
   */
  async _onChooser(c){
    if(document.activeElement!==this.input&&!this.el.contains(document.activeElement)) return;
    const body=document.createElement('div');body.className='brv-chooser';
    const path=document.createElement('input');path.type='text';path.className='sbx-input brv-chooser-path';
    path.setAttribute('aria-label',t('brv.chooser_path'));
    const list=document.createElement('div');list.className='brv-chooser-list ui-scroll';
    const picked=new Set();
    body.append(path,list);
    const load=async(dir)=>{
      path.value=dir;
      const r=await apiGet(FS_LIST_API+'?root=/&path='+encodeURIComponent(dir));
      list.textContent='';
      if(!r.ok||!r.data) return;
      const parent=dir.replace(/[\\/][^\\/]*[\\/]?$/,'')||'/';
      const row=(label,fn,cls)=>{const d=document.createElement('div');d.className='brv-chooser-row '+(cls||'');d.textContent=label;d.tabIndex=0;d.addEventListener('click',fn);list.appendChild(d);return d};
      if(dir!=='/') row('..',()=>load(parent),'dir');
      for(const e of r.data.entries||[]){
        const full=(dir.endsWith('/')?dir:dir+'/')+e.name;
        if(e.dir||e.linkDir){ row(e.name+'/',()=>load(full),'dir'); continue }
        const d=row(e.name,()=>{
          if(!c.multiple){ picked.clear(); for(const x of list.querySelectorAll('.on')) x.classList.remove('on') }
          if(picked.has(full)){picked.delete(full);d.classList.remove('on')}else{picked.add(full);d.classList.add('on')}
        });
      }
    };
    path.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();load(path.value)}e.stopPropagation()});
    const m=UIKit.modal({title:c.multiple?t('brv.chooser_title_multi'):t('brv.chooser_title'),body,cls:'brv-chooser-modal',actions:[
      {label:t('core.cancel'),value:0,onClick:()=>this._send({op:'chooser',id:c.id,files:[]})},
      {label:t('brv.chooser_pick'),kind:'primary',default:true,value:1,onClick:()=>this._send({op:'chooser',id:c.id,
        files:picked.size?[...picked]:(path.value&&!path.value.endsWith('/')?[path.value]:[])})}],
      onClose:(v)=>{if(v===undefined) this._send({op:'chooser',id:c.id,files:[]})}});
    document.body.appendChild(m.el);
    load(c.home||'/');
  },

  // ── 다운로드 줄 (FR-BRT-80) ──

  _onDownload(d){
    if(!this._dl){this._dl=document.createElement('div');this._dl.className='brv-downloads ui-scroll-sm';this.el.appendChild(this._dl)}
    let row=this._dl.querySelector(`[data-guid="${CSS.escape(String(d.guid||''))}"]`);
    if(!row){
      row=document.createElement('div');row.className='brv-dl';row.dataset.guid=String(d.guid||'');
      const name=document.createElement('span');name.className='brv-dl-name';
      const st=document.createElement('span');st.className='brv-dl-state';
      row.append(name,st);this._dl.appendChild(row);
    }
    row.querySelector('.brv-dl-name').textContent=String(d.name||'');
    const st=row.querySelector('.brv-dl-state');
    if(d.state==='completed'){
      st.textContent='';
      if(!row.querySelector('.ui-btn')){
        const b=UIKit.button({label:t('brv.dl_reveal'),kind:'ghost',size:'sm'});
        b.addEventListener('click',()=>this.app.brvReveal(String(d.path||'')));
        row.appendChild(b);
      }
    }else if(d.state==='canceled'){
      st.textContent=t('brv.dl_canceled');
    }else{
      st.textContent=d.total?Math.round(100*d.received/d.total)+'%':Math.round((d.received||0)/1024)+' KB';
    }
  },

  // ── 찾기 (FR-BRT-89) ──

  toggleFind(){
    if(this._find){this._find.remove();this._find=null;this._send({op:'find',q:''});this.focus();return}
    const bar=document.createElement('div');bar.className='brv-find';
    const q=document.createElement('input');q.type='text';q.className='brv-find-q';q.setAttribute('aria-label',t('brv.find'));q.placeholder=t('brv.find');
    const n=document.createElement('span');n.className='brv-find-n';
    // FR-BRT-89: 한계를 드러낸다 — 교차 출처 iframe 안은 찾지 않는다.
    const note=document.createElement('span');note.className='brv-find-note';note.textContent='ⓘ';note.title=t('brv.find_limit');
    note.setAttribute('aria-label',t('brv.find_limit'));
    bar.append(q,n,note);
    this.stage.appendChild(bar);
    this._find=bar;this._findN=n;
    const go=(dir)=>this._send({op:'find',q:q.value,dir});
    q.addEventListener('input',()=>go(1));
    q.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();go(e.shiftKey?-1:1)}
      if(e.key==='Escape'){e.preventDefault();this.toggleFind()}
      e.stopPropagation();
    });
    q.focus();
  },

  _onFind(r){ if(this._findN) this._findN.textContent=r&&r.count?(r.index+'/'+r.count):'0/0' },
});
