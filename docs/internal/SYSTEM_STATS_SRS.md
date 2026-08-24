# SRS: 시스템 지표 수집 재설계 — 프로세스 fork 제거 · 메모리 계산 정정 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

상태바 지표 수집(`getStats`)이 매 HTTP 요청마다 외부 프로세스 6개를 fork 하고 요청당
1.5초를 소비하는 구조를 제거한다. 근본 원인은 하나다 — **커널이 직접 제공하는 값을
사람이 읽는 CLI 출력을 파싱해 얻고 있고, 그 수집을 요청 경로에 동기로 묶어 두었다.**

부수적으로, 같은 함수의 메모리 계산식이 사용량을 5배 과대평가하는 것을 정정한다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| A | CPU·메모리·부팅시각 수집을 mach/sysctl 직접 호출로 교체 (외부 프로세스 6 → 0) |
| B | 수집을 백그라운드 샘플러로 분리. `/api/stats` 는 메모리 스냅샷만 반환 |
| C | 메모리 사용량 계산식 정정 (동작 변경 — §7 기록) |
| D | 클라이언트 폴링의 탭 가시성 게이팅 |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **지표** | `getStats()`(`internal/server/handlers_api.go:75`) 가 반환하는 7개 값. `hostname` `cpu` `memUsed` `memTotal` `diskPct` `sysUptime` `srvUptime` |
| **샘플러** | 지표를 주기적으로 갱신하는 서버 goroutine (본 SRS 로 신설) |
| **샘플 주기** | 샘플러가 커널 값을 읽는 간격. 클라이언트 폴링 주기(`statsInterval`)와 별개 |
| **tick 차분** | `HOST_CPU_LOAD_INFO` 의 누적 CPU tick 을 두 시점에 읽어 차를 구하는 것. CPU% 는 차분 없이 산출 불가 |
| **듀티 사이클** | 단위 시간 중 `top` 프로세스가 살아 있는 시간의 비율 |

### 1.4 참고 (References)

- `docs/internal/architecture.md` — 서버 구조
- `internal/server/handlers_api.go:75-135` — 현재 `getStats()`
- `internal/server/handlers_api.go:632-635` — `apiStats` 핸들러
- `web/js/app.js:2295-2312` — 클라이언트 폴링 (`_startStatsPoll` / `_pollStats`)
- `web/js/helpers.js:99` — `statsInterval` 기본값 3000ms
- `internal/server/attn_tracker.go:81` — 기존 서버 측 주기 goroutine 선례 (`time.NewTicker`)
- Apple `mach/mach_host.h` — `host_statistics(HOST_CPU_LOAD_INFO)`, `host_statistics64(HOST_VM_INFO64)`

본 문서의 파일:라인 인용은 **2026-08-24 작업 트리 기준**이다. 작성 시점에
`internal/server/handlers_api.go` 는 다른 트랙(`mcptool` → `toolaccess` 리팩터)에서
수정 중(`M`)이었으므로, 착수 시 라인 번호가 이동했을 수 있다. 심볼명(`getStats`,
`apiStats`, `_pollStats`)으로 찾는 편이 안전하다.

### 1.5 개요 (Overview)

§2 실측된 현황, §3 요구사항, §4 검증, §5 비목표, §6 구현 계획, §7 동작 변경 기록,
§8 열린 결정.

---

## 2. 현황 (Identified Issue)

### 2.1 요청당 외부 프로세스 6개

`handlers_api.go:75-135` 의 `getStats()` 는 지표 7개를 얻기 위해 다음을 실행한다.

