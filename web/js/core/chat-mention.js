/**
 * 입력칸의 `@` 자동완성과 답장 (ISSUE_TREE_CHAT_SRS FR-CUX-13).
 *
 * 본문에 적힌 `@<표시 이름>` 이 곧 부른 상대다. 보낼 때 `chatCallsIn` 이 그것을 참가자 id 로 바꿔 `call` 에 싣는다 —
 * 따로 든 상태가 없으므로 사용자가 지운 이름은 부르지 않는다. `chat` 화면 묶음이다.
 */

/** 커서 앞 글에서 낱말 처음의 `@질의` 를 찾는다. 없으면 null 이다. */
function chatMentionQuery(before){
  const m=/(^|\s)@([^\s@]*)$/.exec(String(before||''));
  return m?m[2]:null;
}

/** 나를 뺀 참가자 가운데 표시 이름이 질의를 품은 것. 이름이 질의로 시작하는 것이 먼저다. */
function chatMentionMatches(people,meId,q){
  const ql=String(q||'').toLowerCase();
  const all=(people||[]).filter(p=>p.id!==meId).map(p=>({id:p.id,name:chatName(p.label,p.id,meId)}));
  const hit=all.filter(m=>m.name.toLowerCase().includes(ql));
  const head=m=>m.name.toLowerCase().startsWith(ql)?0:1;
  return hit.map((m,i)=>[m,i]).sort((a,b)=>head(a[0])-head(b[0])||a[1]-b[1]).map(x=>x[0]);
}

/** 커서 앞의 `@질의` 를 `@이름 ` 으로 바꾼다. */
function chatMentionPick(text,caret,name){
  const i=text.slice(0,caret).lastIndexOf('@');
  return {text:text.slice(0,i)+'@'+name+' '+text.slice(caret),caret:i+name.length+2};
}

/** 답장 — 입력칸 앞에 `@이름 ` 을 붙인다. 이미 그렇게 시작하면 그대로다. */
function chatReplyText(text,name){
  const tag='@'+name+' ';
  return String(text||'').startsWith(tag)?text:tag+(text||'');
}

/** 본문의 `@이름` 들을 참가자 id 로 바꾼다(나온 차례). 긴 이름을 먼저 잡아 짧은 이름이 그 앞부분에 걸리지 않게 한다. */
function chatCallsIn(text,people,meId){
  let s=String(text||'');
  const found=[];
  const cands=(people||[]).filter(p=>p.id!==meId).map(p=>({id:p.id,tag:'@'+chatName(p.label,p.id,meId)}))
    .sort((a,b)=>b.tag.length-a.tag.length);
  for(const c of cands){
    for(let i=s.indexOf(c.tag);i>=0;i=s.indexOf(c.tag,i+1)){
      if(i>0&&!/\s/.test(s[i-1])) continue;
      found.push([i,c.id]);
      s=s.slice(0,i)+' '.repeat(c.tag.length)+s.slice(i+c.tag.length);
    }
  }
  return [...new Set(found.sort((a,b)=>a[0]-b[0]).map(x=>x[1]))];
}
