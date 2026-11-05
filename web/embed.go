package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

func Files() fs.FS {
	sub, _ := fs.Sub(files, "dist")
	return sub
}
