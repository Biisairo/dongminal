package cli

import (
	"io"
	"os"
	"time"
)

// 로그 크기 상한 (RECONNECT_STORM_SRS 묶음 L).
//
// 재연결 폭주가 로그를 4.17 GB 로 불렸다. 폭주는 막았지만 **상한이 없다는 사실
// 자체**는 그대로다 — 정상 운영에서도 하루 ~124 MB 가 쌓인다(실측 1,439 B/s).
// 원인을 고쳤다고 상한을 면제할 이유는 없다.

const (
	// LogMaxBytes 를 넘으면 줄인다.
	LogMaxBytes = 64 << 20
	// 줄일 때 끝에서 이만큼을 `<로그>.1` 로 남긴다. 사고 직후에 로그를 보는
	// 사람이 가장 필요로 하는 것이 그 직전 기록이다 (FR-LOG-2).
	LogKeepBytes = 8 << 20
	// 확인 주기. 폭주해도 이 사이에 느는 양이 상한에 견주어 작아야 한다.
	LogCheckEvery = time.Minute
)

// capLog 은 path 가 max 를 넘으면 끝에서 keep 만큼을 `path.1` 로 옮기고 본체를
// **자른다**.
//
// 이름을 바꾸지 않는 것이 핵심이다 (FR-LOG-3). 서버의 stdout·stderr 는 부모가
// 열어 준 그 파일의 fd 이고, 이름을 바꿔도 fd 는 옛 inode 를 계속 가리켜 새
// 파일은 영영 비어 있게 된다. `O_APPEND` 로 열린 fd 는 자르기 뒤 곧바로 0 부터
// 쓴다.
//
// 로그 위생 때문에 서버가 서지 않아서는 안 되므로, 닿을 수 없는 경로는 조용히
// 지나간다 (FR-LOG-4).
func capLog(path string, max, keep int64) error {
	if path == "" {
		return nil
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() || st.Size() <= max {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	if keep > st.Size() {
		keep = st.Size()
	}
	if _, err := f.Seek(st.Size()-keep, io.SeekStart); err != nil {
		return nil
	}
	// 남길 부분을 옆에 완성한 뒤 제자리로 옮긴다 — 옮기는 중에 `.1` 이 반쯤
	// 쓰인 채로 보이지 않게 한다.
	tmp := path + ".1.tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil
	}
	if _, err := io.Copy(out, f); err != nil {
		out.Close()
		_ = os.Remove(tmp)
		return nil
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return nil
	}
	if err := os.Rename(tmp, path+".1"); err != nil {
		_ = os.Remove(tmp)
		return nil
	}
	// 본체는 자른다. 여기서 실패하면 다음 주기가 다시 시도한다.
	_ = os.Truncate(path, 0)
	return nil
}

// WatchLogSize 는 ctx 가 끝날 때까지 주기적으로 로그를 줄인다. 서버가 자기
// 로그를 스스로 관리하는 자리이며, 경로를 알 수 없으면 아무 것도 하지 않는다.
func WatchLogSize(done <-chan struct{}) {
	path := os.Getenv(EnvLog)
	if path == "" {
		path = defaultLogFile()
	}
	t := time.NewTicker(LogCheckEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = capLog(path, LogMaxBytes, LogKeepBytes)
		case <-done:
			return
		}
	}
}
