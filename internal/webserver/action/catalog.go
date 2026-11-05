package action

import "dongminal/internal/webserver/apierr"

// Catalog 은 서버가 판정하는 동작 전부와 그 사유다 (M-3). 판정을 더하면 여기에도
// 더한다 — 판정 시험이 MayGive 로 확인하고, 게이트가 이 목록의 문구를 확인한다.
var Catalog = Table{
	GitStashCreate: {apierr.CodeNothingToStash, apierr.CodeUntrackedOnly},

	GitFetch:              {apierr.CodeJobBusy},
	GitPull:               {apierr.CodeJobBusy},
	GitPush:               {apierr.CodeJobBusy},
	GitBranchPush:         {apierr.CodeJobBusy},
	GitBranchFetch:        {apierr.CodeJobBusy},
	GitBranchDeleteRemote: {apierr.CodeJobBusy},
	GitTagPush:            {apierr.CodeJobBusy},
	GitTagDeleteRemote:    {apierr.CodeJobBusy},
	GitWrite:              {apierr.CodeJobBusy},
	GitCommit:             {apierr.CodeJobBusy},
	GitLockRemove:         {apierr.CodeJobBusy},
	GitWorktreeCreate:     {apierr.CodeJobBusy},
	GitSubmoduleUpdate:    {apierr.CodeJobBusy},
	GitWorktreeRemove:     {apierr.CodeJobBusy},
}