| 지표 | 현재 방식 | fork 되는 프로세스 |
|---|---|---|
| `cpu` | `exec.Command("bash","-c",`top -l 1 -n 0 \| grep "CPU usage"`)` | bash, top, grep (3) |
| `memTotal` | `exec.Command("sysctl","-n","hw.memsize")` | sysctl (1) |
| `memUsed` | `exec.Command("vm_stat")` | vm_stat (1) |
| `sysUptime` | `exec.Command("sysctl","-n","kern.boottime")` | sysctl (1) |
| `diskPct` | `syscall.Statfs("/")` | **0** — 이미 올바른 방식 |
| `hostname` | `os.Hostname()` | 0 |
| `srvUptime` | `time.Since(s.started)` | 0 |

`diskPct` 만이 커널을 직접 호출한다. 나머지 5개 지표가 6개 프로세스를 만든다.

### 2.2 요청당 1.5초 — 듀티 사이클 50%

실측(`curl -w %{time_total}`, 로컬):

```
stats 1.423995s   stats 1.591823s   stats 1.796843s   stats 1.493919s   stats 1.487087s
ping  0.000425s
```

`/api/stats` 가 **1.42~1.80초**다. 전량이 `top -l 1 -n 0` 에서 나온다 — 같은 명령을
셸에서 직접 재면 `real 1.59 / 1.71 / 1.51` 이다. `top` 은 `-l 1` 이어도 첫 표본을
확정하기 위해 1초 이상 머문다.

클라이언트 폴링 주기는 3000ms(`helpers.js:99`)다. 즉 **탭 하나만 열어도 시간의 약
50% 동안 `top` 프로세스가 존재한다.** Activity Monitor 에서 `top` 이 상시 보이는 이유가
이것이다. 관측된 `top` 순간 점유율은 26.3%였다.

### 2.3 캐시·singleflight 부재 → 클라이언트 수에 비례

`apiStats` 는 `getStats()` 를 무조건 호출한다.

```go
func (s *Server) apiStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.getStats())
}
```

캐시도 `sync.Once` 도 singleflight 도 없다(`grep -n "CommandContext\|sync.Once\|cache\|singleflight" handlers_api.go` → 결과 없음). 클라이언트 N개는 `top` N개를 동시에 만든다.
실측으로 탭 2개 상태에서 `pgrep -f "top -l 1" | wc -l` 이 **2** 를 반환했다.

폴링 주기(3s)가 수집 시간(1.5s)의 2배뿐이므로, 탭 2개면 `top` 이 사실상 상시 1개
이상 존재한다.

### 2.4 타임아웃 부재

5개 `exec.Command` 모두 `exec.CommandContext` 가 아니다. `top` 이 멈추면 해당 요청
goroutine 이 무한 대기하고, 폴링이 계속되므로 goroutine 이 누적된다.

### 2.5 메모리 사용량이 5배 과대평가된다

`handlers_api.go:94-108` 은 `vm_stat` 에서 `Pages free` 와 `Pages inactive` 만 읽어
`memUsed = memTotal - (free + inactive) * 4096` 으로 계산한다.

같은 시점에 두 계산식을 비교하면:

```
host_statistics64 원값: free=0.11 active=2.21 inactive=2.17 wired=0.77 comp=3.19 purge=0.04 GB
현재 dongminal 식: used=32.08GB / total=34.36GB  (93.4%)
정확한 식(wired+active+compressed): used=6.17GB / total=34.36GB  (18.0%)
```

**75%p 차이**다. macOS 는 유휴 페이지를 free 로 두지 않고 active/compressed/purgeable
로 분류하므로 `free` 가 0.11GB 까지 내려간다. `free + inactive` 를 가용으로 보는 것은
성립하지 않고, 결과적으로 상태바는 상시 90%대를 표시한다.

### 2.6 커널 직접 호출은 검증되었다

대체 방식 3종을 실측했다.

| 방식 | 소요 | fork | CPU% 정확도 |
|---|---|---|---|
| 현재 `top` 파이프라인 | 1500ms | 3 | 기준값 |
| `ps -A -o %cpu` 합산 | 10~20ms | 2 | 프로세스별 감쇠 평균의 합 — 코어 정규화 안 됨 |
| **cgo `host_statistics`** | **769ns** | **0** | tick 차분 — 커널 원값 |

