# Windows PowerShell 5.1; classic Outlook only. Read-only access to task items.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$Request,
 [string]$Output = (Join-Path (Get-Location) 'HelloTodo-Outlook-Attachments.json'),
 [int]$StoreIndex = 0
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.format -ne 'hellotodo-outlook-request-v1') { throw 'Invalid HelloTodo request file.' }
if (Test-Path -LiteralPath $Output) { throw 'Output exists. Choose a new output filename.' }
$outlook = New-Object -ComObject Outlook.Application
$ns = $outlook.GetNamespace('MAPI')
$stores = $ns.Stores
if ($StoreIndex -eq 0) {
 Write-Host 'Select the correct account/store (same Microsoft account as the original To Do):'
 for ($i = 1; $i -le $stores.Count; $i++) { Write-Host ("{0}: {1}" -f $i, $stores.Item($i).DisplayName) }
 $StoreIndex = [int](Read-Host 'Store number')
}
if ($StoreIndex -lt 1 -or $StoreIndex -gt $stores.Count) { throw 'Invalid store number.' }
$store = $stores.Item($StoreIndex)
Write-Host ('Read-only scan: ' + $store.DisplayName)
# Index by subject; do not access mail bodies or export unrelated items.
$wanted = [System.Collections.Generic.Dictionary[string,object]]::new([System.StringComparer]::Ordinal)
function Normalize-Title([string]$s) { return ($s -replace "`r`n", "`n" -replace "`r", "`n") }
foreach ($q in @($manifest.tasks)) {
 if (-not $q.title -or -not $q.createdAt -or $q.taskId -notmatch '^mstask-[a-f0-9]{64}$') { continue }
 $k = Normalize-Title $q.title
 if (-not $wanted.ContainsKey($k)) { $wanted[$k] = [System.Collections.Generic.List[object]]::new() }
 $wanted[$k].Add([pscustomobject]@{ request=$q; matches=([System.Collections.Generic.List[object]]::new()) })
}
function Scan-Folder($folder) {
 try {
  if ([int]$folder.DefaultItemType -eq 3) {
   $items=$folder.Items
   for ($n=1; $n -le $items.Count; $n++) {
    try {
     $item=$items.Item($n)
     if ([int]$item.Class -ne 48) { continue }
     $title=Normalize-Title $item.Subject
     if (-not $wanted.ContainsKey($title)) { continue }
     $created=([datetime]$item.CreationTime).ToUniversalTime()
     foreach ($entry in $wanted[$title]) {
      $expected=[DateTimeOffset]::Parse([string]$entry.request.createdAt).UtcDateTime
      if ([Math]::Abs(($created-$expected).TotalSeconds) -le 120) {
       $entry.matches.Add([pscustomobject]@{ id=$item.EntryID; store=$folder.StoreID })
      }
     }
    } catch { Write-Warning ('Task read failed: ' + $_.Exception.Message) }
   }
  }
 } catch { Write-Warning ('Folder scan failed: ' + $_.Exception.Message) }
 try { for ($i=1; $i -le $folder.Folders.Count; $i++) { Scan-Folder ($folder.Folders.Item($i)) } } catch { Write-Warning $_.Exception.Message }
}
Scan-Folder ($store.GetRootFolder())
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('HelloTodo-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tmp) | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
$errors = [System.Collections.Generic.List[object]]::new()
try {
 foreach ($entries in $wanted.Values) { foreach ($entry in $entries) {
  $q=$entry.request
  # Never guess a task mapping if title and creation time are ambiguous.
  if ($entry.matches.Count -ne 1) { $errors.Add([pscustomobject]@{taskId=$q.taskId;reason=('Expected one exact-title/time match; found '+$entry.matches.Count)}); continue }
  try {
   $m=$entry.matches[0]
   $ambiguous=$false
   foreach ($other in $wanted[(Normalize-Title $q.title)]) {
    if ($other.request.taskId -eq $q.taskId) { continue }
    foreach ($candidate in $other.matches) { if ($candidate.id -eq $m.id -and $candidate.store -eq $m.store) { $ambiguous=$true } }
   }
   if ($ambiguous) { $errors.Add([pscustomobject]@{taskId=$q.taskId;reason='Same Outlook item matches multiple HelloTodo tasks'}); continue }
   $item=$ns.GetItemFromID($m.id,$m.store)
   $files=[System.Collections.Generic.List[object]]::new()
   for ($i=1; $i -le $item.Attachments.Count; $i++) {
    $a=$item.Attachments.Item($i); $path=Join-Path $tmp ([Guid]::NewGuid().ToString('N')+'.bin')
    try {
     if ($a.Size -gt 25MB) { throw 'Attachment exceeds 25 MiB.' }
     $a.SaveAsFile($path)
     $bytes=[IO.File]::ReadAllBytes($path)
     if ($bytes.Length -gt 25MB) { throw 'Attachment exceeds 25 MiB.' }
     $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
     $files.Add([pscustomobject]@{name=[string]$a.FileName;size=$bytes.Length;type='application/octet-stream';sha256=$hash;contentBytes=[Convert]::ToBase64String($bytes)})
    } catch { $errors.Add([pscustomobject]@{taskId=$q.taskId;reason=$_.Exception.Message}) }
    finally { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
   }
   if ($files.Count -gt 0) { $results.Add([pscustomobject]@{taskId=$q.taskId;title=$q.title;createdAt=$q.createdAt;files=$files.ToArray()}) }
   else { $errors.Add([pscustomobject]@{taskId=$q.taskId;reason='Outlook returned no accessible attachments'}) }
  } catch { $errors.Add([pscustomobject]@{taskId=$q.taskId;reason=$_.Exception.Message}) }
 } }
 $bundle=[pscustomobject]@{format='hellotodo-outlook-attachments-v1';tasks=$results.ToArray();errors=$errors.ToArray()}
 $bundle | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output -Encoding UTF8
 Write-Host ('Matched tasks with files: '+$results.Count+'; issues: '+$errors.Count)
 Write-Host ('Saved: '+$Output+' (contains private data; do not upload publicly).')
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }
