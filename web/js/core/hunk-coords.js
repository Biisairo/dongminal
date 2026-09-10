// @ts-check
/**
 * Remote Terminal — 서버 hunk 좌표의 클라이언트 측 사상
 * (DIFF_HUNK_BAR_SRS D-2 · EDITOR_DIRTY_DIFF_SRS FR-EDD-46)
 *
 * 화면이 고른 줄을 서버가 아는 좌표 `(hunk 번호, 덩어리 본문 안의 줄 범위)` 로
 * 옮긴다. **패치를 만들지 않는다** — 패치는 서버가 만들고(GIT_ACTIONS_SRS D6)
 * 여기서 나가는 것은 숫자 넷뿐이다.
 *
 * `core` 에 사는 이유는 부르는 쪽이 둘이기 때문이다 — 편집기의 변경 표시
 * (`ui/file-editor-diff.js`)와 Diff 탭의 hover 툴바(`git/panel-diff.js`). 어느
 * 한쪽에 두면 다른 쪽이 남의 내부를 딛고, 두 벌을 만들면 좌표 규약이 갈린다.
 *
 * 서버가 정한 규약이 둘 있고 이 파일 전체가 그 위에 선다
 * (`domain/git/write/patch.go:169~218`):
 *
 *   ① `from`·`to` 는 `hunk.lines` 의 **1-기반 인덱스**이며 둘 다 0 이면 덩어리 전체다
 *   ② **문맥 줄은 선택 여부와 무관하게 언제나 남는다** — 범위에 섞여도 결과가
 *      같으므로, 좁히지 못한 경계가 조용히 다른 줄을 고치는 일은 없다
 */

// unified diff 한 줄의 첫 글자. 서버가 `git diff` 의 출력을 그대로 싣는다.
const GIT_HUNK_ADD_MARK='+';
const GIT_HUNK_DEL_MARK='-';
const GIT_HUNK_CTX_MARK=' ';
// `\ No newline at end of file` — 줄이 아니라 **앞 줄에 딸린 표식**이다.
const GIT_HUNK_NONL_MARK='\\';

/**
 * 덩어리 본문에 줄 번호를 매긴다. 새 쪽과 옛 쪽을 함께 세는 이유는 삭제 줄이
 * 새 쪽에 없고 추가 줄이 옛 쪽에 없기 때문이다 — 한쪽만 세면 그 절반을 가리킬
 * 방법이 없다.
 *
 * 돌려주는 것은 `[{i,mark,newLine,oldLine}]` 이며 `i` 가 곧 서버에 보낼 좌표다.
 * 해당 쪽에 자리가 없는 줄의 번호는 0 이다.
 */
function gitHunkScan(hunk){
  const lines=(hunk&&hunk.lines)||[];
  const out=[];
  let nl=(hunk&&hunk.newStart)||1;
  let ol=(hunk&&hunk.oldStart)||1;
  for(let i=0;i<lines.length;i++){
    const l=lines[i]||'',mark=l.charAt(0),idx=i+1;
    if(mark===GIT_HUNK_NONL_MARK){out.push({i:idx,mark,newLine:0,oldLine:0});continue}
    if(mark===GIT_HUNK_ADD_MARK){out.push({i:idx,mark,newLine:nl++,oldLine:0});continue}
    if(mark===GIT_HUNK_DEL_MARK){out.push({i:idx,mark,newLine:0,oldLine:ol++});continue}
    out.push({i:idx,mark:GIT_HUNK_CTX_MARK,newLine:nl++,oldLine:ol++});
  }
  return out;
}

/**
 * 조각(새 줄 범위 **와** 옛 줄 범위를 아는 쪽)의 좌표 범위.
 *
 * 편집기가 부른다 — 그쪽은 기준 내용을 갖고 있으므로 지워진 줄이 기준의 어디였는지
 * 안다 (EDITOR_DIRTY_DIFF_SRS FR-EDD-46).
 */
function gitHunkRangeForChange(hunk,ch){
  if(!ch) return null;
  const nFrom=ch.line,nTo=ch.count?ch.line+ch.count-1:-1;
  const oFrom=ch.baseStart,oTo=ch.baseCount?ch.baseStart+ch.baseCount-1:-1;
  let from=0,to=0;
  for(const r of gitHunkScan(hunk)){
    // 표식은 앞 줄을 골랐을 때만 함께 간다 — 남기면 없는 줄에 대한 표식이 된다.
    if(r.mark===GIT_HUNK_NONL_MARK){if(to===r.i-1) to=r.i;continue}
    const hit=(r.mark===GIT_HUNK_ADD_MARK&&nTo>=0&&r.newLine>=nFrom&&r.newLine<=nTo)
      ||(r.mark===GIT_HUNK_DEL_MARK&&oTo>=0&&r.oldLine>=oFrom&&r.oldLine<=oTo);
    if(hit){if(!from) from=r.i;to=r.i}
  }
  return from?[from,to]:null;
}

