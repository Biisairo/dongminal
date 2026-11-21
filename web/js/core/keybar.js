/**
 * Remote Terminal — 모바일 키바의 구성과 매크로 (UX_AUDIT_FIX_SRS §3.11.2, FR-UXF-93·94, D-31)
 *
 * 순수 함수만 둔다. 키바는 app-mobile.js 가, 설정 구역은 settings-terminal.js(`TerminalSection`) 가 그린다.
 * 구성 값은 설정 키 `keybar` 다: `{order:[id…], off:[id…], macros:[{id,label,key,ctrl,alt,shift}…]}`.
 * constants.js(`MKB_KEYS`) 뒤에 로드된다.
 */

/** FR-UXF-94: 매크로가 고를 수 있는 키. */
const KEYBAR_MACRO_KEYS=Object.freeze([...'abcdefghijklmnopqrstuvwxyz0123456789',
  'space','esc','tab','enter','backspace','up','down','left','right','home','end','pgup','pgdn','[',']','\\','/']);
const KEYBAR_LABEL_MAX=8;
// 키바에 서는 키 표기와 길게 누르면 뜨는 이름(영어). 표에 없는 키는 대문자로 적는다.
const MKB_COMBO_KEY_LABEL=Object.freeze({space:'Space',esc:'Esc',tab:'Tab',enter:'⏎',backspace:'⌫',
  up:'↑',down:'↓',left:'←',right:'→',home:'Home',end:'End',pgup:'PgUp',pgdn:'PgDn'});
const MKB_COMBO_KEY_NAME=Object.freeze({space:'Space',esc:'Esc',tab:'Tab',enter:'Enter',backspace:'Backspace',
  up:'Up',down:'Down',left:'Left',right:'Right',home:'Home',end:'End',pgup:'PageUp',pgdn:'PageDown'});
// 바이트 표 (FR-UXF-94). CSI 끝 글자 · `~` 앞의 수 · 수식이 바이트를 바꾸지 않는 키.
const MKB_COMBO_CSI=Object.freeze({up:'A',down:'B',right:'C',left:'D',home:'H',end:'F'});
const MKB_COMBO_TILDE=Object.freeze({pgup:5,pgdn:6});
const MKB_COMBO_PLAIN=Object.freeze({esc:'\x1b',enter:'\r',tab:'\t',backspace:'\x7f'});

/** 수식이 하나 이상이고 키가 표에 있어야 매크로다. */
function mkbMacroValid(m){
  return !!m&&typeof m==='object'&&KEYBAR_MACRO_KEYS.includes(m.key)&&!!(m.ctrl||m.alt||m.shift);
}

/** FR-UXF-94: 키 조합 하나가 보내는 바이트. Alt 는 앞에 ESC, 방향·페이지 키는 수식 값 `m` 을 싣는다. */
function mkbComboBytes(m){
  const ESC='\x1b';
  const pre=m.alt?ESC:'';
  if(MKB_COMBO_CSI[m.key]||MKB_COMBO_TILDE[m.key]){
    const mod=1+(m.shift?1:0)+(m.alt?2:0)+(m.ctrl?4:0);
    return MKB_COMBO_CSI[m.key]?ESC+'[1;'+mod+MKB_COMBO_CSI[m.key]:ESC+'['+MKB_COMBO_TILDE[m.key]+';'+mod+'~';
  }
  if(MKB_COMBO_PLAIN[m.key]){
    if(m.key==='tab'&&m.shift) return pre+ESC+'[Z';
    if(m.key==='backspace'&&m.ctrl) return pre+'\x08';
    return pre+MKB_COMBO_PLAIN[m.key];
  }
  let ch=m.key==='space'?' ':m.key;
  if(m.shift) ch=ch.toUpperCase();
  if(m.ctrl){
    const c=ch.charCodeAt(0);
    if(ch===' ') ch='\x00';
    else if(ch==='/') ch='\x1f';
    else if(c>=0x40&&c<=0x7e) ch=String.fromCharCode(c&0x1f);
  }
  return pre+ch;
}

