package workspace

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"sync"
	"sync/atomic"

	"dongminal/internal/shared/dmlog"
)

var ErrStale = errors.New("workspace: stale revision")

// ErrLabelIdentifier 는 ResolveStrict 가 좌표 라벨 형태의 입력을 거부했다는 표시다
// (FR-IDU-2). 호출자는 errors.Is 로 이것을 갈라 "잘못 불렀다"(400)를 "없다"(404)와
// 구분한다. 메시지 자체가 진단의 마지막 줄이다.
//
// 진단문의 끝 문장이므로 마침표가 있는 것이 옳다 (errLabelRejected 가 %w 로 이것을
// 문단 끝에 놓는다).
//
//lint:ignore ST1005 이것은 감싸일 오류 조각이 아니라 **사람이 읽을 마지막 줄**이다.
var ErrLabelIdentifier = errors.New(
	"uuid 는 `dmctl list-workspace` 의 uuid= 컬럼, 또는 생성 명령(new-tab/split-*)의 응답에 있다.")

// ErrSchemaTooOld는 workspace.json 이 v2 미만일 때 반환된다 (FR-EM-2a).
// 구 스키마를 빈 workspace 와 구별할 수 없으므로 조용히 넘기지 않고
// 명시적으로 실패한다 — 방치하면 브라우저가 빈 상태를 저장해 덮어쓴다.
var ErrSchemaTooOld = errors.New("workspace: schemaVersion 이 2 미만입니다 — `dongminal migrate` 를 먼저 실행하세요")

// ErrSchemaTooNew 는 workspace.json 이 이 코드가 아는 판보다 **위**일 때다
// (STATE_FILE_DURABILITY_SRS FR-SFD-15).
//
// 종전에는 `<` 만 봤다. 상위 판은 이 코드가 모르는 필드를 담고 있는데도
// 통과했고, 읽고 **모르는 것을 버리고** 저장하면 그 순간 다운그레이드 손실이다.
//
// 이 파일은 손상된 것이 아니라 **더 새로운 것**이므로 격리하지 않는다.
var ErrSchemaTooNew = errors.New("workspace: schemaVersion 이 이 판보다 높습니다 — dongminal 을 최신으로 올리거나 백업 세대(.bak.1)에서 되돌리세요")

// SchemaVersion은 이 코드가 읽고 쓰는 workspace.json 스키마 버전이다.
const SchemaVersion = 2

type TabEntry struct {
	ToolID     string
	Label      string
	WindowName string
	TabName    string
	IsActive   bool

	// Entity identity (UUID_IDENTITY_SRS Phase 1, FR-UID-6/7). Empty when the
	// upstream workspace.json predates the schema; consumers must tolerate that.
	WindowUUID string
	PaneUUID   string
	TabUUID    string
	ShortCode  string
}

type Liveness interface {
	IsLive(toolID string) bool
}

type Persister interface {
	Read() ([]byte, error)
	Write(data []byte) error
}

type index struct {
	entries   []TabEntry
	labels    map[string]string
	labelToID map[string]string
	tabIDs    map[string]struct{}
	// uuidToID maps a tab's UUID (lower-case canonical form) to its toolId.
	// Stable across label reflows: closing other sessions/regions does not
	// shift the uuid->toolId binding (UUID_IDENTITY_SRS TC-UID-2).
	uuidToID map[string]string
}

// snap is the coherent (raw, rev) pair published atomically by Save.
type snap struct {
	raw []byte
	rev uint64
}

