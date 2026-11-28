/**
 * 대화 그리기의 순수 판정 (ISSUE_TREE_CHAT_SRS FR-CUX-1·2·6·7).
 *
 * 글 하나를 앞 글과 견주어 날짜 구분선과 묶음 머리를 둘지 정하고, 부른 상대를 `@이름` 으로 적는다.
 * `chat` 화면 묶음이다. `chat-views.js` 가 부른다.
 */

/** `call` 에서 방의 모든 사람을 뜻하는 항목 (데몬 `CALL_USER`). */
const CHAT_CALL_USER='user';

function chatDayKey(ms){
  const d=new Date(ms||0);
  return d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate();
}

function chatDayLabel(ms){
  return new Date(ms||0).toLocaleDateString(I18N.locale,{year:'numeric',month:'long',day:'numeric',weekday:'short'});
}

/** 알림 단계의 이름. 비면 기본값(called, §10 A-1)이다. */
function chatNotifyLabel(level){
  return t(level==='all'?'chat.notify_all':level==='off'?'chat.notify_off':'chat.notify_called');
}

/** 참가자를 노드별로 묶는다 (FR-CUX-12). 내 노드가 먼저, 다른 노드는 이름 차례다. 묶음 안에서는 사람이 먼저다. */
function chatPeopleGroups(people,meId){
  const nodeOf=p=>p.node||chatNodeOf(p.id);
  const mine=chatNodeOf(meId);
  const groups=new Map();
  for(const p of people||[]){
    const k=nodeOf(p);
    if(!groups.has(k)) groups.set(k,{node:k,name:String(p.label||'').split('/')[0],people:[]});
    groups.get(k).people.push(p);
  }
  const name=p=>chatName(p.label,p.id,meId);
  for(const g of groups.values()) g.people.sort((a,b)=>(a.kind==='user'?0:1)-(b.kind==='user'?0:1)||name(a).localeCompare(name(b)));
  return [...groups.values()].sort((a,b)=>(a.node===mine?0:1)-(b.node===mine?0:1)||a.name.localeCompare(b.name));
}

/** 참가자 행의 부제 `<종류> · <상태> · 알림: <단계>`. 상태는 내 노드의 에이전트만, 단계는 아는 것만 적는다 (FR-CUX-12, 결정 I-10). */
function chatPersonSub(p,meId,activity){
  const parts=[t(p.kind==='user'?'chat.human':'chat.agent')];
  const local=chatNodeOf(p.id)===chatNodeOf(meId);
  const st=local&&p.kind!=='user'&&p.tool&&activity&&activity.get(p.tool);
  if(st&&AGENT_STATE_LABEL[st.state]) parts.push(AGENT_STATE_LABEL[st.state]);
  if(p.notify) parts.push(t('chat.notify_is',{level:chatNotifyLabel(p.notify)}));
  return parts.join(' · ');
}

/** 방 머리 셋째 줄의 글 — 만든 이 · 참가자 수 (FR-CUX-11). 내 알림 단계는 그 옆의 단추다. */
function chatRoomMeta(r,meId){
  const n=t('chat.members',{n:r.members||0});
  return r.creator||r.creatorName?t('chat.made_by',{name:chatName(r.creatorName,r.creator,meId)})+' · '+n:n;
}

/** 참가자의 색 변수. 나는 `--chat-me`, 그 밖은 id 로 고른 에이전트 칸이다 (FR-CUX-10). */
function chatColorVar(id,meId){
  if(id&&id===meId) return '--chat-me';
  let h=2166136261;
  for(const ch of String(id||'')){ h^=ch.codePointAt(0); h=Math.imul(h,16777619) }
  return '--chat-a'+((h>>>0)%CHAT_AGENT_COLORS);
}

/** 동그라미의 머리글자 — 이름의 첫 글자(문자 단위)다. */
function chatInitial(label){
  const c=[...String(label||'').trim()][0];
  return c?c.toUpperCase():'?';
}

/** 앞 글 prev 뒤에 m 을 놓을 때 날짜 구분선(day)과 묶음 머리(head)가 필요한가. */
function chatMsgPlace(prev,m){
  const day=!prev||chatDayKey(prev.at)!==chatDayKey(m.at);
  const head=day||prev.from!==m.from||(m.at||0)-(prev.at||0)>CHAT_GROUP_GAP_MS;
  return {day,head};
}

/** 글이 부른 상대의 표시. 나를 부른 글은 `@나` 가 먼저이고, 다른 상대는 방의 표시 이름이다. */
function chatCallTags(m,meId,people){
  const tags=m.called?['@'+t('chat.me')]:[];
  for(const id of m.call||[]){
    if(id===meId) continue;
    if(id===CHAT_CALL_USER){ if(!m.called) tags.push('@'+t('chat.human')); continue }
    const p=(people||[]).find(x=>x.id===id);
    tags.push('@'+(p?chatName(p.label,id,meId):chatShortId(id)));
  }
  return tags;
}

/**
 * 대화칸 맨 위에 걸친 글과 그 글 안의 거리 (CHAT_TELEGRAM_UX_SRS FR-CTU-3).
 * `boxOf(i)` 는 글 i 의 `[위, 아래]` 이고 차례로 늘어난다. 아래변이 `scrollTop` 보다 아래인 첫 글을 고른다.
 */
function chatAnchorAt(n,boxOf,scrollTop){
  if(!n) return null;
  let lo=0,hi=n-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(boxOf(mid)[1]>scrollTop) hi=mid; else lo=mid+1;
  }
  return {idx:lo,offset:scrollTop-boxOf(lo)[0]};
}

/** 되돌릴 `scrollTop`. 자리가 없으면 null(맨 아래), 적힌 글이 버려졌으면 0(맨 위)이다 (FR-CTU-4·6·7). */
function chatResumeTop(list,mark,topOf){
  if(!mark) return null;
  const i=list.indexOf(mark.msg);
  return i<0?0:topOf(i)+mark.offset;
}

/** 입력칸의 높이 (CHAT_TELEGRAM_UX_SRS FR-CTU-60). 내용 높이를 아래 한계와 탭 높이의 반 사이로 자른다. 아래 한계가 이긴다. */
function chatInputHeight(content,min,viewHeight){
  return Math.max(min,Math.min(content,Math.floor(viewHeight/2)));
}
