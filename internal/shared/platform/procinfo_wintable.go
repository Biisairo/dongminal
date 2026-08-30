package platform

import "encoding/binary"

// Windows 의 TCP 표를 읽는 **순수** 부분이다. DLL 호출은
// procinfo_windows.go 가 하고, 여기는 그 결과 바이트를 해석만 한다.
//
// 이 파일에 build tag 가 없는 것이 요점이다 — 표 해석은 이 트랙에서 가장
// 틀리기 쉬운 부분(구조체 크기·필드 위치·바이트 순서)인데, 태그를 달면
// Windows 실기 없이는 한 줄도 검증할 수 없다 (§4.2).

// 표의 한 줄 크기와 필드 위치다. MIB_TCPROW_OWNER_PID 는 DWORD 6개이고,
// MIB_TCP6ROW_OWNER_PID 는 주소 16바이트 두 개에 DWORD 6개다.
const (
	tcpRowV4Size = 24
	tcpRowV6Size = 56

	// v4: State(0) LocalAddr(4) LocalPort(8) RemoteAddr(12) RemotePort(16) OwningPid(20)
	tcpV4PortOff = 8
	tcpV4PIDOff  = 20

	// v6: LocalAddr(0..16) LocalScopeId(16) LocalPort(20) RemoteAddr(24..40)
	//     RemoteScopeId(40) RemotePort(44) State(48) OwningPid(52)
	tcpV6PortOff = 20
	tcpV6PIDOff  = 52

	// 표는 항목 수(DWORD) 뒤에 줄들이 이어진다.
	tcpTableHeaderSize = 4
)

// netPort 는 DWORD 에 실린 포트를 호스트 순서로 바꾼다. Windows 는 이 필드의
// **하위 2바이트에 네트워크 바이트 순서로** 포트를 넣는다 — 그대로 읽으면
// 58146 이 8683 으로 보인다.
func netPort(dw uint32) uint16 {
	low := uint16(dw)
	return low>>8 | low<<8
}

// parseTCPTable 은 GetExtendedTcpTable 이 채운 버퍼에서 port 를 점유한 pid 를
// 낸다. rowSize·portOff·pidOff 로 v4·v6 두 배치를 같은 코드가 처리한다.
//
// 요청한 표가 LISTENER 전용이므로 상태를 다시 거르지 않는다. 접속만 한
// 클라이언트는 애초에 이 표에 없다 (ProcInfo.ListenerPIDs 주석).
func parseTCPTable(buf []byte, port uint16, rowSize, portOff, pidOff int) []int {
	if len(buf) < tcpTableHeaderSize {
		return nil
	}
	n := int(binary.LittleEndian.Uint32(buf[:tcpTableHeaderSize]))
	var pids []int
	seen := map[int]struct{}{}
	for i := 0; i < n; i++ {
		off := tcpTableHeaderSize + i*rowSize
		if off+rowSize > len(buf) {
			break
		}
		row := buf[off : off+rowSize]
		if netPort(binary.LittleEndian.Uint32(row[portOff:])) != port {
			continue
		}
		pid := int(binary.LittleEndian.Uint32(row[pidOff:]))
		if pid <= 0 {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		pids = append(pids, pid)
	}
	return pids
}

func parseTCPTableV4(buf []byte, port uint16) []int {
	return parseTCPTable(buf, port, tcpRowV4Size, tcpV4PortOff, tcpV4PIDOff)
}

func parseTCPTableV6(buf []byte, port uint16) []int {
	return parseTCPTable(buf, port, tcpRowV6Size, tcpV6PortOff, tcpV6PIDOff)
}
