# llm-config one-line installer for Windows PowerShell 5.1 and PowerShell 7+:
#   irm https://raw.githubusercontent.com/SunGrow/llm-config/main/get.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/SunGrow/llm-config/main/get.ps1))) --yes --components claude,opencode
# Downloads (or updates) the repository into ~/.llm-config/repo, then runs install.ps1 there with the given
# arguments. Without a selection option (--components, --all, ...): the picker on a first install, --update once installed.
# Environment: LLM_CONFIG_DIR (checkout path), LLM_CONFIG_REPO (git URL), LLM_CONFIG_BRANCH (default main).
# Runs inside a function and never calls `exit`, so `| iex` does not close your shell; the result is in $LASTEXITCODE.

function Invoke-LlmConfigGet {
    param([Parameter(ValueFromRemainingArguments = $true)] $PassArgs)
    $ErrorActionPreference = 'Stop'
    $repo = if ($env:LLM_CONFIG_REPO) { $env:LLM_CONFIG_REPO } else { 'https://github.com/SunGrow/llm-config.git' }
    $branch = if ($env:LLM_CONFIG_BRANCH) { $env:LLM_CONFIG_BRANCH } else { 'main' }
    $userHome = [Environment]::GetFolderPath('UserProfile')
    $dest = if ($env:LLM_CONFIG_DIR) { $env:LLM_CONFIG_DIR } else { Join-Path $userHome '.llm-config/repo' }
    $git = Get-Command -Name git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $isCheckout = Test-Path (Join-Path $dest 'installer/install.mjs')

    if (Test-Path (Join-Path $dest '.git')) {
        if (-not $git) { Write-Host "llm-config: $dest is a git checkout but git is not installed"; $global:LASTEXITCODE = 1; return }
        Write-Host "llm-config: updating $dest"
        & $git.Source -C $dest pull --ff-only --quiet
        if ($LASTEXITCODE -ne 0) { Write-Host "llm-config: git pull failed in $dest (local changes or a diverged branch); resolve it there and run again"; $global:LASTEXITCODE = 1; return }
    } elseif ((Test-Path $dest) -and -not $isCheckout -and (Get-ChildItem -Force $dest | Select-Object -First 1)) {
        Write-Host "llm-config: $dest exists and is not an llm-config checkout; set LLM_CONFIG_DIR to another path"; $global:LASTEXITCODE = 1; return
    } elseif ($git -and -not $isCheckout) {
        Write-Host "llm-config: cloning $repo into $dest"
        New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
        & $git.Source clone --quiet --depth 1 --branch $branch $repo $dest
        if ($LASTEXITCODE -ne 0) { Write-Host 'llm-config: git clone failed'; $global:LASTEXITCODE = 1; return }
    } else {
        if ($repo -notmatch '^https://github\.com/') { Write-Host "llm-config: git is not installed and $repo is not a GitHub URL; install git first"; $global:LASTEXITCODE = 1; return }
        $base = $repo -replace '\.git$', ''
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("llm-config-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $tmp | Out-Null
        try {
            Write-Host "llm-config: git not found; downloading $base ($branch) as a zip"
            $zip = Join-Path $tmp 'src.zip'
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -UseBasicParsing -Uri "$base/archive/refs/heads/$branch.zip" -OutFile $zip
            Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x')
            $src = Get-ChildItem -Directory (Join-Path $tmp 'x') | Select-Object -First 1
            if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'installer/install.mjs'))) { Write-Host 'llm-config: the downloaded archive has no installer'; $global:LASTEXITCODE = 1; return }
            if (Test-Path $dest) {
                # keep the private overlay (local/) of an earlier zip install
                $local = Join-Path $dest 'local'
                if (Test-Path $local) { Move-Item $local (Join-Path $src.FullName 'local') }
                Remove-Item -Recurse -Force $dest
            }
            New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
            Move-Item $src.FullName $dest
        } finally {
            Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        }
    }

    $installArgs = @($PassArgs | Where-Object { $null -ne $_ })
    # Something installed and no selection given (e.g. only --yes): update what is installed.
    $selection = @($installArgs | Where-Object { "$_" -match '^(--components(=.*)?|-c|--all|--update|-u|--uninstall(=.*)?|--list|--help|-h)$' }).Count -gt 0
    if (-not $selection -and (Test-Path (Join-Path $userHome '.llm-config/manifest.json'))) { $installArgs = @('--update') + $installArgs }
    # not captured: the installer needs the real console for its picker
    & (Join-Path $dest 'install.ps1') @installArgs
}

Invoke-LlmConfigGet @args
