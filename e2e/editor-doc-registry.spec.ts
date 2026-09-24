/**
 * REPO_FIX 03 §3A-5·3A-7·3A-8 — 문서 레지스트리: 비동기 적용 재확인·고아 모델·경로
 * 이동·판 기반 dirty·저장 대기·줄 끝.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';

import { test, expect, waitForInit } from './fixtures';
import { tmpPath, realPath } from './osenv';

const ROOT = tmpPath('dm-edreg-' + process.pid);
const fx = () => realPath(ROOT);
const P = (n: string) => join(fx(), n);

test.beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  for (const n of ['r.txt', 'o.txt', 'm.txt', 'u.txt', 'q.txt']) writeFileSync(join(ROOT, n), n + '-0\n');
  writeFileSync(join(ROOT, 'd.md'), '# old\n');
  writeFileSync(join(ROOT, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, stdio: 'ignore' });
  git('init', '-q'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');
});

async function enter(page: any) {
  await waitForInit(page);
  await page.evaluate(async (p: string) => {
    await fetch('/api/editors/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  }, fx());
  await expect.poll(async () => page.evaluate(async (p: string) => {
    const app = (window as any).app;
    await app.testing.edReconcile?.();
    await app.testing.edOpenWindow(p);
    return app.testing.edSearchRoot();
  }, fx()), { timeout: 15000 }).not.toBe('');
}

async function open(page: any, name: string) {
  await page.evaluate((f: string) => (window as any).app.testing.edOpenFile(f), P(name));
  await expect.poll(() => page.evaluate((n: string) => [...(window as any).app.fileEditors.values()]
    .some((v: any) => String(v.filePath).endsWith(n) && !!v._editor), name), { timeout: 30000 }).toBe(true);
}

const doc = (name: string) => `window.app.testing.edDocs.get(${JSON.stringify(P(name))})`;

// E-3.2: refresh 응답이 요청 뒤의 편집을 덮지 않는다.
test('refresh 응답 도착 전의 편집은 덮이지 않는다', async ({ page }) => {
  await enter(page);
  await open(page, 'r.txt');
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r });
  await page.route('**/api/file/read*', async (route: any) => { await held; await route.continue() });
  writeFileSync(join(ROOT, 'r.txt'), 'DISK\n');
  await page.evaluate((p: string) => { (window as any).__r = (window as any).app.edDocRefresh(p) }, P('r.txt'));
  await page.evaluate((s: string) => { eval(s).model.setValue('MINE\n') }, doc('r.txt'));
  release();
  expect(await page.evaluate(() => (window as any).__r)).toBe(false);
  expect(await page.evaluate((s: string) => eval(s).model.getValue(), doc('r.txt'))).toBe('MINE\n');
  await page.unroute('**/api/file/read*');
});

// #9: 어느 문서에도 속하지 않는 같은 URI 모델(고아)은 다시 열 때 쓰이지 않는다.
test('고아 모델을 재사용하지 않는다', async ({ page }) => {
  await enter(page);
  await open(page, 'm.txt'); // Monaco 를 싣는다
  await page.evaluate((p: string) => {
    const m = (window as any).monaco;
    m.editor.createModel('STALE\n', 'plaintext', m.Uri.file(p));
  }, P('o.txt'));
  await open(page, 'o.txt');
  expect(await page.evaluate((s: string) => eval(s).model.getValue(), doc('o.txt'))).toBe('o.txt-0\n');
});

// E-5: 이동은 새 URI 모델로 — 내용·dirty 보존, undo 소실, 옛 모델 해제.
test('edDocMove: 새 URI 모델, 내용·dirty 보존, undo 소실', async ({ page }) => {
  await enter(page);
  await open(page, 'm.txt');
  await page.evaluate((s: string) => { eval(s).model.setValue('EDITED\n') }, doc('m.txt'));
  renameSync(join(ROOT, 'm.txt'), join(ROOT, 'm2.txt'));
  await page.evaluate(({ a, b }: any) => (window as any).app.edRetargetTabs(a, b), { a: P('m.txt'), b: P('m2.txt') });
  const got = await page.evaluate(({ a, b }: any) => {
    const app = (window as any).app, m = (window as any).monaco;
    const d = app.testing.edDocs.get(b);
    return {
      moved: !!d && !app.testing.edDocs.get(a),
      uri: d && d.model.uri.fsPath,
      text: d && d.model.getValue(),
      dirty: d && d.dirty,
      canUndo: d && d.model.canUndo ? d.model.canUndo() : null,
      old: !!m.editor.getModel(m.Uri.file(a)),
      view: [...app.fileEditors.values()].some((v: any) => v.filePath === b && v._editor.getModel() === d.model),
    };
  }, { a: P('m.txt'), b: P('m2.txt') });
  expect(got).toMatchObject({ moved: true, text: 'EDITED\n', dirty: true, old: false, view: true });
  expect(String(got.uri).replace(/\\/g, '/')).toBe(P('m2.txt').replace(/\\/g, '/'));
  if (got.canUndo !== null) expect(got.canUndo).toBe(false);
});

