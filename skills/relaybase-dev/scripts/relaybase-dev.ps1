[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("preflight", "status", "register", "start", "stop", "restart", "logs", "url", "ensure-manifest", "verify", "diagnose-token", "check-stop", "route-check", "stream-logs", "docker-preflight", "compose-detect", "compose-status", "compose-health", "compose-logs", "compose-cleanup", "compose-verify-stop", "docker-diagnose")]
  [string]$Action,

  [string]$AppId,
  [string]$ManifestPath = ".\relaybase.app.json",
  [string]$Name,
  [string]$Command,
  [string]$Cwd = ".",
  [int]$Lines = 100,
  [string]$HostName = "127.0.0.1",
  [int]$Port = 7777,
  [string]$StateDir,
  [string]$RelaybaseRepo,
  [int]$BackendPort,
  [int]$StreamSeconds = 5,
  [string]$DashboardStatusUrl
)

$ErrorActionPreference = "Stop"

if (-not $RelaybaseRepo) {
  $RelaybaseRepo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
}

function Write-Result {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 30
}

function Get-BaseUrl {
  "http://${HostName}:$Port"
}

function Resolve-StateDir {
  if ($StateDir) {
    return [System.IO.Path]::GetFullPath($StateDir)
  }

  if ($env:RELAYBASE_STATE_DIR) {
    return [System.IO.Path]::GetFullPath($env:RELAYBASE_STATE_DIR)
  }

  if ($env:LOCALAPPDATA) {
    return Join-Path $env:LOCALAPPDATA "Relaybase"
  }

  return Join-Path $HOME ".relaybase"
}

function Get-TokenInfo {
  $dir = Resolve-StateDir
  $path = Join-Path $dir "session-token"
  $exists = Test-Path -LiteralPath $path
  $length = $null
  if ($exists) {
    try {
      $length = ((Get-Content -LiteralPath $path -Raw).Trim()).Length
    } catch {
      $length = $null
    }
  }

  [pscustomobject]@{
    stateDir = $dir
    tokenPath = $path
    exists = $exists
    hasToken = ($exists -and $length -gt 0)
    tokenLength = $length
    explicitStateDir = [bool]$StateDir
    envStateDir = $env:RELAYBASE_STATE_DIR
  }
}

function Read-RelaybaseToken {
  $info = Get-TokenInfo
  if (-not $info.hasToken) {
    return $null
  }

  $token = (Get-Content -LiteralPath $info.tokenPath -Raw).Trim()
  if ($token.Length -eq 0) {
    return $null
  }

  return $token
}

function Test-RelaybaseDiscovery {
  $uri = "$(Get-BaseUrl)/.well-known/mcp.json"
  try {
    $document = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 2
    [pscustomobject]@{
      ok = $true
      uri = $uri
      document = $document
    }
  } catch {
    [pscustomobject]@{
      ok = $false
      uri = $uri
      error = $_.Exception.Message
    }
  }
}

function Invoke-RelaybaseApi {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    $Body
  )

  $headers = @{}
  $token = Read-RelaybaseToken
  if ($token) {
    $headers["x-relaybase-token"] = $token
  }

  $uri = "$(Get-BaseUrl)$Path"
  $params = @{
    Method = $Method
    Uri = $uri
    TimeoutSec = 5
    Headers = $headers
  }

  if ($null -ne $Body) {
    $params["ContentType"] = "application/json"
    $params["Body"] = ($Body | ConvertTo-Json -Depth 20)
  }

  Invoke-RestMethod @params
}

function Invoke-RelaybaseCli {
  param(
    [Parameter(Mandatory = $true)][string]$CliCommand,
    [string[]]$CliArgs = @()
  )

  $stateArgs = @()
  if ($StateDir) {
    $stateArgs = @("--state-dir", (Resolve-StateDir))
  }

  if ((Test-Path -LiteralPath (Join-Path $RelaybaseRepo "package.json")) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Push-Location $RelaybaseRepo
    try {
      $allArgs = @("run", "relaybase", "--", $CliCommand) + $CliArgs + $stateArgs
      $output = & npm.cmd @allArgs 2>&1
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }

    return [pscustomobject]@{
      ok = ($code -eq 0)
      source = "repo"
      exitCode = $code
      output = ($output -join "`n")
    }
  }

  if (Get-Command npx.cmd -ErrorAction SilentlyContinue) {
    $allArgs = @("--yes", "@cameloo/relaybase", $CliCommand) + $CliArgs + $stateArgs
    $output = & npx.cmd @allArgs 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{
      ok = ($code -eq 0)
      source = "npx"
      exitCode = $code
      output = ($output -join "`n")
    }
  }

  [pscustomobject]@{
    ok = $false
    source = "none"
    exitCode = 127
    output = "Relaybase CLI unavailable: npm.cmd and npx.cmd were not found."
  }
}

