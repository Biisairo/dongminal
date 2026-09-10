/**
 * 서버를 부르는 자리 한 겹 (CLIENT_API_SRS 묶음 A).
 *
 * 종전에는 29파일 82곳이 각자 같은 네 줄을 다시 썼다:
 *
 *   try{const r=await fetch(`/api/tools/${id}/busy`);const d=await r.json();return d.busy}catch{return false}
 *
 * 같은 일을 하는 코드가 82벌이면 **규약도 82벌**이다. 실제로 갈려 있었다 —
 * 실패를 `try/catch` 로 잡는 곳과 `if(!r.ok)` 로 잡는 곳과 아예 안 잡는 곳,
 * 본문을 `json()` 으로 읽는 곳과 `text()` 로 읽는 곳과 안 읽는 곳.
 *
 * **그중 하나는 결함이었다.** 상태 변경 `fetch` 6곳이 `Content-Type` 을 밝히지
 * 않아, M2 의 요청 게이트를 켜자 앱이 부팅되지 않았다. 그 여섯에 셸을 만드는
 * `POST /api/tools` 와 `DELETE /api/tools/{id}` 가 있었다. 한 자리를 지나면
 * 그 부류가 사라진다 (FR-CAPI-5).
 *
 * 그리고 M4 가 401 을 다룰 자리가 하나가 된다. 지금 상태로 인증을 붙이면
 * 29파일을 고쳐야 하고, 하나를 빠뜨리면 "로그인했는데 어떤 화면만 안 된다" 다.
 *
 * ── 이 겹이 하지 않는 것 ──
 *
 * **오류 본문을 해석하지 않는다.** 서버의 오류 방언은 넷이고 그것은 공개 계약이다
 * (`architecture.md:141-176`). 여기서는 `data` 와 `text` 를 그대로 주고, 어느
 * 방언인지는 그 종단을 아는 호출자가 안다.
 *
 * **재시도하지 않는다.** 요청 하나에 자동 재시도를 넣으면 쓰기가 두 번 일어난다.
 *
 * **던지지 않는다.** 망 실패도 봉투로 돌아온다 — 호출부에 `try/catch` 가 생기지
 * 않는 것이 이 겹의 값이다.
 */

/**
 * 응답 봉투 (FR-CAPI-2).
 *
 * @typedef {{ok:boolean, status:number, data:any, text:string, headers:Headers}} ApiRes
 *
 *   ok      HTTP 성공. **본문 유무를 보지 않는다** — 204 를 내는 종단이 있다.
 *           `git/api.js` 의 `ok` 는 여기에 `data!==null` 과 echo 를 더한 것이며,
 *           그 차이는 의도된 것이다 (git 종단은 언제나 JSON 을 낸다).
 *   status  HTTP 상태. **망 실패는 0** 이다 — 503 을 판정으로 굳히는 자리가 있어
 *           (`_gitOff`) 상태를 그대로 실어 보낸다.
 *   data    본문을 JSON 으로 읽은 것. 아니면 null.
 *   text    본문 원문. 단문 `{error}` 방언의 사유가 여기 있다.
 *   headers 응답 헤더. 망 실패면 null.
 *
 *           **`ETag` 때문에 있다.** 워크스페이스 저장이 낙관적 잠금을 쓰고
 *           (`WORKSPACE_SAVE_CONFLICT_SRS`) 그 판정이 `ETag`/`If-Match` 위에 선다.
 *           이 값을 주지 못하면 그 자리들이 이 겹을 지나지 못하고, 지나지 못하는
 *           자리가 하나라도 있으면 M4 의 401 이 다시 흩어진다.
 */

/** 본문이 `FormData` 인가. 업로드는 브라우저가 경계를 붙여야 한다 (FR-CAPI-5). */
function apiIsForm(b) {
  return typeof FormData !== 'undefined' && b instanceof FormData;
}

/** 쿼리를 붙인 URL. 호출자가 `encodeURIComponent` 를 빠뜨릴 자리가 없다 (FR-CAPI-6). */
function apiUrl(path, query) {
  if (!query) return path;
  const qs = new URLSearchParams(query).toString();
  return qs ? path + '?' + qs : path;
}

