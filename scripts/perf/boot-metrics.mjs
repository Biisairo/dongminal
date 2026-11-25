/**
 * scenario.mjs boot 단계의 부팅 지표 집계 (NFR-PRF-11·12, M3_DESIGN §3.4 "목표를 재는 법").
 *
 *   bootNetCollector   CDP Network 이벤트 → 요청 수, 자원 종류별 수, 부팅 JS 바이트(풀린 크기·전송 크기)
 *   longTasksFromTrace 트레이스 이벤트 → 렌더러 메인 스레드에서 기준(ms)을 넘는 RunTask
 */

export function bootNetCollector() {
  const reqs = new Map();
  let requests = 0;
  const known = (id) => reqs.get(id);
  return {
    request(e) {
      requests++;
      const r = known(e.requestId);
      if (r) {
        r.sent++;
        return;
      }
      reqs.set(e.requestId, { type: e.type || 'Other', sent: 1, bytes: 0, encoded: 0 });
    },
    response(e) {
      const r = known(e.requestId);
      if (r && e.type) r.type = e.type;
    },
    data(e) {
      const r = known(e.requestId);
      if (r) r.bytes += e.dataLength || 0;
    },
    finished(e) {
      const r = known(e.requestId);
      if (r) r.encoded = e.encodedDataLength || 0;
    },
    summary() {
      const byType = {};
      let jsFiles = 0;
      let jsBytes = 0;
      let jsEncodedBytes = 0;
      for (const r of reqs.values()) {
        byType[r.type] = (byType[r.type] || 0) + r.sent;
        if (r.type !== 'Script') continue;
        jsFiles++;
        jsBytes += r.bytes;
        jsEncodedBytes += r.encoded;
      }
      return { requests, byType, jsFiles, jsBytes, jsEncodedBytes };
    },
  };
}

export function longTasksFromTrace(events, thresholdMs = 16) {
  const main = new Set();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') main.add(`${e.pid}:${e.tid}`);
  const tasksMs = events
    .filter((e) => e.ph === 'X' && e.name === 'RunTask' && main.has(`${e.pid}:${e.tid}`) && e.dur > thresholdMs * 1000)
    .map((e) => e.dur / 1000)
    .sort((a, b) => b - a);
  return { count: tasksMs.length, maxMs: tasksMs[0] || 0, totalMs: tasksMs.reduce((a, b) => a + b, 0), tasksMs };
}
