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
 * FR-BDL-3 · UX_BATCH11_SRS FR-FPL-3 / D-13: 절대 경로들 중 **있는 파일**. 같은 경로의 답은 5초
 * 기억한다 — 맨 도메인과 파일 경로 링크가 이 저장 하나를 쓴다. 요청이 실패하면 기억한 것만
 * 돌려준다(그 밖은 모른다). 모르는 것을 무엇으로 읽을지는 부르는 쪽이 정한다.
 */
async function fileStampsKnown(paths){
  const out=new Set();
  const now=Date.now();
  const ask=[];
  for(const p of paths){
    const hit=bareLinkSeen.get(p);
    if(hit&&now-hit.at<BARE_LINK_CACHE_MS){ if(hit.file) out.add(p) }
    else if(!ask.includes(p)) ask.push(p);
  }
  if(!ask.length) return out;
  const r=await apiPost(FILE_STAMPS_API,{paths:ask});
  const stamps=r&&r.ok&&r.data&&r.data.stamps;
  if(!stamps) return out;
  if(bareLinkSeen.size>BARE_LINK_CACHE_MAX) bareLinkSeen.clear();
  for(const p of ask){
    const file=Object.prototype.hasOwnProperty.call(stamps,p);
    bareLinkSeen.set(p,{at:now,file});
    if(file) out.add(p);
  }
  return out;
}

/**
 * FR-BDL-2·3: `names` 중 `dir` 에 **있는 파일**의 이름. 확인할 수 없으면 빈 집합이다
 * (D-BDL-5) — 그러면 모두 링크로 남는다.
 */
async function bareLinkFiles(names,dir){
  const out=new Set();
  if(!dir||!names.length) return out;
  const paths=names.map(n=>pathJoin(dir,n));
  const known=await fileStampsKnown(paths);
  names.forEach((n,i)=>{ if(known.has(paths[i])) out.add(n) });
  return out;
}

/**
 * xterm 버퍼의 `y`(1부터) 줄 글자와, 글자 자리 → 칸 자리 표. 한글처럼 두 칸을 차지하는 글자가
 * 앞에 있으면 문자열 자리와 칸 자리가 어긋나므로 **칸 단위로** 읽는다.
 */
function termLineText(term,y){
  const line=term.buffer.active.getLine(y-1);
  if(!line) return null;
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
  return {s,at};
}

/**
 * FR-BDL-4: xterm 링크 공급자.
 *
 * UX_BATCH11_SRS FR-FPL-6: 같은 글자가 파일 경로 링크로 서면(`README.md:1`) 맨 도메인은 물러난다.
 */
function bareLinkProvider(term,cwdOf){
  return {
    provideLinks(y,cb){
      const ln=termLineText(term,y);
      if(!ln){cb(undefined);return}
      const ms=bareLinks(ln.s);
      if(!ms.length){cb(undefined);return}
      const fps=fileLinksOn()?filePathCandidates(ln.s):[];
      Promise.all([bareLinkFiles(ms.map(m=>m.text),cwdOf()),fps.length?filePathExisting(fps,cwdOf()):[]]).then(([files,taken])=>{
        const links=ms.filter(m=>!files.has(m.text)&&!taken.some(({cand:c})=>c.index<m.lastIndex&&m.index<c.lastIndex)).map(m=>({
          text:m.text,
          range:{start:{x:ln.at[m.index]+1,y},end:{x:ln.at[m.lastIndex-1]+1,y}},
          activate:()=>{window.open(m.url,'_blank')},
        }));
        cb(links.length?links:undefined);
      });
    },
  };
}
