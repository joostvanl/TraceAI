# Rebuild TraceAI on the LAN test host (always branch test).
$ErrorActionPreference = "Stop"
ssh.exe -o BatchMode=yes joostvl@192.168.1.185 "~/update-test.sh"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "UI:  http://192.168.1.185:3011"
Write-Host "API: http://192.168.1.185:3847/health"
