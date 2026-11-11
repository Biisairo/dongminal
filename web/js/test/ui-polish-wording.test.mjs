import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load } from './harness.mjs';

/**
 * UI_POLISH_SRS TC-UIP-7 (FR-UIP-11·12·24) — 일반 동작 라벨은 ko 에서 한국어이고,
 * git 고유 용어는 영어로 남는다. 코드에 박혀 있던 라벨도 카탈로그를 거친다.
 */

function ctxFor() {
  return load(['core/i18n.js', 'i18n/ko.js', 'core/constants.js',
    'core/constants-api.js', 'core/constants-git.js', 'core/constants-git-changes.js',
    'core/constants-git-commit.js', 'core/constants-git-detect.js', 'core/constants-git-diff.js',
    'core/constants-git-history.js', 'core/constants-git-refs.js', 'core/constants-git-remote.js',
    'core/constants-git-actions.js'], {
    expose: ['t', 'GIT_CONFIRM_CANCEL', 'GIT_CONFIRM_COPY', 'GIT_DIRTY_OPTS', 'GIT_BR_CONFLICT_LABEL',
      'GIT_BR_UNMERGED_LABEL', 'GIT_DIFF_MODE_LABEL', 'GIT_AXIS_LABEL'],
  });
}

const KO = {
  'git.act.job_cancel': '취소',
  'git.act.job_close': '닫기',
  'git.act.note_close': '닫기',
  'git.act.preflight_copy': '복사',
  'git.menu.file_copy_path': '경로 복사',
  'git.act.job_auth_copy': '명령 복사',
  'git.act.job_copy': '출력 복사',
  'git.act.br_create_run': '만들기',
  'git.act.stash_create_run': '만들기',
  'git.act.stash_branch_run': '만들기',
  'git.act.wt_create_run': '만들기',
  'git.act.rm_create_run': '추가',
  'git.act.rm_remove': '제거',
  'git.act.br_delete': '삭제',
  'git.act.tag_delete': '삭제 (로컬)',
  'git.act.tag_delete_remote': '삭제 (원격)',
  'git.act.br_delete_both': '로컬과 원격 삭제',
  'git.act.br_remote_delete': '원격 브랜치 삭제',
  'git.act.br_rename_run': '이름 바꾸기',
  'git.act.br_upstream_run': '설정',
  'git.act.br_retry': '다시 시도',
  'git.act.undo_label': '되돌리기',
  'core.act.window_close_undo_label': '되돌리기',
  'git.act.hist_apply': '적용',
  'git.act.stash_apply': '적용',
  'git.act.stash_apply_index': '적용 (--index)',
  'git.act.co_compare_run': '비교',
  'git.act.confirm_run': '실행',
  'git.menu.file_open_file': '파일 열기',
  'git.act.file_open_head': '파일 열기 (HEAD)',
  'git.menu.file_open_changes': '변경 열기',
  'git.act.file_history': '파일 기록',
  'git.act.con_reads_label': '읽기 보기',
  'git.act.con_replay': '다시 실행',
  'git.act.tag_create_run': '태그 만들기',
  'git.act.file_ignore': '.gitignore 에 추가',
  'git.act.diff_fold_label': '변경 없는 줄 접기',
  'git.act.diff_ws_label': '공백 무시',
  'core.drop_files_hint': '여기에 파일을 놓으세요',
  'git.act.br_checkout_local': '로컬로 Checkout',
  'git.act.br_merge': '현재 브랜치에 Merge',
  'git.act.br_remote_fetch': '로컬로 Fetch',
  'git.act.br_unset_upstream': 'upstream 해제',
  'git.act.tag_push': '원격에 Push',
  'git.act.tag_push_all': '모든 태그 Push',
  'editor.repo_entries_none': '등록된 저장소가 없습니다',
};

const KEEP_EN = {
  'git.act.commit_btn': 'Commit',
  'git.act.br_push': 'Push',
  'git.act.br_merge_run': 'Merge',
  'git.act.co_cherry_run': 'Cherry-pick',
  'git.act.co_revert_run': 'Revert',
  'git.act.co_reset_run': 'Reset',
  'git.act.file_blame': 'Blame',
  'git.act.stash_pop': 'Pop',
  'git.act.stash_drop': 'Drop',
  'git.act.unc_clean': 'Clean',
  'git.act.unc_reset': 'Reset (mixed)',
  'html.slot_label': 'Slot',
};

test('TC-UIP-7a: 부록 A 의 일반 동작 라벨은 ko 에서 한국어다', () => {
  const { t } = ctxFor();
  for (const [k, v] of Object.entries(KO)) assert.equal(t(k), v, k);
});

test('TC-UIP-7b: git 고유 용어와 기능 이름은 ko 에서도 영어다', () => {
  const { t } = ctxFor();
  for (const [k, v] of Object.entries(KEEP_EN)) assert.equal(t(k), v, k);
});

test('TC-UIP-7c: 코드에 박혀 있던 취소·복사 라벨이 카탈로그를 거친다', () => {
  const c = ctxFor();
  assert.equal(c.GIT_CONFIRM_CANCEL, '취소');
  assert.equal(c.GIT_CONFIRM_COPY, '복사');
  assert.equal(c.GIT_DIRTY_OPTS.find((o) => o.id === 'cancel').label, '취소');
  assert.equal(c.GIT_BR_CONFLICT_LABEL.cancel, '취소');
  assert.equal(c.GIT_BR_UNMERGED_LABEL.cancel, '취소');
});

test('TC-UIP-7d: Diff 보기 방식과 비교 이름은 읽히는 말이다 (FR-UIP-17·24)', () => {
  const c = ctxFor();
  assert.equal(c.GIT_DIFF_MODE_LABEL.side, '나란히');
  assert.equal(c.GIT_DIFF_MODE_LABEL.inline, '통합');
  assert.equal(c.GIT_AXIS_LABEL['worktree-index'], '작업 트리 ↔ 스테이지');
  assert.equal(c.GIT_AXIS_LABEL['index-head'], '스테이지 ↔ HEAD');
  assert.equal(c.GIT_AXIS_LABEL['worktree-head'], '작업 트리 ↔ HEAD');
  assert.equal(c.GIT_AXIS_LABEL['commit-parent'], '커밋 ↔ 부모');
});
