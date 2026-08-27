/**
 * Dongminal — Git 히스토리 그래프의 레인 배치
 * (GIT_SRS §3C / FR-GIT-117~121, GIT_REVIEW4_SRS §3.3 / FR-GIT-228~234)
 *
 * **VSCode Git Graph 의 배치 알고리즘을 따른다** (`mhutchie/vscode-git-graph`
 * `web/graph.ts` 의 `determinePaths`·`determinePath`·`Vertex`·`Branch`).
 * 근거와 규칙 R1~R4 는 GIT_REVIEW4_SRS §2.3.1 에 적었다. 요지는 넷이다.
 *
 *   R1  **행마다 열을 왼쪽부터 촘촘히 나눠 준다.** 갈래를 머리 행 순서로 처리하고,
 *       각 갈래가 지나는 행에서 "아직 안 쓰인 가장 왼쪽 열"을 집는다 (`nextX`).
 *       그래서 빈 열이 없고, 앞 갈래가 끝나면 뒤 선이 그 자리로 당겨진다.
 *   R2  커밋 **점**의 열은 한 번 정해지면 고정이다 (`addToBranch` 의
 *       `if(onBranch===null)`). 통과선은 행마다 다음 빈 열을 받으므로 열이 비면
 *       왼쪽으로 휜다 — 그 이동은 그 행 안에서 곡선으로 이어 그린다.
 *   R3  갈래는 **first-parent 사슬을 끝까지 걸어가며** 한 덩어리로 잡는다. 그래서
 *       트렁크는 자기 색을 뿌리까지 유지한다. 색은 재사용되는 슬롯 번호이며 갈래가
 *       사는 동안 바뀌지 않는다 (`getAvailableColour`).
 *   R4  머지가 **이미 배치된** 부모로 갈 때는 새 갈래·새 색을 만들지 않고 그 부모의
 *       갈래로 붙는다.
 *
 * ── 무엇이 나오는가 ──
 *
 * 행 r 의 상자는 위 경계에서 아래 경계까지이고 점은 그 중간에 있다. 한 선의 위 끝은
 * 행 r 에서의 열, 아래 끝은 행 r+1 에서의 열이다 — 그래서 행 r 의 아래 끝이 곧 행
 * r+1 의 위 끝이고 **선이 끊기지 않는다** (FR-GIT-229). 커밋의 진입선은 위 끝과
 * 점이 같은 열이라 늘 곧게 내려온다.
 *
 * 행의 모양:
 *   {hash, lane, color, passThrough:[{top,bottom,color}], parentLanes:[{col,color}],
 *    isNewHead, laneCount, compressed?}
 *
 * `passThrough` 는 이 행을 지나가는 선, `parentLanes` 는 이 행의 점에서 내려가는
 * 선이다. 점의 열은 그 행에서 점 자신이 집은 것이므로, 점의 열에서 시작하는 선은
 * 그 점의 것뿐이다 — 그것으로 둘을 가른다.
 *
 * isNewHead 는 어느 자식도 이 커밋을 예약하지 않았다는 뜻이다(자기가 갈래를
 * 시작했다) — 위쪽 진입선을 그리지 않는다 (FR-GIT-121).
 */

