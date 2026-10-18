# Claude Code setup for the Claude Code gateway (Windows): settings + status line
# Usage: irm https://claude.semafore.co/setup.ps1 | iex
#    or: powershell -ExecutionPolicy Bypass -File setup.ps1
# Safe to re-run (e.g. after `gw rotate`).

function Install-ClaudeGateway {
    $ErrorActionPreference = "Stop"

    # ---- Settings ----
    $GatewayUrl   = "https://claude.semafore.co"
    # ------------------

    $SettingsDir  = Join-Path $HOME ".claude"
    $SettingsFile = Join-Path $SettingsDir "settings.json"
    $StatusScript = Join-Path $SettingsDir "gateway-statusline.ps1"
    $env:Path = "$HOME\.local\bin;$env:Path"   # where the Claude Code installer puts claude.exe
    $warnings = 0

    Write-Host "== Claude Code gateway setup =="

    # 1. Install Claude Code if it isn't already
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Write-Host "Claude Code not found, installing..."
        Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    }

    # 2. Ask for the key (hidden input)
    $secure = Read-Host "Paste this workstation's gateway key (input hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not $Key) { Write-Host "No key entered, aborting." -ForegroundColor Red; return }

    # 3. Check the key before saving it (/gateway/status isn't forwarded or recorded)
    Write-Host "Checking key..."
    try {
        $status = Invoke-RestMethod "$GatewayUrl/gateway/status?format=json" -UseBasicParsing `
            -TimeoutSec 15 -Headers @{ 'x-api-key' = $Key }
        Write-Host "Key OK (workstation: $($status.workstation))." -ForegroundColor Green
        if (-not $status.enabled) {
            Write-Host "  ! This workstation is disabled on the gateway; requests will be refused until it's enabled." -ForegroundColor Yellow
            $warnings++
        }
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code) {
            Write-Host "Key rejected (HTTP $code). Check you pasted it correctly." -ForegroundColor Red
        } else {
            Write-Host "Can't reach $GatewayUrl. Check your network and try again." -ForegroundColor Red
        }
        return
    }

    # 4. Status line script (shows Max 5h / 7d usage, since /usage doesn't work here)
    New-Item -ItemType Directory -Force $SettingsDir | Out-Null
    $statusOk = $false
    try {
        Invoke-WebRequest "$GatewayUrl/gateway-statusline.ps1" -UseBasicParsing -TimeoutSec 15 -OutFile $StatusScript
        $statusOk = $true
    } catch {
        Write-Host "  ! Couldn't download the status line script; skipping it." -ForegroundColor Yellow
        $warnings++
    }

    # 5. Save settings, keeping anything already in the file
    $settings = $null
    if (Test-Path $SettingsFile) {
        Copy-Item $SettingsFile "$SettingsFile.bak.$([DateTimeOffset]::Now.ToUnixTimeSeconds())"
        try { $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json } catch { $settings = $null }
    }
    if ($null -eq $settings -or $settings -isnot [pscustomobject]) { $settings = [pscustomobject]@{} }
    if (-not $settings.PSObject.Properties['env'] -or $settings.env -isnot [pscustomobject]) {
        $settings | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $values = [ordered]@{
        ANTHROPIC_BASE_URL          = $GatewayUrl
        ANTHROPIC_AUTH_TOKEN        = $Key
        ENABLE_CLAUDEAI_MCP_SERVERS = "false"   # claude.ai connectors can't work through the gateway
    }
    foreach ($name in $values.Keys) {
        $settings.env | Add-Member -NotePropertyName $name -NotePropertyValue $values[$name] -Force
    }
    # The first two would be used instead of the gateway key; a pinned model
    # (e.g. from an older setup) would override Claude Code's default and /model
    foreach ($name in "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_MODEL") {
        $settings.env.PSObject.Properties.Remove($name)
    }
    if ($statusOk) {
        $statusLine = [pscustomobject]@{
            type    = "command"
            command = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$($StatusScript -replace '\\', '/')`""
        }
        $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLine -Force
    }

    # Write as UTF-8 without BOM so Claude Code can parse it
    $json = $settings | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($SettingsFile, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Settings saved to $SettingsFile."

    # 6. Environment variables that would override the gateway key
    foreach ($name in "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN") {
        if ([Environment]::GetEnvironmentVariable($name, "User")) {
            [Environment]::SetEnvironmentVariable($name, $null, "User")
            Write-Host "Removed user environment variable $name."
        }
        if ([Environment]::GetEnvironmentVariable($name, "Machine")) {
            Write-Host "  ! $name is set system-wide. Remove it (needs admin), or Claude Code won't use the gateway." -ForegroundColor Yellow
            $warnings++
        }
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Write-Host "  ! Can't find the 'claude' command yet; open a new terminal before running it." -ForegroundColor Yellow
        $warnings++
    }

    Write-Host ""
    if ($warnings -eq 0) {
        Write-Host "All set! Open a new terminal and run: claude" -ForegroundColor Green
    } else {
        Write-Host "Done with $warnings warning(s) above. Open a new terminal and run: claude" -ForegroundColor Yellow
    }
    Write-Host "If this machine was logged in to a Claude account, type /logout inside Claude Code once."
    Write-Host "Don't run 'claude login' here; the gateway provides the subscription."
}

Install-ClaudeGateway
