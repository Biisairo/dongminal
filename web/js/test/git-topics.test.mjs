import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from './harness.mjs';

/**
 * `web/js/core/git-topics.js` — git 토픽 구독 (PERF_OPTIMIZATION_SRS M1 ·
 * `perf/CHANNEL_PROTOCOL.md` §10.5 C4, TC-CH4-11~15).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

function fakeChannel() {
  const subs = [];
  return {
    subs,
    sub(topic, fn) {
      const rec = { topic, fn, stopped: false };
      subs.push(rec);
      return { topic, stop: () => { rec.stopped = true } };
    },
    live(topic) { return subs.filter((s) => s.topic === topic && !s.stopped) },
    raw: [],
    on(t, fn) {
      const rec = { t, fn, stopped: false };
      this.raw.push(rec);
      return { stop: () => { rec.stopped = true } };
    },
  };
}

function topics() {
  const ctx = load(['core/git-topics.js'], { expose: ['GitTopics'] });
  const changed = [];
  const jobs = [];
  const t = new ctx.GitTopics({ onChange: (a) => changed.push(a), onJobs: (j) => jobs.push(j) });
  return { t, changed, jobs };
}

test('TC-CH4-11: 같은 루트를 여럿이 봐도 구독은 하나, 마지막이 놓으면 해지한다', () => {
  const { t } = topics();
  const ch = fakeChannel();
  t.bind(ch);
  const a = t.watch('/r');
  const b = t.watch('/r');
  assert.equal(ch.live('git:/r').length, 1);
  a.stop();
  a.stop();
  assert.equal(ch.live('git:/r').length, 1, '한 명이 두 번 놓아 남의 구독을 끊었다');
  b.stop();
  assert.equal(ch.live('git:/r').length, 0);
});

test('TC-CH4-12: 채널이 서기 전의 watch 는 bind 때 구독한다', () => {
  const { t } = topics();
  t.watch('/r');
  const ch = fakeChannel();
  t.bind(ch);
  assert.equal(ch.live('git:/r').length, 1);
});

test('TC-CH4-13: full 은 {repo, mark} 변화로 넘어간다', () => {
  const { t, changed } = topics();
  const ch = fakeChannel();
  t.bind(ch);
  t.watch('/r');
  ch.live('git:/r')[0].fn({ kind: 'full', seq: 1, data: { repo: '/r', mark: 'm1' } });
  ch.live('git:/r')[0].fn({ kind: 'reset' });
  assert.deepEqual(JSON.parse(JSON.stringify(changed)), [{ repo: '/r', mark: 'm1' }]);
});

test('TC-CH4-14: git.jobs 는 bind 와 함께 구독하고 목록을 넘긴다', () => {
  const { t, jobs } = topics();
  const ch = fakeChannel();
  t.bind(ch);
  const s = ch.live('git.jobs');
  assert.equal(s.length, 1);
  s[0].fn({ kind: 'full', seq: 1, data: { jobs: [{ id: 'j1' }] } });
  s[0].fn({ kind: 'full', seq: 2, data: {} });
  assert.deepEqual(jobs, [[{ id: 'j1' }]]);
});

test('TC-CH4-18: followJob — 줄을 넘기고, 끝에서 해지하며, 모르는 잡은 fail 이다', () => {
  const { t } = topics();
  const ch = fakeChannel();
  t.bind(ch);
  const got = [];
  t.followJob('j1', { line: (l) => got.push(['line', l.seq]), done: (j) => got.push(['done', j.id]), fail: () => got.push(['fail']) });
  const s = ch.live('gitjob:j1')[0];
  s.fn({ kind: 'reset' });
  s.fn({ kind: 'event', seq: 1, data: { kind: 'line', line: { seq: 1, text: 'a' } } });
  s.fn({ kind: 'event', seq: 2, data: { kind: 'done', job: { id: 'j1', done: true } } });
  assert.deepEqual(got, [['line', 1], ['done', 'j1']]);
  assert.equal(ch.live('gitjob:j1').length, 0, '끝났는데 구독이 남았다');

  const bad = [];
  t.followJob('nope', { line() {}, done() {}, fail: () => bad.push('fail') });
  for (const r of ch.raw.filter((r) => !r.stopped)) r.fn({ t: 'error', code: 'unknown_topic', topic: 'gitjob:other' });
  assert.deepEqual(bad, [], '남의 토픽 오류에 실패했다');
  for (const r of ch.raw.filter((r) => !r.stopped)) r.fn({ t: 'error', code: 'unknown_topic', topic: 'gitjob:nope' });
  assert.deepEqual(bad, ['fail']);
  assert.equal(ch.live('gitjob:nope').length, 0);
});

test('TC-CH4-15: 브라우저의 git 상태 폴링과 job SSE 가 없다', () => {
  const poll = SRC('git/git-poll.js');
  assert.ok(/topics\.watch\(/.test(poll), 'Git 패널이 git:<repo> 토픽을 보지 않는다');
  for (const f of ['git/remote.js', 'git/submodules.js']) {
    assert.ok(!/openChannel\(|EventSource/.test(SRC(f)), f + ' 가 SSE 를 연다');
  }
  assert.ok(!/visiblePoll\(/.test(SRC('core/git-repos-list.js')), '저장소 목록 폴링이 남았다');
  assert.ok(!/git\.watchdog/.test(SRC('core/git-controller.js')), 'git 감시견 주기가 남았다');
  assert.ok(!/jobs:'1'|_gitJobsBegin/.test(SRC('core/statusbar-controller.js')), '상태바가 git 작업 목록을 묻는다');
  assert.ok(!/git_changed|git_jobs_changed/.test(SRC('core/state-registry.js')), '등록부가 옛 git 방송을 듣는다');
});