/**
 * `fetch` 의 두 번째 인자를 만든다.
 *
 * **상태 변경은 본문이 없어도 JSON 을 밝힌다** (REQUEST_GATE_SRS FR-RQG-5).
 * `POST /api/tools?cwd=…` 처럼 쿼리만으로 셸을 만드는 종단이 있어서, 본문 유무로
 * 예외를 두면 그 경로가 그대로 열린다.
 *
 * 시한은 **옵트인**이다 (FR-CAPI-7). 전역 기본값을 두면 최대 30분을 기다리는
 * 대기 종단(`/api/status`)이 조용히 끊긴다. 호출자가 준 `signal` 이 있으면
 * 그쪽이 이긴다 — 명시한 쪽이다.
 */
function apiInit(method, body, o) {
  const init = { method };
  const form = apiIsForm(body);
  if (body !== null && body !== undefined) {
    init.body = form || typeof body === 'string' ? body : JSON.stringify(body);
  }
  if (method !== 'GET' && !form) init.headers = { 'Content-Type': 'application/json' };
  if (o.headers) init.headers = Object.assign({}, init.headers, o.headers);
  if (o.cache) init.cache = o.cache;
  if (o.signal) init.signal = o.signal;
  else if (o.timeout > 0) init.signal = AbortSignal.timeout(o.timeout);
  return init;
}

/**
 * 요청 하나.
 *
 * @param {string} method
 * @param {string} path
 * @param {any} body       `FormData` 는 그대로, 문자열은 그대로, 그 밖은 JSON.
 * @param {object} [opts]
 *   opts.query   {object}   쿼리. `URLSearchParams` 로 조립한다.
 *   opts.timeout {number}   ms. 없으면 시한이 없다.
 *   opts.signal  {AbortSignal} 있으면 `timeout` 보다 우선한다.
 *   opts.headers {object}   더할 헤더.
 *   opts.cache   {string}   `fetch` 의 캐시 모드. 판 감시가 `no-store` 를 쓴다.
 *   opts.parse   {boolean}  거짓이면 JSON 파싱을 시도하지 않는다(원문만 쓴다).
 *   opts.fetch   {Function} 쓸 `fetch` 구현. `TimerHub` 의 `ctx.fetch` 가 이 자리다.
 * @returns {Promise<ApiRes>}
 */
async function apiSend(method, path, body, opts) {
  const o = opts || {};
  const doFetch = o.fetch || fetch;

  let res = null;
  // 흐름이 아니라 **경계**를 잡는다 — 망 실패·중단은 이 겹이 흡수하고 호출자는
  // 봉투 하나만 본다 (FR-CAPI-3).
  try {
    res = await doFetch(apiUrl(path, o.query), apiInit(method, body, o));
  } catch {
    res = null;
  }
  // **응답이 없는 것도 전송 실패다.** 진짜 `fetch` 는 응답 없이 resolve 하지
  // 않지만 이 겹은 구현을 주입받으므로(FR-CAPI-8) 그 입력에 대해 전부여야 한다.
  if (!res) return { ok: false, status: 0, data: null, text: '', headers: null };

  // **본문을 한 번만 읽는다** (FR-CAPI-4). `Response` 의 본문은 한 번뿐이므로,
  // 텍스트로 받아 두고 그것을 파싱해야 `data` 와 `text` 가 함께 선다. 종전에는
  // 자리마다 하나만 골라 읽었고, 그래서 실패 경로에서 사유를 버리는 곳이 있었다.
  let text = '';
  try { text = await res.text() } catch { text = '' }

  let data = null;
  if (o.parse !== false && text !== '') {
    try { data = JSON.parse(text) } catch { data = null }
  }

  // ── M4 의 자리 (FR-CAPI-10) ──
  // 401 을 다루는 곳은 **여기 하나**다. 지금은 아무것도 하지 않는다 — 자리와
  // 계약만 둔다 (REQUEST_GATE_SRS 의 `authGate` 와 같은 규약). 빈 자리가 여기
  // 있는 것이, M4 가 29파일을 다시 여는 것보다 싸다.

  return { ok: res.ok, status: res.status, data, text, headers: res.headers || null };
}

/** 조회 하나. */
function apiGet(path, opts) { return apiSend('GET', path, null, opts) }

/** 변경 하나. */
function apiPost(path, body, opts) { return apiSend('POST', path, body, opts) }
function apiPut(path, body, opts) { return apiSend('PUT', path, body, opts) }
function apiDel(path, opts) { return apiSend('DELETE', path, null, opts) }