function Get-WebErrorMessage {
  param([Parameter(Mandatory = $true)]$ErrorRecord)

  $message = $ErrorRecord.Exception.Message
  $response = $ErrorRecord.Exception.Response
  if ($response) {
    try {
      $stream = $response.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        if ($body) {
          return "$message $body"
        }
      }
    } catch {
      return $message
    }
  }

  return $message
}

function Get-WebStatusCode {
  param([Parameter(Mandatory = $true)]$ErrorRecord)
  $response = $ErrorRecord.Exception.Response
  if ($response -and $response.StatusCode) {
    try {
      return [int]$response.StatusCode
    } catch {
      return $null
    }
  }
  return $null
}

function Require-AppId {
  if (-not $AppId) {
    throw "-AppId is required for action '$Action'."
  }
}

function Resolve-ManifestPath {
  [System.IO.Path]::GetFullPath($ManifestPath)
}

function Get-ManifestObject {
  $path = Resolve-ManifestPath
  if (-not (Test-Path -LiteralPath $path)) {
    return $null
  }

  (Get-Content -LiteralPath $path -Raw) | ConvertFrom-Json
}

function Get-EffectiveAppId {
  if ($AppId) {
    return $AppId
  }

  $manifest = Get-ManifestObject
  if ($manifest -and $manifest.id) {
    return [string]$manifest.id
  }

  throw "-AppId is required when the manifest does not contain an id."
}

function Get-AppStatus {
  param([Parameter(Mandatory = $true)][string]$Id)
  try {
    $body = Invoke-RelaybaseApi -Method Get -Path "/__hub/api/apps"
    $apps = @($body.apps)
    $app = $apps | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    [pscustomobject]@{
      ok = $true
      app = $app
      apps = $apps
      error = $null
    }
  } catch {
    [pscustomobject]@{
      ok = $false
      app = $null
      apps = @()
      error = (Get-WebErrorMessage $_)
    }
  }
}

function Get-AppPort {
  param($AppOrRuntime)
  if (-not $AppOrRuntime) {
    return $null
  }

  if ($AppOrRuntime.runtime -and $AppOrRuntime.runtime.assignedPort) {
    return [int]$AppOrRuntime.runtime.assignedPort
  }

  if ($AppOrRuntime.assignedPort) {
    return [int]$AppOrRuntime.assignedPort
  }

  if ($AppOrRuntime.upstreamPort) {
    return [int]$AppOrRuntime.upstreamPort
  }

  return $null
}

function Test-TcpPortOpen {
  param(
    [Parameter(Mandatory = $true)][int]$CheckPort,
    [string]$CheckHost = $HostName
  )

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect($CheckHost, $CheckPort, $null, $null)
    $connected = $connect.AsyncWaitHandle.WaitOne(1000, $false)
    if (-not $connected) {
      return $false
    }
    $client.EndConnect($connect)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Invoke-HttpCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [hashtable]$Headers = @{}
  )

  try {
    $response = Invoke-WebRequest -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 5 -UseBasicParsing
    $statusCode = [int]$response.StatusCode
    [pscustomobject]@{
      ok = ($statusCode -ge 200 -and $statusCode -lt 500)
      uri = $Uri
      statusCode = $statusCode
      error = $null
    }
  } catch {
    $statusCode = Get-WebStatusCode $_
    [pscustomobject]@{
      ok = ($statusCode -ge 200 -and $statusCode -lt 500)
      uri = $Uri
      statusCode = $statusCode
      error = (Get-WebErrorMessage $_)
    }
  }
}

function Join-RoutePath {
  param([string]$Path)
  if (-not $Path) {
    return "/"
  }

  if ($Path.StartsWith("/")) {
    return $Path
  }

  return "/$Path"
}

