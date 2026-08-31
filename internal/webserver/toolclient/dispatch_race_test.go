package toolclient

import (
	"encoding/json"
	"sync"
	"testing"
)

// 출력 분배는 구독 변화와 **동시에** 일어난다. readLoop 는 도구 하나가 아니라
// 전부를 나르는 한 고루틴이고, 브라우저는 아무 때나 붙고 떨어진다.
//
// 종전에는 락 안에서 map 참조만 꺼내고 밖에서 돌았다. 그 참조는 map 그 자체라,
// 순회 중에 Subscribe/unsubscribe 가 쓰면 Go 런타임이 프로세스를 죽인다 —
// `fatal error: concurrent map iteration and map write`. recover 로 잡히지
// 않는 종류이고, e2e 서버가 실제로 그렇게 죽어 그 뒤 검사가 전부 무너졌다.
func TestToolClient_OutputDispatchRacesWithSubscribe(t *testing.T) {
	pc := &ToolClient{subbers: map[string]map[chan []byte]chan struct{}{}}
	raw := json.RawMessage(`{"tool":"t1","data":"aGk="}`)

	// 순회가 실제로 여러 항목을 돌아야 겹칠 자리가 생긴다 — 빈 map 은 즉시 끝난다.
	for i := 0; i < 8; i++ {
		pc.Subscribe("t1", make(chan []byte, 1))
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			ch := make(chan []byte, 1)
			_, un := pc.Subscribe("t1", ch)
			un()
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(stop)
		for i := 0; i < 50000; i++ {
			pc.handlePush("output", raw)
		}
	}()

	wg.Wait()
}
