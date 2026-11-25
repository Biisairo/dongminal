/**
 * Otterminal — 화면 등록부와 묶음 로더 (PERF M3 §3.4, D-30, FR-SPA-1).
 *
 * 화면과 라이브러리 묶음은 이름과 싣기 정보(묶음 이름, CSS 유무, 맡는 탭, 먼저 실을 needs)를 등록한다(D-45). 처음 쓸 때 `Screens.load(name)` 이
 * 서버 묶음 `b/<묶음>.js`(D-29)와 `b/<묶음>.css` 를 클래식 태그로 붙인다(FR-SPA-6).
 *
 * 규약은 `loadCodeMirror`(ui/cm-load.js)와 같다: 기다리는 호출자는 같은 Promise 를 나누고, 실패는
 * 기억하지 않으며, 다시 시도할 때는 URL 을 바꾼다 — 브라우저가 실패한 URL 을 다시 받지 않을 수 있다.
 *
 * 로드 순서: 렌더러 앞(렌더러가 `forTab`·`ready` 를 묻는다).
 */

/** 부팅 묶음 태그의 `?v=` — 자산의 판이다 (ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-1). 없으면 null. */
function bootAssetVersion(){
  const el=document.querySelector('script[src*="b/boot.js"]');
  const m=el&&(el.getAttribute('src')||'').match(/[?&]v=([0-9a-f]+)/);
  return m?m[1]:null;
}

const Screens={
  _defs:new Map(),
  _loading:new Map(),
  _ready:new Set(),
  _attempt:new Map(),

  /**
   * `bundle` 은 묶음 이름, `css` 는 그 묶음이 CSS 를 갖는가, `tab(at)` 은 이 화면이 맡는 탭인가,
   * `needs` 는 먼저 실어야 하는 등록 이름들이다(D-45). 라이브러리 묶음은 `tab` 없이 등록한다.
   */
  register(name,{bundle=name,css=false,tab=null,needs=[]}={}){
    if(this._defs.has(name)) throw new Error('Screens: registered twice: '+name);
    this._defs.set(name,{bundle,css,tab,needs});
  },

  /** 이미 실렸는가 — 동기 질문이다. */
  ready(name){ return this._ready.has(name) },

  /** 탭 `at` 을 맡는 화면의 이름. 맡는 화면이 없으면(부팅 묶음에 있다) null. */
  forTab(at){
    for(const [name,d] of this._defs) if(d.tab&&d.tab(at)) return name;
    return null;
  },

  /**
   * needs 를 순서대로 실은 뒤 본 묶음을 붙인다. need 가 실패하면 본 묶음은 붙이지 않는다.
   * 순환은 reject 한다.
   */
  load(name){ return this._load(name,[]) },

  _load(name,chain){
    if(this._ready.has(name)) return Promise.resolve();
    const def=this._defs.get(name);
    if(!def) return Promise.reject(new Error('Screens: not registered: '+name));
    if(chain.includes(name)) return Promise.reject(new Error('Screens: needs cycle: '+[...chain,name].join(' > ')));
    if(this._loading.has(name)) return this._loading.get(name);
    const up=[...chain,name];
    const needs=def.needs.filter((n)=>!this._ready.has(n));
    // needs 가 다 실렸으면 이번 호출 안에서 바로 붙인다(needs 가 없는 화면의 이전 동작 그대로).
    const p=(needs.length
      ?needs.reduce((acc,n)=>acc.then(()=>this._load(n,up)),Promise.resolve()).then(()=>this._attach(name,def))
      :this._attach(name,def))
      .then(()=>{ this._ready.add(name); this._loading.delete(name) },(err)=>{
        this._loading.delete(name);
        throw err;
      });
    this._loading.set(name,p);
    return p;
  },

  /** `b/<묶음>.js`(와 CSS)를 붙인다. 실패하면 붙인 태그를 걷고, 다음 시도는 URL 을 바꾼다. */
  _attach(name,def){
    const n=this._attempt.get(name)||0;
    this._attempt.set(name,n+1);
    const q=[bootAssetVersion()&&'v='+bootAssetVersion(),n&&'r='+n].filter(Boolean).join('&');
    const url=(ext)=>'b/'+def.bundle+ext+(q?'?'+q:'');
    const tags=[];
    const attach=(tag,set)=>new Promise((res,rej)=>{
      const e=document.createElement(tag);
      set(e);
      e.onload=()=>res();
      e.onerror=()=>rej(new Error('Screens: bundle failed: '+def.bundle));
      tags.push(e);
      document.head.appendChild(e);
    });
    const parts=[attach('script',(e)=>{ e.async=false; e.src=url('.js') })];
    if(def.css) parts.push(attach('link',(e)=>{ e.rel='stylesheet'; e.href=url('.css') }));
    return Promise.all(parts).then(()=>{},(err)=>{
      for(const e of tags) e.remove();
      throw err;
    });
  },
};