function Invoke-RouteCheck {
  param([Parameter(Mandatory = $true)][string]$Id)

  $status = Get-AppStatus -Id $Id
  $healthPath = "/"
  if ($status.app -and $status.app.healthUrl) {
    $healthPath = Join-RoutePath ([string]$status.app.healthUrl)
  }

  $human = Invoke-HttpCheck -Uri "http://$Id.localhost:$Port$healthPath"
  $agent = Invoke-HttpCheck -Uri "$(Get-BaseUrl)$healthPath" -Headers @{ "X-Relaybase-App" = $Id }

  [pscustomobject]@{
    action = "route-check"
    ok = ($human.ok -or $agent.ok)
    id = $Id
    healthPath = $healthPath
    status = $status.app
    human = $human
    agent = $agent
  }
}

function Get-TokenDiagnosis {
  $discovery = Test-RelaybaseDiscovery
  $token = Get-TokenInfo
  $hints = @()

  if ($discovery.ok -and -not $token.hasToken) {
    $hints += "Discovery is healthy but no readable token was found; mutation calls will likely return 401 Unauthorized."
  }

  if (-not $StateDir -and -not $env:RELAYBASE_STATE_DIR) {
    $hints += "The helper is using the default state dir. If Relaybase was launched with --state-dir, pass -StateDir or set RELAYBASE_STATE_DIR."
  }

  if ($StateDir -and $env:RELAYBASE_STATE_DIR) {
    $resolvedParam = [System.IO.Path]::GetFullPath($StateDir)
    $resolvedEnv = [System.IO.Path]::GetFullPath($env:RELAYBASE_STATE_DIR)
    if ($resolvedParam -ne $resolvedEnv) {
      $hints += "The -StateDir parameter differs from RELAYBASE_STATE_DIR; verify which one the running Relaybase process uses."
    }
  }

  [pscustomobject]@{
    action = "diagnose-token"
    ok = $token.hasToken
    discovery = $discovery
    token = $token
    hints = $hints
    note = "Token contents are intentionally not printed."
  }
}

function Test-StopClosed {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [int]$KnownPort = 0
  )

  $status = Get-AppStatus -Id $Id
  $portToCheck = $KnownPort
  if (-not $portToCheck -and $BackendPort) {
    $portToCheck = $BackendPort
  }
  if (-not $portToCheck -and $status.app) {
    $derived = Get-AppPort $status.app
    if ($derived) {
      $portToCheck = $derived
    }
  }

  $portOpen = $null
  if ($portToCheck) {
    $portOpen = Test-TcpPortOpen -CheckPort $portToCheck
  }

  $runtimeStatus = $null
  if ($status.app -and $status.app.runtime) {
    $runtimeStatus = $status.app.runtime.status
  }

  [pscustomobject]@{
    action = "check-stop"
    ok = (($runtimeStatus -eq "stopped" -or $runtimeStatus -eq $null) -and (-not $portToCheck -or $portOpen -eq $false))
    id = $Id
    runtimeStatus = $runtimeStatus
    backendPort = $(if ($portToCheck) { $portToCheck } else { $null })
    portKnown = [bool]$portToCheck
    portOpen = $portOpen
    portClosureVerified = [bool]($portToCheck -and $portOpen -eq $false)
    status = $status.app
  }
}

function Ensure-Manifest {
  if (-not $AppId) {
    throw "-AppId is required for ensure-manifest."
  }
  if (-not $Name) {
    throw "-Name is required for ensure-manifest."
  }
  if (-not $Command) {
    throw "-Command is required for ensure-manifest."
  }

  $path = Resolve-ManifestPath
  if (Test-Path -LiteralPath $path) {
    return [pscustomobject]@{
      action = "ensure-manifest"
      ok = $true
      preserved = $true
      manifestPath = $path
      message = "Existing relaybase.app.json preserved."
    }
  }

  $manifest = [ordered]@{
    schemaVersion = 1
    id = $AppId
    name = $Name
    command = $Command
    cwd = $Cwd
    protocol = "http"
    healthUrl = "/"
  }

  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  $json = $manifest | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, "$json`n", $utf8NoBom)
  [pscustomobject]@{
    action = "ensure-manifest"
    ok = $true
    preserved = $false
    manifestPath = $path
    manifest = $manifest
  }
}

