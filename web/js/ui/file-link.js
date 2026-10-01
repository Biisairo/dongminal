/**
 * UX_BATCH11_SRS FR-FPL — 터미널 출력의 파일 경로를 편집기의 그 줄로 여는 링크.
 *
 * 후보는 글자 규칙으로 고르고(FR-FPL-1), 링크가 되는 것은 **있는 파일**뿐이다(FR-FPL-3).
 * 줄 읽기(`termLineText`)와 존재 확인의 저장(`fileStampsKnown`)은 맨 도메인과 같다 (D-13).
 *
 * 로드 순서: `ui/bare-link.js` 바로 뒤.
 */
const FILE_LINK_TOKEN_RE=/[^\s'"`()[\]<>]+/g;
const FILE_LINK_TRAIL_RE=/[:,.;]+$/;
const FILE_LINK_POS_RE=/:(\d+)(?::(\d+))?$/;
const FILE_LINK_DRIVE_RE=/^[A-Za-z]:[\\/]/;

/**
 * FR-FPL-1: `{index, lastIndex, text, path, line, col}`. 구분자가 든 경로, Windows 드라이브 경로,
 * 또는 `:줄[:칸]` 이 붙은 이름만 후보다. 맨 이름(`main.go`)과 URL 은 아니다. 없는 줄·칸은 `null`.
 */
function filePathCandidates(text){
  const out=[];
  for(const m of String(text||'').matchAll(FILE_LINK_TOKEN_RE)){
    const tok=m[0].replace(FILE_LINK_TRAIL_RE,'');
    if(!tok||tok.includes('://')) continue;
    let path=tok, line=null, col=null;
    const pos=tok.match(FILE_LINK_POS_RE);
    if(pos){ path=tok.slice(0,pos.index); line=+pos[1]; col=pos[2]===undefined?null:+pos[2] }
    if(!path||line===0||col===0) continue;
    const pathy=path.includes('/')||path.includes('\\')||FILE_LINK_DRIVE_RE.test(path);
    if(!pathy&&line===null) continue;
    out.push({index:m.index,lastIndex:m.index+tok.length,text:tok,path,line,col});
  }
  return out;
}

/** FR-FPL-2: 절대 경로면 그대로, 아니면 cwd 기준. cwd 를 모르면 `''`. `~` 는 펼치지 않는다. */
function filePathResolve(p,cwd){
  if(isAbsPath(p)) return p;
  if(!cwd) return '';
  return pathJoin(cwd,p.replace(/^(\.[\\/])+/,''));
}

/** FR-FPL-3: 있는 파일인 후보만 `{cand, abs}` 로. 한 요청으로 묻는다. */
async function filePathExisting(cands,cwd){
  const xs=cands.map(cand=>({cand,abs:filePathResolve(cand.path,cwd)})).filter(x=>x.abs);
  if(!xs.length) return [];
  const known=await fileStampsKnown(xs.map(x=>x.abs));
  return xs.filter(x=>known.has(x.abs));
}

/** FR-FPL-4: 편집기가 꺼져 있으면 파일 링크는 서지 않는다. */
function fileLinksOn(){
  const A=window.app;
  return !!(A&&A.edOn&&A.edOn());
}

/** FR-FPL-4·5: xterm 링크 공급자. 누르면 편집기의 그 줄로 연다. */
function fileLinkProvider(term,cwdOf){
  return {
    provideLinks(y,cb){
      const ln=fileLinksOn()&&termLineText(term,y);
      const cs=ln?filePathCandidates(ln.s):[];
      if(!cs.length){cb(undefined);return}
      filePathExisting(cs,cwdOf()).then(xs=>{
        const links=xs.map(({cand,abs})=>({
          text:cand.text,
          range:{start:{x:ln.at[cand.index]+1,y},end:{x:ln.at[cand.lastIndex-1]+1,y}},
          activate:()=>{
            const o={};
            if(cand.line) o.line=cand.line;
            if(cand.col) o.col=cand.col;
            window.app.edOpenFile(abs,o);
          },
        }));
        cb(links.length?links:undefined);
      });
    },
  };
}
