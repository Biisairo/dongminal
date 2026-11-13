package claudeacct

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// unclaimedDir 는 주인을 확정하지 못한 자격증명을 두는 폴더다 (FR-CAC-34).
const unclaimedDir = "unclaimed"

var unclaimedName = regexp.MustCompile(`^([0-9]+)-([0-9a-f]{12})\.json$`)

// UnclaimedEntry 는 보관된 자격증명 하나다. 내용은 싣지 않는다 (FR-CAC-34a).
type UnclaimedEntry struct {
	Name        string `json:"name"`
	At          int64  `json:"at"`
	Fingerprint string `json:"fingerprint"`
}

// Unclaimed 는 보관 목록이다. 최신 먼저이고, 이름이 형식에 맞지 않는 파일은 뺀다.
func (s *Service) Unclaimed() ([]UnclaimedEntry, error) {
	des, err := os.ReadDir(filepath.Join(s.Dir, unclaimedDir))
	if errors.Is(err, os.ErrNotExist) {
		return []UnclaimedEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []UnclaimedEntry{}
	for _, de := range des {
		m := unclaimedName.FindStringSubmatch(de.Name())
		if m == nil || !de.Type().IsRegular() {
			continue
		}
		at, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			continue
		}
		out = append(out, UnclaimedEntry{Name: de.Name(), At: at, Fingerprint: m[2]})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].At != out[j].At {
			return out[i].At > out[j].At
		}
		return strings.Compare(out[i].Name, out[j].Name) < 0
	})
	return out, nil
}

// RemoveUnclaimed 는 보관된 자격증명 하나를 지운다. 이미 없으면 그대로 성공이다.
func (s *Service) RemoveUnclaimed(name string) error {
	if !unclaimedName.MatchString(name) {
		return fmt.Errorf("%w: 보관 이름 형식이 아닙니다", ErrInvalid)
	}
	err := os.Remove(filepath.Join(s.Dir, unclaimedDir, name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