/**
 * 선택된 **새 쪽 줄 범위**만으로 좌표 범위를 낸다 (DIFF_HUNK_BAR_SRS FR-DHB-33).
 *
 * Diff 탭이 부른다 — Monaco 의 텍스트 선택은 모디파이드 쪽 줄 번호만 준다.
 *
 * **수정 짝은 함께 간다.** `+` 줄 하나만 골라 보내면 그 짝인 `-` 가 문맥으로 바뀌어
 * (서버 `patchBody` 의 규약, §2.4) 옛 줄과 새 줄이 **둘 다** 남는다 — 사용자가
 * 고른 것은 "이 줄을 이렇게 바꾼다" 이지 "이 줄을 더한다" 가 아니다. 그래서 연속한
 * `-`/`+` 를 한 **변경 블록**으로 묶고 블록 단위로 넣는다.
 *
 * 삭제만 있는 블록은 새 쪽에 줄이 없어 선택으로 닿을 수 없다 (FR-DHB-35) — 그
 * 블록은 덩어리 전체 동작의 몫이다.
 */
function gitHunkRangeForLines(hunk,sLine,eLine){
  const s=Math.min(sLine,eLine),e=Math.max(sLine,eLine);
  let from=0,to=0;
  // 블록 하나: 본문 인덱스 범위와 그 블록이 차지하는 새 줄 범위.
  let bFrom=0,bTo=0,bLo=0,bHi=0;
  const flush=()=>{
    if(bFrom&&bLo&&bLo<=e&&bHi>=s){if(!from) from=bFrom;to=bTo}
    bFrom=0;bTo=0;bLo=0;bHi=0;
  };
  for(const r of gitHunkScan(hunk)){
    if(r.mark===GIT_HUNK_CTX_MARK){flush();continue}
    if(r.mark===GIT_HUNK_NONL_MARK){if(bFrom) bTo=r.i;continue}
    if(!bFrom) bFrom=r.i;
    bTo=r.i;
    if(r.mark===GIT_HUNK_ADD_MARK){
      if(!bLo||r.newLine<bLo) bLo=r.newLine;
      if(r.newLine>bHi) bHi=r.newLine;
    }
  }
  flush();
  return from?[from,to]:null;
}

/**
 * 조각 → `{hunk,from,to,wide}`. `wide:true` 는 **경계를 좁히지 못해 덩어리 전체**를
 * 가리킨다는 뜻이고, `null` 은 겹치는 덩어리가 없다 — 관측이 낡았으므로 다시
 * 받아야 한다.
 */
function gitHunkCoordsForChange(hunks,ch){
  if(!ch) return null;
  const from=ch.line,to=ch.count?ch.line+ch.count-1:ch.line;
  for(const h of hunks||[]){
    const hs=h.newStart,he=h.newStart+Math.max(h.newLines,1)-1;
    // 삭제 조각은 새 쪽에 줄이 없다 — 덩어리의 경계 한 줄 밖까지 자기 자리로 본다.
    const hit=ch.count?(from<=he&&to>=hs):(from>=hs-1&&from<=he+1);
    if(!hit) continue;
    const r=gitHunkRangeForChange(h,ch);
    return r?{hunk:h.index,from:r[0],to:r[1],wide:false}
            :{hunk:h.index,from:0,to:0,wide:true};
  }
  return null;
}

/**
 * 그 새 쪽 줄을 담는 덩어리 (FR-DHB-11). 문맥 줄도 그 덩어리의 것이다 — 사용자가
 * 보는 조각의 범위가 그것이다.
 *
 * `newLines` 가 0 인 덩어리(새 쪽이 통째로 비었다)는 `newStart` 한 줄로 본다.
 */
function gitHunkAt(hunks,line){
  for(const h of hunks||[]){
    const s=h.newStart,e=h.newStart+Math.max(h.newLines,1)-1;
    if(line>=s&&line<=e) return h;
  }
  return null;
}