/** 라벨 기본값: `^`(Ctrl)·`⌥`(Alt)·`⇧`(Shift) 다음에 키 표기 — `^D`·`⌥B`·`^⇧↑`. */
function mkbComboLabel(m){
  return (m.ctrl?'^':'')+(m.alt?'⌥':'')+(m.shift?'⇧':'')+(MKB_COMBO_KEY_LABEL[m.key]||m.key.toUpperCase());
}

/** 길게 누르면 뜨는 이름 — `Macro: Ctrl+D`. */
function mkbComboName(m){
  const parts=[m.ctrl&&'Ctrl',m.alt&&'Alt',m.shift&&'Shift'].filter(Boolean);
  parts.push(MKB_COMBO_KEY_NAME[m.key]||m.key.toUpperCase());
  return 'Macro: '+parts.join('+');
}

/** 사용자가 고친 라벨은 1~8자일 때만 쓴다. 아니면 기본값이다. */
function _keybarMacroLabel(m){
  const l=typeof m.label==='string'?m.label.trim():'';
  const n=[...l].length;
  return n>=1&&n<=KEYBAR_LABEL_MAX?l:mkbComboLabel(m);
}

/** 값이 무엇이든 세 목록을 가진 구성으로 읽는다 (FR-UXF-93 ④). */
function _keybarCfg(cfg){
  const c=cfg&&typeof cfg==='object'&&!Array.isArray(cfg)?cfg:{};
  const strs=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):[];
  return {order:strs(c.order),off:strs(c.off),macros:Array.isArray(c.macros)?c.macros:[]};
}

/**
 * FR-UXF-93: 구성할 수 있는 키 전부(⌨ 제외)를 순서대로, 켜기 표시와 함께.
 * `order` 의 id 가 먼저, 적히지 않은 기본 키는 기본 순서, 적히지 않은 매크로는 만든 순서다. 알 수 없는 id 는 버린다.
 */
function keybarRows(cfg){
  const c=_keybarCfg(cfg);
  const pool=new Map();
  for(const k of MKB_KEYS) if(k.id) pool.set(k.id,k);
  for(const m of c.macros){
    if(!mkbMacroValid(m)||typeof m.id!=='string'||pool.has(m.id)) continue;
    pool.set(m.id,{id:m.id,label:_keybarMacroLabel(m),raw:mkbComboBytes(m),name:mkbComboName(m),macro:true});
  }
  const out=[];
  for(const id of c.order) if(pool.has(id)&&!out.includes(pool.get(id))) out.push(pool.get(id));
  for(const k of pool.values()) if(!out.includes(k)) out.push(k);
  const off=new Set(c.off);
  return out.map(k=>({key:k,on:!off.has(k.id)}));
}

/** FR-UXF-93: 키바에 서는 키 — `⌨` 가 맨 왼쪽이고 꺼진 키는 없다. */
function keybarResolve(cfg){
  return [MKB_KEYS.find(k=>k.act==='kb'),...keybarRows(cfg).filter(r=>r.on).map(r=>r.key)];
}

/** 켜기·끄기. */
function keybarToggle(cfg,id,on){
  const c=_keybarCfg(cfg);
  const off=c.off.filter(x=>x!==id);
  if(!on) off.push(id);
  return {...c,off};
}

/** 한 칸 위(-1)·아래(+1). 끝에서는 순서를 적기만 한다. */
function keybarMove(cfg,id,dir){
  const c=_keybarCfg(cfg);
  const order=keybarRows(c).map(r=>r.key.id);
  const i=order.indexOf(id),j=i+dir;
  if(i>=0&&j>=0&&j<order.length) [order[i],order[j]]=[order[j],order[i]];
  return {...c,order};
}

/** FR-UXF-95: `기본값으로` 는 순서와 켜기만 되돌린다. 매크로는 남는다. */
function keybarReset(cfg){
  return {macros:_keybarCfg(cfg).macros};
}

function keybarAddMacro(cfg,m){
  const c=_keybarCfg(cfg);
  return {...c,macros:[...c.macros,m]};
}

function keybarRemoveMacro(cfg,id){
  const c=_keybarCfg(cfg);
  const drop=x=>x!==id;
  return {order:c.order.filter(drop),off:c.off.filter(drop),macros:c.macros.filter(m=>!m||m.id!==id)};
}
