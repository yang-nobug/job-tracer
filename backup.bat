@echo off
chcp 65001 >nul
cd /d %~dp0

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i

echo [job-tracer] 正在备份数据到 backups\data-%TS% ...
xcopy data "backups\data-%TS%\" /E /I /Y >nul
if errorlevel 1 (
    echo 备份失败！
) else (
    echo 备份完成：backups\data-%TS%
)
pause
