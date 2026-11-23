//! 시험. Go `internal/webserver/domain/git/write/*_test.go` 의 포팅이다.

#![allow(clippy::type_complexity)]

mod support;

mod branch;
mod commit;
mod exec_count;
mod ignore;
mod operation;
mod patch;
mod remote;
mod remote_live;
mod resolve;
mod stage;
mod stash;
mod tag;
mod uncommitted;
