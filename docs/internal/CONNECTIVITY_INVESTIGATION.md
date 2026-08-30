# 조사 노트: 간헐적 접속 불가 (Tailscale 원격 · SSH 포함)

> **이것은 SRS 가 아니다.** 원인이 확정되지 않았고 사용자가 "지금은 조사만" 을
> 택했으므로 요구사항도 설계도 적지 않는다. 확정한 사실과, 다음 발생 때 무엇을
> 봐야 하는지만 적는다. 원인이 서면 그때 SRS 를 연다.

접수한 말:

> **"한번씩 접근이 안돼. 테일스케일을 이용해서 원격으로 접속 중인데 한번씩 서버에
> 접속이 안되고 어쩔때는 ssh 를 이용해서도 접근이 안될 때가 있어."**

`RECONNECT_STORM_SRS.md` 가 다룬 것과 **말이 겹치지만 같다고 단정할 수 없다.**
저쪽은 "dongminal 에 접속이 안 된다" 였고 이번에는 **SSH 까지 안 된다**. SSH 는
dongminal 과 아무 관계가 없는 별개의 데몬이므로, 그것까지 끊긴다면 원인은 프로세스
하나가 아니라 **호스트나 네트워크 계층**에 있다.

---

## 1. 확정한 사실 (2026-08-30 14:40~14:45 실측)

### 1.1 재연결 폭주는 **여전히 돌고 있다** — 다만 크기가 줄었다

`/tmp/dongminal.log`:

```
14:41:26.120674 ws connected addr=100.117.248.111:56776 tool=01a04d3b-f9bc-7000-a92a-621da644fef1
14:41:26.500775 ws addr=100.117.248.111:56773: tool 01a04d3b-… not found (sent toolhub.OpExit)
14:41:26.500852 http GET /ws 200 2.003s addr=100.117.248.111:56773
```

65초 표본에서 **없는 도구 다섯**을 각각 120~122회씩 부르고 있었다. 부르는 쪽은
로컬 탭(`[::1]`)과 Tailscale 피어(`100.117.248.111`) 둘 다다.

`GET /ws 200 2.0s` 의 2초는 `ws_miss.go` 의 `MissDelay` 다 — **방어가 작동 중**
이라는 증거다.

| 지표 | RECONNECT_STORM 관측 (08-30 10:05) | 이번 (08-30 14:45) |
|---|---|---|
| TIME_WAIT (:58146) | **2,881** | **164** |
| ESTABLISHED | — | 79 |
| 로그 크기 | 4.17 GB | 36 MB (로테이션 작동) |

FR-RCS-1·3(클라이언트)과 FR-RCS-9(서버 지연)가 규모를 **17분의 1** 로 줄였다.
그러나 **멎지는 않았다** — 그 SRS 가 스스로 적어 둔 이유대로다. 클라이언트 수정은
이미 열려 있는 탭에 닿지 않고, 그 탭은 사람이 닫기 전까지 남는다.

### 1.2 절전은 원인이 아니다

```
$ pmset -g custom
AC Power:
 sleep                0
 powernap             1
 tcpkeepalive         1
 womp                 1
```

AC 전원에서 시스템 절전이 꺼져 있다. `pmset -g` 에 보이는 `caffeinate` 도
dongminal 이 아니라 **Claude Code 가 띄운 것**이다 (`caffeinate -i -t 300`, 부모가
`claude`). 즉 절전 방지는 부수적으로 걸려 있을 뿐이고, 그것이 없어도 잠들지 않는다.

### 1.3 Tailscale 은 프록시를 거치지 않는다

```
$ tailscale serve status
No serve config
```

서버는 `0.0.0.0:58146` 에 직접 바인드하고, 피어는 `direct` 연결이다(릴레이 아님).
`MagicDNSSuffix` 는 `tail5da9ae.ts.net` 이고 `CertDomains` 는 `null` — HTTPS 는
켜져 있지 않다.

### 1.4 데몬이 둘 떠 있다

```
$ ps aux | grep dongminal
dykim  32032  … /Users/dykim/personal/dongminal/dongminal d        (14:39 기동)
dykim  95591  … /Users/dykim/personal/dongminal/dongminal d        (금요일 20시 기동)
```

`95591` 은 **사흘 가까이 살아 있는 옛 데몬**이다. `~/.dongminal` 에 소켓·pid 파일이
두 벌(`paned.*` / `paneld.*`) 있는 것과 함께 봐야 한다. 이것이 증상과 관계있는지는
**확인되지 않았다** — 다만 "하나만 살아 있어야 할 것이 둘"이므로 기록한다.

