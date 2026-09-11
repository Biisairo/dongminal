package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// `/api/file/*` 의 경계 (FILE_API_BOUNDARY_SRS).
//
// 이 계층은 절대경로면 **어디든** 열었다. 가드가 없는 것은 사고가 아니라 명시된
// 설계였다 (`handlers_fs.go:22-25`): "사용자가 경로를 이미 알고 지목한 읽기·쓰기"
// 이므로 상한이 필요 없다는 것.
//
// 그 전제는 **대화형 사용자**에게 참이다. 그 사람은 터미널에서 무엇이든 할 수 있다.
// 브라우저 매개 공격자에게는 거짓이다 — PTY 를 쓰려면 WebSocket 을 열고 프레임
// 규약을 따라 명령을 타이핑하고 출력을 읽어야 하는데, `POST /api/file/write` 는
// 요청 하나이고 **응답을 읽을 필요가 없다.** 난이도가 다르면 같은 위험이 아니다.
//
// `requestGate` 가 그 요청의 **호출**을 닫는다. 여기는 **닿는 범위**를 닫는다.
// 게이트 하나에 전부 걸면, 게이트가 언젠가 새는 날 파일시스템 전체가 함께 샌다.

// fileReadMaxBytes 는 `/api/file/{read,raw}` 가 내보내는 한 파일의 상한이다
// (FR-FAB-8). **10 MiB** 다 — Monaco 가 실용적으로 다루는 상한선이며, 그 위의
// 파일에는 터미널과 다운로드라는 길이 이미 있다.
//
// 값을 클라이언트가 따로 들고 있지 않다. `/api/file/probe` 가 이 값을 실어 보내고
// 편집기는 그것으로 판정한다 (FR-FAB-9) — 상수가 두 벌이면 언젠가 한쪽만 고쳐지고,
// 그때 사용자는 "열린다고 했는데 안 열린다" 를 만난다.
//
// var 인 것은 테스트가 낮춰 쓰기 위해서다 (`zipMaxBytes` 와 같은 관례).
var fileReadMaxBytes int64 = 10 << 20

// fileRoots 는 이 계층이 닿아도 되는 자리들이다 (FR-FAB-2).
//
// 전부 서버가 이미 아는 값이며 **새 상태를 만들지 않는다.**
//
//	사용자 홈             탐색기의 시작점이다 (wsentry.Roots 의 첫 항목)
//	Editor 목록의 루트   편집기의 저장이 이 종단이다 — 여는 자리가 곧 여기다
//	살아 있는 도구의 cwd  터미널에서 `edit <파일>` 로 여는 자리
//	Notes · Plugins      제품이 스스로 쓰는 자리
//	$DONGMINAL_HOME      자기 상태 (설정·워크스페이스)
//
// **사용자 홈이 그 안에 든다** (`wsentry.Store.Roots()[0]` = `os.UserHomeDir`). 즉
// `~/.ssh`·`~/.aws` 가 이 경계 안이다.
//
// 종전 주석은 "홈 전체는 루트가 아니다" 라고 적혀 있었고 **그것은 사실이 아니었다**
// (2026-09-11 확인: 실제 인스턴스에서 `/api/file/read?path=~/.ssh/known_hosts` 가
// 200). 단위 테스트가 가짜 `HomeFn` 을 쓰는 탓에 그 어긋남이 드러나지 않았다.
//
// **여기서 홈을 빼지 않는다.** 홈이 루트인 것은 탐색기의 설계이고
// (FR-EDT-113·FR-EDT-42), `/api/fs/*` 는 같은 범위를 이미 다룬다 — `root=$HOME` 의
// 조회·다운로드·삭제가 전부 그 자리다. 이쪽만 좁히면 접근 경로는 그대로 남고
// **편집기로 여는 흐름만** 끊긴다. 그 잔여 위험은 인증의 자리이며 `SEC-3` 과 함께
// M4 로 간다.
//
// 매 요청 다시 읽는다 (FR-FAB-4). 도구를 새로 열거나 Editor 를 추가한 직후에 그
// 자리가 막혀 있으면 사용자는 제품이 고장 났다고 읽는다.
func (s *Server) fileRoots() ([]string, error) {
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		}
		out = append(out, filepath.Clean(p))
	}

	if s.Entries != nil {
		roots, err := s.Entries.Roots()
		if err != nil {
			// FR-FAB-NFR-3: 읽지 못하면 **fail-closed** 다. 읽기 실패로 전부
			// 열리면 그 실패가 곧 우회 경로가 된다.
			return nil, err
		}
		for _, r := range roots {
			add(r)
		}
		if n, err := s.Entries.Notes(); err == nil {
			add(n)
		}
		if p, err := s.Entries.Plugins(); err == nil {
			add(p)
		}
	}
	if s.Tools != nil {
		// `List()` 가 도구 목록의 유일한 공개 창구다. `Cwd(id)` 는 데몬 모드에서
		// RPC 를 지나므로 살아 있는 값이다 (`Get(id).Cwd()` 는 아니다).
		for _, t := range s.Tools.List() {
			id, _ := t["id"].(string)
			if id != "" {
				add(s.Tools.Cwd(id))
			}
		}
	}
	add(s.cfg.DataDir)
	return out, nil
}

