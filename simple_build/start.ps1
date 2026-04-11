# PowerShell-эквивалент start.sh для Windows-хоста.
# Запуск: .\start.ps1
# С кастомным .env: $env:ENV_FILE="C:\path\to\.env"; .\start.ps1

$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

if (-not $env:ENV_FILE) {
    $env:ENV_FILE = ".\env"
}

if (-not (Test-Path $env:ENV_FILE)) {
    Write-Error "env file not found: $($env:ENV_FILE)"
    Write-Host "Create one based on .env.example from the main repo, or set `$env:ENV_FILE=..."
    exit 1
}

$env:CACHEBUST = [int][double]::Parse((Get-Date -UFormat %s))

Write-Host "==> Using env file: $($env:ENV_FILE)"
Write-Host "==> CACHEBUST=$($env:CACHEBUST) (forces fresh git clone)"
Write-Host ""

docker compose up -d --build

Write-Host ""
Write-Host "==> Container is starting. Follow logs with:"
Write-Host "    docker compose logs -f"
