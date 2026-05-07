[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("preflight", "status", "register", "start", "stop", "restart", "logs", "url", "ensure-manifest")]
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
  [string]$RelaybaseRepo
)

$ErrorActionPreference = "Stop"

if (-not $RelaybaseRepo) {
  $RelaybaseRepo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
}

function Write-Result {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 20
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
  [pscustomobject]@{
    stateDir = $dir
    tokenPath = $path
    exists = $exists
  }
}

function Read-RelaybaseToken {
  $info = Get-TokenInfo
  if (-not $info.exists) {
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

function Require-AppId {
  if (-not $AppId) {
    throw "-AppId is required for action '$Action'."
  }
}

function Resolve-ManifestPath {
  [System.IO.Path]::GetFullPath($ManifestPath)
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
        fallbackAllowed = (-not $discovery.ok)
        fallbackReason = $(if ($discovery.ok) { $null } else { "Relaybase discovery is unreachable." })
      })
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

      $discovery = Test-RelaybaseDiscovery
      try {
        $body = Invoke-RelaybaseApi -Method Post -Path "/__hub/api/apps/register" -Body @{ manifestPath = $path }
        Write-Result ([pscustomobject]@{ action = "register"; ok = $true; source = "http"; app = $body.app })
      } catch {
        if ($discovery.ok) {
          Write-Result ([pscustomobject]@{
            action = "register"
            ok = $false
            source = "http"
            error = (Get-WebErrorMessage $_)
            message = "Relaybase is running but HTTP registration failed. Do not fall back to offline CLI registration because the running daemon will not reload that registry write."
          })
          exit 1
        }
        $cli = Invoke-RelaybaseCli -CliCommand "register" -CliArgs @($path)
        Write-Result ([pscustomobject]@{ action = "register"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "start" {
      Require-AppId
      try {
        $body = Invoke-RelaybaseApi -Method Post -Path "/__hub/api/apps/$([uri]::EscapeDataString($AppId))/start"
        Write-Result ([pscustomobject]@{ action = "start"; ok = $true; source = "http"; runtime = $body.runtime })
      } catch {
        $cli = Invoke-RelaybaseCli -CliCommand "start" -CliArgs @($AppId)
        Write-Result ([pscustomobject]@{ action = "start"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "stop" {
      Require-AppId
      try {
        $body = Invoke-RelaybaseApi -Method Post -Path "/__hub/api/apps/$([uri]::EscapeDataString($AppId))/stop"
        Write-Result ([pscustomobject]@{ action = "stop"; ok = $true; source = "http"; runtime = $body.runtime })
      } catch {
        $cli = Invoke-RelaybaseCli -CliCommand "stop" -CliArgs @($AppId)
        Write-Result ([pscustomobject]@{ action = "stop"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "restart" {
      Require-AppId
      try {
        $body = Invoke-RelaybaseApi -Method Post -Path "/__hub/api/apps/$([uri]::EscapeDataString($AppId))/restart"
        Write-Result ([pscustomobject]@{ action = "restart"; ok = $true; source = "http"; runtime = $body.runtime })
      } catch {
        $cli = Invoke-RelaybaseCli -CliCommand "restart" -CliArgs @($AppId)
        Write-Result ([pscustomobject]@{ action = "restart"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "logs" {
      Require-AppId
      try {
        $body = Invoke-RelaybaseApi -Method Get -Path "/__hub/api/apps/$([uri]::EscapeDataString($AppId))/logs"
        $tail = @($body.logs) | Select-Object -Last $Lines
        Write-Result ([pscustomobject]@{ action = "logs"; ok = $true; source = "http"; id = $AppId; lines = $tail })
      } catch {
        $cli = Invoke-RelaybaseCli -CliCommand "logs" -CliArgs @($AppId)
        Write-Result ([pscustomobject]@{ action = "logs"; ok = $cli.ok; source = $cli.source; cli = $cli })
      }
    }
    "url" {
      Require-AppId
      Write-Result ([pscustomobject]@{
        action = "url"
        ok = $true
        id = $AppId
        human = "http://$AppId.localhost:$Port"
        agent = [pscustomobject]@{
          url = "$(Get-BaseUrl)/"
          headers = [pscustomobject]@{ "X-Relaybase-App" = $AppId }
        }
      })
    }
    "ensure-manifest" {
      Write-Result (Ensure-Manifest)
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
