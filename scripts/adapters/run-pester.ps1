<#
Pester v5 runner for the Sterling 'pester' toolchain adapter (scripts/adapters/pester.mjs).
Runs Invoke-Pester over the given paths and emits ONE delimited JSON summary on stdout
that the adapter parses to classify pass | assertion_fail | crash. Pester v5 required.
Verbosity is None so the only structured stdout is the delimited block.
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Path)

$ErrorActionPreference = 'Stop'
$START = '@@PESTER_JSON_START@@'
$END = '@@PESTER_JSON_END@@'

function Emit($obj) {
  $START
  ($obj | ConvertTo-Json -Depth 6 -Compress)
  $END
}

try {
  Import-Module Pester -MinimumVersion 5.0 -ErrorAction Stop
  if (-not $Path -or $Path.Count -eq 0) { $Path = @('.') }
  $cfg = [PesterConfiguration]::Default
  $cfg.Run.Path = $Path
  $cfg.Run.PassThru = $true
  $cfg.Output.Verbosity = 'None'
  $r = Invoke-Pester -Configuration $cfg
  $tests = foreach ($t in $r.Tests) {
    [pscustomobject]@{
      name   = [string]$t.Name
      result = [string]$t.Result
      errId  = [string]$t.ErrorRecord.FullyQualifiedErrorId
    }
  }
  Emit ([pscustomobject]@{
      ok      = $true
      result  = [string]$r.Result
      passed  = [int]$r.PassedCount
      failed  = [int]$r.FailedCount
      skipped = [int]$r.SkippedCount
      tests   = @($tests)
    })
}
catch {
  Emit ([pscustomobject]@{ ok = $false; error = [string]$_.Exception.Message })
}
