import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pageScripts, readBundles } from '../../../scripts/bundles-def.mjs';

import { BASE, load, plain } from './harness.mjs';

/**
 * PERF 3.4.12.5 (perf/M3_BOOT_SCOPE.md §3 `remote`): 원격 명령 본체(`tool-cmd-remote.js`)와 `open-url.js` 는
 * `[remote]` 묶음이다. 부팅에 남은 껍데기 `ToolCmd._execRemote` 가 첫 명령 때 `Screens.load('remote')` 를 부르고,
 * 실리는 동안 받은 명령은 받은 순서대로 줄을 세웠다가 실린 뒤 그 순서대로 돈다.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function shell() {
  const loads = [];
  const Screens = {
    register() {},
    load(name) {
      let res, rej;
      const p = new Promise((a, b) => { res = a; rej = b });
      loads.push({ name, res, rej });
      return p;
    },
  };
  const ctx = load([...BASE, 'core/layout-tree.js', 'core/tool-cmd.js'], { globals: { Screens }, expose: ['ToolCmd'] });
  const cmd = new ctx.ToolCmd({});
  const ran = [];
  // 묶음이 실리면 원형에 본체가 선다 — 그것을 흉내 낸다.
  const arrive = () => { ctx.ToolCmd.prototype._execRemoteNow = function (a, b) { ran.push([a, b && b.n]) } };
  return { ctx, cmd, loads, ran, arrive };
}

const tick = () => new Promise((r) => setImmediate(r));

test('본체가 없으면 첫 명령이 remote 묶음을 한 번 싣고, 실리는 동안 받은 명령은 받은 순서대로 돈다', async () => {
  const { cmd, loads, ran, arrive } = shell();
  cmd._execRemote('renameTab', { n: 1 });
  cmd._execRemote('tabNext', { n: 2 });
  cmd._execRemote('renameTab', { n: 3 });
  assert.deepEqual(loads.map((l) => l.name), ['remote']);
  assert.deepEqual(ran, []);
  arrive();
  // 본체가 원형에 섰어도 줄이 남아 있으면 새 명령은 줄 끝에 선다 — 앞지르지 않는다.
  cmd._execRemote('paneUp', { n: 4 });
  assert.deepEqual(ran, []);
  loads[0].res();
  await tick();
  assert.deepEqual(plain(ran), [['renameTab', 1], ['tabNext', 2], ['renameTab', 3], ['paneUp', 4]]);
  cmd._execRemote('tabPrev', { n: 5 });
  assert.deepEqual(plain(ran.at(-1)), ['tabPrev', 5], '실린 뒤에는 바로 돈다');
  assert.equal(loads.length, 1);
});

test('묶음이 실리지 않으면 줄 선 명령을 버리고, 다음 명령이 다시 싣는다', async () => {
  const { cmd, loads, ran, arrive } = shell();
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a);
  cmd._execRemote('renameTab', { n: 1 });
  cmd._execRemote('renameTab', { n: 2 });
  loads[0].rej(new Error('net'));
  await tick();
  console.warn = warn;
  assert.equal(warned.length, 1);
  assert.deepEqual(ran, []);
  cmd._execRemote('renameTab', { n: 3 });
  assert.equal(loads.length, 2);
  arrive();
  loads[1].res();
  await tick();
  assert.deepEqual(plain(ran), [['renameTab', 3]]);
});

test('_findTabById 는 부팅 껍데기에 남는다 — layout-groups 가 묶음 없이 부른다', () => {
  const { cmd } = shell();
  cmd.app.ws = { windows: [{ id: 'w', layout: { type: 'pane', id: 'p', tabs: [{ id: 't' }] } }] };
  const r = cmd._findTabById('t');
  assert.deepEqual([r.windowId, r.paneId, r.tabId], ['w', 'p', 't']);
  assert.equal(cmd._findTabById('none'), null);
});

test('tool-cmd-remote.js·open-url.js 는 [remote] 묶음에만 있고 페이지가 싣지 않는다. 껍데기는 부팅이다', () => {
  const defs = readBundles(ROOT);
  assert.deepEqual(defs.get('remote')?.js, ['js/ui/open-url.js', 'js/core/tool-cmd-remote.js']);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const boot = pageScripts(html, defs);
  assert.ok(!boot.includes('js/core/tool-cmd-remote.js'));
  assert.ok(!boot.includes('js/ui/open-url.js'));
  assert.ok(boot.includes('js/core/tool-cmd.js'));
});
