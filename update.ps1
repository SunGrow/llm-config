# Update llm-config: pull the latest commits (when this is a git checkout), then re-apply every installed
# component with `install.ps1 --update`. Extra arguments go to the installer (e.g. --dry-run, --yes).
# Set LLM_CONFIG_NO_PULL=1 to skip the pull.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$git = Get-Command -Name git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

if ($env:LLM_CONFIG_NO_PULL -eq '1') {
} elseif ((Test-Path (Join-Path $here '.git')) -and $git) {
    Write-Host 'llm-config: pulling the latest version'
    & $git.Source -C $here pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'update.ps1: git pull failed (local changes or a diverged branch). Resolve it, or set LLM_CONFIG_NO_PULL=1.'
        exit 1
    }
} else {
    Write-Host 'llm-config: not a git checkout, so nothing to pull; re-run the get.ps1 one-liner to download the latest files'
}

& (Join-Path $here 'install.ps1') --update @args
exit $LASTEXITCODE
