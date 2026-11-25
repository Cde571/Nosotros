param([switch]$AppOnly,[string]$AppOutput)
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$csc="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if($AppOutput -and -not $AppOnly){throw 'AppOutput requires AppOnly'}
$payload=if($AppOutput){$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AppOutput)}else{Join-Path $PSScriptRoot 'native-payload'}
$ui=Join-Path $payload 'ui'
New-Item -ItemType Directory -Force $ui, '.\dist-native' | Out-Null
Copy-Item .\style.css,.\app.js,.\together.js,.\catalog.js,.\youtube-player.js,.\journey.js,.\cloud-config.js,.\icons.svg $ui -Force
Copy-Item .\assets $ui -Recurse -Force
$pdf=Join-Path $ui 'pdfjs'
New-Item -ItemType Directory -Force (Join-Path $pdf 'build') | Out-Null
Copy-Item .\node_modules\pdfjs-dist\build\pdf.mjs,.\node_modules\pdfjs-dist\build\pdf.worker.mjs (Join-Path $pdf 'build') -Force
Copy-Item .\node_modules\pdfjs-dist\cmaps,.\node_modules\pdfjs-dist\standard_fonts,.\node_modules\pdfjs-dist\wasm,.\node_modules\pdfjs-dist\LICENSE $pdf -Recurse -Force
$html=Get-Content .\index.html -Raw -Encoding UTF8
[IO.File]::WriteAllText((Join-Path $ui 'index.html'),$html,(New-Object Text.UTF8Encoding($false)))
& .\node_modules\.bin\esbuild.cmd browser-bridge.js --bundle --platform=browser --minify --outfile="$ui\bridge.js"
if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}
$lib=Join-Path $PSScriptRoot 'webview2\lib\net462'
Copy-Item "$lib\Microsoft.Web.WebView2.Core.dll","$lib\Microsoft.Web.WebView2.WinForms.dll" $payload -Force
$loader=Get-ChildItem .\webview2 -Recurse -Filter WebView2Loader.dll | Where-Object FullName -Match 'win-x64|x64' | Select-Object -First 1
if(!$loader){throw 'WebView2 x64 loader missing'}
Copy-Item $loader.FullName $payload -Force
& $csc /nologo /target:winexe /platform:x64 /win32icon:assets\icon.ico /out:"$payload\Nosotros.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:"$lib\Microsoft.Web.WebView2.Core.dll" /r:"$lib\Microsoft.Web.WebView2.WinForms.dll" Native.cs MediaLinks.cs
if($LASTEXITCODE -ne 0){throw 'Native compile failed'}
if($AppOnly){return}
Copy-Item .\schema.sql,.\migration-0.2.sql,.\LEEME.txt $payload -Force
Copy-Item .\supabase $payload -Recurse -Force
if(Test-Path (Join-Path $payload 'smoke-result.json')){Remove-Item (Join-Path $payload 'smoke-result.json') -Force}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=Join-Path $PSScriptRoot 'payload.zip'
if(Test-Path $zip){Remove-Item $zip -Force}
[IO.Compression.ZipFile]::CreateFromDirectory($payload,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
& $csc /nologo /target:winexe /platform:x64 /win32icon:assets\icon.ico /out:".\dist-native\Nosotros-Setup.exe" /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:Microsoft.CSharp.dll /resource:"$zip,payload.zip" Installer.cs
if($LASTEXITCODE -ne 0){throw 'Installer compile failed'}
Get-Item .\dist-native\Nosotros-Setup.exe | Format-List FullName,Length,LastWriteTime
$installerPath=Join-Path $PSScriptRoot 'dist-native\Nosotros-Setup.exe'
$stream=[IO.File]::OpenRead($installerPath)
try {$sha=[Security.Cryptography.SHA256]::Create();$checksum=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()} finally {$stream.Dispose();if($sha){$sha.Dispose()}}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'dist-native\SHA256SUMS.txt'),$checksum+'  Nosotros-Setup.exe'+[Environment]::NewLine)
Write-Output ('SHA256: '+$checksum)
