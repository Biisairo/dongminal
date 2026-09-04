# SRS: 언어 서버가 Windows 에서도 발견된다 — IEEE 29148

| 항목 | 값 |
|---|---|
| 문서 | LSP_WINDOWS_PORTABILITY_SRS |
| 선행 | EDITOR_LSP_SRS (FR-LSP-4·7b·10) · CROSS_PLATFORM_SRS (R-1, FR-XPL-5) |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 것은 CI 다. LSP M1~M5 를 푸시하자 `test (windows-latest)` 가 여덟을 냈다.

```
--- FAIL: TestInstall_IsolatesToManagedDir
    설치가 실패했다: {OK:false Reason:go 는 끝났는데 …\bin\gopls 가 놓이지 않았습니다}
--- FAIL: TestLocate_Order
    설정 경로가 이기지 않았다: {Found:true Exe:/usr/bin/gopls Origin:path …}
--- FAIL: TestLocate_IsObservationNotCache
--- FAIL: TestLocate_ManagedLayoutPerTool
--- FAIL: TestService_StatusHonorsOverrides
--- FAIL: TestSession_HandshakeThenSyncThenAsk    자리가 어긋났다: {Path:root\other.go}
--- FAIL: TestSession_PublishDiagnostics          경로가 풀리지 않았다: "root\\a.go"
--- FAIL: TestSession_EmptyDiagnosticsStillNotifies
```

**개발 호스트가 darwin 이라 손으로 확인할 수 없는 자리다** — CROSS_PLATFORM_SRS R-1
이 CI 를 세운 이유가 정확히 이것이고, 그 검사기가 제 일을 했다.

여덟은 두 갈래이며 **한쪽만 제품이다.**

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 |
|---|---|
| **X** 실행 가능 판정 | Windows 에서 실행 가능함은 **권한 비트가 아니라 확장자**다 |
| **N** 전용 디렉터리의 이름 | 설치 도구가 실제로 놓는 파일 이름을 탐색과 설치가 **같이** 안다 |
| **T** 검사의 이식성 | POSIX 절대경로를 박아 둔 세션 검사를 플랫폼에 맞게 짓는다 |

**미포함:** §5 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **PATHEXT** | Windows 가 "실행할 수 있는 확장자" 로 아는 목록. 기본 `.COM;.EXE;.BAT;.CMD` |
| **전용 디렉터리** | `<홈>/lsp/`. 우리가 받은 서버가 사는 곳 (FR-LSP-7) |
| **shim** | npm 이 `node_modules/.bin` 에 놓는 실행 진입점. POSIX 는 심링크, Windows 는 `.cmd`·`.ps1` |

### 1.4 참조 (References)

- [`./EDITOR_LSP_SRS.md`](./EDITOR_LSP_SRS.md) — FR-LSP-4(탐색 순서)·7b(도구마다 다른
  자리)·10(성공의 판정은 종료 코드가 아니라 실행 파일의 존재)
- [`./CROSS_PLATFORM_SRS.md`](./CROSS_PLATFORM_SRS.md) — R-1(개발 호스트에서 볼 수
  없는 것은 CI 가 본다) · FR-XPL-5(`runtime.GOOS` 는 `platform` 안에서만) ·
  FR-XPL-2(소비자는 번들이 아니라 자기가 쓰는 필드 하나를 받는다)

### 1.5 착수 전 확정된 결정

| # | 물음 | 답 |
|---|---|---|
| **I-1** | LSP 는 Windows 를 지원하는가 | **한다.** `session.go` 의 `pathToURI`·`uriToPath` 가 이미 Windows 분기를 갖고 있고 `TestPathURIRoundTrip` 이 이미 Windows 경로를 잰다 — 의도는 처음부터 지원이었고, 빠진 것은 발견 경로다 |
| **I-2** | 실행 가능 판정을 어디에 두는가 | **`platform.Paths`.** OS 마다 갈리는 판단이며, 호출부에 OS 이름이 나타나면 그것은 그 패키지의 실패다 (FR-XPL-5) |

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 `isExecutable` 은 Windows 에서 **언제나 거짓**이다

`install.go`:

```go
func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() { return false }
	return fi.Mode().Perm()&0o111 != 0
}
```

Go 는 Windows 에서 보통 파일에 `0666`(읽기 전용이면 `0444`)을 준다. **실행 비트가
설 자리가 없다.** 그러므로 이 함수는 Windows 에서 모든 경로에 거짓을 낸다.

그 하나가 다섯을 무너뜨린다 — 셋 다 이 판정을 딛기 때문이다.

