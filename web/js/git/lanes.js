/**
 * Dongminal — Git 히스토리 그래프의 레인 배치 (GIT_SRS §3C, FR-GIT-117~121)
 *
 * 위→아래로 그리는 DAG 의 레인 배치. 입력 순서 그대로 **단일 전방 패스**다
 * (FR-GIT-117). 부모 목록이 유일한 입력이고, 커밋 시각·정렬은 보지 않는다 —
 * 정렬은 이미 서버(`git log --*-order`)가 정한 것으로 받는다.
 *
 * activeLanes[i] 는 레인 i 가 예약된 부모 해시(또는 null)다.
 *   - 커밋의 레인 = 자기 해시로 예약된 레인, 없으면 첫 빈 레인
 *   - 첫 부모가 커밋의 레인을 물려받고, 나머지 부모는 새 빈 레인을 잡는다
 *   - 이미 다른 곳에 예약된 부모는 머지 진입선만 만든다
 *   - 통과 레인 = 이 행 처리 전후로 모두 살아 있던 레인
 *
 * isNewHead 는 어느 자식도 이 커밋의 레인을 예약하지 않았다는 뜻이다 — 위쪽
 * 진입선을 그리지 않는다 (FR-GIT-121).
 */

// commits: [{hash, parents:[hash]}] → {rows:[…], maxLanes}
function buildLaneGraph(commits){
  const rows=[];
  const activeLanes=[];
  let maxLanes=0;

  for(const commit of commits){
    const beforeNonNull=activeLanes.map(h=>h!==null);

    let myLane=activeLanes.indexOf(commit.hash);
    let isNewHead;
    if(myLane===-1){
      isNewHead=true;
      myLane=activeLanes.findIndex(h=>h===null);
      if(myLane===-1){
        myLane=activeLanes.length;
        activeLanes.push(null);
      }
    }else{
      isNewHead=false;
    }

    // 자기 레인의 예약을 먼저 푼다 — 곧 부모에게 다시 배정한다. 부모가 0개인
    // 루트 커밋에서는 이대로 비어 레인이 해제된다.
    activeLanes[myLane]=null;

    const parentLanes=[];
    for(let i=0;i<commit.parents.length;i++){
      const parentHash=commit.parents[i];
      // 다른 레인이 이미 이 부모를 예약했으면 새 레인을 만들지 않는다 —
      // 같은 커밋이 두 레인에 그려지면 그래프가 갈라져 보인다.
      const existingLane=activeLanes.indexOf(parentHash);
      if(existingLane!==-1){
        parentLanes.push(existingLane);
        continue;
      }
      if(i===0){
        activeLanes[myLane]=parentHash;
        parentLanes.push(myLane);
      }else{
        let freshLane=activeLanes.findIndex(h=>h===null);
        if(freshLane===-1){
          freshLane=activeLanes.length;
          activeLanes.push(parentHash);
        }else{
          activeLanes[freshLane]=parentHash;
        }
        parentLanes.push(freshLane);
      }
    }

    const afterNonNull=activeLanes.map(h=>h!==null);

    // 통과 레인: 이 행 전후로 모두 살아 있고 자기 레인이 아닌 것. 이 행에서
    // 시작하거나 끝나는 레인은 점·부모선이 이미 그리므로 제외한다.
    const passThrough=[];
    const maxLen=Math.max(beforeNonNull.length,afterNonNull.length);
    for(let i=0;i<maxLen;i++){
      if(i===myLane) continue;
      if(beforeNonNull[i]===true&&afterNonNull[i]===true) passThrough.push(i);
    }

    const laneCount=Math.max(beforeNonNull.length,afterNonNull.length,myLane+1);
    if(laneCount>maxLanes) maxLanes=laneCount;

    rows.push({hash:commit.hash,lane:myLane,passThrough,parentLanes,isNewHead,laneCount});

    // 뒤쪽 빈 레인을 잘라 다음 행이 낮은 인덱스를 재사용하게 한다 — 이것이
    // 없으면 레인 수가 단조 증가해 폭이 계속 늘어난다.
    while(activeLanes.length>0&&activeLanes[activeLanes.length-1]===null) activeLanes.pop();
  }

  return {rows,maxLanes};
}

/**
 * 상한을 넘는 레인을 압축한다 (FR-GIT-120). 상한 이상의 인덱스를 상한-1 로
 * 접고, 접힘이 실제로 일어난 행에만 compressed 를 세운다.
 *
 * 접은 뒤 passThrough·parentLanes 는 중복을 제거하고 오름차순으로 정렬한다 —
 * 같은 인덱스를 두 번 그리면 선이 겹쳐 굵어 보인다.
 *
 * graph 를 제자리에서 고치지 않고 새 객체를 반환한다. 원본 배치가 남아 있어야
 * 상한을 바꿔(데스크톱 20 ↔ 모바일 10) 다시 접을 수 있다. 이미 접힌 그래프를
 * 다시 넣어도 compressed 는 유지된다 — 두 번째 호출에는 상한을 넘는 인덱스가
 * 남아 있지 않으므로, 표식을 다시 계산하면 압축 사실이 사라진다.
 */
function clampLanes(graph,max){
  const lim=max-1;
  const fold=arr=>{
    const out=[];
    for(const i of arr){const v=Math.min(i,lim); if(!out.includes(v)) out.push(v)}
    return out.sort((a,b)=>a-b);
  };
  const rows=graph.rows.map(r=>{
    const folded=r.lane>=max||r.passThrough.some(i=>i>=max)||r.parentLanes.some(i=>i>=max);
    return {
      hash:r.hash,
      lane:Math.min(r.lane,lim),
      passThrough:fold(r.passThrough),
      parentLanes:fold(r.parentLanes),
      isNewHead:r.isNewHead,
      laneCount:Math.min(r.laneCount,max),
      compressed:folded||r.compressed===true,
    };
  });
  return {rows,maxLanes:Math.min(graph.maxLanes,max)};
}
