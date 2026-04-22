// Package web는 브라우저로 서빙할 정적 자산(HTML/CSS/JS)을 임베드한다.
// cmd/dongminal 은 FS() 를 server.Config.StaticFS 로 전달한다.
package web

import (
	"embed"
	"io/fs"
)

//go:embed *.html *.css *.js
var files embed.FS

// FS는 embed 된 정적 자산을 파일 서버에 바로 꽂을 수 있도록 fs.FS 로 반환한다.
func FS() fs.FS { return files }
