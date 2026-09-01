@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
    echo [job-tracer] Installing dependencies. This may take a few minutes...
    call npm.cmd install
    if errorlevel 1 (
        echo [job-tracer] Dependency installation failed. Check your network and try again.
        pause
        exit /b 1
    )
)

if not exist server\public (
    echo [job-tracer] Building the frontend...
    call npm.cmd run build
    if errorlevel 1 (
        echo [job-tracer] Frontend build failed.
        pause
        exit /b 1
    )
)

echo [job-tracer] Starting. Your browser will open automatically...
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3210"
call npm.cmd start
pause