function New-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Ok,
    $Details
  )

  [pscustomobject]@{
    name = $Name
    ok = $Ok
    details = $Details
  }
}

function Invoke-RegisterManifest {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $body = Invoke-RelaybaseApi -Method Post -Path "/__hub/api/apps/register" -Body @{ manifestPath = $Path }
    [pscustomobject]@{ ok = $true; source = "http"; app = $body.app; error = $null }
  } catch {
    $discovery = Test-RelaybaseDiscovery
    if ($discovery.ok) {
      [pscustomobject]@{
        ok = $false
        source = "http"
        error = (Get-WebErrorMessage $_)
        message = "Relaybase is running but HTTP registration failed. Do not fall back to offline CLI registration because the running daemon will not reload that registry write."
        token = (Get-TokenInfo)
      }
    } else {
      $cli = Invoke-RelaybaseCli -CliCommand "register" -CliArgs @($Path)
      [pscustomobject]@{ ok = $cli.ok; source = $cli.source; cli = $cli; error = $(if ($cli.ok) { $null } else { $cli.output }) }
    }
  }
}

function Invoke-Lifecycle {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$LifecycleAction
  )

  try {
    $body = Invoke-RelaybaseApi -Method Post -Path "/__hub/api/apps/$([uri]::EscapeDataString($Id))/$LifecycleAction"
    [pscustomobject]@{ action = $LifecycleAction; ok = $true; source = "http"; runtime = $body.runtime; error = $null }
  } catch {
    $errorText = Get-WebErrorMessage $_
    $discovery = Test-RelaybaseDiscovery
    if ($discovery.ok -and $errorText -match "Unauthorized|401") {
      return [pscustomobject]@{
        action = $LifecycleAction
        ok = $false
        source = "http"
        error = $errorText
        message = "Relaybase is reachable but mutation auth failed. Run diagnose-token and verify the helper state dir matches the running Relaybase process."
        token = (Get-TokenInfo)
      }
    }

    $cli = Invoke-RelaybaseCli -CliCommand $LifecycleAction -CliArgs @($Id)
    [pscustomobject]@{ action = $LifecycleAction; ok = $cli.ok; source = $cli.source; cli = $cli; error = $(if ($cli.ok) { $null } else { $cli.output }) }
  }
}

function Read-SseLogStream {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [int]$Seconds = 5
  )

  $uri = "$(Get-BaseUrl)/__hub/api/apps/$([uri]::EscapeDataString($Id))/logs/stream"
  $events = @()
  $path = "/__hub/api/apps/$([uri]::EscapeDataString($Id))/logs/stream"
  $client = $null

  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect($HostName, $Port)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 250
    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII)
    $writer.NewLine = "`r`n"
    $writer.WriteLine("GET $path HTTP/1.1")
    $writer.WriteLine("Host: $HostName`:$Port")
    $writer.WriteLine("Accept: text/event-stream")
    $writer.WriteLine("Connection: close")
    $writer.WriteLine("")
    $writer.Flush()

    $buffer = New-Object byte[] 4096
    $text = ""
    $deadline = [DateTimeOffset]::Now.AddSeconds($Seconds)
    while ([DateTimeOffset]::Now -lt $deadline) {
      try {
        if ($stream.DataAvailable) {
          $read = $stream.Read($buffer, 0, $buffer.Length)
          if ($read -le 0) {
            break
          }
          $text += [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        } else {
          Start-Sleep -Milliseconds 50
        }
      } catch [System.IO.IOException] {
        Start-Sleep -Milliseconds 50
      }
    }

    $statusCode = $null
    if ($text -match "^HTTP/\d(?:\.\d)?\s+(\d+)") {
      $statusCode = [int]$Matches[1]
    }

    $parts = $text -split "\r?\n\r?\n", 2
    $body = $(if ($parts.Count -gt 1) { $parts[1] } else { "" })
    foreach ($block in ($body -split "\r?\n\r?\n")) {
      if (-not $block.Trim()) {
        continue
      }
      $eventName = $null
      $data = @()
      foreach ($line in ($block -split "\r?\n")) {
        if ($line.StartsWith("event:")) {
          $eventName = $line.Substring(6).Trim()
        } elseif ($line.StartsWith("data:")) {
          $data += $line.Substring(5).Trim()
        }
      }
      if ($eventName -or $data.Count -gt 0) {
        $events += [pscustomobject]@{ event = $eventName; data = ($data -join "`n") }
      }
      if ($events.Count -ge 25) {
        break
      }
    }

    [pscustomobject]@{
      action = "stream-logs"
      ok = ($statusCode -ge 200 -and $statusCode -lt 300 -and $events.Count -gt 0)
      id = $Id
      uri = $uri
      statusCode = $statusCode
      seconds = $Seconds
      events = $events
    }
  } catch {
    [pscustomobject]@{
      action = "stream-logs"
      ok = $false
      id = $Id
      uri = $uri
      seconds = $Seconds
      events = $events
      error = $_.Exception.Message
    }
  } finally {
    if ($client) {
      $client.Close()
    }
  }
}

