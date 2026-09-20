<#
  SIGHTLINE - ANS agent registration (VTHacks 14)

  Registers one agent with GoDaddy's PRODUCTION Agent Name Service.

  Usage, from this folder in PowerShell:

      $env:ANS_API_KEY = "<KEY>:<SECRET>"      # from classic-developer.godaddy.com/keys
      .\register-agent.ps1 -Agent guardian

  Then publish the DNS records it prints at Porkbun and run:

      .\ans-cli.exe verify-acme <agentId>
      .\ans-cli.exe verify-dns  <agentId>
      .\ans-cli.exe status      <agentId>

  Do NOT register "rogue" - it stays unregistered on purpose, so the
  blocked-agent demo fails for a real reason.
#>

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("guardian", "memory")]
  [string]$Agent,

  [string]$Domain = "sightline.surf",
  [string]$Version = "1.0.0",
  [string]$Org = "SIGHTLINE"
)

$ErrorActionPreference = "Stop"

# --- The registry defaults to the OTE *test* environment. Force production. ---
$env:ANS_BASE_URL = "https://api.godaddy.com/"

if (-not $env:ANS_API_KEY) {
  Write-Host "ANS_API_KEY is not set." -ForegroundColor Red
  Write-Host 'Set it first:  $env:ANS_API_KEY = "<KEY>:<SECRET>"'
  Write-Host "Get the pair at https://classic-developer.godaddy.com/keys (type: Production)."
  exit 1
}
if ($env:ANS_API_KEY -notmatch ":") {
  Write-Host "ANS_API_KEY must be KEY:SECRET (both halves, colon separated)." -ForegroundColor Red
  exit 1
}

$cfg = @{
  guardian = @{
    Name        = "SIGHTLINE Guardian"
    Description = "Safety agent for SIGHTLINE. Detects falls from wearable telemetry and requests scene context from the Memory agent before escalating."
    Endpoint    = "/api/guardian"
    Functions   = @(
      "fall-detect:Fall Detection:safety,telemetry",
      "escalate:Emergency Escalation:safety,notification"
    )
  }
  memory = @{
    Name        = "SIGHTLINE Memory"
    Description = "Object memory for SIGHTLINE. Stores and recalls what the wearer has seen, and releases scene context only to ANS-verified agents within policy scope."
    Endpoint    = "/api/memory/context"
    Functions   = @(
      "recall:Object Recall:memory,vision",
      "context:Scene Context:memory"
    )
  }
}[$Agent]

$host_fqdn = "$Agent.$Domain"
$certDir   = ".\certs\$Agent"

Write-Host ""
Write-Host "=== Registering $host_fqdn with PRODUCTION ANS ===" -ForegroundColor Cyan
Write-Host "  base url : $env:ANS_BASE_URL"
Write-Host "  host     : $host_fqdn"
Write-Host "  version  : $Version"
Write-Host ""

# --- 1. CSRs (identity = EC P-256, server = RSA-2048; registry defaults) ------
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
Write-Host "[1/2] generate-csr" -ForegroundColor Yellow
.\ans-cli.exe generate-csr `
  --host    $host_fqdn `
  --org     $Org `
  --version $Version `
  --country US `
  --out-dir $certDir
if ($LASTEXITCODE -ne 0) { Write-Host "generate-csr failed" -ForegroundColor Red; exit 1 }

# --- 2. Register ---------------------------------------------------------------
Write-Host ""
Write-Host "[2/2] register" -ForegroundColor Yellow

$args = @(
  "register",
  "--name",               $cfg.Name,
  "--host",               $host_fqdn,
  "--version",            $Version,
  "--description",        $cfg.Description,
  "--identity-csr",       "$certDir\identity.csr",
  "--server-csr",         "$certDir\server.csr",
  "--endpoint-url",       "https://$host_fqdn$($cfg.Endpoint)",
  "--metadata-url",       "https://$host_fqdn/.well-known/agent-card.json",
  "--endpoint-protocol",  "HTTP-API",
  "--endpoint-transports","STREAMABLE-HTTP",
  "--verbose"
)
foreach ($f in $cfg.Functions) { $args += @("--function", $f) }

& .\ans-cli.exe @args
if ($LASTEXITCODE -ne 0) { Write-Host "register failed - see the error above" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== NEXT ===" -ForegroundColor Green
Write-Host "1. Copy the agentId printed above."
Write-Host "2. Add the _acme-challenge TXT record it gave you, in Porkbun DNS for $Domain."
Write-Host "   Porkbun's Host field takes the part BEFORE $Domain - e.g. _acme-challenge.$Agent"
Write-Host "3. .\ans-cli.exe verify-acme <agentId>"
Write-Host "4. Add the _ans.$Agent and _ans-badge.$Agent TXT records it then gives you (both required)."
Write-Host "5. .\ans-cli.exe verify-dns <agentId>"
Write-Host "6. .\ans-cli.exe status <agentId>    # looking for ACTIVE"
Write-Host ""
Write-Host "Then, from web\ :  npx tsx ans-check.ts" -ForegroundColor Cyan
