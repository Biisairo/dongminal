/**
 * EDITOR_LIVE_RELOAD_SRS — 열어 둔 파일이 밖에서 바뀌면 곧바로 따라간다
 * (V-ELR-5·6·7·9·10·11·12).
 *
 * 접수는 `U-31` 이다. 선행 문서(`EDITOR_EXTERNAL_CHANGE_SRS`)가 잰 것은 **계기가
 * 주어졌을 때** 따라가는가였고, 이 파일이 재는 것은 **계기 자체가 스스로 서는가**
 * 다 — 사용자가 아무것도 하지 않아도 화면이 디스크를 따라가는지.
 *
 * 그 반대편도 함께 잰다: **손을 댄 순간 따라가기를 멈춘다** (FR-ELR-40). 편집을
 * 확인 없이 잃는 것이 이 제품에서 가장 비싼 실패이고(`U-10`), 실시간 반영은 그
 * 실패로 가는 가장 짧은 길이기도 하다.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

import { Page } from '@playwright/test';

import {
  test, expect, waitForInit, addEditorRoot, switchToEditorRoot, rmTree,
} from './fixtures';
import { TMP, realPath } from './osenv';

let BASE = '';

test.beforeAll(() => { BASE = realPath(mkdtempSync(join(TMP, 'dm-elr-'))) });
test.afterAll(() => { rmTree(BASE) });

// 폴링 주기(`gitReposInterval`, 기본 3초)의 세 배 남짓. 한 회차를 놓쳐도 다음이
// 잡으므로 대기가 주기에 아슬아슬하게 걸리지 않는다 (notes-live-explorer 와 같은
// 근거).
const POLL_WAIT = 12000;

async function mkroot(request: any, page: Page, name: string, files: Record<string, string>) {
  const root = join(BASE, name);
  mkdirSync(root, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  const saved = await addEditorRoot(request, root);
  await waitForInit(page);
  await switchToEditorRoot(page, saved);
  return { root, saved };
}

async function openFile(page: Page, saved: string, rel: string) {
  await page.evaluate((p: string) => (window as any).app.testing.edOpenFile(p, { pin: true }),
    saved + '/' + rel);
  await page.waitForFunction((n: string) => {
    const eds = [...(window as any).app.fileEditors.values()];
    return eds.some((e: any) => e._editor && e.name === n);
  }, rel, { timeout: 30000 });
}

const valueOf = (page: Page, name: string) => page.evaluate((n: string) => {
  const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
  return v && v._editor ? v._editor.getValue() : '';
}, name);

const dirtyOf = (page: Page, name: string) => page.evaluate((n: string) => {
  const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
  return !!(v && v._dirty);
}, name);

const cursorOf = (page: Page, name: string) => page.evaluate((n: string) => {
  const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
  const p = v && v._editor && v._editor.getPosition();
  return p ? { line: p.lineNumber, col: p.column } : null;
}, name);

async function putCursor(page: Page, name: string, line: number, col: number) {
  await page.evaluate(([n, l, c]: [string, number, number]) => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
    v._editor.setPosition({ lineNumber: l, column: c });
  }, [name, line, col] as [string, number, number]);
}

// 사용자의 타이핑과 같은 경로다 — `setValue` 는 isFlush 라 dirty 규약이 다르다.
async function typeInto(page: Page, name: string, text: string) {
  await page.evaluate(([n, t]: string[]) => {
    const v: any = [...(window as any).app.fileEditors.values()].find((e: any) => e.name === n);
    const m = v._editor.getModel();
    v._editor.executeEdits('test', [{ range: m.getFullModelRange(), text: t }]);
  }, [name, text]);
  await expect.poll(() => dirtyOf(page, name)).toBe(true);
}

// `/api/file/stamps` 의 요청 본문을 모은다 — 무엇을 묻고 있는지가 곧 관측의 범위다.
function stampsProbe(page: Page) {
  const box: { bodies: string[] } = { bodies: [] };
  page.on('request', ((req: any) => {
    if (String(req.url()).includes('/api/file/stamps')) box.bodies.push(String(req.postData() || ''));
  }) as never);
  return box;
}

const LONG = Array.from({ length: 60 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n';

test('V-ELR-5: clean 인 편집기는 손대지 않아도 새 내용을 받는다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'live', { 'a.txt': 'before\n' });
  await openFile(page, saved, 'a.txt');
  expect(await valueOf(page, 'a.txt')).toBe('before\n');

  writeFileSync(join(root, 'a.txt'), 'after\n');
  // **아무것도 하지 않는다.** 탭을 다시 열지도, 새로고침하지도 않는다.
  await expect.poll(() => valueOf(page, 'a.txt'), { timeout: POLL_WAIT }).toBe('after\n');
  expect(await dirtyOf(page, 'a.txt')).toBe(false);
});

test('V-ELR-6: 따라가도 커서는 그 자리에 남는다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'gaze', { 'b.txt': LONG });
  await openFile(page, saved, 'b.txt');
  await putCursor(page, 'b.txt', 40, 3);

  writeFileSync(join(root, 'b.txt'), LONG.replace('line 1\n', 'LINE ONE\n'));
  await expect.poll(() => valueOf(page, 'b.txt'), { timeout: POLL_WAIT })
    .toContain('LINE ONE');
  // `setValue` 는 커서를 1,1 로 되돌린다. 그것을 되돌리는 것이 FR-ELR-30 이다.
  expect(await cursorOf(page, 'b.txt')).toEqual({ line: 40, col: 3 });
});

test('V-ELR-7: dirty 면 따라가지 않는다 — 편집본이 그대로다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'dirty', { 'c.txt': 'before\n' });
  await openFile(page, saved, 'c.txt');
  await typeInto(page, 'c.txt', 'MINE\n');

  writeFileSync(join(root, 'c.txt'), 'THEIRS\n');
  // **예외 (`TEST-16`)**: 화면이 **바뀌지 않음**을 잰다 — 기다릴 신호가 없다.
  // 한 주기를 넘겨도 편집본이 남아 있어야 한다. 폴링이 이 문서를 아예 묻지
  // 않으므로(FR-ELR-12) 반영의 경로 자체가 서지 않는다.
  await page.waitForTimeout(POLL_WAIT);
  expect(await valueOf(page, 'c.txt')).toBe('MINE\n');
  expect(await dirtyOf(page, 'c.txt')).toBe(true);
});

test('V-ELR-9: 밖에서 지워져도 탭이 남고 화면이 비지 않는다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'gone', { 'd.txt': 'keep me\n' });
  await openFile(page, saved, 'd.txt');

  rmSync(join(root, 'd.txt'));
  // **예외 (`TEST-16`)**: 탭이 **사라지지 않고** 화면이 **비지 않음**을 잰다.
  await page.waitForTimeout(POLL_WAIT);
  expect(await valueOf(page, 'd.txt')).toBe('keep me\n');
});

test('V-ELR-10: 보이지 않는 창의 파일은 묻지 않는다', async ({ page, request }) => {
  const { saved } = await mkroot(request, page, 'hidden', { 'e.txt': 'x\n' });
  await openFile(page, saved, 'e.txt');
  const probe = stampsProbe(page);
  // 그 파일을 묻고 있다는 것을 먼저 확인한다 — 확인 없이 "묻지 않는다" 를 재면
  // 종단이 통째로 죽어 있어도 검사가 통과한다.
  await expect.poll(() => probe.bodies.some(b => b.includes('e.txt')), { timeout: POLL_WAIT })
    .toBe(true);

  // 일반 창으로 간다. Editor 창은 이제 화면에 없다 (FR-STAT-17).
  await page.evaluate(() => {
    const a: any = (window as any).app;
    const plain = a.ws.windows.find((s: any) => s && !a.isEditorWin(s));
    if (plain) a.switchWindow(plain.id);
  });
  probe.bodies.length = 0;
  // **예외 (`TEST-16`)**: 그 경로를 **묻지 않음**을 잰다. 오지 않는 요청을
  // 기다릴 조건은 없다 — 시간을 주고 그래도 비어 있는지가 검사 자체다.
  await page.waitForTimeout(POLL_WAIT);
  expect(probe.bodies.filter(b => b.includes('e.txt'))).toEqual([]);
});

test('V-ELR-11: 종단이 없는 서버(404)면 묻기를 멈춘다', async ({ page, request }) => {
  await page.route('**/api/file/stamps', r => r.fulfill({ status: 404, body: '{}' }));
  const { saved } = await mkroot(request, page, 'old', { 'f.txt': 'x\n' });
  await openFile(page, saved, 'f.txt');
  const probe = stampsProbe(page);
  await expect.poll(() => probe.bodies.length, { timeout: POLL_WAIT }).toBeGreaterThan(0);

  const after = probe.bodies.length;
  // **예외 (`TEST-16`)**: 굳은 뒤로 요청이 **더 나가지 않음**을 잰다.
  await page.waitForTimeout(POLL_WAIT);
  // 404 를 받은 뒤로는 한 번도 더 묻지 않는다 — 굳히지 않으면 3초마다 404 다.
  expect(probe.bodies.length).toBe(after);
});