`host_statistics(HOST_CPU_LOAD_INFO)` 는 호출 1회 **538~769ns**, `host_statistics64(HOST_VM_INFO64)` 는 **10µs**, `syscall.Sysctl("kern.boottime")` 는 **7µs**, 모두 fork 0개다.
`top` 대비 약 300만 배 빠르다.

### 2.7 프로젝트는 사실상 darwin 전용이나 그렇게 선언되어 있지 않다

빌드 태그(`//go:build`)를 쓰는 파일이 없고, `hw.memsize` · `kern.boottime` · `vm_stat`
등 darwin 전용 API 를 5곳에서 빌드 태그 없이 사용한다. linux 에서 컴파일은 되지만
런타임에 지표가 0으로 떨어진다. cgo 도입 판단의 전제로 기록한다(§8 D-1).

### 2.8 백그라운드 탭도 계속 폴링한다

`_startStatsPoll`(`app.js:2295`)은 `setInterval` 만 걸고 `visibilitychange` 를 보지
않는다. 탭이 가려져 지표가 보이지 않는 동안에도 3초마다 수집이 발생한다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 커널 직접 호출

- **FR-STAT-1** `cpu` 는 `host_statistics(HOST_CPU_LOAD_INFO)` 의 누적 tick 을 두 시점에
  읽어 `busy = user + system + nice`, `total = busy + idle` 의 차분으로 산출한다.
  외부 프로세스를 fork 하지 않는다.
- **FR-STAT-2** `memTotal` 은 `syscall.Sysctl("hw.memsize")` 로 얻는다. `sysctl` 프로세스를
  fork 하지 않는다.
- **FR-STAT-3** `memUsed` 는 `host_statistics64(HOST_VM_INFO64)` 로 얻는다. `vm_stat`
  프로세스를 fork 하지 않는다.
- **FR-STAT-4** `sysUptime` 은 `syscall.Sysctl("kern.boottime")` 로 얻는다. `sysctl`
  프로세스를 fork 하지 않는다.
- **FR-STAT-5** `diskPct` `hostname` `srvUptime` 의 수집 방식은 변경하지 않는다.
- **FR-STAT-6** 위 변경 후 `getStats()` 경로에 `os/exec` 호출이 0개여야 한다.
- **FR-STAT-7** 커널 호출이 `KERN_SUCCESS` 가 아니면 해당 지표만 마지막 유효값을
  유지하고, 유효값이 없으면 응답에서 그 키를 생략한다. 다른 지표 수집을 중단하지 않는다.

### 3.2 묶음 B — 백그라운드 샘플러

- **FR-STAT-8** 서버는 지표를 갱신하는 goroutine 1개를 서버 수명 동안 운영한다. 기존
  선례(`attn_tracker.go:81`)의 `time.NewTicker` 패턴을 따른다.
- **FR-STAT-9** `/api/stats` 핸들러는 커널을 호출하지 않는다. 샘플러가 갱신한 스냅샷을
  잠금 하에 복사해 반환한다.
- **FR-STAT-10** `/api/stats` 응답 시간은 클라이언트 수와 무관하게 **10ms 이하**여야 한다.
- **FR-STAT-11** 커널 호출 횟수는 접속 클라이언트 수와 무관하게 샘플 주기당 1회여야 한다.
- **FR-STAT-12** CPU% 는 tick 차분을 필요로 하므로, 샘플러는 시작 즉시 기준 tick 을 1회
  읽고 첫 주기 경과 후부터 유효한 `cpu` 를 제공한다. 그 이전 요청에는 FR-STAT-7 을 적용한다.
- **FR-STAT-13** 서버 종료 시 샘플러 goroutine 은 누수 없이 종료된다.
- **FR-STAT-14** `os/exec` 가 남는 경로가 있으면 `exec.CommandContext` 로 타임아웃을
  건다. 묶음 A 를 완수하면 해당 경로는 없다.

