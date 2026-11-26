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
    tags.push('@'+(p?p.label:chatShortId(id)));
  }
  return tags;
}
