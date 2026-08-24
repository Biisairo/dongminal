import { test as base, expect } from '@playwright/test';

// e2e 는 만든 도구를 정리하지 않는다. 스펙이 workspace 를 비우거나 탭을
// 직접 지워도 서버측 도구(PTY)는 그대로 남는다 — 브라우저의 closeTab 경로만
// 도구를 종료하기 때문이다.
//
// 그렇게 누적된 고아 도구는 다음 페이지 로드에서 전부 "재연결 대상"으로
// 미리 생성된다 (app.js init: 서버 도구마다 숨겨진 터미널 + WebSocket).
// 수십 개가 쌓이면 포커스된 터미널의 WS open 이 늦어져 waitForInit 이
// 타임아웃하고, 스펙 대부분이 순서 의존으로 무너진다.
//
// 매 테스트 전에 **어떤 탭도 참조하지 않는** 도구만 회수한다. 참조된 도구와
// workspace 는 건드리지 않으므로 파일 내 테스트 간 상태 의존은 보존된다.
async function reapOrphanTools(request: any) {
  let state: any;
  try {
    const r = await request.get('/api/state');
    if (!r.ok()) return;
    state = await r.json();
  } catch {
    return;
  }
  const referenced = new Set<string>();
  const walk = (n: any) => {
    if (!n) return;
    for (const t of n.tabs || []) if (t.toolId) referenced.add(t.toolId);
    for (const c of n.children || []) walk(c);
  };
  for (const w of state?.workspace?.windows || []) walk(w.layout);

  for (const tool of state?.tools || []) {
    if (!tool?.id || referenced.has(tool.id)) continue;
    try {
      await request.delete('/api/tools/' + tool.id);
    } catch {
      // 이미 종료된 도구는 무시
    }
  }
}

// 테스트 간 워크스페이스 누적은 순서 의존 실패의 주 원인이다. 앞선 테스트가
// 만든 창·탭이 남아 있으면 "포커스된 분할 칸의 활성 탭" 이 터미널이 아니게 되고
// waitForInit 의 .xterm-helper-textarea 대기가 hidden 상태로 타임아웃한다.
// 매 테스트 전에 빈 워크스페이스로 되돌린다 — 브라우저가 첫 도구를 새로 만든다.
async function resetWorkspace(request: any) {
  try {
    const get = await request.get('/api/workspace');
    if (!get.ok()) return;
    const rev = get.headers()['etag'] || '0';
    await request.put('/api/workspace', {
      headers: { 'If-Match': rev, 'Content-Type': 'application/json' },
      data: '{"schemaVersion":2,"windows":[]}',
    });
  } catch {
    // 서버가 아직 안 떴으면 무시 — 첫 테스트가 goto 에서 다시 기다린다.
  }
}

// 주의 알림은 도구가 사라져도 서버에 남고 배지 개수·모아보기 목록에 누적된다.
// 개수를 단정하는 스펙(attention.spec.ts)이 앞선 테스트의 알림에 오염되므로
// 매 테스트 전에 비운다.
async function clearAttention(request: any) {
  try {
    await request.post('/api/tools/attention/clear-all');
  } catch {
    // 서버가 아직 안 떴으면 무시
  }
}

export const test = base.extend<{ cleanTools: void }>({
  cleanTools: [
    async ({ request }, use) => {
      await resetWorkspace(request);
      await reapOrphanTools(request);
      await clearAttention(request);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
