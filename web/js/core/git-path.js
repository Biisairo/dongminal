/**
 * 저장소 경로의 두 계산 (REPO_FIX 05 §3A-4) — 탐색기·변경 표시·git 프런트가 함께 쓴다.
 *
 * `helpers.js` 의 `pathSep` 위에 선다(그 뒤에 싣는다).
 */
/**
 * FR-DIR-41 / REPO_FIX 05 §3A-4: 저장소 루트(`repo`)에서 요청 루트(`resolved`)까지의
 * 접두 — `"src/"`. 루트가 저장소 밖이면 `null` 이다. 탐색기·변경 표시·git 프런트가
 * 이 한 함수를 쓴다(종전에는 탐색기의 `_prefixOf` 와 변경 표시의 `edDdPrefix` 두 벌).
 *
 * 클라이언트는 심볼릭 링크를 풀지 않는다 — 서버가 준 정규화 값 둘 사이에서만 잰다.
 * `/appx` 가 `/app` 의 하위로 오인되지 않도록 경계는 구분자로 본다.
 */
function gitRepoPrefix(repo,resolved){
  if(!resolved) return null;
  if(resolved===repo) return '';
  const sep=pathSep(repo);
  const base=repo.endsWith(sep)?repo:repo+sep;
  if(!resolved.startsWith(base)) return null;
  return resolved.slice(base.length).replace(/\\/g,'/')+'/';
}

/**
 * REPO_FIX 05 §3A-4 (F-3): **어휘적** 저장소 최상위 — 요청 루트(`requested`)에서 접두만큼
 * 올라간 경로. status 의 상대경로는 여기에 잇는다.
 *
 * 서버의 `repo` 는 심볼릭 링크를 푼 값이라 편집기 경로와 다를 수 있다 — 그 값으로 열면
 * 같은 파일에 문서가 둘 생긴다(03 문서 키가 경로 문자열). 근거가 없으면(접두를 못 잼)
 * 서버의 `repo` 로 물러난다.
 */
function gitLexicalTop(d){
  if(!d||!d.repo) return '';
  const req=d.requested||'';
  if(!req||req===d.repo||d.rootMatch===true) return req||d.repo;
  const prefix=gitRepoPrefix(d.repo,d.requestedResolved||'');
  if(prefix===null) return d.repo;
  let top=req.replace(/[\\/]+$/,'');
  const sep=pathSep(top);
  const up=prefix.split('/').filter(Boolean).length;
  for(let n=0;n<up;n++){
    const i=top.lastIndexOf(sep);
    if(i<=0) return d.repo;
    top=top.slice(0,i);
  }
  return top;
}