### 3.3 묶음 C — 메모리 계산식 정정

- **FR-STAT-15** `memUsed` 는 `(wire_count + active_count + compressor_page_count) × page_size`
  로 산출한다. `free` 와 `inactive` 를 기준으로 역산하지 않는다.
- **FR-STAT-16** 페이지 크기를 4096 으로 하드코딩하지 않고 커널이 보고하는 값을 쓴다.
  (현재 `handlers_api.go:106` 은 `4096` 리터럴이다.)

### 3.4 묶음 D — 클라이언트 폴링 게이팅

- **FR-STAT-17** 문서가 `document.hidden` 인 동안 클라이언트는 `/api/stats` 폴링을
  중단하고, 다시 보이면 즉시 1회 수집한 뒤 정상 주기를 재개한다.
- **FR-STAT-18** `/api/ping` 의 지연 측정 동작은 변경하지 않는다. `ping` 과 `stats` 를
  분리한 현재 구조를 유지한다(`app.js:2301` 주석의 의도).

---

## 4. 검증 (Verification)

| ID | 검증 방법 | 합격 기준 |
|---|---|---|
| V-1 | FR-STAT-6 — `grep -n "exec.Command" internal/server/handlers_api.go` | `getStats` 경로에 0건 |
| V-2 | FR-STAT-10 — `curl -w "%{time_total}"` ×5 | 전부 ≤ 0.010s |
| V-3 | FR-STAT-11 — 탭 3개 접속 후 `pgrep -f "top -l 1" \| wc -l` | 0 |
| V-4 | FR-STAT-1 정확도 — 동일 시점에 신방식과 `top -l 2` 2번째 표본을 교차 측정 | 절대차 ≤ 5%p |
| V-5 | FR-STAT-15 — 신방식 `memUsed` 와 Activity Monitor "사용된 메모리" 비교 | 절대차 ≤ 5% |
| V-6 | FR-STAT-12 — 서버 기동 직후 `/api/stats` 즉시 호출 | 500 아님. `cpu` 는 생략되거나 유효값 |
| V-7 | FR-STAT-13 — 서버 기동/종료 반복 후 goroutine 수 | 증가 없음 |
| V-8 | FR-STAT-7 — 커널 호출 실패를 주입 | 나머지 지표가 정상 반환됨 |
| V-9 | FR-STAT-17 — 탭을 백그라운드로 전환하고 네트워크 탭 관찰 | `/api/stats` 요청 중단 |
| V-10 | 회귀 — 기존 `handlers_api_test.go` | 전부 통과 |

단위 테스트는 커널 호출을 인터페이스로 분리해 주입 가능하게 한 뒤 작성한다. 실제 커널
값에 의존하는 단정(assertion)은 결정론적이지 않으므로 범위 검사(0 ≤ cpu ≤ 100 등)로
한정한다.

### 4.1 실측 결과 (2026-08-24, 구현 완료)

