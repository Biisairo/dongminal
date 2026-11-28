/**
 * 채팅 — 사람이 본 대화 (PEER_CHAT_SRS §3.11, FR-PCH-85).
 *
 * 대화는 브라우저 메모리에만 둔다. 데몬·서버는 글을 들지 않는다. 새로고침하면 사라진다.
 * 안 읽은 수도 여기서 센다: 그 방의 탭이 보이지 않을 때 온 글이다. 알람(ISSUE_TREE_CHAT_SRS FR-CAL-15·16)도 방마다
 * 여기 둔다 — 탭이 보이면 안 읽은 수와 함께 꺼진다.
 */

/** 방마다 남기는 글의 수. 넘으면 오래된 글부터 버린다. */
const CHAT_KEEP=500;

class ChatStore{
  constructor(keep){
    this.keep=keep||CHAT_KEEP;
    this.rooms=new Map();
  }

  _room(id){
    let r=this.rooms.get(id);
    if(!r) this.rooms.set(id,r={msgs:[],ids:new Set(),unread:0,alarm:false,mark:null});
    return r;
  }

  /** 글 하나를 넣는다. 같은 id 는 한 번만 들어간다. `shown` 이 아니면 안 읽은 수가 는다. */
  add(roomId,msg,shown){
    if(!roomId||!msg) return false;
    const r=this._room(roomId);
    if(msg.id&&r.ids.has(msg.id)) return false;
    r.msgs.push(msg);
    if(msg.id) r.ids.add(msg.id);
    while(r.msgs.length>this.keep){
      const old=r.msgs.shift();
      if(old&&old.id) r.ids.delete(old.id);
    }
    if(!shown) r.unread++;
    return true;
  }

  list(roomId){
    const r=this.rooms.get(roomId);
    return r?r.msgs:[];
  }

  unread(roomId){
    const r=this.rooms.get(roomId);
    return r?r.unread:0;
  }

  /** 그 방에 알람을 건다 (FR-CAL-15). */
  alarm(roomId){ if(roomId) this._room(roomId).alarm=true }

  alarmed(roomId){
    const r=this.rooms.get(roomId);
    return !!(r&&r.alarm);
  }

  /** 그 방의 읽던 자리 `{msg, offset}` 를 적는다 (CHAT_TELEGRAM_UX_SRS FR-CTU-1). */
  mark(roomId,m){ if(roomId) this._room(roomId).mark=m||null }

  markOf(roomId){
    const r=this.rooms.get(roomId);
    return (r&&r.mark)||null;
  }

  /** 그 방의 탭이 보였다 — 안 읽은 수가 0 이 되고 알람이 꺼진다 (FR-CAL-16). 바뀌었으면 참이다. */
  read(roomId){
    const r=this.rooms.get(roomId);
    if(!r||(!r.unread&&!r.alarm)) return false;
    r.unread=0;
    r.alarm=false;
    return true;
  }
}

/** 방의 보이는 이름. 단체채팅은 `#이름`(# 는 겹치지 않는다), 개인채팅은 상대의 표시 이름이다 (FR-CUX-14). */
function chatRoomTitle(room,meId){
  if(!room) return '';
  if(room.kind!=='direct') return '#'+String(room.name||'').replace(/^#+/,'');
  const other=(room.people||[]).find(p=>p&&p.id!==meId);
  return other?chatName(other.label,other.id,meId):t('chat.direct');
}

/**
 * 참가자의 표시 이름 (ISSUE_TREE_CHAT_SRS FR-CUX-9). 원래 이름은 `<노드>/<탭>` 이다(FR-PCH-46). 내 노드의 참가자는
 * 탭 이름, 다른 노드는 `<노드> › <탭>` 이다. 노드는 id 의 지문(마지막 `-` 앞)으로 가른다.
 */
function chatName(label,id,meId){
  const s=String(label||''),i=s.indexOf('/');
  if(i<0) return s||chatShortId(id);
  return chatNodeOf(id)===chatNodeOf(meId)?s.slice(i+1):t('chat.name_remote',{node:s.slice(0,i),tab:s.slice(i+1)});
}

/** 참가자 id 의 노드 지문 — 마지막 `-` 앞이다 (FR-PCH-46). */
function chatNodeOf(id){
  const s=String(id||'');
  return s.slice(0,Math.max(0,s.lastIndexOf('-')));
}

/** 참가자 id 의 짧은 표시. 앞은 노드 지문이라 모두 같으므로 `-` 뒤 앞자리를 쓴다 (FR-PCH-46). */
function chatShortId(id){
  const s=String(id||'');
  const i=s.lastIndexOf('-');
  return (i>=0?s.slice(i+1):s).slice(0,6);
}

/** 글의 시각 `HH:MM`. */
function chatClock(ms){
  const d=new Date(ms||0);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