// fileUnrestricted 는 경계를 끄는 설정이다 (FR-FAB-5).
//
// 기본은 거짓이다. 참이면 종전 동작(절대경로면 어디든)으로 돌아가며, 그 사실이
// **로그에 한 번 남는다** (FR-FAB-6) — 조용히 열려 있으면 안 된다.
func (s *Server) fileUnrestricted() bool {
	if s.Settings == nil {
		return false
	}
	var cfg struct {
		FileAPIUnrestricted bool `json:"fileApiUnrestricted"`
	}
	if err := json.Unmarshal(s.Settings.get(), &cfg); err != nil {
		return false
	}
	if cfg.FileAPIUnrestricted {
		fileUnrestrictedOnce.Do(func() {
			dmlog.Infof(nil, "file: fileApiUnrestricted=true — /api/file/* 의 경계가 꺼져 있습니다")
		})
	}
	return cfg.FileAPIUnrestricted
}

var fileUnrestrictedOnce sync.Once

// homeWriteDenied 는 `$DONGMINAL_HOME` 아래로 가는 쓰기인가다 (FR-FAB-12).
//
// 홈은 **읽히기만 하는 값의 자리가 아니다.** `ext` 매니페스트에 적힌 설치 명령은
// 실제로 실행되고(FR-EXT-17), `access.json` 은 경계 자체이며, `settings.json` 에는
// 그 경계를 끄는 스위치가 있다. 그 값들은 자기 전용 API 로만 바뀐다 (FR-FAB-13) —
// 검증하는 문과 검증하지 않는 문이 같은 값에 함께 나 있으면 검증은 있으나 마나다.
//
// 노트만 예외다. 그곳은 제품이 웹에서 쓰라고 만든 자리다.
//
// 대조는 경계의 것을 그대로 쓴다 (FR-FAB-3) — 심링크로 홈에 들어가는 길을 따로
// 막지 않기 위해서다. 두 벌로 적으면 한쪽만 고쳐진다.
func (s *Server) homeWriteDenied(p string) bool {
	data := s.cfg.DataDir
	if data == "" {
		return false
	}
	if r, err := filepath.EvalSymlinks(data); err == nil {
		data = r
	}
	resolve := fsResolveTarget
	if _, err := os.Lstat(p); err == nil {
		resolve = fsResolveExisting
	}
	if _, err := resolve(data, p); err != nil {
		return false
	}
	if _, err := resolve(filepath.Join(data, "notes"), p); err == nil {
		return false
	}
	return true
}

// errGitRepoOutside 는 git 의 `repo` 가 경계 밖이라는 사유다. 본문에는 나가지
// 않는다 — 호출부가 자기 표면의 문구로 답한다.
var errGitRepoOutside = errors.New("repo 가 허용 루트 밖이다")

// gitRepoAllowed 는 파일 표면의 경계를 git 의 `repo` 에 그대로 적용한다
// (FR-FAB-14·15, `SEC-15`). `gitapi.GitServer.RepoGuard` 로 주입된다.
//
// 같은 함수를 지나므로 예외도 같다 — `fileApiUnrestricted` 가 참이면 여기도
// 통과한다. 규칙이 둘이면 한쪽만 고쳐지고, 그때 "탐색기에서는 열리는데 git 은
// 안 된다" 가 된다.
// gitRepoGuardTTL 은 허용 판정을 붙들어 두는 시간이다 (NFR-FAB-4). git 폴링이
// 초당 여러 번 지나므로 이 값이 곧 판정 비용을 나눈다.
const gitRepoGuardTTL = 5 * time.Second

func (s *Server) gitRepoAllowed(repoRoot string) error {
	if s.fileUnrestricted() {
		return nil
	}
	// NFR-FAB-4: 허용은 붙들어 둔다. 거부는 담지 않는다 — 방금 등록한 저장소가
	// TTL 동안 막히면 "더했는데 안 열린다" 가 된다.
	if v, ok := s.gitRepoOK.Load(repoRoot); ok {
		if exp, ok := v.(time.Time); ok && time.Now().Before(exp) {
			return nil
		}
		s.gitRepoOK.Delete(repoRoot)
	}
	roots, err := s.fileRoots()
	if err != nil {
		// NFR-FAB-3 과 같은 fail-closed 다. 읽기 실패로 전부 열리면 그 실패가 곧
		// 우회 경로가 된다.
		dmlog.Warnf(nil, "git repo: 루트 목록을 읽지 못했다 (%v) — 거절한다", err)
		return errGitRepoOutside
	}
	// **핀 목록이 여기 더해진다** (FR-FAB-14a). 파일 표면의 루트 목록(`Roots()`)은
	// `Editors` 만 담고 `Pinned` 는 담지 않는데, git 에서 "워크스페이스에 등록한
	// 저장소" 란 곧 **핀**이다. 그것을 빼면 등록한 저장소가 자기 표면에서 막힌다 —
	// e2e 전량이 그 사실을 한 번에 보고했다 (M2 §2.21).
	if s.Entries != nil {
		if lists, err := s.Entries.Read(); err == nil {
			roots = append(roots, lists.Pinned...)
		} else {
			dmlog.Warnf(nil, "git repo: 핀 목록을 읽지 못했다 (%v) — 거절한다", err)
			return errGitRepoOutside
		}
	}
	// **조상도 허용한다** (FR-FAB-14b). 파일 표면은 "루트의 **아래**인가" 만 묻지만
	// git 에서는 방향이 하나 더 있다 — 저장소 **안의 하위 폴더**를 Editor 루트로
	// 삼는 것이 정상이고(`FR-DIR-40`·`FR-EDT-69`), 그때 다룰 저장소는 그 루트의
	// **조상**이다. 아래쪽만 보면 그 흐름이 통째로 끊긴다.
	for _, root := range roots {
		if _, err := fsResolveExisting(root, repoRoot); err == nil {
			s.gitRepoOK.Store(repoRoot, time.Now().Add(gitRepoGuardTTL))
			return nil
		}
		if _, err := fsResolveExisting(repoRoot, root); err == nil {
			s.gitRepoOK.Store(repoRoot, time.Now().Add(gitRepoGuardTTL))
			return nil
		}
	}
	dmlog.Infof(nil, "git repo denied path=%q", repoRoot)
	return errGitRepoOutside
}

