/**
 * 주의 상태 파비콘 (OTTERMINAL_RENAME_SRS FR-FAV-1~3).
 *
 * 주의 집합에서 가장 급한 이유의 색을 브라우저 탭 아이콘에 보인다. 급한 순서는
 * waiting(사람이 손대야 진행) > done(일이 끝남) > 그 밖이다.
 */

const ATTN_FAVICON=Object.freeze({
  base:'assets/brand/otter-15.svg',
  waiting:'assets/brand/otter-14-red.svg',
  done:'assets/brand/otter-14-green.svg',
  other:'assets/brand/otter-14-yellow.svg',
});

/** 주의 집합과 설정에서 보일 아이콘 주소를 고른다. */
function attnFaviconHref(attn,on){
  if(!on||!attn||!attn.size) return ATTN_FAVICON.base;
  let done=false;
  for(const v of attn.values()){
    const r=v&&v.reason;
    if(r==='waiting') return ATTN_FAVICON.waiting;
    if(r==='done') done=true;
  }
  return done?ATTN_FAVICON.done:ATTN_FAVICON.other;
}

/** SVG 아이콘 링크의 주소를 바꾼다. 같으면 DOM 을 건드리지 않는다. */
function applyAttnFavicon(doc,href){
  const link=doc.querySelector('link[rel="icon"][type="image/svg+xml"]');
  if(!link||link.getAttribute('href')===href) return;
  link.setAttribute('href',href);
}
