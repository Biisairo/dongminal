package adapters

import "dongminal/internal/server"

// Command는 server.CommandHub 를 mcptool 의 CommandBroadcaster 인터페이스로 어댑트한다.
type Command struct{ Hub *server.CommandHub }

func (c Command) AllowedAction(a string) bool { return c.Hub.AllowedAction(a) }
func (c Command) Broadcast(p []byte) int      { return c.Hub.Broadcast(p) }