---

## 2. 아직 확정되지 않은 것

**SSH 까지 끊기는 이유.** §1.1 의 규모(초당 15연결 수준, TIME_WAIT 164)로는
macOS 의 임시 포트 16,384 개가 마르지 않는다. RECONNECT_STORM §2.2 가 설명한
고갈 경로는 **폭주가 초당 95연결이던 때**의 것이다. 지금 크기로 그 설명을 그대로
가져다 쓸 수 없다.

그러므로 남은 가설은 셋이고, 셋 다 근거가 없다:

| 가설 | 확인 방법 |
|---|---|
| 폭주가 **간헐적으로 다시 커진다** (탭을 여럿 열었을 때 등) | 발생 시점의 연결 수·로그 유입률 |
| Tailscale 세션·NAT 매핑 문제 (direct → DERP 전환 실패, 키 갱신) | `tailscale netcheck`, `tailscale status`, `tailscaled` 로그 |
| 홈 네트워크·ISP (공유기 NAT 테이블, 상대 회선) | 같은 순간 다른 경로(LAN, 다른 피어)로 닿는지 |

---

## 3. 다음 발생 때 볼 것

**끊긴 그 순간에 찍어야 의미가 있다.** 복구된 뒤의 값은 아무것도 말하지 않는다.
아래를 그 자리에서 실행한다 — 서버 쪽 화면에 닿을 수 있으면 서버에서, 아니면
클라이언트 쪽에서 닿는 데까지.

```sh
# ── 클라이언트(끊긴 쪽)에서 ──
tailscale status                 # 피어가 active 인가, direct 인가 DERP 인가
tailscale ping <서버호스트>       # 경로가 서는가
tailscale netcheck               # UDP 차단·NAT 종류
nc -vz <서버 100.x 주소> 22       # SSH 포트만 따로
nc -vz <서버 100.x 주소> 58146    # dongminal 포트만 따로

# ── 서버에서 (닿는다면) ──
netstat -an | grep 58146 | awk '{print $6}' | sort | uniq -c   # 상태별 소켓 수
sysctl net.inet.ip.portrange.first net.inet.ip.portrange.last  # 임시 포트 범위
tail -200 /tmp/dongminal.log                                    # 그 순간의 유입
log show --last 10m --predicate 'process == "tailscaled"' | tail -50
```

**가르는 지점**

| 관측 | 뜻 |
|---|---|
| SSH 는 되는데 58146 만 안 된다 | dongminal 쪽 문제다. §1.1 의 폭주를 다시 잰다 |
| 둘 다 안 되는데 `tailscale ping` 은 선다 | 호스트의 소켓·포트 고갈. `netstat` 집계가 근거 |
| `tailscale ping` 도 안 선다 | 네트워크 계층. dongminal 밖이다 |
| `netcheck` 가 UDP 차단·hard NAT 를 보고한다 | 경로가 DERP 로 떨어졌거나 아예 못 선 것 |

---

## 4. 지금 당장 줄일 수 있는 것 (사용자 판단 대기)

원인 확정과 별개로, §1.1 의 폭주는 **원인 후보 하나를 확실히 지우기 위해서라도**
멎히는 편이 낫다. 지금 할 수 있는 것은 둘이다.

1. **폭주하는 옛 탭을 찾아 닫거나 새로고침한다.** 사람이 하는 일이고 코드가 필요
   없다. 로그의 `addr=` 로 어느 클라이언트인지는 알 수 있으나 어느 탭인지는
   알 수 없다 — 그 클라이언트의 dongminal 탭을 전부 새로고침하면 된다.
2. **서버가 되풀이 미스를 지연이 아니라 차단으로 올린다.** 지금은 2초 지연이라
   폭주가 초당 0.5회로 줄 뿐 멎지 않는다. 임계를 넘은 도구 id 에 대해 upgrade 를
   거절하면 옛 탭도 스스로 멎는다. **코드 변경이므로 사용자 승인이 필요하다** —
   RECONNECT_STORM D-6 이 "바르게 행동하는 쪽을 망가뜨리지 않는다" 는 이유로
   거절 대신 지연을 택했으므로, 그 결정을 뒤집는 셈이다.

사용자는 "지금은 조사만" 을 택했다. 위 둘은 **제안으로만 남기고 실행하지 않는다.**
