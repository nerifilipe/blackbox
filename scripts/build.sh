#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
(cd web && npm ci && npm run build)
go test ./... -count=1
go vet ./...
mkdir -p dist
go build -trimpath -o dist/blackbox ./cmd/blackbox
echo 'Built dist/blackbox. Run it and open http://127.0.0.1:9090'
