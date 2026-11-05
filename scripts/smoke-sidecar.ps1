param([string]$SidecarDirectory = (Join-Path $PSScriptRoot '../electron/sidecar'))
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scratchParent = Join-Path $repoRoot '.tools'
$scratchRoot = Join-Path $scratchParent ('sidecar-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratchRoot -Force | Out-Null
$folderA = Join-Path $scratchRoot 'A'
$folderB = Join-Path $scratchRoot 'B'
New-Item -ItemType Directory -Path $folderA, $folderB | Out-Null
$original = ('a' * 70000) + "`nLAST LINE`n"
[IO.File]::WriteAllText((Join-Path $folderA 'large.txt'), $original)
[IO.File]::WriteAllText((Join-Path $folderB 'large.txt'), 'project B')
$token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$taskOldToken = $env:AICLIENT_AUTHTOKEN
$taskOldData = $env:AICLIENT_DataRoot
$taskOldDotnetRoot = $env:DOTNET_ROOT
$probeProcess = $null
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$probePort = $portProbe.LocalEndpoint.Port
$portProbe.Stop()
$base = "http://127.0.0.1:$probePort"
function Call-Api([string]$Method, [string]$Path, $Payload = $null, [int]$Expected = 200, [bool]$Authenticated = $true) {
    # Compatible with Windows PowerShell 5.1 and PowerShell 7: 5.1 throws on non-2xx, 7 only does
    # so without -SkipHttpErrorCheck, and the two exceptions carry different Response shapes.
    $options = @{ Uri = $base + $Path; Method = $Method; TimeoutSec = 15; UseBasicParsing = $true }
    if ($Authenticated) { $options.Headers = @{ Authorization = "Bearer $token" } }
    if ($null -ne $Payload) { $options.Body = $Payload | ConvertTo-Json -Depth 20 -Compress; $options.ContentType = 'application/json' }
    $status = 0
    $content = $null
    try {
        $response = Invoke-WebRequest @options
        $status = [int]$response.StatusCode
        $content = $response.Content
    } catch {
        $response = $_.Exception.Response
        if (-not $response -and $_.Exception.InnerException) { $response = $_.Exception.InnerException.Response }
        if (-not $response) { throw }
        $status = [int]$response.StatusCode
        if ($response -is [System.Net.HttpWebResponse]) {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
            $content = $reader.ReadToEnd()
            $reader.Close()
        } else {
            $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
    }
    if ($status -ne $Expected) { throw "$Method $Path expected $Expected, received ${status}: $content" }
    if ($content) { return $content | ConvertFrom-Json }
}
function Assert-Probe([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
    $exe = [IO.Path]::GetFullPath((Join-Path $SidecarDirectory 'AIClient.Server.exe'))
    Assert-Probe (Test-Path (Join-Path $SidecarDirectory 'hostfxr.dll')) 'The release sidecar must contain its runtime.'
    $env:AICLIENT_AUTHTOKEN = $token
    $env:AICLIENT_DataRoot = Join-Path $scratchRoot 'data'
    $env:DOTNET_ROOT = Join-Path $scratchRoot 'no-system-runtime'
    $probeProcess = Start-Process -FilePath $exe -ArgumentList '--urls', $base -WorkingDirectory $SidecarDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $scratchRoot 'stdout.log') -RedirectStandardError (Join-Path $scratchRoot 'stderr.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($probeProcess.HasExited) { throw 'Sidecar exited before becoming ready.' }
        try {
            $health = Invoke-WebRequest -Uri ($base + '/api/health') -TimeoutSec 2
            if ($health.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 200 }
    }
    Assert-Probe $ready 'Sidecar did not become ready.'
    $null = Call-Api GET '/api/workspace' $null 401 $false
    $null = Call-Api POST '/api/workspace/open' @{ directory = $folderA }
    $document = Call-Api GET ('/api/workspace/document?path=large.txt&expectedRoot=' + [uri]::EscapeDataString($folderA))
    Assert-Probe ($document.content -ceq $original -and -not $document.isTruncated -and !!$document.contentHash) 'Complete editor read failed.'
    $cp = Call-Api POST '/api/checkpoints' @{ conversationId = [guid]::Empty; label = 'smoke'; files = @('large.txt'); includeGraph = $false; expectedRoot = $folderA }
    $snapshot = Call-Api GET ('/api/checkpoints/' + $cp.id)
    Assert-Probe ($snapshot.files.'large.txt' -ceq $original -and $snapshot.formatVersion -eq 2) 'Checkpoint truncated the document.'
    $null = Call-Api POST '/api/workspace/write' @{ path = 'large.txt'; content = 'edited'; expectedRoot = $folderA; expectedHash = $document.contentHash }
    $null = Call-Api POST ('/api/checkpoints/' + $cp.id + '/restore') @{}
    Assert-Probe ([IO.File]::ReadAllText((Join-Path $folderA 'large.txt')) -ceq $original) 'Checkpoint restore lost file content.'
    [IO.File]::WriteAllText((Join-Path $folderA 'large.txt'), 'external edit')
    $null = Call-Api POST '/api/workspace/write' @{ path = 'large.txt'; content = 'stale editor'; expectedRoot = $folderA; expectedHash = $document.contentHash } 400
    Assert-Probe ([IO.File]::ReadAllText((Join-Path $folderA 'large.txt')) -ceq 'external edit') 'Stale editor overwrote an external edit.'
    $null = Call-Api POST '/api/workspace/open' @{ directory = $folderB }
    $null = Call-Api POST '/api/workspace/write' @{ path = 'large.txt'; content = 'wrong project'; expectedRoot = $folderA } 409
    $null = Call-Api POST ('/api/checkpoints/' + $cp.id + '/restore') @{} 409
    Assert-Probe ([IO.File]::ReadAllText((Join-Path $folderB 'large.txt')) -ceq 'project B') 'A workspace-bound operation wrote into another project.'
    $snapshot.formatVersion = 1
    $snapshot.workspaceRoot = $folderB
    [IO.File]::WriteAllText((Join-Path $scratchRoot ('data/AIClient/checkpoints/' + $cp.id + '.json')), ($snapshot | ConvertTo-Json -Depth 20))
    $null = Call-Api POST ('/api/checkpoints/' + $cp.id + '/restore') @{} 409
    Write-Host 'Sidecar smoke passed: embedded runtime, authentication, full documents, checkpoints, hash conflicts and workspace isolation.'
} catch {
    foreach ($logName in @('stdout.log', 'stderr.log')) {
        $logPath = Join-Path $scratchRoot $logName
        if (Test-Path -LiteralPath $logPath) {
            Write-Host "Sidecar $logName (last 60 lines):"
            Get-Content -LiteralPath $logPath -Tail 60 | Write-Host
        }
    }
    throw
} finally {
    if ($probeProcess -and -not $probeProcess.HasExited) { Stop-Process -Id $probeProcess.Id -Force; $probeProcess.WaitForExit() }
    $env:AICLIENT_AUTHTOKEN = $taskOldToken
    $env:AICLIENT_DataRoot = $taskOldData
    $env:DOTNET_ROOT = $taskOldDotnetRoot
    $resolvedScratch = [IO.Path]::GetFullPath($scratchRoot)
    if ([IO.Path]::GetDirectoryName($resolvedScratch) -eq [IO.Path]::GetFullPath($scratchParent)) {
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
}