// E-6.3: undo 로 원복하면 dirty 가 풀린다.
test('undo 로 되돌리면 dirty 가 풀린다', async ({ page }) => {
  await enter(page);
  await open(page, 'u.txt');
  await page.evaluate((s: string) => {
    const m = eval(s).model;
    m.pushEditOperations([], [{ range: m.getFullModelRange(), text: 'X\n' }], () => null);
  }, doc('u.txt'));
  expect(await page.evaluate((s: string) => eval(s).dirty, doc('u.txt'))).toBe(true);
  await page.evaluate((s: string) => { eval(s).model.undo() }, doc('u.txt'));
  expect(await page.evaluate((s: string) => eval(s).dirty, doc('u.txt'))).toBe(false);
});

// E-9.3: 저장 중의 저장은 버려지지 않는다 — 끝난 뒤 dirty 면 한 번 더.
test('저장 진행 중 재저장은 대기 후 한 번 더 저장한다', async ({ page }) => {
  await enter(page);
  await open(page, 'q.txt');
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r });
  let writes = 0;
  await page.route('**/api/file/write', async (route: any) => { writes++; if (writes === 1) await held; await route.continue() });
  await page.evaluate((s: string) => { eval(s).model.setValue('ONE\n') }, doc('q.txt'));
  await page.evaluate((p: string) => {
    const v = [...(window as any).app.fileEditors.values()].find((x: any) => x.filePath === p) as any;
    (window as any).__s1 = v.save();
    v._editor.getModel().setValue('TWO\n');
    (window as any).__s2 = v.save();
    (window as any).__s3 = v.save();
  }, P('q.txt'));
  await expect.poll(() => writes).toBe(1);
  release();
  expect(await page.evaluate(() => Promise.all([(window as any).__s1, (window as any).__s2, (window as any).__s3]))).toEqual([true, true, true]);
  expect(writes).toBe(2);
  expect(readFileSync(join(ROOT, 'q.txt'), 'utf8')).toBe('TWO\n');
  expect(await page.evaluate((s: string) => eval(s).dirty, doc('q.txt'))).toBe(false);
  await page.unroute('**/api/file/write');
});

// E-8.1: CRLF 파일을 편집하지 않으면 변경 표시가 없다.
test('CRLF 파일은 편집하지 않으면 변경 표시가 없다', async ({ page }) => {
  await enter(page);
  await open(page, 'crlf.txt');
  await expect.poll(() => page.evaluate((s: string) => { const d = eval(s); return !!(d.dd && d.dd.settled) }, doc('crlf.txt')),
    { timeout: 20000 }).toBe(true);
  expect(await page.evaluate((s: string) => eval(s).dd.changes.length, doc('crlf.txt'))).toBe(0);
});

// E-7.1: 문서의 뷰가 렌더 탭뿐이어도 외부 변경이 문서(소스 모델)에 반영된다.
test('렌더 탭만 남은 문서도 외부 변경을 문서 단위로 반영한다', async ({ page }) => {
  await enter(page);
  await open(page, 'd.md');
  await page.evaluate((p: string) => {
    const app = (window as any).app;
    app.testing.docRenderOpen(p, 'd.md');
  }, P('d.md'));
  await expect.poll(() => page.evaluate((s: string) => eval(s).views.size, doc('d.md'))).toBe(2);
  // 소스 뷰를 거둔다 — 남은 뷰는 DocRender 하나.
  await page.evaluate((p: string) => {
    const v = [...(window as any).app.fileEditors.values()].find((x: any) => x.filePath === p && !x.render) as any;
    v.destroy();
  }, P('d.md'));
  await expect.poll(() => page.evaluate((s: string) => eval(s).views.size, doc('d.md'))).toBe(1);
  writeFileSync(join(ROOT, 'd.md'), '# new\n');
  await expect.poll(async () => {
    await page.evaluate(() => (window as any).app.edPollDocStamps());
    return page.evaluate((s: string) => eval(s).model.getValue(), doc('d.md'));
  }, { timeout: 15000 }).toBe('# new\n');
});
