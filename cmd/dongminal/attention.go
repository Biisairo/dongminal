package main

import (
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
)

// AGENT_RECORD_DAEMON_SRS 단계 3 — 알람 판정의 조립 (FR-ARD-30~32, §3.3a).

type attnClient interface {
	HasFeature(name string) bool
	AttnConfig(idleMS int64, allowBell bool) error
	Report(method string, body any) error
	Attend(toolID string, typed bool) error
	AttendAll() (int, error)
	SetOnAttn(cb func(ev toolipc.AttnEvent))
}

// daemonAttention 은 httpapi.AttentionDaemon 이다. 판정 여부는 부를 때마다 데몬의 기능을
// 본다 — 다시 붙은 데몬이 옛 판일 수 있다.
type daemonAttention struct{ c attnClient }

func (d daemonAttention) Judges() bool { return d.c.HasFeature(toolipc.FeatureAttention) }

func (d daemonAttention) Report(method string, body any) error { return d.c.Report(method, body) }

func (d daemonAttention) Attend(toolID string, typed bool) error { return d.c.Attend(toolID, typed) }

func (d daemonAttention) AttendAll() (int, error) { return d.c.AttendAll() }

// wireDaemonAttention 은 추적기를 데몬 판정의 거울로 잇고 판정 설정을 보낸다. 다시 붙을
// 때는 syncAttnConfig 를 다시 부른다.
func wireDaemonAttention(c attnClient, tr *hub.AttnTracker) daemonAttention {
	d := daemonAttention{c: c}
	tr.SetMirror(d.Judges)
	c.SetOnAttn(tr.ApplyAttn)
	syncAttnConfig(c)
	return d
}

// syncAttnConfig 는 서버가 읽은 판정 설정을 데몬에 보낸다 (FR-ARD-31). 두 값은 서버가 뜰
// 때 읽는 환경변수라 붙을 때마다 보내면 된다.
func syncAttnConfig(c attnClient) {
	if !c.HasFeature(toolipc.FeatureAttention) {
		return
	}
	idle := toolhub.AttentionIdleThreshold() / time.Millisecond
	if err := c.AttnConfig(int64(idle), toolhub.AttentionAllowBell()); err != nil {
		dmlog.Warnf(nil, "attention: 판정 설정을 데몬에 보내지 못했다: %v", err)
	}
}