| ID | 결과 |
|---|---|
| V-1 | **통과** — `handlers_api.go` 의 `exec.Command` 0건. `internal/server/handlers_stats_test.go` 의 `TestStats_NoExecInSource` 가 회귀를 막는다 |
| V-2 | **통과** — 실서버 실측 `0.00026 ~ 0.0012s` (교체 전 1.42~1.80s). 약 2000~5000배 |
| V-3 | **통과** — `/api/stats` 30회 동시 요청 중 서버 자식 프로세스 0개 (6회 관측). `top` 프로세스 0개 |
| V-4 | **통과 (조건부)** — 10코어 전량 포화 부하에서 정확히 `100%`, 부하 제거 후 11~40% 정상 추종. `top -l 2` 와의 단발 비교는 3/4 가 5%p 이내였고 1건이 12.5%p 였는데, 이는 **측정 창 불일치**다 (우리는 2s tick 차분, `top` 은 마지막 ~1s). raw tick 델타 확인 결과 `dTotal ≈ 998/초` = 10코어 × 100Hz 로 코어 전체 합산이 맞고 `dIdle` 도 정상 증가한다 |
| V-5 | **부분** — 계산식은 독립 재현과 일치 (우리 23.24GB vs `vm_stat` 원값 직접 계산 23.22GB). Activity Monitor 대조는 수동 확인 대상 |
| V-6 | **통과** — `TestStats_ColdStartHasNoCPU`. 기동 직후 `cpu` 키만 생략되고 나머지는 유효 |
| V-7 | **통과** — `TestSampler_StopsOnChannelClose` (`-count=3`) |
| V-8 | **통과** — `TestSampler_PartialFailureIsolated`, `TestSampler_KeepsLastValidOnFailure`, `TestSampler_UnsupportedIsNotFatal` |
| V-9 | **미실행** — 수동 확인 대상 (브라우저 네트워크 탭) |
| V-10 | **통과** — `go test ./...` 전량, `go vet`, `gofmt -l` 0건 |

**§2.5 를 넘는 추가 발견 — 페이지 크기 하드코딩**: 이 머신의 페이지 크기는 **16384**
(Apple Silicon)이다. 구 코드의 `4096` 리터럴은 free 페이지를 4배 적게 계산해 `memUsed`
를 부풀리는, free/inactive 역산과 **독립된 두 번째 버그**였다. FR-STAT-16 이 이미 이를
요구하고 있었고 구현은 `host_page_size` 를 읽는다.

동일 시점 실측 (32GiB 머신, 부하 있는 상태):

```
page_size=16384
구 계산식: 29.95GB / 32.00GB = 93.6%
신 계산식: 23.22GB / 32.00GB = 72.6%
```

§2.5 의 수치(93.4% → 18.0%)와 절대값이 다른 것은 측정 시점의 실제 메모리 사용량 차이다
(그때는 6.17GB 사용). 계산식 자체는 동일하다.

**빌드 조합 검증** — `go build`(cgo), `CGO_ENABLED=0 go build`,
`CGO_ENABLED=0 GOOS=linux go build` 세 조합 모두 통과. §8.1 의 cgo 격리가 성립한다.

---

## 5. 비목표 (Non-goals)

- 지표 항목의 추가·삭제. 7개 키와 JSON 스키마는 그대로 둔다(`memUsed` 의 **값**만 정정).
- linux/windows 지원. §2.7 의 현황을 바꾸지 않는다.
- `statsInterval` 기본값 변경. 폴링 주기 정책은 손대지 않는다.
- `/api/ping` 변경.
- 상태바 UI·레이아웃 변경.
- 서버→클라이언트 push(WebSocket) 로의 전환. 폴링 구조를 유지한다.

---

## 6. 구현 계획 (Implementation Plan)

순서에 의존성이 있다. Spec → Test → Code 를 묶음마다 적용한다.

| 단계 | 작업 | 선행 |
|---|---|---|
| 1 | §8 열린 결정 D-1(cgo) · D-2(메모리 정의) 해소 | — |
| 2 | 커널 호출을 인터페이스로 추상화한 신규 파일 (`internal/sysstat/`) + 단위 테스트 | 1 |
| 3 | 묶음 A — `getStats()` 를 신규 패키지 호출로 교체, `exec` 제거 | 2 |
| 4 | 묶음 C — 메모리 계산식 정정 (묶음 A 와 같은 함수라 동시 수행 가능) | 2 |
| 5 | 묶음 B — 샘플러 goroutine + 스냅샷, `apiStats` 를 스냅샷 반환으로 | 3, 4 |
| 6 | 묶음 D — `visibilitychange` 게이팅 | 독립 |
| 7 | V-1~V-10 검증, §7 동작 변경 기록 확정 | 5, 6 |

