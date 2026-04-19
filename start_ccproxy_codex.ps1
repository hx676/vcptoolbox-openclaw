$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ccproxyDir = Join-Path $repoRoot "ccproxy-api"

$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

Push-Location $ccproxyDir
try {
    uv run ccproxy serve --config .ccproxy.toml
}
finally {
    Pop-Location
}