type Manager struct {
	live  Liveness
	store Persister

	mu   sync.Mutex
	snap atomic.Pointer[snap]
	idx  atomic.Pointer[index]

	// OnIndexUpdate, when non-nil, runs synchronously after the in-memory index
	// is replaced (initial load + every Save). Use it to reconcile satellite
	// stores (e.g., mdscroll) against the current set of tabs.
	//
	// **`mu` 밖에서 불린다** (M8 `GO-34`) — 훅이 Snapshot·Resolve 를 되물어도
	// 된다. 순서는 rev 순서다: hookMu 를 `mu` 안에서 잡으므로 인덱스를 먼저
	// 바꾼 Save 의 훅이 먼저 돈다. 훅 안에서 Save 를 부르면 hookMu 에서 막힌다.
	OnIndexUpdate func()
	hookMu        sync.Mutex

	writeCh    chan []byte
	done       chan struct{}
	wg         sync.WaitGroup
	closedOnce sync.Once

	// loadErr 는 **기동 시 적재의 분류**다 (FR-SFD-14). 기동 뒤에는 바뀌지
	// 않으므로 잠금이 없다 — 쓰는 것은 `New` 하나뿐이고, 읽기는 그 뒤다.
	// 빈 값이 정상이다.
	loadErr string

	// persistErr 는 **마지막 비동기 쓰기의 결과**다 (`GO-10`). 쓰는 것은 writer
	// 고루틴이고 읽는 것은 헬스 요청이므로 원자값이다.
	//
	// 성공하면 **걷힌다** — 한 번의 실패가 영원히 남으면 그것은 상태가 아니라
	// 흉터이고, 지금 디스크가 멀쩡한지를 말해 주지 못한다.
	persistErr atomic.Value
}

// PersistErr 는 마지막 비동기 쓰기의 분류다 — `""`(정상) 또는 `PersistFailed`.
// 헬스가 이 값을 싣는다 (VERSION_HEALTH_SRS FR-VHL-10).
func (m *Manager) PersistErr() string {
	v, _ := m.persistErr.Load().(string)
	return v
}

// noteWrite 는 쓰기 한 번의 결과를 남긴다. 사유의 **원문을 담지 않는다** —
// 이 값은 헬스로 나가고, 헬스 몸통에는 경로가 실리지 않는다 (FR-VHL-14).
func (m *Manager) noteWrite(err error) {
	if err != nil {
		m.persistErr.Store(PersistFailed)
		return
	}
	m.persistErr.Store("")
}

// LoadErr 는 기동 시 적재가 어땠는지다 — `""`(정상) · `LoadRestored` ·
// `LoadEmpty`. 헬스가 이 값을 싣는다 (VERSION_HEALTH_SRS FR-VHL-10).
//
// **분류 문자열이며 경로를 담지 않는다** (FR-VHL-14).
func (m *Manager) LoadErr() string { return m.loadErr }

func New(live Liveness, store Persister) (*Manager, error) {
	m := &Manager{
		live:    live,
		store:   store,
		writeCh: make(chan []byte, 1),
		done:    make(chan struct{}),
	}
	data, err := store.Read()
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("workspace read: %w", err)
		}
		data = nil
	}
	buf := append([]byte(nil), data...)
	m.snap.Store(&snap{raw: buf, rev: 0})
	ix, perr := buildIndex(buf)
	if perr != nil {
		// 스키마가 어긋나면 치명적이다 — 계속 진행하면 브라우저가 빈 상태를
		// 저장해 사용자 워크스페이스를 덮어쓴다 (FR-EM-2a). 위아래 모두
		// 거부하며(FR-SFD-15), 그 파일들은 **손상된 것이 아니므로 격리하지 않는다**.
		if errors.Is(perr, ErrSchemaTooOld) || errors.Is(perr, ErrSchemaTooNew) {
			return nil, perr
		}
		// STATE_FILE_DURABILITY_SRS FR-SFD-10·12: **격리하고 세대에서 되살린다.**
		//
		//   이전 동작: 빈 인덱스로 조용히 지나갔다 (NFR-EM-3). raw 는 손상본인
		//             채로 남고, 브라우저가 그것을 읽지 못해 만든 빈 판을
		//             저장하면 그것이 곧 덮어쓰기였다
		//   새  동작: 손상본을 `.corrupt-<ts>` 로 옮기고 `.bak.1`~`.bak.3` 에서
		//             읽히는 첫 세대를 현재 판으로 삼는다
		//   이유:     되돌아갈 곳이 없으면 사용자의 창·탭이 그대로 사라진다
		var loadErr string
		buf, ix, loadErr = recoverCorrupt(store)
		m.snap.Store(&snap{raw: buf, rev: 0})
		m.loadErr = loadErr
	}
	m.idx.Store(ix)
	// Note: OnIndexUpdate is not yet wired at construction time; callers invoke
	// the initial reconcile manually after assigning the hook (see main.go).
	m.wg.Add(1)
	go m.writer()
	return m, nil
}

