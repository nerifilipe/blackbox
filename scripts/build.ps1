param([string]$GoBinary = 'go')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    Push-Location web
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    } finally { Pop-Location }
    & $GoBinary test ./... -count=1
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    & $GoBinary vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed' }
    New-Item -ItemType Directory -Force dist | Out-Null
    & $GoBinary build -trimpath -o dist/blackbox.exe ./cmd/blackbox
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }
    Write-Output 'Built dist/blackbox.exe. Run it and open http://127.0.0.1:9090'
} finally { Pop-Location }