| 자리 | 무엇이 죽는가 |
|---|---|
| `Locate` ① 설정 | 사용자가 적은 절대경로가 **이기지 못한다** (`TestLocate_Order`) |
| `Locate` ③ 전용 디렉터리 | 우리가 받아 둔 서버를 **못 찾는다** (`TestLocate_IsObservationNotCache`) |
| `Install` 의 성공 판정 | 받아 놓고도 **"놓이지 않았습니다"** 라고 한다 (`TestInstall_…`) |

즉 Windows 에서 이 기능은 **PATH 에 이미 있는 서버 말고는 아무것도 쓰지 못한다.**
받기(FR-LSP-8~11)는 통째로 동작하지 않는다.

### 2.2 전용 디렉터리의 파일 이름이 OS 마다 다르다

`ManagedExe` 는 서술자의 `Exe` 를 그대로 잇는다. 실제로 놓이는 것은 다르다.

| 도구 | POSIX | Windows |
|---|---|---|
| `go install` | `<lsp>/bin/gopls` | `<lsp>\bin\gopls.exe` |
| `npm --prefix` | `<lsp>/node_modules/.bin/<exe>` | `<lsp>\node_modules\.bin\<exe>.cmd` (그리고 `.ps1`) |

FR-LSP-7b 는 **설치와 탐색이 같은 함수로 그 자리를 얻어야 한다**고 적는다. 그
규약은 지켜져 있으나, 그 함수가 아는 것이 POSIX 의 이름뿐이다.

### 2.3 세션 검사가 POSIX 절대경로를 박아 두었다

`session_test.go` 는 `/root/a.go`·`/root/other.go` 를 상수로 쓴다. Windows 에서
`pathToURI("/root/a.go")` → `file:///root/a.go` → `uriToPath` 가 앞 `/` 를 떼어
`root\a.go` 를 낸다.

**변환은 옳다.** Windows 의 진짜 경로는 `C:\root\a.go` 이고, 그 왕복은
`TestPathURIRoundTrip` 이 이미 플랫폼별 입력으로 재고 있다. 틀린 것은 **POSIX
경로를 Windows 에서도 참이라고 가정한 검사** 쪽이다.

---

## 3. 기능 요구사항 (Functional Requirements)

### 3.1 묶음 X — 실행 가능 판정 (FR-LWP-1~4)

- **FR-LWP-1** 실행 가능 판정은 `platform.Paths` 가 갖는다 (I-2). 호출부는 OS 를
  묻지 않는다 (FR-XPL-5).
- **FR-LWP-2** POSIX 의 판정은 **바뀌지 않는다** — 실행 비트가 선 보통 파일.
  권한 없는 동명 파일을 서버로 삼지 않는 규약(TC-LSP-7)이 그대로 살아야 한다.
- **FR-LWP-3** Windows 의 판정은 **확장자**다. `PATHEXT` 를 읽고, 비어 있으면
  `.COM;.EXE;.BAT;.CMD` 를 쓴다. 비교는 대소문자를 가리지 않는다.
- **FR-LWP-4** 어느 쪽이든 **디렉터리는 실행 파일이 아니다.**

### 3.2 묶음 N — 전용 디렉터리의 이름 (FR-LWP-5~7)

- **FR-LWP-5** `ManagedExe` 는 **그 OS 에서 그 도구가 실제로 놓는 이름**을 낸다
  (§2.2). `go` 는 `ExeSuffix`, `npm` 은 Windows 에서 `.cmd` 다.
- **FR-LWP-6** 설치의 성공 판정과 탐색이 **여전히 같은 함수**를 쓴다 (FR-LSP-7b).
  이 판이 바꾸는 것은 그 함수가 아는 이름뿐이며, 두 벌로 갈라지지 않는다.
- **FR-LWP-7** npm 의 자리를 한 이름으로 좁히지 않는다 — `node_modules/.bin` 에는
  OS 마다 다른 shim 이 함께 놓인다. 후보를 순서대로 보고 **먼저 있는 것**을 쓴다.

### 3.3 묶음 T — 검사의 이식성 (FR-LWP-8~9)

- **FR-LWP-8** 세션 검사의 루트·파일 경로는 **그 플랫폼의 절대경로**다. 상수를
  박지 않고 헬퍼 하나에서 얻는다 (`TestPathURIRoundTrip` 이 이미 하는 것과 같은
  규약).
- **FR-LWP-9** 검사가 실행 파일을 놓을 때도 **그 OS 가 실행 가능하다고 볼 이름**
  으로 놓는다 — 그러지 않으면 검사가 제품의 옳은 판정을 실패로 읽는다.

