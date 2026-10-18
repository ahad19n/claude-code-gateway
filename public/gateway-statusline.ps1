# Claude Code status line: shows Max 5-hour / 7-day usage from the gateway.
# Uses the same variables Claude Code uses; set GATEWAY_URL / GATEWAY_KEY to
# override them if they aren't visible to the status line process.
$url = if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { $env:ANTHROPIC_BASE_URL }
$key = if ($env:GATEWAY_KEY) { $env:GATEWAY_KEY } else { $env:ANTHROPIC_AUTH_TOKEN }
try {
  $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
    -Headers @{ 'x-api-key' = $key } `
    -Uri ("{0}/gateway/status?color=1" -f $url.TrimEnd('/'))
  [Console]::Out.Write($r.Content)
} catch {
  'gateway unreachable'
}
