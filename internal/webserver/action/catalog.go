package action

import "dongminal/internal/webserver/apierr"

// Catalog 은 서버가 판정하는 동작 전부와 그 사유다 (M-3). 판정을 더하면 여기에도
// 더한다 — 판정 시험이 MayGive 로 확인하고, 게이트가 이 목록의 문구를 확인한다.
var Catalog = Table{
	GitStashCreate: {apierr.CodeJobBusy, apierr.CodeNothingToStash, apierr.CodeUntrackedOnly},

	GitFetch:           {apierr.CodeJobBusy},
	GitPull:            {apierr.CodeJobBusy},
	GitPush:            {apierr.CodeJobBusy},
	GitTagPush:         {apierr.CodeJobBusy},
	GitTagDeleteRemote: {apierr.CodeJobBusy},
	GitWrite:           {apierr.CodeJobBusy},
	GitCommit:          {apierr.CodeEmptyMessage, apierr.CodeJobBusy, apierr.CodePreflightBlocked, apierr.CodeNothingStaged},
	GitLockRemove:      {apierr.CodeJobBusy},
	GitWorktreeCreate: {apierr.CodeJobBusy, apierr.CodeEmptyName, apierr.CodeRefName, apierr.CodeEmptyRef,
		apierr.CodeWorktreeExists, apierr.CodeBranchExists},
	GitSubmoduleUpdate: {apierr.CodeJobBusy},
	GitWorktreeRemove:  {apierr.CodeJobBusy},

	GitStashNew:         {apierr.CodeJobBusy, apierr.CodeNothingToStash},
	GitUncommittedReset: {apierr.CodeJobBusy, apierr.CodeNoHead},
	GitUncommittedClean: {apierr.CodeJobBusy, apierr.CodeNothingToClean},

	GitCommitCherryPick: {apierr.CodeJobBusy, apierr.CodeOperationInProgress, apierr.CodeTargetIsHead},
	GitCommitRevert:     {apierr.CodeJobBusy, apierr.CodeOperationInProgress},
	GitCommitReset:      {apierr.CodeJobBusy, apierr.CodeOperationInProgress, apierr.CodeTargetIsHead},
	GitCommitDrop:       {apierr.CodeJobBusy, apierr.CodeOperationInProgress, apierr.CodeRootCommit, apierr.CodeMergeCommit},

	GitBranchCheckout:      {apierr.CodeJobBusy, apierr.CodeNotLocalBranch, apierr.CodeBranchCurrent},
	GitBranchCheckoutLocal: {apierr.CodeJobBusy, apierr.CodeNotRemoteBranch},
	GitBranchRename:        {apierr.CodeJobBusy, apierr.CodeNotLocalBranch},
	GitBranchMerge:         {apierr.CodeJobBusy, apierr.CodeOperationInProgress, apierr.CodeTargetIsHead},
	GitBranchRebase:        {apierr.CodeJobBusy, apierr.CodeOperationInProgress, apierr.CodeTargetIsHead},
	GitBranchUpstreamSet:   {apierr.CodeJobBusy, apierr.CodeNotLocalBranch, apierr.CodeEmptyRef, apierr.CodeUpstreamUnknown},
	GitBranchUpstreamUnset: {apierr.CodeJobBusy, apierr.CodeNotLocalBranch, apierr.CodeNoUpstream},
	GitBranchPush:          {apierr.CodeJobBusy, apierr.CodeNotLocalBranch},
	GitBranchFetch:         {apierr.CodeJobBusy, apierr.CodeNotRemoteBranch},
	GitBranchDelete:        {apierr.CodeJobBusy, apierr.CodeNotLocalBranch, apierr.CodeBranchCurrent},
	GitBranchDeleteRemote:  {apierr.CodeJobBusy, apierr.CodeNotRemoteBranch},
	GitBranchDeleteBoth: {apierr.CodeJobBusy, apierr.CodeNoUpstream, apierr.CodeNoTrackingBranch,
		apierr.CodeManyTrackingBranch, apierr.CodeBranchCurrent},

	// 대화상자 입력 (GV-c)
	GitTagCreate:   {apierr.CodeTagKindInvalid, apierr.CodeTagMessageRequired},
	GitStashBranch: {apierr.CodeEmptyName, apierr.CodeRefName, apierr.CodeBranchExists},
	GitRemoteAdd: {apierr.CodeEmptyName, apierr.CodeRemoteNameInvalid, apierr.CodeEmptyURL,
		apierr.CodeRemoteURLInvalid, apierr.CodeRemoteExists},
	GitCompare: {apierr.CodeEmptyRev, apierr.CodeEmptyPath},
	GitRepoAdd: {apierr.CodeEmptyPath, apierr.CodeAbsPathNeeded, apierr.CodeNotRepo, apierr.CodeRepoMissing},

	FSRename:   fsProtected(fsMissing...),
	FSMove:     fsProtected(fsMissing...),
	FSCopy:     fsMissing,
	FSDelete:   fsProtected(append(fsMissing, apierr.CodeTooManyEntries)...),
	FSName:     {apierr.CodeEmptyName, apierr.CodeNameHasSeparator, apierr.CodeNameReserved},
	EntityName: {apierr.CodeNameTooLong},

	RunClose:        {apierr.CodeRunClosed},
	RunDelete:       {},
	RunMemberDetach: {apierr.CodeMemberNotAttached},
	EditorAdd: {apierr.CodeEmptyPath, apierr.CodeAbsPathNeeded, apierr.CodeNotFound, apierr.CodeNotADirectory,
		apierr.CodeFilesystemRootProtected},

	SandboxRuntimeStart: {apierr.CodeRuntimeMissing, apierr.CodeRuntimeStartManual},
}

// fsMissing 은 대상을 읽지 못한 사유다 — 파일 표면의 os 오류 표(`apierr.FS`)가 낸다.
var fsMissing = []string{apierr.CodeNotFound, apierr.CodePermission, apierr.CodeIO}

// fsProtected 는 보호 판정(루트·홈·파일시스템 루트)의 사유에 그 동작의 사유를 잇는다.
func fsProtected(more ...string) []string {
	return append([]string{apierr.CodeEditorRootProtected, apierr.CodeHomeProtected,
		apierr.CodeFilesystemRootProtected}, more...)
}
