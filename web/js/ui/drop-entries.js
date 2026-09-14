/**
 * Dongminal — 드롭을 `{file, relPath}` 로 펴는 **순수 함수** (TERMINAL_FOLDER_DROP_SRS
 * FR-TFD-1~3).
 *
 * 탐색기와 터미널이 **같은 일**을 한다 — 놓인 것이 폴더면 하위 구조까지 올린다.
 * 다른 것은 "어디에 놓는가" 뿐이고(탐색기는 그 폴더, 터미널은 그 도구의 cwd),
 * 그 판단은 각자 그대로 둔다.
 *
 * ## 왜 클래스에 붙이지 않는가
 *
 * `term-pane.js` 는 `e2e/reconnect-storm.spec.ts` 가 **빈 페이지에 홀로 싣는다.**
 * 그 격리가 그 검사의 값이므로(M6 "비싸게 배운 것" 4), 터미널이 `FileTree` 의
 * `static` 을 부르게 하면 그 하네스가 `file-tree*.js` 넉 장을 싣게 된다.
 *
 * 그래서 이 파일은 **의존이 0** 이다 — 상수도 참조하지 않는다. 상한은 부르는
 * 쪽이 인자로 준다 (FR-TFD-3).
 */

/**
 * M9_SRS FR-M9-30: **이 드래그가 파일·폴더인가.**
 *
 * `dragover` 와 `drop` 이 **같은 문장**으로 답해야 한다. 둘이 갈리면 한쪽이
 * 삼킨 드롭을 다른 쪽이 기다리게 되고, 그 차이는 화면에서 "아무 일도 안
 * 일어난다" 로만 보인다 — 접수한 결함이 그것이다 (드래그드랍 분할, 2026-09-14).
 *
 * **`items` 나 `files` 의 유무로 묻지 않는다.** 탭 드래그에도 `items` 가 실리는
 * 판이 있고, 그때 터미널이 그 드롭을 파일 드롭으로 오인해 `stopPropagation()`
 * 했다. 파일·폴더는 `types` 에 `Files` 를 싣는 것이 규약이며, 폴더 드롭도 그렇다.
 *
 * 여기 있는 이유는 `dropEntries` 와 같다 — 부르는 자리가 터미널과 탐색기 둘이고,
 * 이 파일은 의존이 0 이라 어느 쪽 하네스에도 짐이 되지 않는다.
 */
function isFileDrag(e){
  const t=e&&e.dataTransfer&&e.dataTransfer.types;
  return !!t&&[...t].includes('Files');
}

/**
 * FR-EDT-21: 드롭된 최상위 entry 들. **동기적으로** 꺼낸다 — `dataTransfer` 의
 * `items` 는 이벤트 핸들러가 끝나면 비워지므로, 재귀(비동기) 안에서 꺼내면
 * 아무것도 없다.
 *
 * `webkitGetAsEntry` 가 없는 브라우저에서는 null 이고, 그때는 `files` 로
 * 폴백한다 — 폴더는 못 올리지만 파일은 올라간다.
 */
function dropEntries(e){
  const items=(e&&e.dataTransfer&&e.dataTransfer.items)||null;
  if(!items||!items.length) return null;
  const out=[];
  // `DataTransferItemList` 는 배열이 아니다 — 인덱스로 읽는다.
  for(let i=0;i<items.length;i++){
    const it=items[i];
    if(!it||it.kind!=='file'||typeof it.webkitGetAsEntry!=='function') continue;
    const en=it.webkitGetAsEntry();
    if(en) out.push(en);
  }
  return out.length?out:null;
}

/**
 * entry 하나를 걷는다. 파일이면 담고 디렉터리면 그 안으로 내려간다.
 * 상한을 넘으면 `false` 를 돌려 **걷기 자체를 멈춘다** (FR-ETR-22) — 홈 폴더를
 * 잘못 놓았을 때 브라우저가 멎지 않아야 한다.
 *
 * `readEntries` 는 한 번에 전부 주지 않는다. 빈 배열이 올 때까지 되풀이해야
 * 하며, 그러지 않으면 항목이 100개쯤에서 잘린다 (Chrome 의 실제 동작이다).
 */
async function walkDropEntry(en,prefix,out,max){
  if(!en) return true;
  if(out.length>=max) return false;
  const rel=prefix?prefix+'/'+en.name:en.name;
  if(en.isFile){
    const f=await new Promise(res=>en.file(res,()=>res(null)));
    // 읽지 못한 항목은 건너뛴다. 드롭한 것 중 하나를 못 읽었다고 나머지를
    // 버리지 않는다 — 실패는 업로드 단계에서 사용자에게 묻는다 (FR-ETR-26).
    if(f) out.push({file:f,relPath:rel});
    return true;
  }
  if(!en.isDirectory) return true;
  const reader=en.createReader();
  for(;;){
    const batch=await new Promise(res=>reader.readEntries(res,()=>res([])));
    if(!batch||!batch.length) return true;
    for(const child of batch){
      if(await walkDropEntry(child,rel,out,max)===false) return false;
    }
  }
}

/**
 * 드롭 하나를 통째로 편다 (FR-TFD-1). `null` 이면 entry API 가 없다는 뜻이고,
 * 부르는 쪽은 `dataTransfer.files` 로 내려간다.
 *
 * 상한을 넘으면 `{over:true}` 다 — **하나도 올리지 않는다** (FR-TFD-14).
 * 절반만 올라간 폴더는 되돌릴 길이 없다.
 */
async function walkDrop(e,max){
  const ens=dropEntries(e);
  if(!ens) return null;
  const items=[];
  for(const en of ens){
    if(await walkDropEntry(en,'',items,max)===false) return {over:true,items:[]};
  }
  return {over:false,items};
}