**단계 3~4 를 단계 5 보다 먼저 하는 이유:** 커널 호출로 바꾸면 수집이 1.5초에서 1ms
미만이 되므로, 샘플러 없이도 FR-STAT-10 이 사실상 충족된다. 샘플러(단계 5)는 그 위에서
FR-STAT-11(클라이언트 수 무관 1회)을 위한 것이다. 순서를 뒤집으면 1.5초 수집을 감싼
샘플러를 만든 뒤 다시 걷어내야 한다.

**검증된 참조 구현** — 스크래치 프로토타입으로 아래를 확인했다(§2.6). 구현 시 그대로
차용 가능하다.

```go
/*
#include <mach/mach.h>
#include <mach/mach_host.h>
*/
import "C"

// CPU: 누적 tick. 두 시점 차분으로 % 산출.
var info C.host_cpu_load_info_data_t
count := C.mach_msg_type_number_t(C.HOST_CPU_LOAD_INFO_COUNT)
kr := C.host_statistics(C.host_t(C.mach_host_self()), C.HOST_CPU_LOAD_INFO,
	C.host_info_t(unsafe.Pointer(&info)), &count)
// info.cpu_ticks[C.CPU_STATE_USER / SYSTEM / IDLE / NICE]

// 메모리: vm_statistics64_data_t
var vm C.vm_statistics64_data_t
count = C.mach_msg_type_number_t(C.HOST_VM_INFO64_COUNT)
kr = C.host_statistics64(C.host_t(C.mach_host_self()), C.HOST_VM_INFO64,
	C.host_info64_t(unsafe.Pointer(&vm)), &count)
// vm.free_count / active_count / inactive_count / wire_count
//   / compressor_page_count / purgeable_count

// 부팅 시각·총 메모리: fork 없이
syscall.Sysctl("kern.boottime")   // 7µs, len=15 (struct timeval)
syscall.Sysctl("hw.memsize")      // little-endian uint64 파싱
```

`scripts/start.sh:94` 와 `scripts/migrate.sh:78` 의 `go build` 는 `CGO_ENABLED` 를 명시하지
않으므로 네이티브 빌드에서 기본값 1 이 적용된다. D-1 을 cgo 채택으로 결정하면 스크립트
변경 없이 빌드되지만, 의도를 드러내기 위해 명시하는 편이 낫다.

---

## 7. 동작 변경 기록 (Behavior Change)

### 7.1 메모리 사용량 표시 (FR-STAT-15)

| 항목 | 내용 |
|---|---|
| **이전 동작** | `memUsed = memTotal − (free + inactive) × 4096`. 실측 32.08GB / 93.4% |
| **새 동작** | `memUsed = (wired + active + compressed) × page_size`. 실측 6.17GB / 18.0% |
| **이유** | macOS 는 유휴 페이지를 free 로 두지 않는다(실측 free=0.11GB). `free + inactive` 를 가용으로 보는 계산은 speculative·purgeable·external page cache 를 무시해 사용량을 과대평가하고, 그 결과 상태바가 상시 90%대를 표시한다. Activity Monitor 의 "사용된 메모리" 정의에 맞춘다 |

사용자에게는 상태바 MEM 수치가 갑자기 크게 낮아지는 것으로 보인다. 릴리스 노트에 기록
대상이다.

### 7.2 지표 신선도 (FR-STAT-8, FR-STAT-9)

| 항목 | 내용 |
|---|---|
| **이전 동작** | 요청 시점에 동기 수집. 응답값은 항상 "1.5초 전에 시작한 측정" |
| **새 동작** | 샘플러가 갱신한 최신 스냅샷. 최대 샘플 주기만큼 오래된 값일 수 있다 |
| **이유** | 요청당 프로세스 6개와 1.5초 지연을 제거하고, 클라이언트 수에 비례하는 부하를 없애기 위함 |

