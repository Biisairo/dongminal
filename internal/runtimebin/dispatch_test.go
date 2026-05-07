package runtimebin

import "testing"

func TestDispatchUnknownReturnsNotHandled(t *testing.T) {
	_, ok := Dispatch([]string{"dongminal"})
	if ok {
		t.Errorf("dongminal should not be handled by Dispatch")
	}
	_, ok = Dispatch([]string{})
	if ok {
		t.Errorf("empty argv should not be handled")
	}
	_, ok = Dispatch([]string{"unknown-tool"})
	if ok {
		t.Errorf("unknown tool should not be handled")
	}
}

func TestDispatchHelperBasename(t *testing.T) {
	for _, name := range HelperNames() {
		_, ok := Dispatch([]string{"/abs/path/" + name, "-h"})
		if !ok {
			t.Errorf("helper %s not dispatched via basename", name)
		}
	}
}

func TestHelperNamesNonEmpty(t *testing.T) {
	if len(HelperNames()) == 0 {
		t.Fatal("HelperNames empty")
	}
}