function Invoke-Verify {
  $id = Get-EffectiveAppId
  $steps = @()

  $discovery = Test-RelaybaseDiscovery
  $steps += New-Step -Name "discovery" -Ok ([bool]$discovery.ok) -Details $discovery

  $token = Get-TokenInfo
  $steps += New-Step -Name "token" -Ok ([bool]$token.hasToken) -Details $token

  $manifestPathResolved = Resolve-ManifestPath
  $manifestExists = Test-Path -LiteralPath $manifestPathResolved
  $registerResult = $null
  if ($manifestExists) {
    $registerResult = Invoke-RegisterManifest -Path $manifestPathResolved
  } else {
    $existing = Get-AppStatus -Id $id
    $registerResult = [pscustomobject]@{
      ok = [bool]$existing.app
      skipped = [bool]$existing.app
      source = "existing-status"
      message = $(if ($existing.app) { "Manifest not found; existing registration was used." } else { "Manifest not found and app is not registered." })
      manifestPath = $manifestPathResolved
      status = $existing.app
    }
  }
  $steps += New-Step -Name "register" -Ok ([bool]$registerResult.ok) -Details $registerResult

  $startResult = Invoke-Lifecycle -Id $id -LifecycleAction "start"
  $startOk = [bool]($startResult.ok -and $startResult.runtime -and $startResult.runtime.status -eq "running")
  $steps += New-Step -Name "start" -Ok $startOk -Details $startResult

  $statusAfterStart = Get-AppStatus -Id $id
  $portBeforeStop = $null
  if ($startResult.runtime) {
    $portBeforeStop = Get-AppPort $startResult.runtime
  }
  if (-not $portBeforeStop -and $statusAfterStart.app) {
    $portBeforeStop = Get-AppPort $statusAfterStart.app
  }

  $route = Invoke-RouteCheck -Id $id
  $steps += New-Step -Name "routed-health" -Ok ([bool]$route.ok) -Details $route

  $logSnapshot = $null
  try {
    $logBody = Invoke-RelaybaseApi -Method Get -Path "/__hub/api/apps/$([uri]::EscapeDataString($id))/logs"
    $logSnapshot = [pscustomobject]@{ ok = $true; lines = @($logBody.logs) | Select-Object -Last $Lines }
  } catch {
    $logSnapshot = [pscustomobject]@{ ok = $false; error = (Get-WebErrorMessage $_) }
  }
  $steps += New-Step -Name "logs" -Ok ([bool]$logSnapshot.ok) -Details $logSnapshot

  $stream = Read-SseLogStream -Id $id -Seconds ([Math]::Min($StreamSeconds, 5))
  $steps += New-Step -Name "live-logs" -Ok ([bool]$stream.ok) -Details $stream

  $stopResult = Invoke-Lifecycle -Id $id -LifecycleAction "stop"
  $stopOk = [bool]($stopResult.ok -and $stopResult.runtime -and $stopResult.runtime.status -eq "stopped")
  $steps += New-Step -Name "stop" -Ok $stopOk -Details $stopResult

  $closed = Test-StopClosed -Id $id -KnownPort $(if ($portBeforeStop) { $portBeforeStop } else { 0 })
  $steps += New-Step -Name "backend-port-closed" -Ok ([bool]$closed.ok) -Details $closed

  if ($DashboardStatusUrl) {
    $dashboard = Invoke-HttpCheck -Uri $DashboardStatusUrl
    $steps += New-Step -Name "dashboard-status" -Ok ([bool]$dashboard.ok) -Details $dashboard
  }

  $ok = -not [bool]($steps | Where-Object { -not $_.ok } | Select-Object -First 1)
  [pscustomobject]@{
    action = "verify"
    ok = $ok
    id = $id
    manifestPath = $manifestPathResolved
    backendPortChecked = $portBeforeStop
    steps = $steps
  }
}

