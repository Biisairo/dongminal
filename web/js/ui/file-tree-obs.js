// @ts-check
/**
 * 탐색기 폴더의 관측 상태 (REPO_FIX 04 §3A-2).
 *
 * 폴더마다 `unseen` · `ok(stamp)` · `failed(code)` · `gone` 중 하나다. 스탬프 하나로
 * "처음 본 겹" 과 "읽기 실패·사라짐" 을 함께 뜻하던 것을 가른다 — 그래서 실패·사라짐
 * 폴더가 영영 재조회되지 않던 것이 없어진다 (#29 #30).
 *
 *   이전 동작: 실패하면 스탬프를 지우고, 폴링 응답에서 빠진 겹도 스탬프를 지워
 *             "처음 본 겹" 이 되었다 — 다시 읽지 않았다
 *   새  동작: failed·gone 은 매 회차(백오프) 재조회, 사라졌다 다시 생기면 새로 읽는다
 *
 * 순수 함수다 — 상태 Map(폴더 → 상태)을 인자로 받아 고치고, 할 일을 돌려준다.
 */

/**
 * load 의 결말을 옮긴다. ok 면 stamp, 아니면 failed(code).
 * @param {Map<string,any>} obs @param {string} dir @param {boolean} ok
 * @param {string} stamp @param {string} code @param {number} now @param {number} backoff
 */
function ftObsLoaded(obs, dir, ok, stamp, code, now, backoff) {
  if (ok) { obs.set(dir, { state: 'ok', stamp: stamp || '', fails: 0, retryAt: 0 }); return }
  const prev = obs.get(dir);
  const fails = (prev && prev.state === 'failed' ? prev.fails : 0) + 1;
  obs.set(dir, { state: 'failed', code: code || '', fails, retryAt: now + (backoff || 0) });
}

/**
 * 스탬프 폴링 한 회차. dirs 는 물은 폴더, stamps 는 응답(폴더 → 스탬프, 빠지면 없음).
 * 돌려주는 것: reload(다시 읽을 폴더) · gone(이번에 사라진 폴더 — 캐시를 버린다).
 *
 *   ok      같은 스탬프면 무동작, 다르면 reload. 응답에서 빠지면 gone
 *   unseen  스탬프만 기억한다(방금 읽은 겹을 곧바로 다시 읽지 않는다, FR-FSL-10)
 *   failed  스탬프와 무관하게 reload — 단 백오프 시각 전이면 건너뛴다
 *   gone    다시 나타나면 reload(새 목록), 여전히 없으면 무동작
 *
 * @param {Map<string,any>} obs @param {string[]} dirs
 * @param {Record<string,string>} stamps @param {number} now
 */
function ftObsPoll(obs, dirs, stamps, now) {
  const reload = [], gone = [];
  for (const dir of dirs) {
    const cur = obs.get(dir);
    const s = stamps[dir];
    const has = typeof s === 'string';
    if (cur && cur.state === 'failed') {
      if (now >= (cur.retryAt || 0)) reload.push(dir);
      continue;
    }
    if (!has) {
      if (!cur || cur.state !== 'gone') { obs.set(dir, { state: 'gone' }); gone.push(dir) }
      continue;
    }
    if (!cur || cur.state === 'unseen') { obs.set(dir, { state: 'ok', stamp: s, fails: 0, retryAt: 0 }); continue }
    if (cur.state === 'gone') { reload.push(dir); continue }
    if (cur.stamp !== s) { cur.stamp = s; reload.push(dir) }
  }
  return { reload, gone };
}