// fileGuard 는 경로 하나를 허용 루트와 대조하고 **푼 경로**를 돌려준다.
//
// 대조는 `/api/fs/*` 의 것을 그대로 쓴다 (FR-FAB-3) — 두 벌을 만들지 않는다.
// `forWrite` 가 가르는 것은 마지막 조각을 따라가는가다:
//
//	읽기  fsResolveExisting  전량을 푼다. 그 파일이 실재해야 한다
//	쓰기  fsResolveTarget    부모만 푼다. 아직 없는 파일을 만들 수 있어야 한다
//
// 마지막 조각을 따라가지 않는 덕에 링크 자체를 다루는 것이 가능하고, 중간
// 디렉터리가 링크여서 루트를 벗어나는 경우는 걸린다 (FR-EDT-112).
func (s *Server) fileGuard(w http.ResponseWriter, r *http.Request, p string, forWrite bool) (string, bool) {
	if p == "" {
		httpErr(w, "missing path", http.StatusBadRequest, apierr.CodeMissingArg)
		return "", false
	}
	if !filepath.IsAbs(p) {
		httpErr(w, "path must be absolute", http.StatusBadRequest, apierr.CodeAbsPathNeeded)
		return "", false
	}
	// FR-FAB-12: 홈 아래 쓰기는 **노트만**이다 (`SEC-16`).
	//
	// 이 판정이 `fileUnrestricted` 보다 **앞**에 있다. 그 설정은 "내 작업 파일을
	// 어디서든 열겠다" 는 뜻이지 "내 서버의 집행 선언을 웹으로 덮겠다" 는 뜻이
	// 아니다 — 노출 모드가 같은 설정을 무시하는 것과 같은 논리다 (FR-FAB-7).
	if forWrite && s.homeWriteDenied(p) {
		dmlog.Infof(nil, "file denied(home) addr=%s %s path=%q", r.RemoteAddr, r.Method, p)
		httpErr(w, "forbidden", http.StatusForbidden, apierr.CodeForbidden)
		return "", false
	}
	if s.fileUnrestricted() {
		return p, true
	}

	roots, err := s.fileRoots()
	if err != nil {
		dmlog.Warnf(nil, "file: 루트 목록을 읽지 못했다 (%v) — 거절한다", err)
		httpErr(w, "forbidden", http.StatusForbidden, apierr.CodeForbidden)
		return "", false
	}

	resolve := fsResolveExisting
	if forWrite {
		// 쓰기는 **실재 여부**로 갈린다.
		//
		// 아직 없는 파일은 부모만 풀 수 있다 — 마지막 조각을 따라갈 대상이 없다.
		// 그런데 이미 있는 파일이 **심링크**면 그것을 풀지 않고는 어디에 쓰는지
		// 알 수 없다. 지금의 `WriteFileAtomic` 은 임시 파일을 만들어 rename 하므로
		// 링크를 따라가지 않고 대체하지만, **경계가 그 구현 세부에 기대면 안 된다** —
		// 언젠가 제자리 쓰기로 바뀌는 날 이 구멍이 조용히 열린다.
		if _, err := os.Lstat(p); err == nil {
			resolve = fsResolveExisting
		} else {
			resolve = fsResolveTarget
		}
	}
	for _, root := range roots {
		if got, err := resolve(root, p); err == nil {
			return got, true
		}
	}
	// 어느 루트에도 들지 않았다. **목록을 본문에 싣지 않는다** — 흘리면 그것이 곧
	// 다음 시도의 입력이 된다 (FR-ACL-8 승계). 사후 추적은 로그가 한다.
	dmlog.Infof(nil, "file denied addr=%s %s path=%q", r.RemoteAddr, r.Method, p)
	httpErr(w, "forbidden", http.StatusForbidden, apierr.CodeForbidden)
	return "", false
}