test('V-ELR-12: 표식만 바뀌고 내용이 같으면 넣지 않는다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'touch', { 'g.txt': LONG });
  await openFile(page, saved, 'g.txt');
  await putCursor(page, 'g.txt', 30, 2);
  const probe = stampsProbe(page);

  // 같은 내용으로 다시 쓴다 — mtime 이 움직이므로 표식은 달라진다.
  writeFileSync(join(root, 'g.txt'), LONG);
  await expect.poll(() => probe.bodies.length, { timeout: POLL_WAIT }).toBeGreaterThan(1);
  // **예외 (`TEST-16`)**: 물음이 오간 뒤에도 `setValue` 가 **일어나지 않음**을
  // 잰다. 커서가 움직이지 않는 것을 기다릴 조건으로는 쓸 수 없다.
  await page.waitForTimeout(2000);

  expect(await valueOf(page, 'g.txt')).toBe(LONG);
  expect(await cursorOf(page, 'g.txt')).toEqual({ line: 30, col: 2 });
});

/**
 * V-ELR-8 (FR-ELR-30): 같은 파일을 두 칸에서 보고 있을 때.
 *
 * 문서는 하나이고 모델도 하나이므로(FR-SVS-50·51) `setValue` 한 번이 **두 칸을
 * 함께** 새 내용으로 만든다. 그런데 같은 한 번이 **두 칸의 커서를 함께** 1,1 로
 * 보낸다 — 시선은 칸마다의 것이다. 이 검사가 그 둘을 한 자리에서 잰다.
 */
