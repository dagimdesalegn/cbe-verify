$ErrorActionPreference = "Stop"
$root = "C:\Users\Dagi\Desktop\cbe-verify-api"
Set-Location $root

Write-Host "`n=== Git status ===" -ForegroundColor Yellow
git status --short

Write-Host "`n=== Committing all changes ===" -ForegroundColor Yellow
git add .
git commit -m "Production-ready: CBE SMS + Reference, Telebirr SMS. Telebirr URL needs Ethiopian relay." --allow-empty

Write-Host "`n=== Pushing to GitHub ===" -ForegroundColor Yellow
git push

Write-Host "`n=== DONE ===" -ForegroundColor Green
Write-Host "`nRepo: https://github.com/dagimdesalegn/cbe-verify" -ForegroundColor Cyan