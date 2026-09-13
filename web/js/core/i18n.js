/**
 * Dongminal — 문구 카탈로그 (M8_UNIFIED_SRS 축 B, FR-B-1·2·4·5·7).
 *
 * 읽는 함수는 둘이다 — `t(key, params)` 와 `tn(key, n, params)`. 문장은
 * `web/js/i18n/<locale>.js` 가 `I18N.register` 로 싣는다. 이 파일은 **모든
 * 상수보다 먼저** 선다: `constants*.js` 가 `const X=t('…')` 로 로드 시점에 읽기
 * 때문이다. 그래서 로케일은 여기서 한 번 정해지고 바뀌지 않는다 — 전환은
 * 페이지를 다시 여는 일이다 (D-B-1).
 *
 * 로케일의 원천은 설정 키 `locale` 이지만 설정은 부팅 뒤에야 도착한다. 그래서
 * 설정을 얹는 쪽이 `localStorage` 에 비추고, 첫 페인트 전의 head 인라인 스크립트와
 * 이 파일이 그 거울을 읽는다 (`dm.themeVars` 와 같은 모양, BOOT_SCREEN D-4).
 * `navigator.language` 는 보지 않는다 (FR-B-1).
 */
const I18N_LOCALES=['ko','en'];
const I18N_DEFAULT='ko';
const I18N_STORAGE_KEY='dm.locale';

const I18N={
  _cat:{},
  _warned:new Set(),
  locale:I18N_DEFAULT,

  /** 저장값 → 지원 로케일. 밖의 값은 전부 기본으로 떨어진다. */
  resolve(v){return I18N_LOCALES.includes(v)?v:I18N_DEFAULT},

  /** 카탈로그 파일이 부른다. 같은 로케일에 거듭 부르면 합쳐진다. */
  register(locale,table){
    const cat=this._cat[locale]||(this._cat[locale]={});
    Object.assign(cat,table);
  },

  /**
   * 키 하나의 문장. 활성 로케일 → 기본 로케일 → 키 자체. 폴백을 지나는 키는
   * 콘솔에 **한 번** 경고한다 (FR-B-4) — 매번 내면 진짜 경고가 그 사이에 묻힌다.
   */
  lookup(key){
    const own=this._cat[this.locale];
    if(own&&typeof own[key]==='string') return own[key];
    const base=this._cat[I18N_DEFAULT];
    const hit=base&&typeof base[key]==='string';
    if(!this._warned.has(key)){
      this._warned.add(key);
      console.warn('[i18n] '+(hit?'미번역 키 — '+I18N_DEFAULT+' 로 폴백':'없는 키')+': '+key+' (locale='+this.locale+')');
    }
    return hit?base[key]:key;
  },

  /** 활성 로케일 또는 기본 로케일에 키가 있는가 — 경고 없이 묻는다. */
  has(key){
    const own=this._cat[this.locale], base=this._cat[I18N_DEFAULT];
    return !!((own&&typeof own[key]==='string')||(base&&typeof base[key]==='string'));
  },

  /** `{name}` 치환. 없는 이름은 그대로 남긴다 — 결함이 보인다. */
  fill(s,params){
    if(!params) return s;
    return s.replace(/\{([a-z0-9_]+)\}/gi,(m,k)=>(k in params?String(params[k]):m));
  },

  /**
   * 정적 문구 채움 (FR-B-2). `data-i18n` 은 텍스트, `data-i18n-html` 은 마크업을
   * 품은 안내문(`<b>`·`<code>` — 카탈로그는 개발자가 적은 정적 데이터다),
   * `data-i18n-title` · `data-i18n-placeholder` · `data-i18n-aria-label` 은 그 속성이다.
   * `data-i18n-shortcut="<action>"` 이 있으면 `{key}` 에 단축키 표기가 든다
   * (FR-B-7) — 표기는 `opts.shortcut(action)` 이 주고, 없으면 전역
   * `shortcuts`·`displayKey` 를 본다 (helpers.js 가 뒤에 선다). 그 둘이 아직
   * 없으면 단축키 툴팁은 건너뛴다 — `applyShortcuts` 가 설정 뒤에 채운다.
   */
  apply(root,opts){
    const sc=(opts&&opts.shortcut)||(I18N._hasShortcuts()?I18N._shortcutLabel:null);
    const els=root.querySelectorAll('[data-i18n],[data-i18n-html],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]');
    for(const el of els){
      const d=el.dataset;
      if(d.i18nShortcut&&!sc) continue;
      const params=d.i18nShortcut?{key:sc(d.i18nShortcut)}:null;
      if(d.i18n) el.textContent=t(d.i18n,params);
      if(d.i18nHtml) el.innerHTML=t(d.i18nHtml,params);
      if(d.i18nTitle) el.setAttribute('title',t(d.i18nTitle,params));
      if(d.i18nPlaceholder) el.setAttribute('placeholder',t(d.i18nPlaceholder,params));
      if(d.i18nAriaLabel) el.setAttribute('aria-label',t(d.i18nAriaLabel,params));
    }
  },

  /** 단축키가 바뀐 뒤 툴팁만 다시 채운다 (FR-B-7). */
  applyShortcuts(root){
    const els=root.querySelectorAll('[data-i18n-shortcut]');
    for(const el of els){
      const d=el.dataset, params={key:I18N._shortcutLabel(d.i18nShortcut)};
      if(d.i18nTitle) el.setAttribute('title',t(d.i18nTitle,params));
      if(d.i18nAriaLabel) el.setAttribute('aria-label',t(d.i18nAriaLabel,params));
    }
  },

  _hasShortcuts(){return typeof shortcuts==='object'&&typeof displayKey==='function'},
  _shortcutLabel(action){
    if(!I18N._hasShortcuts()) return '';
    return displayKey(shortcuts[action]||'');
  },
};

function t(key,params){return I18N.fill(I18N.lookup(key),params)}

/**
 * 복수형 (FR-B-2). `Intl.PluralRules` 가 `one`/`other` 를 고르고, 그 접미의 키가
 * 없으면 `.other` 로 간다 — `ko` 는 `.other` 만 둔다. `{n}` 은 자동이다.
 */
function tn(key,n,params){
  const p=Object.assign({n},params||{});
  let cat=(typeof Intl!=='undefined'&&Intl.PluralRules)?new Intl.PluralRules(I18N.locale).select(n):'other';
  const own=I18N._cat[I18N.locale]||{};
  if(cat!=='other'&&typeof own[key+'.'+cat]!=='string') cat='other';
  return t(key+'.'+cat,p);
}

// 로케일은 로드 시점에 한 번 정해진다 (D-B-1).
(function(){
  let v=null;
  try{v=localStorage.getItem(I18N_STORAGE_KEY)}catch{}
  I18N.locale=I18N.resolve(v);
  // FR-B-5: `<html lang>` 은 활성 로케일이다. head 스크립트가 먼저 세웠어도 같은 값이다.
  const html=typeof document!=='undefined'&&document.documentElement;
  if(html) html.setAttribute('lang',I18N.locale);
})();

// 정적 문구는 카탈로그가 실린 뒤 **한 번** 채운다 — 이 파일은 body 끝에서 돌므로
// 마크업은 이미 있다. 카탈로그 파일이 이 뒤에 오므로 DOMContentLoaded 에서 한다.
if(typeof document!=='undefined'&&document.addEventListener){
  document.addEventListener('DOMContentLoaded',()=>I18N.apply(document),{once:true});
}