// commits: [{hash, parents:[hash]}] → {rows:[…], maxLanes}
function buildLaneGraph(commits){
  const n=commits.length;
  if(!n) return {rows:[],maxLanes:0};

  const rowOf=new Map();
  for(let i=0;i<n;i++) rowOf.set(commits[i].hash,i);
  /**
   * 부모를 행 번호로 바꾼다. 로드된 창 밖의 부모는 **n**(목록 아래)이다 — 그쪽으로
   * 가는 선은 목록 끝까지 내려가고 거기서 멈춘다. 자기보다 위에 있는 부모도 n 으로
   * 둔다: 위상 정렬이 깨진 입력에서 걸음이 되돌아 돌지 않게 하는 바닥이다.
   */
  const parentRows=commits.map((c,i)=>(c.parents||[]).map(h=>{
    const r=rowOf.has(h)?rowOf.get(h):n;
    return (r>i&&r<n)?r:n;
  }));

  const branchOf=new Array(n).fill(-1);   // 커밋 → 갈래 id
  const dotCol=new Array(n).fill(0);      // 커밋 점의 열 (R2: 한 번 정하면 고정)
  const isNewHead=new Array(n).fill(false);
  const done=new Array(n).fill(0);        // 처리한 부모 수
  const branchColor=[];                   // 갈래 id → 색 키
  const colorEnd=[];                      // 색 키 → 그 색을 쓰던 갈래가 끝난 행

  // 행마다 "다음 빈 열"과 이미 나간 자리. n 번째는 목록 아래의 가상 경계다.
  const nextX=new Array(n+1).fill(0);
  const taken=[]; for(let r=0;r<=n;r++) taken.push(new Map());
  // gaps[r] = 행 r 과 r+1 사이를 지나는 선들
  const gaps=[]; for(let r=0;r<=n;r++) gaps.push([]);

  /**
   * R1: 행 r 에서 열 하나를 집는다.
   *
   * 자리는 **(향하는 부모, 갈래)** 로 구분한다 — 같은 부모를 향하는 같은 갈래의 선은
   * 한 행에서 자리를 하나만 쓴다. 그래서 여러 머지가 같은 부모로 갈 때 선이 겹쳐
   * 그려지지 않고 하나로 합쳐진다 (Git Graph 의 `getPointConnectingTo`).
   */
  const slot=(target,br)=>target+' '+br;
  function take(r,target,br){
    const k=slot(target,br);
    const had=taken[r].get(k);
    if(had!==undefined) return had;
    const c=nextX[r]++;
    taken[r].set(k,c);
    return c;
  }
  function heldAt(r,target,br){ return taken[r].get(slot(target,br)) }

  // R3: 색은 재사용되는 슬롯이다. 앞 갈래가 **끝난 뒤에야** 그 색을 다시 쓴다.
  function availColor(start){
    for(let i=0;i<colorEnd.length;i++) if(start>colorEnd[i]) return i;
    colorEnd.push(0);
    return colorEnd.length-1;
  }

  /**
   * R4: 머지가 이미 배치된 부모로 가는 선. 새 갈래·새 색을 만들지 않고 그 부모의
   * 갈래 자리를 따라 내려가 붙는다. 부모 행에서는 그 점이 이미 잡아 둔 자리를 다시
   * 쓰므로 선이 정확히 점에 닿는다.
   */
  function connect(start,pRow){
    const br=branchOf[pRow], color=branchColor[br];
    let last=dotCol[start];
    for(let r=start+1;r<=n;r++){
      const had=heldAt(r,pRow,br);
      const col=had!==undefined?had:take(r,pRow,br);
      gaps[r-1].push({top:last,bottom:col,color});
      last=col;
      // 자리가 이미 있었다는 것은 그 갈래의 선을 만났다는 뜻이다 — 거기서 합친다.
      if(had!==undefined||r>=n){done[start]++;return}
    }
  }

  /**
   * 갈래 하나를 걸어 내려간다. first-parent 를 만나면 그 커밋을 이 갈래에 넣고
   * 계속 걷는다 (R3) — 이미 다른 갈래에 있으면 거기서 멈춘다.
   */
  function follow(start){
    const br=branchColor.length;
    const color=availColor(start);
    branchColor.push(color);

    let v=start;
    let last;
    if(branchOf[start]===-1){
      // 아무 자식도 예약하지 않았다 — 이 커밋이 갈래를 시작한다 (FR-GIT-121).
      isNewHead[start]=true;
      const c=take(start,start,br);
      branchOf[start]=br; dotCol[start]=c;
      last=c;
    }else{
      // 머지의 두 번째 부모를 향해 새 갈래가 이 점에서 갈라져 나간다.
      last=dotCol[start];
    }
    let target=done[v]<parentRows[v].length?parentRows[v][done[v]]:-1;
    /**
     * 부모가 없으면 갈래는 이 행에서 끝난다 — 선을 아래로 내리지 않는다.
     *
     * Git Graph 는 이 경우에도 목록 끝까지 걸어가며 선을 그린다(`parentVertex`
     * 가 null 인데 루프가 `for(i=startAt+1;i<n;i++)` 를 그대로 돈다). 뿌리 커밋은
     * 보통 마지막 행이라 그 코드가 실제로 도는 일이 없어 드러나지 않는 것이고,
     * `--all` 에서 뿌리가 중간에 오면 **아무 데도 닿지 않는 선이 아래로 늘어진다.**
     * 그것은 따르지 않는다.
     */
    if(target<0){colorEnd[color]=start; return}
    let end=n;

    for(let r=start+1;r<=n;r++){
      if(r>=n){
        // 목록 아래로 이어지는 선이다. 아래 경계까지 그려 "여기서 끝이 아니다" 를
        // 보이고, 부모를 처리한 것으로 표시해 걸음이 다시 돌지 않게 한다.
        if(target>=0){
          const col=take(n,target,br);
          gaps[n-1].push({top:last,bottom:col,color});
          done[v]++;
        }
        end=n;
        break;
      }
      let col;
      const atTarget=r===target;
      if(atTarget&&branchOf[r]!==-1){
        col=dotCol[r];                       // 이미 배치된 부모 — 그 점에 붙는다
      }else if(atTarget){
        col=take(r,r,br);                    // 이 갈래가 부모를 데려간다
        branchOf[r]=br; dotCol[r]=col;
      }else{
        col=take(r,target,br);               // 지나가는 자리
      }
      gaps[r-1].push({top:last,bottom:col,color});
      last=col;

      if(atTarget){
        const parentWasPlaced=branchOf[r]!==br;
        done[v]++;
        v=r;
        target=done[v]<parentRows[v].length?parentRows[v][done[v]]:-1;
        if(target<0||parentWasPlaced){end=r;break}
      }
    }
    colorEnd[color]=end;
  }

  /**
   * 드라이버 (Git Graph 의 `determinePaths`). 부모가 남았거나 아직 갈래가 없는
   * 정점에서 걸음을 시작한다. **같은 정점을 여러 번 부른다** — 머지의 부모마다
   * 한 번이다. 걸음마다 갈래를 배정하거나 부모 하나를 처리하므로 멈춘다.
   */
  let i=0;
  while(i<n){
    if(done[i]<parentRows[i].length||branchOf[i]===-1){
      const pIdx=done[i];
      const pRow=pIdx<parentRows[i].length?parentRows[i][pIdx]:-1;
      if(pRow>=0&&pRow<n&&parentRows[i].length>1&&branchOf[i]!==-1&&branchOf[pRow]!==-1)
        connect(i,pRow);
      else
        follow(i);
    }else i++;
  }

  const rows=[];
  let maxLanes=0;
  for(let r=0;r<n;r++){
    const passThrough=[],parentLanes=[];
    for(const s of gaps[r]){
      // 점의 열은 점 자신이 집은 것이다 — 거기서 시작하는 선은 그 점의 것뿐이다.
      if(s.top===dotCol[r]) parentLanes.push({col:s.bottom,color:s.color});
      else passThrough.push({top:s.top,bottom:s.bottom,color:s.color});
    }
    passThrough.sort((a,b)=>a.top-b.top||a.bottom-b.bottom);
    parentLanes.sort((a,b)=>a.col-b.col);
    // 행의 폭은 위·아래 경계를 모두 담아야 한다 — 아래가 더 넓은 행에서 선이
    // 잘리면 그래프가 조용히 틀려 보인다.
    const laneCount=Math.max(nextX[r],nextX[r+1]);
    if(laneCount>maxLanes) maxLanes=laneCount;
    rows.push({hash:commits[r].hash,lane:dotCol[r],
               color:branchColor[branchOf[r]]||0,
               passThrough,parentLanes,isNewHead:isNewHead[r],laneCount});
  }
  return {rows,maxLanes};
}