샘플 주기를 클라이언트 폴링 주기(기본 3s) 이하로 두면 체감 신선도는 현재와 같거나 낫다
(현재 값은 이미 1.5초 지연을 포함한다).

### 7.3 기동 직후 CPU 값 (FR-STAT-12)

| 항목 | 내용 |
|---|---|
| **이전 동작** | 첫 요청도 `top` 을 실행하므로 즉시 유효값 |
| **새 동작** | tick 차분이 성립하는 첫 주기 이전에는 `cpu` 키가 생략될 수 있다 |
| **이유** | CPU% 는 누적 tick 의 차분으로만 얻을 수 있다. 단일 시점 tick 에는 순간 사용률 정보가 없다 |

클라이언트 `_updateStatusBar`(`app.js:2313`)는 이미 `this._stats.cpu!==undefined` 를
검사하므로 키 생략을 견딘다. 프론트 변경은 필요하지 않다.

---

## 8. 열린 결정 (Open Decisions)

| ID | 결정 사항 | 선택지 | 권장 |
|---|---|---|---|
| **D-1** | cgo 도입 | (a) cgo + mach 호출 — 정확·fork 0·538ns. `CGO_ENABLED=1` 필요, 크로스컴파일 제약 (b) 순수 Go + `sysctl vm.loadavg` — cgo 0·fork 0 이나 지표 의미가 CPU% 가 아니라 로드 평균이므로 §5 비목표(지표 항목 유지)에 위배 (c) `ps -A -o %cpu` 합산 — cgo 0·fork 2·10~20ms, 코어 정규화 안 된 근사값 | **(a)**. §2.7 대로 이미 darwin 전용이고 로컬 네이티브 빌드만 하므로 실질 제약이 없다. (b)는 지표를 바꿔야 하고 (c)는 정확도를 잃는다 |
| **D-2** | 메모리 "사용량" 정의 | (a) `wired + active + compressed` — Activity Monitor 기준 (b) `wired + active + inactive + compressed` — inactive 포함, 더 큰 값 (c) 현행 유지 | **(a)**. 사용자가 Activity Monitor 와 대조할 값이다 |
| **D-3** | 샘플 주기 | (a) 서버 고정 2s (b) 클라이언트 `statsInterval` 최솟값에 연동 (c) 설정 노출 | **(a)**. 커널 호출이 µs 단위라 주기를 짧게 둘 여유가 크고, (b)는 클라이언트 상태를 서버가 추적해야 해 복잡도가 늘어난다 |
| **D-4** | 접속 클라이언트가 0일 때 샘플러 | (a) 계속 돌린다 (b) 유휴 시 정지 | **(a)**. µs 단위 비용이라 정지 로직의 복잡도가 이득보다 크다 |
| **D-5** | `internal/sysstat/` 신설 vs `internal/server/` 내부 파일 | — | **신설**. cgo 를 한 패키지에 격리하면 나머지 패키지의 빌드·테스트가 cgo 에 묶이지 않는다 |

### 8.1 확정 (2026-08-24)

| ID | 결정 | 근거 |
|---|---|---|
| **D-1** | **(a) cgo + mach 호출** | 사용자 결정 — `top` 을 유지하지 않는다. 남은 선택지 중 (b)는 지표 의미를 CPU% 에서 로드 평균으로 바꿔 §5 비목표(지표 항목 유지)에 위배되고, (c)는 여전히 fork 2개에 코어 정규화가 안 된 근사값이다. 조사 중 제안된 절충안("`top` 을 샘플러 뒤로만 이동")도 같은 결정으로 기각됐다 |
| **D-2** | **(a) `wired + active + compressed`** | 사용자가 Activity Monitor 와 대조할 값. 동작 변경은 §7.1 에 기록됨 |
| **D-3** | **(a) 서버 고정 2s** | 커널 호출이 µs 단위라 짧은 주기의 여유가 크고, 클라이언트 상태 추적을 서버로 끌어들이지 않는다 |
| **D-4** | **(a) 유휴 시에도 계속** | µs 단위 비용이라 정지 로직의 복잡도가 이득보다 크다 |
| **D-5** | **`internal/sysstat/` 신설** | cgo 를 한 패키지에 격리하면 나머지 패키지의 빌드·테스트가 cgo 에 묶이지 않는다 |

