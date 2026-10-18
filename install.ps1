# llm-config bootstrap for Windows PowerShell 5.1 and PowerShell 7+.
# Checks for Node.js >= 18, then runs installer/install.mjs with all arguments.
# Usage: .\install.ps1 [--help]
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Show-NodeHint {
    Write-Host ''
    Write-Host 'Install Node.js 18 or newer, then run this script again:'
    $onLinux = (Get-Variable -Name IsLinux -ErrorAction SilentlyContinue) -and $IsLinux
    $onMac = (Get-Variable -Name IsMacOS -ErrorAction SilentlyContinue) -and $IsMacOS
    if ($onMac) {
        Write-Host '  brew install node'
    } elseif ($onLinux) {
        Write-Host '  sudo apt-get install -y nodejs npm   (or dnf / pacman / your package manager)'
    } else {
        Write-Host '  winget install OpenJS.NodeJS.LTS   (then open a new terminal)'
        Write-Host '  or: scoop install nodejs-lts  /  choco install nodejs-lts'
    }
    Write-Host '  or download it from https://nodejs.org/en/download'
}

$node = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
    Write-Host 'install.ps1: Node.js was not found on PATH.'
    Show-NodeHint
    exit 1
}

$version = (& $node.Source -p 'process.versions.node' 2>$null | Out-String).Trim()
$major = 0
if (-not [int]::TryParse(($version -split '\.')[0], [ref]$major)) { $major = 0 }
if ($major -lt 18) {
    Write-Host "install.ps1: Node.js $version found, but 18 or newer is required."
    Show-NodeHint
    exit 1
}

# PowerShell turns unquoted a,b into an array; re-join so "--components a,b" reaches node intact.
$passArgs = @()
foreach ($a in $args) {
    if ($a -is [System.Array]) { $passArgs += ($a -join ',') } else { $passArgs += [string]$a }
}

& $node.Source (Join-Path $here 'installer/install.mjs') @passArgs
exit $LASTEXITCODE