test('V-ELR-8: 두 칸이 같은 파일을 볼 때 내용은 함께, 시선은 각자 남는다', async ({ page, request }) => {
  const { root, saved } = await mkroot(request, page, 'slots', { 'h.txt': LONG });
  await openFile(page, saved, 'h.txt');

  const edWin = await page.evaluate(() => (window as any).app.testing.aw().id);
  await page.evaluate(() => (window as any).app.slotAdd());
  await page.evaluate((id: string) => {
    const a: any = (window as any).app;
    a.slotOpen(0, id); a.slotOpen(1, id); a.render();
  }, edWin);
  await page.waitForFunction(() => {
    const es = [...(window as any).app.fileEditors.values()];
    return es.length === 2 && es.every((e: any) => !!e._editor);
  }, undefined, { timeout: 20000 });

  const keys: string[] = await page.evaluate(
    () => [...(window as any).app.fileEditors.keys()].sort());
  // 칸마다 다른 자리를 본다 — 하나가 다른 하나로 덮이면 검사가 그것을 본다.
  await page.evaluate(([ks, a, b]: [string[], number, number]) => {
    const app: any = (window as any).app;
    app.fileEditors.get(ks[0])._editor.setPosition({ lineNumber: a, column: 2 });
    app.fileEditors.get(ks[1])._editor.setPosition({ lineNumber: b, column: 5 });
  }, [keys, 12, 45] as [string[], number, number]);

  writeFileSync(join(root, 'h.txt'), LONG.replace('line 2\n', 'LINE TWO\n'));

  const valueIn = (k: string) => page.evaluate(
    (key: string) => (window as any).app.fileEditors.get(key)._editor.getValue(), k);
  const posIn = (k: string) => page.evaluate((key: string) => {
    const p = (window as any).app.fileEditors.get(key)._editor.getPosition();
    return { line: p.lineNumber, col: p.column };
  }, k);

  await expect.poll(() => valueIn(keys[0]), { timeout: POLL_WAIT }).toContain('LINE TWO');
  expect(await valueIn(keys[1])).toContain('LINE TWO');
  expect(await posIn(keys[0])).toEqual({ line: 12, col: 2 });
  expect(await posIn(keys[1])).toEqual({ line: 45, col: 5 });
});