**cgo 격리 방식** — D-1 이 cgo 를 도입하지만 저장소 전체가 `CGO_ENABLED=1` 을 요구하게
만들지는 않는다. `internal/sysstat` 안에서 빌드 태그로 분리한다:

| 파일 | 빌드 태그 | 내용 |
|---|---|---|
| `sysstat.go`, `sampler.go` | 없음 | 타입·`Reader` 인터페이스·tick 차분·샘플러 (순수 Go, 모든 플랫폼에서 컴파일·테스트 가능) |
| `reader_darwin.go` | `darwin` | `syscall.Sysctl`(hw.memsize·kern.boottime) + `syscall.Statfs` — cgo 불필요 |
| `mach_darwin_cgo.go` | `darwin && cgo` | `host_statistics` / `host_statistics64` |
| `mach_darwin_nocgo.go` | `darwin && !cgo` | 위 둘만 `ErrUnsupported` — 나머지 지표는 계속 동작 |
| `reader_other.go` | `!darwin` | 전부 `ErrUnsupported` |

`CGO_ENABLED=0` 이나 linux 에서도 빌드가 깨지지 않으며, 사용 불가한 지표는 FR-STAT-7
경로로 응답에서 생략된다. §5 의 "linux 지원 비목표"를 바꾸지 않는다 — 빌드를 깨뜨리지
않을 뿐이다.

---

## 9. 부록 — 본 SRS 와 무관한 관측 (Appendix)

조사 중 확인된 사항으로, dongminal 의 결함이 아니다. 혼동을 막기 위해 기록한다.

체감 CPU 고갈의 실제 원인은 dongminal 이 아니었다. 다른 도구가 남긴 고아 busy-loop
프로세스 8개(PID 37233~37240, `ppid=1`)가 3시간 14분에 걸쳐 각 82~95% 를 점유하고
있었다(합계 약 660%).

```
cd .../.claude/worktrees/graph_dev
for c in 1 2 3 4 5 6 7 8; do (while :; do :; done) & done
LOADPIDS=$(jobs -p)
npx vitest run ...
kill $LOADPIDS 2>/dev/null      # ← 실패
```

비대화형 `zsh -c` 에서는 job control 이 비활성이라 `jobs -p` 가 서브셸 PID 를 반환하지
않는다. `kill` 이 빈 인자로 실패하고 부모 셸이 종료되면서 8개가 고아가 됐다. 2026-08-24
에 `kill -9` 로 정리했다(정리 후 생존 0 확인).

또한 dongminal 이 만드는 페인 셸(`/bin/zsh -l`, `internal/server/tool.go:216`)은 페인당
1개로 설계대로이며 실측 점유율이 모두 0.0% 였다. Activity Monitor 에 보이는 zsh 수십
개의 대부분은 VS Code 통합 터미널 세션(`ppid=884`)으로 dongminal 과 무관하다.

---

## 10. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-08-24 | 초안. §2 전량 로컬 실측, §6 참조 구현 프로토타입 검증 완료. 구현 미착수 |
| 2026-08-24 | §8.1 착수 전 결정 5건 확정 (D-1 cgo, D-2 Activity Monitor 기준, D-3 2s, D-4 상시, D-5 패키지 신설) + cgo 격리 방식 명시 |
| 2026-08-24 | 묶음 A~D 구현 완료. §4.1 실측 결과 추가. 페이지 크기 4096 하드코딩이 독립된 두 번째 버그였음을 기록 |