---

## 4. 검증 (Verification)

| ID | 검증 | 수단 |
|---|---|---|
| **V-LWP-1** | Windows 판정 로직이 **darwin 호스트에서도** 검증된다 (§4.2 의 규약: 어댑터는 build tag 없이 컴파일된다) | `go test ./internal/shared/platform` |
| **V-LWP-2** | `PATHEXT` 에 없는 확장자는 실행 파일이 아니다 (FR-LWP-3) | 같은 자리 |
| **V-LWP-3** | POSIX 의 실행 비트 규약이 그대로다 (FR-LWP-2 / TC-LSP-7) | `go test ./internal/webserver/domain/lsp` |
| **V-LWP-4** | CI 의 `test (windows-latest)` 가 초록이다 — **이 작업의 전부다** | GitHub Actions |
| **V-LWP-5** | linux·darwin 이 그대로 초록이다 | CI · 로컬 |

**V-LWP-4 는 로컬에서 대신할 수 없다** (R-1). 이 판의 검증은 CI 왕복이다.

---

## 5. 비목표 (Non-goals)

1. ~~`session.go` 가 `runtime.GOOS` 를 직접 만지는 것을 `platform` 으로 옮기기.~~
   **뒤이어 했다** (§6). 이 판에서 미룬 이유는 그대로다 — CI 를 고친 커밋에 무관한
   이동을 섞으면 무엇이 CI 를 고쳤는지 알 수 없게 된다. 다만 "동작은 옳으니 두어도
   된다" 는 판단은 **틀렸다**: 그것은 문서상의 권고가 아니라 `scripts/check-seams.sh`
   (FR-XBD-3)가 강제하는 조항이고, 그 검사는 이미 빨간 상태였다.
2. Windows 에서 언어 서버를 실제로 받아 보는 종단 검사 — CI 러너에서 `go install`
   이 네트워크를 타므로 그 검사는 네트워크를 잰다.
3. WSL 경로(`/mnt/c/...`)의 변환.
4. `.ps1` shim 을 PowerShell 로 실행하기 — `.cmd` 로 충분하고, 셸을 거치지 않는
   규약(FR-EGS-9)을 흔든다.

---

## 6. 후속 (FR-LWP-10~12)

`scripts/check-seams.sh` 는 이 판을 마친 뒤에도 빨갰다.

```
❌ runtime.GOOS 이(가) platform 밖에 있습니다:
     internal/webserver/domain/lsp/session.go:520
     internal/webserver/domain/lsp/session.go:540
     internal/webserver/domain/lsp/session_test.go:21   ← 이 판이 더한 것
     internal/webserver/domain/lsp/session_test.go:33
```

§5-1 이 미뤘던 자리이며, `verify.yml` 이 이 스크립트를 부르지 않아 CI 는 초록이었다.
**검사기가 보지 않는 결함은 없는 것과 같지 않다** — 여기서는 검사기가 있었고 아무도
그것을 CI 에 걸지 않았을 뿐이다.

- **FR-LWP-10** `file://` URI 변환을 `platform.Paths` 로 옮긴다. URI 의 모양이 OS
  마다 다르다는 것이 그 판단의 내용이며(POSIX 는 이미 `/` 로 시작, Windows 는 앞에
  하나를 더해야 한다), 그것은 이 패키지가 답할 질문이다 (FR-XPL-5).
- **FR-LWP-11** 어댑터는 **호스트에 의존하지 않는다.** `filepath.ToSlash`·`FromSlash`
  는 도는 호스트의 구분자를 쓰므로, darwin 에서 windows 어댑터가 백슬래시를 그대로
  두고 `url.URL` 이 그것을 `%5C` 로 인코딩한다. 구분자 변환을 어댑터가 스스로 하고
  몸통은 **슬래시 형태만** 다룬다 — 그래야 §4.2 의 "Windows 갈래도 darwin 에서
  검증된다" 가 실제로 성립한다.
- **FR-LWP-12** 검사의 자리는 `testpath` 가 짓는다. `runtime.GOOS` 로 가르면 그것이
  곧 같은 위반이다.

| ID | 검증 | 수단 |
|---|---|---|
| **V-LWP-6** | `scripts/check-seams.sh` 가 초록이다 | 로컬 |
| **V-LWP-7** | 두 OS 의 URI 모양과 왕복이 **한 호스트에서** 검증된다 (FR-LWP-11) | `go test ./internal/shared/platform` |