function Get-DockerProfilePath {
  $root = [System.IO.Path]::GetFullPath((Split-Path -Parent (Resolve-ManifestPath)))
  return Join-Path $root ".relaybase\docker-profile.json"
}

function Get-DockerProfile {
  $path = Get-DockerProfilePath
  if (-not (Test-Path -LiteralPath $path)) {
    return $null
  }
  (Get-Content -LiteralPath $path -Raw) | ConvertFrom-Json
}

function Invoke-DockerJson {
  param([Parameter(Mandatory = $true)][string[]]$DockerArgs)
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & docker @DockerArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $code) {
    $code = 1
  }
  [pscustomobject]@{
    ok = ($code -eq 0)
    exitCode = $code
    command = "docker $($DockerArgs -join ' ')"
    output = ($output -join "`n")
  }
}

function Get-ComposeArgs {
  param([Parameter(Mandatory = $true)]$Profile)
  $args = @()
  $root = [System.IO.Path]::GetFullPath((Split-Path -Parent (Resolve-ManifestPath)))
  foreach ($file in @($Profile.composeFiles)) {
    $args += @("-f", (Join-Path $root ([string]$file)))
  }
  if ($Profile.overrideFile) {
    $args += @("-f", (Join-Path $root ([string]$Profile.overrideFile)))
  }
  foreach ($profileName in @($Profile.profiles)) {
    $args += @("--profile", ([string]$profileName))
  }
  $args += @("-p", ([string]$Profile.composeProjectName))
  return $args
}

function Invoke-ComposeJson {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string[]]$ComposeArgs
  )
  Invoke-DockerJson -DockerArgs (@("compose") + (Get-ComposeArgs -Profile $Profile) + $ComposeArgs)
}

function Invoke-DockerPreflight {
  $profile = Get-DockerProfile
  $dockerVersion = Invoke-DockerJson -DockerArgs @("--version")
  $dockerInfo = Invoke-DockerJson -DockerArgs @("info", "--format", "{{json .}}")
  $context = Invoke-DockerJson -DockerArgs @("context", "show")
  $composeVersion = Invoke-DockerJson -DockerArgs @("compose", "version")
  [pscustomobject]@{
    action = "docker-preflight"
    ok = ($dockerVersion.ok -and $dockerInfo.ok -and $composeVersion.ok -and [bool]$profile)
    profilePath = (Get-DockerProfilePath)
    profile = $profile
    dockerVersion = $dockerVersion
    dockerInfo = $dockerInfo
    context = $context
    composeVersion = $composeVersion
    remoteContextBlocked = [bool]($context.output -match "ssh://|tcp://|remote")
  }
}

function Invoke-ComposeDetect {
  $root = [System.IO.Path]::GetFullPath((Split-Path -Parent (Resolve-ManifestPath)))
  $files = Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Name -match "^(compose|docker-compose)\.ya?ml$" }
  [pscustomobject]@{
    action = "compose-detect"
    ok = ($files.Count -gt 0)
    root = $root
    composeFiles = @($files | ForEach-Object { $_.FullName })
    dockerProfile = Get-DockerProfile
  }
}

function Invoke-ComposeStatus {
  $profile = Get-DockerProfile
  if (-not $profile) {
    return [pscustomobject]@{ action = "compose-status"; ok = $false; error = "Docker profile not found." }
  }
  $ps = Invoke-ComposeJson -Profile $profile -ComposeArgs @("ps", "--format", "json")
  [pscustomobject]@{ action = "compose-status"; ok = $ps.ok; profile = $profile; ps = $ps }
}

