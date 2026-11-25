$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$csc="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$payload=Join-Path $PSScriptRoot 'native-payload'
$ui=Join-Path $payload 'ui'
New-Item -ItemType Directory -Force $ui, '.\dist-native' | Out-Null
Copy-Item .\style.css,.\app.js,.\cloud-config.js $ui -Force
$html=Get-Content .\index.html -Raw -Encoding UTF8
$html=$html.Replace('<script src="cloud-config.js">','<script src="bridge.js"></script><script src="cloud-config.js">').Replace('>⚙<','>⚙<')
[IO.File]::WriteAllText((Join-Path $ui 'index.html'),$html,(New-Object Text.UTF8Encoding($false)))
& .\node_modules\.bin\esbuild.cmd browser-bridge.js --bundle --platform=browser --minify --outfile="$ui\bridge.js"
if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}
$lib=Join-Path $PSScriptRoot 'webview2\lib\net462'
Copy-Item "$lib\Microsoft.Web.WebView2.Core.dll","$lib\Microsoft.Web.WebView2.WinForms.dll" $payload -Force
$loader=Get-ChildItem .\webview2 -Recurse -Filter WebView2Loader.dll | Where-Object FullName -Match 'win-x64|x64' | Select-Object -First 1
if(!$loader){throw 'WebView2 x64 loader missing'}
Copy-Item $loader.FullName $payload -Force
& $csc /nologo /target:winexe /platform:x64 /out:"$payload\Nosotros.exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:"$lib\Microsoft.Web.WebView2.Core.dll" /r:"$lib\Microsoft.Web.WebView2.WinForms.dll" Native.cs
if($LASTEXITCODE -ne 0){throw 'Native compile failed'}
Copy-Item .\schema.sql,.\migration-0.2.sql,.\LEEME.txt $payload -Force
if(Test-Path (Join-Path $payload 'smoke-result.json')){Remove-Item (Join-Path $payload 'smoke-result.json') -Force}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=Join-Path $PSScriptRoot 'payload.zip'
if(Test-Path $zip){Remove-Item $zip -Force}
[IO.Compression.ZipFile]::CreateFromDirectory($payload,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
& $csc /nologo /target:winexe /platform:x64 /out:".\dist-native\Nosotros-Setup.exe" /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:Microsoft.CSharp.dll /resource:"$zip,payload.zip" Installer.cs
if($LASTEXITCODE -ne 0){throw 'Installer compile failed'}
Get-Item .\dist-native\Nosotros-Setup.exe | Format-List FullName,Length,LastWriteTime
Get-FileHash .\dist-native\Nosotros-Setup.exe -Algorithm SHA256 | Format-List