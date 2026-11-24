/**
 * 브라우저 저장소의 옛 키를 새 키로 옮긴다 (OTTERMINAL_RENAME_SRS FR-MIG-10).
 *
 * 이름 변경 전에는 키 접두가 `dm.` 이었다. 그대로 두면 언어·테마 같은 사용자 설정이 처음으로
 * 돌아간다. `<head>` 에서 테마·언어를 읽는 머리 스크립트보다 먼저 돈다.
 */

const STORAGE_LEGACY_PREFIX='dm.';
const STORAGE_PREFIX='otter.';

/** 옛 키를 새 키로 옮기고 옛 키를 지운다. 새 키가 이미 있으면 새 값을 지킨다. */
function storageRenameLegacy(storage){
  try{
    const old=[];
    for(let i=0;i<storage.length;i++){ const k=storage.key(i); if(k&&k.startsWith(STORAGE_LEGACY_PREFIX)) old.push(k) }
    for(const k of old){
      const nk=STORAGE_PREFIX+k.slice(STORAGE_LEGACY_PREFIX.length);
      if(storage.getItem(nk)===null) storage.setItem(nk,storage.getItem(k));
      storage.removeItem(k);
    }
  }catch(e){ console.warn('[storage-rename]',e) }
}

if(typeof localStorage!=='undefined') storageRenameLegacy(localStorage);
