/**
 * BARE_DOMAIN_LINK_SRS — 스킴 없이 적힌 도메인(`naver.com`)을 링크로 잡는다.
 *
 * 감지는 번들된 linkify-it 의 fuzzy link 다 (D-BDL-3). 그것은 `README.md` 도 잡는다
 * — `md` 가 국가 TLD 이기 때문이다. 그래서 기준 폴더에 그 이름의 파일이 있으면
 * 링크가 아니다 (D-BDL-2).
 */
let bareLinkify=null;
const bareLinkSeen=new Map();

function bareLinkifier(){
  if(!bareLinkify&&typeof markdownit==='function') bareLinkify=markdownit().linkify.set({fuzzyLink:true,fuzzyEmail:false});
  return bareLinkify;
}

/** FR-BDL-1: 맨 도메인만. 스킴 있는 링크는 기존 경로가 잡는다. */
function bareLinks(text){
  const lk=bareLinkifier();
  const ms=lk&&lk.match(String(text||''));
  if(!ms) return [];
  return ms.filter(m=>m.schema==='').map(m=>({index:m.index,lastIndex:m.lastIndex,text:m.text,url:m.url}));
}

/**
 * FR-BDL-2·3: `names` 중 `dir` 에 **있는 파일**의 이름. 확인할 수 없으면 빈 집합이다
 * (D-BDL-5) — 그러면 모두 링크로 남는다.
 */
async function bareLinkFiles(names,dir){
  const out=new Set();
  if(!dir||!names.length) return out;
  const now=Date.now();
  const ask=[];
  for(const n of names){
    const hit=bareLinkSeen.get(dir+'\n'+n);
    if(hit&&now-hit.at<BARE_LINK_CACHE_MS){ if(hit.file) out.add(n) }
    else ask.push(n);
  }
  if(!ask.length) return out;
  const paths=ask.map(n=>pathJoin(dir,n));
  const r=await apiPost(FILE_STAMPS_API,{paths});
  const stamps=r&&r.ok&&r.data&&r.data.stamps;
  if(!stamps) return out;
  if(bareLinkSeen.size>BARE_LINK_CACHE_MAX) bareLinkSeen.clear();
  ask.forEach((n,i)=>{
    const file=Object.prototype.hasOwnProperty.call(stamps,paths[i]);
    bareLinkSeen.set(dir+'\n'+n,{at:now,file});
    if(file) out.add(n);
  });
  return out;
}

/**
 * FR-BDL-4: xterm 링크 공급자. 줄의 글자를 **칸 단위로** 읽는다 — 한글처럼 두 칸을
 * 차지하는 글자가 앞에 있으면 문자열 자리와 칸 자리가 어긋난다.
 */
function bareLinkProvider(term,cwdOf){
  return {
    provideLinks(y,cb){
      const line=term.buffer.active.getLine(y-1);
      if(!line){cb(undefined);return}
      let s='';
      const at=[];
      for(let x=0;x<term.cols;x++){
        const c=line.getCell(x);
        if(!c) break;
        if(!c.getWidth()) continue;
        const ch=c.getChars()||' ';
        for(let k=0;k<ch.length;k++) at.push(x);
        s+=ch;
      }
      const ms=bareLinks(s);
      if(!ms.length){cb(undefined);return}
      bareLinkFiles(ms.map(m=>m.text),cwdOf()).then(files=>{
        const links=ms.filter(m=>!files.has(m.text)).map(m=>({
          text:m.text,
          range:{start:{x:at[m.index]+1,y},end:{x:at[m.lastIndex-1]+1,y}},
          activate:(e)=>{ if(window.app&&window.app.openLink) window.app.openLink(m.url,e); else window.open(m.url,'_blank') },
        }));
        cb(links.length?links:undefined);
      });
    },
  };
}
