/**
 * 상태바 인코딩 항목 — 포커스 편집기 문서의 인코딩, 다시 열기·UTF-8 변환 저장
 * (REPO_FIX 03 §3A-2 · 사용자 결정 "인코딩 왕복 + 수동 선택 + UTF-8 로 변환해 저장")
 *
 * 편집기 자체에는 상태 표시줄이 없으므로 전역 상태바가 포커스 칸의 것을 보인다 —
 * `termsize` 가 포커스 터미널일 때만 서는 것과 같은 규약이다.
 */
Object.assign(App.prototype, {

  // 포커스 칸의 텍스트 문서 편집기와 그 문서. 모델이 없으면(로딩·이진) 없다.
  _sbEncDoc(){
    const v=this._edActiveEditor();
    if(!v||v.render||!v._doc||!v._doc.model) return null;
    return {v,d:v._doc};
  },

  _sbEncLabel(d){
    const base=ENC_LABEL[d.encoding]||d.encoding||ENC_LABEL['utf-8'];
    const withBom=d.encoding==='utf-8'&&d.bom?base+' BOM':base;
    return d.decodable===false?withBom+' · '+ENC_READONLY:withBom;
  },

  // updateStatusBar 가 부른다. 그릴 것이 없으면 빈 문자열이다.
  _sbEncHtml(){
    const got=this._sbEncDoc();
    if(!got) return '';
    const e=escHtml;
    return `<span class="sb-item sb-enc" role="button" tabindex="0" title="${e(ENC_TITLE)}"><span class="mono">${e(this._sbEncLabel(got.d))}</span></span>`;
  },

  // 상태바에 한 번만 건다 — 항목은 reconcile 로 새로 만들어지므로 위임한다.
  _sbEncBind(bar){
    if(bar._encBound) return;
    bar._encBound=true;
    const open=(el)=>{
      const got=this._sbEncDoc();
      if(!got) return;
      const r=el.getBoundingClientRect();
      this._sbEncMenu(got,{x:r.left,y:r.top});
    };
    bar.addEventListener('click',(ev)=>{
      const el=/** @type {HTMLElement} */ (ev.target).closest('.sb-enc');
      if(el) open(el);
    });
    bar.addEventListener('keydown',(ev)=>{
      if(ev.key!=='Enter'&&ev.key!==' ') return;
      const el=/** @type {HTMLElement} */ (ev.target).closest('.sb-enc');
      if(el){ev.preventDefault();open(el)}
    });
  },

  _sbEncMenu({v,d},at){
    const path=v.filePath;
    const items=[{label:ENC_REOPEN,static:true}];
    for(const id of ENC_REOPEN_CHOICES){
      items.push({id:'reopen-'+id,label:ENC_LABEL[id],cur:d.encoding===id,
        onClick:()=>this.edDocReopen(path,id)});
    }
    items.push({sep:true});
    let why='';
    if(d.decodable===false) why=ENC_CONVERT_NO_DECODE;
    else if(d.encoding==='utf-8'&&!d.bom) why=ENC_CONVERT_ALREADY;
    items.push({id:'to-utf8',label:ENC_CONVERT,disabled:why||false,onClick:()=>this.edDocConvertUtf8(path)});
    UIKit.menu(items,{at,cls:'sb-enc-menu',flipGap:4});
  },
});
