package settingsschema_test

import (
	"testing"

	"dongminal/internal/shared/settingsschema"
)

// TC-CFG-4: Go 가 embed 된 **같은 바이트**를 읽어 서술자를 얻는다.
// 표를 Go 에 다시 적지 않는다 (FR-CFG-10).
func TestLoadReadsEmbeddedTable(t *testing.T) {
	specs, err := settingsschema.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(specs) != 20 {
		t.Fatalf("서술자 %d개, 기대 20개", len(specs))
	}
	by := settingsschema.ByKey(specs)
	for _, k := range []string{"themeName", "tabWidthPx", "attnEdgeLevel", "gitStatusInterval"} {
		if _, ok := by[k]; !ok {
			t.Errorf("%s 가 표에 없다", k)
		}
	}
	if s := by["tabWidthPx"]; s.Type != "int" || s.Min == nil || *s.Min != 40 || *s.Max != 480 {
		t.Errorf("tabWidthPx 서술자가 어긋난다: %+v", s)
	}
	if s := by["gitStatusInterval"]; !s.Off {
		t.Errorf("gitStatusInterval 은 0(끔)을 받는다")
	}
}

// TC-CFG-3: 파일 형태가 계약이다 (FR-CFG-2). JS 표현식이 섞이면 Go 가 읽지 못하고,
// 그 실패는 **조용하지 않아야** 한다.
func TestSchemaFileIsPlainJSON(t *testing.T) {
	if err := settingsschema.CheckShape(); err != nil {
		t.Fatalf("형태 계약 위반: %v", err)
	}
}

// TC-CFG-12·14: 검증은 **첫 오류에서 멈추지 않는다.**
func TestValidateReportsAllProblems(t *testing.T) {
	specs, err := settingsschema.Load()
	if err != nil {
		t.Fatal(err)
	}
	blob := []byte(`{"tabWidthPx":9999,"focusEdgeLevel":-3,"attnEdgeLevel":77,"pageTitle":"ok"}`)
	probs, unknown, err := settingsschema.Validate(specs, blob)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if len(probs) != 3 {
		t.Fatalf("불일치 %d건, 기대 3건: %+v", len(probs), probs)
	}
	if len(unknown) != 0 {
		t.Errorf("알 수 없는 키가 없어야 한다: %v", unknown)
	}
}

// TC-CFG-13: 알 수 없는 키는 **경고이며 실패가 아니다** (FR-CFG-9 / D-CFG-4).
// 판이 앞선 브라우저가 쓴 키가 빨갛게 뜨면 사용자가 멀쩡한 설정을 지운다.
func TestValidateUnknownKeyIsWarningOnly(t *testing.T) {
	specs, _ := settingsschema.Load()
	probs, unknown, err := settingsschema.Validate(specs, []byte(`{"futureKey":1,"pageTitle":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(probs) != 0 {
		t.Errorf("알 수 없는 키가 불일치로 셌다: %+v", probs)
	}
	if len(unknown) != 1 || unknown[0] != "futureKey" {
		t.Errorf("경고 = %v, 기대 [futureKey]", unknown)
	}
}

// 깨진 블롭은 불일치가 아니라 **오류**다 — 고칠 방법이 다르다.
func TestValidateCorruptBlob(t *testing.T) {
	specs, _ := settingsschema.Load()
	if _, _, err := settingsschema.Validate(specs, []byte(`{nope`)); err == nil {
		t.Fatal("깨진 JSON 이 통과했다")
	}
}