function Invoke-ComposeHealth {
  $profile = Get-DockerProfile
  if (-not $profile) {
    return [pscustomobject]@{ action = "compose-health"; ok = $false; error = "Docker profile not found." }
  }
  $ps = Invoke-ComposeJson -Profile $profile -ComposeArgs @("ps", "--format", "json")
  $config = Invoke-ComposeJson -Profile $profile -ComposeArgs @("config")
  [pscustomobject]@{
    action = "compose-health"
    ok = ($ps.ok -and $config.ok)
    selectedService = $profile.selectedService
    requiredServices = $profile.requiredServices
    optionalServices = $profile.optionalServices
    ps = $ps
    config = $config
  }
}

function Invoke-ComposeLogs {
  $profile = Get-DockerProfile
  if (-not $profile) {
    return [pscustomobject]@{ action = "compose-logs"; ok = $false; error = "Docker profile not found." }
  }
  $logs = Invoke-ComposeJson -Profile $profile -ComposeArgs @("logs", "--no-color", "--tail", "$Lines")
  [pscustomobject]@{ action = "compose-logs"; ok = $logs.ok; logs = $logs }
}

function Invoke-ComposeCleanup {
  $profile = Get-DockerProfile
  if (-not $profile) {
    return [pscustomobject]@{ action = "compose-cleanup"; ok = $false; error = "Docker profile not found." }
  }
  $down = Invoke-ComposeJson -Profile $profile -ComposeArgs @("down", "--remove-orphans", "--timeout", "30")
  $verify = Invoke-ComposeVerifyStop
  [pscustomobject]@{ action = "compose-cleanup"; ok = ($down.ok -and $verify.ok); down = $down; verify = $verify }
}

function Invoke-ComposeVerifyStop {
  $profile = Get-DockerProfile
  if (-not $profile) {
    return [pscustomobject]@{ action = "compose-verify-stop"; ok = $false; error = "Docker profile not found." }
  }
  $ps = Invoke-ComposeJson -Profile $profile -ComposeArgs @("ps", "--format", "json")
  $portChecks = @()
  if ($BackendPort) {
    $portChecks += [pscustomobject]@{ port = $BackendPort; open = (Test-TcpPortOpen -CheckPort $BackendPort) }
  }
  foreach ($port in @($profile.dependencyPorts)) {
    $portChecks += [pscustomobject]@{ port = [int]$port; open = (Test-TcpPortOpen -CheckPort ([int]$port)) }
  }
  $survivingPort = $portChecks | Where-Object { $_.open } | Select-Object -First 1
  $survivingContainers = ($ps.ok -and $ps.output.Trim().Length -gt 2)
  [pscustomobject]@{
    action = "compose-verify-stop"
    ok = (-not $survivingContainers -and -not $survivingPort)
    ps = $ps
    portChecks = $portChecks
    cleanupStatus = $(if ($survivingContainers -or $survivingPort) { "cleanup_failed" } else { "succeeded" })
  }
}

function Invoke-DockerDiagnose {
  [pscustomobject]@{
    action = "docker-diagnose"
    ok = $true
    preflight = Invoke-DockerPreflight
    detect = Invoke-ComposeDetect
    status = Invoke-ComposeStatus
    health = Invoke-ComposeHealth
  }
}