// writer drains writeCh serially. Latest-wins coalescing is enforced by Save
// via the size-1 buffer: concurrent Saves overwrite any queued-but-not-yet-
// picked blob, so disk writes collapse when the producer outruns the disk.
func (m *Manager) writer() {
	defer m.wg.Done()
	for {
		select {
		case blob := <-m.writeCh:
			err := m.store.Write(blob)
			if err != nil {
				dmlog.Infof(nil, "workspace async write: %v", err)
			}
			m.noteWrite(err)
		case <-m.done:
			// drain pending (at most 1) and exit
			for {
				select {
				case blob := <-m.writeCh:
					err := m.store.Write(blob)
					if err != nil {
						dmlog.Infof(nil, "workspace async write (flush): %v", err)
					}
					m.noteWrite(err)
				default:
					return
				}
			}
		}
	}
}

// enqueueWrite publishes blob with latest-wins semantics: never blocks the
// caller, drops any previously-queued-but-unpicked blob.
func (m *Manager) enqueueWrite(blob []byte) {
	for {
		select {
		case m.writeCh <- blob:
			return
		default:
			select {
			case <-m.writeCh:
			default:
			}
		}
	}
}

// Close stops the writer goroutine after flushing any pending blob. Safe to
// call multiple times; subsequent Saves still update in-memory state but their
// blobs will not reach disk.
func (m *Manager) Close() error {
	m.closedOnce.Do(func() {
		close(m.done)
		m.wg.Wait()
	})
	return nil
}

// Snapshot returns a coherent (raw, rev) pair from the same Save transaction.
// raw is shared (do not mutate). rev=0 indicates no Save has occurred.
func (m *Manager) Snapshot() ([]byte, uint64) {
	p := m.snap.Load()
	if p == nil {
		return nil, 0
	}
	return p.raw, p.rev
}

func (m *Manager) CurrentRev() uint64 {
	_, rev := m.Snapshot()
	return rev
}

func (m *Manager) Raw() []byte {
	raw, _ := m.Snapshot()
	return raw
}

func (m *Manager) Save(blob []byte, ifMatch string) (uint64, error) {
	m.mu.Lock()
	cur := uint64(0)
	if p := m.snap.Load(); p != nil {
		cur = p.rev
	}
	if ifMatch != "" {
		want, err := strconv.ParseUint(ifMatch, 10, 64)
		if err != nil || want != cur {
			m.mu.Unlock()
			return 0, ErrStale
		}
	}
	ix, err := buildIndex(blob)
	if err != nil {
		m.mu.Unlock()
		return 0, fmt.Errorf("workspace parse: %w", err)
	}
	buf := append([]byte(nil), blob...)
	newRev := cur + 1
	m.snap.Store(&snap{raw: buf, rev: newRev})
	m.idx.Store(ix)
	m.enqueueWrite(buf)
	hook := m.OnIndexUpdate
	if hook == nil {
		m.mu.Unlock()
		return newRev, nil
	}
	// 락 순서는 mu → hookMu 다. hookMu 를 mu 안에서 잡아 두면 rev 순서가 곧
	// 훅 호출 순서이고, mu 는 훅이 도는 동안 풀려 있어 다른 Save 가 줄을 서지
	// 않는다 (M8 `GO-34`).
	m.hookMu.Lock()
	m.mu.Unlock()
	hook()
	m.hookMu.Unlock()
	return newRev, nil
}

func (m *Manager) Entries() []TabEntry {
	ix := m.idx.Load()
	if ix == nil {
		return nil
	}
	out := make([]TabEntry, len(ix.entries))
	copy(out, ix.entries)
	return out
}

func (m *Manager) InvalidateTool(toolID string) {
	// Labels are positional (derived from workspace.json). Tool death doesn't
	// shift labels; liveness is queried via Liveness at Resolve time. Kept as
	// an explicit hook so callers (onExit) can signal the manager without
	// caring about current semantics.
	_ = toolID
}