/**
 * 상한을 넘는 열을 접는다 (FR-GIT-120). 상한 이상의 열을 상한-1 로 접고, 접힘이
 * 실제로 일어난 행에만 compressed 를 세운다.
 *
 * 접은 뒤 passThrough·parentLanes 는 중복을 없애고 오름차순으로 정렬한다 — 같은
 * 자리를 두 번 그리면 선이 겹쳐 굵어 보인다. 색 키는 **먼저 온 것을 남긴다**:
 * 접힌 자리에 여러 갈래가 겹치므로 어느 색이든 하나여야 한다.
 *
 * graph 를 제자리에서 고치지 않고 새 객체를 반환한다. 원본 배치가 남아 있어야
 * 상한을 바꿔(데스크톱 20 ↔ 모바일 10) 다시 접을 수 있다. 이미 접힌 그래프를
 * 다시 넣어도 compressed 는 유지된다 — 두 번째 호출에는 상한을 넘는 열이 남아
 * 있지 않으므로, 표식을 다시 계산하면 압축 사실이 사라진다.
 */
function clampLanes(graph,max){
  const lim=max-1;
  const foldPass=arr=>{
    const out=[],seen=new Set();
    for(const s of arr){
      const t=Math.min(s.top,lim),b=Math.min(s.bottom,lim);
      const k=t+':'+b;
      if(seen.has(k)) continue;
      seen.add(k);
      out.push({top:t,bottom:b,color:s.color});
    }
    return out.sort((a,b)=>a.top-b.top||a.bottom-b.bottom);
  };
  const foldPar=arr=>{
    const out=[],seen=new Set();
    for(const s of arr){
      const c=Math.min(s.col,lim);
      if(seen.has(c)) continue;
      seen.add(c);
      out.push({col:c,color:s.color});
    }
    return out.sort((a,b)=>a.col-b.col);
  };
  const rows=graph.rows.map(r=>{
    const folded=r.lane>=max
      ||r.passThrough.some(s=>s.top>=max||s.bottom>=max)
      ||r.parentLanes.some(s=>s.col>=max);
    return {
      hash:r.hash,
      lane:Math.min(r.lane,lim),
      color:r.color,
      passThrough:foldPass(r.passThrough),
      parentLanes:foldPar(r.parentLanes),
      isNewHead:r.isNewHead,
      laneCount:Math.min(r.laneCount,max),
      compressed:folded||r.compressed===true,
    };
  });
  return {rows,maxLanes:Math.min(graph.maxLanes,max)};
}