try {
  switch ($Action) {
    "preflight" {
      $discovery = Test-RelaybaseDiscovery
      $tokenInfo = Get-TokenInfo
      $repoPackage = Join-Path $RelaybaseRepo "package.json"
      Write-Result ([pscustomobject]@{
        action = "preflight"
        ok = $discovery.ok
        relaybaseReachable = $discovery.ok
        discovery = $discovery
        token = $tokenInfo
        cli = [pscustomobject]@{
          npm = [bool](Get-Command npm.cmd -ErrorAction SilentlyContinue)
          npx = [bool](Get-Command npx.cmd -ErrorAction SilentlyContinue)
          repo = $RelaybaseRepo
          repoPackageExists = (Test-Path -LiteralPath $repoPackage)
        }
        windows = [pscustomobject]@{
          powershell = $PSVersionTable.PSVersion.ToString()
          pwsh = [bool](Get-Command pwsh -ErrorAction SilentlyContinue)
          npmCmdPreferred = $true
        }
        fallbackAllowed = (-not $discovery.ok)
        fallbackReason = $(if ($discovery.ok) { $null } else { "Relaybase discovery is unreachable." })
      })
    }
    "diagnose-token" {
      Write-Result (Get-TokenDiagnosis)
    }
    "status" {
      try {
        $body = Invoke-RelaybaseApi -Method Get -Path "/__hub/api/apps"
        Write-Result ([pscustomobject]@{ action = "status"; ok = $true; source = "http"; apps = $body.apps })
      } catch {
        $cli = Invoke-RelaybaseCli -CliCommand "status"
        Write-Result ([pscustomobject]@{ action = "status"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "register" {
      $path = Resolve-ManifestPath
      if (-not (Test-Path -LiteralPath $path)) {
        throw "Manifest not found: $path"
      }
      $result = Invoke-RegisterManifest -Path $path
      Write-Result ([pscustomobject]@{ action = "register"; ok = $result.ok; result = $result })
      if (-not $result.ok) { exit 1 }
    }
    "start" {
      $id = Get-EffectiveAppId
      $result = Invoke-Lifecycle -Id $id -LifecycleAction "start"
      Write-Result ([pscustomobject]@{ action = "start"; ok = $result.ok; id = $id; result = $result })
      if (-not $result.ok) { exit 1 }
    }
    "stop" {
      $id = Get-EffectiveAppId
      $statusBeforeStop = Get-AppStatus -Id $id
      $knownPort = $(if ($statusBeforeStop.app) { Get-AppPort $statusBeforeStop.app } else { $null })
      $result = Invoke-Lifecycle -Id $id -LifecycleAction "stop"
      $closed = Test-StopClosed -Id $id -KnownPort $(if ($knownPort) { $knownPort } else { 0 })
      Write-Result ([pscustomobject]@{ action = "stop"; ok = ($result.ok -and $closed.ok); id = $id; result = $result; stopCheck = $closed })
      if (-not ($result.ok -and $closed.ok)) { exit 1 }
    }
    "restart" {
      $id = Get-EffectiveAppId
      $result = Invoke-Lifecycle -Id $id -LifecycleAction "restart"
      Write-Result ([pscustomobject]@{ action = "restart"; ok = $result.ok; id = $id; result = $result })
      if (-not $result.ok) { exit 1 }
    }
    "logs" {
      $id = Get-EffectiveAppId
      try {
        $body = Invoke-RelaybaseApi -Method Get -Path "/__hub/api/apps/$([uri]::EscapeDataString($id))/logs"
        $tail = @($body.logs) | Select-Object -Last $Lines
        Write-Result ([pscustomobject]@{ action = "logs"; ok = $true; source = "http"; id = $id; lines = $tail })
      } catch {
        $cli = Invoke-RelaybaseCli -CliCommand "logs" -CliArgs @($id)
        Write-Result ([pscustomobject]@{ action = "logs"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "stream-logs" {
      $id = Get-EffectiveAppId
      Write-Result (Read-SseLogStream -Id $id -Seconds $StreamSeconds)
    }
    "url" {
      $id = Get-EffectiveAppId
      Write-Result ([pscustomobject]@{
        action = "url"
        ok = $true
        id = $id
        human = "http://$id.localhost:$Port"
        agent = [pscustomobject]@{
          url = "$(Get-BaseUrl)/"
          headers = [pscustomobject]@{ "X-Relaybase-App" = $id }
        }
      })
    }
    "route-check" {
      $id = Get-EffectiveAppId
      $result = Invoke-RouteCheck -Id $id
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "check-stop" {
      $id = Get-EffectiveAppId
      $result = Test-StopClosed -Id $id -KnownPort $BackendPort
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "ensure-manifest" {
      Write-Result (Ensure-Manifest)
    }
    "verify" {
      $result = Invoke-Verify
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "docker-preflight" {
      $result = Invoke-DockerPreflight
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "compose-detect" {
      $result = Invoke-ComposeDetect
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "compose-status" {
      $result = Invoke-ComposeStatus
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "compose-health" {
      $result = Invoke-ComposeHealth
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "compose-logs" {
      $result = Invoke-ComposeLogs
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "compose-cleanup" {
      $result = Invoke-ComposeCleanup
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "compose-verify-stop" {
      $result = Invoke-ComposeVerifyStop
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
    "docker-diagnose" {
      $result = Invoke-DockerDiagnose
      Write-Result $result
      if (-not $result.ok) { exit 1 }
    }
  }
} catch {
  Write-Result ([pscustomobject]@{
    action = $Action
    ok = $false
    error = $_.Exception.Message
  })
  exit 1
}
