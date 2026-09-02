@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [job-tracer] Node.js was not found. Install Node.js 24.x and run this file again.
    pause
    exit /b 1
)

:preflight
node scripts\preflight.mjs
set "check_code=%errorlevel%"

if "%check_code%"=="10" (
    echo [job-tracer] Installing dependencies. This may take a few minutes...
    call npm.cmd install
    if errorlevel 1 goto dependency_error
    goto preflight
)

if "%check_code%"=="12" (
    echo [job-tracer] Rebuilding better-sqlite3 for the current Node.js version...
    call npm.cmd rebuild better-sqlite3
    if errorlevel 1 goto dependency_error
    goto preflight
)

if "%check_code%"=="11" (
    echo [job-tracer] Building the frontend...
    call npm.cmd run build
    if errorlevel 1 (
        echo [job-tracer] Frontend build failed.
        pause
        exit /b 1
    )
    goto preflight
)

if not "%check_code%"=="0" (
    pause
    exit /b %check_code%
)

:agent_environment
where python >nul 2>nul
if errorlevel 1 (
    echo [job-tracer] Python was not found. The app will start, but Interview Prep Agent will be unavailable.
    set "PREP_AGENT_DISABLED=1"
    goto start_app
)

if not exist ".venv-agent\Scripts\python.exe" (
    echo [job-tracer] Creating the isolated Python environment for Interview Prep Agent...
    python -m venv .venv-agent
    if errorlevel 1 (
        echo [job-tracer] Could not create .venv-agent. Other features can still be used.
        set "PREP_AGENT_DISABLED=1"
        goto start_app
    )
)

".venv-agent\Scripts\python.exe" scripts\preflight-agent.py
set "agent_check_code=%errorlevel%"
if "%agent_check_code%"=="20" (
    echo [job-tracer] Installing Interview Prep Agent dependencies. This only happens after dependency changes...
    ".venv-agent\Scripts\python.exe" -m pip install -r agent_service\requirements.txt
    if errorlevel 1 (
        echo [job-tracer] Agent dependencies could not be installed. Other features can still be used.
        set "PREP_AGENT_DISABLED=1"
        goto start_app
    )
    ".venv-agent\Scripts\python.exe" scripts\preflight-agent.py
    set "agent_check_code=%errorlevel%"
)
if not "%agent_check_code%"=="0" (
    echo [job-tracer] Interview Prep Agent environment check failed. Other features can still be used.
    set "PREP_AGENT_DISABLED=1"
    goto start_app
)
set "PREP_AGENT_PYTHON=%CD%\.venv-agent\Scripts\python.exe"
if not defined PORT set "PORT=3210"
if not defined PREP_AGENT_PORT set "PREP_AGENT_PORT=3211"
set "PREP_AGENT_BASE_URL=http://127.0.0.1:%PREP_AGENT_PORT%"
set "JOB_TRACER_BASE_URL=http://127.0.0.1:%PORT%"
set "PREP_AGENT_CHECKPOINT_PATH=%CD%\data\prep_agent_checkpoints.db"
for /f "delims=" %%T in ('node scripts\prep-agent-token.mjs') do set "PREP_AGENT_INTERNAL_TOKEN=%%T"
if not defined PREP_AGENT_INTERNAL_TOKEN (
    echo [job-tracer] Could not prepare the Interview Prep Agent token. Other features can still be used.
    set "PREP_AGENT_DISABLED=1"
    goto start_app
)
set "PREP_AGENT_CONTROL_TOKEN=%PREP_AGENT_INTERNAL_TOKEN%"

node scripts\prep-agent-process.mjs health >nul 2>nul
if errorlevel 1 (
    echo [prep-agent] Starting the Python service...
    set "PREP_AGENT_STARTED_BY_BATCH=1"
    start "" /b "%PREP_AGENT_PYTHON%" -m uvicorn agent_service.main:app --host 127.0.0.1 --port %PREP_AGENT_PORT% --log-level warning >"%CD%\data\prep-agent.log" 2>&1
    node scripts\prep-agent-process.mjs wait
    if errorlevel 1 (
        echo [prep-agent] Python service did not become ready. See data\prep-agent.log.
        set "PREP_AGENT_DISABLED=1"
    )
) else (
    echo [prep-agent] Python service is already running.
)

:start_app
echo [job-tracer] Starting. Your browser will open automatically...
if not "%JOB_TRACER_NO_BROWSER%"=="1" start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"
call npm.cmd start
set "start_code=%errorlevel%"
if defined PREP_AGENT_STARTED_BY_BATCH node scripts\prep-agent-process.mjs stop >nul 2>nul
if not "%JOB_TRACER_NO_PAUSE%"=="1" pause
exit /b %start_code%

:dependency_error
echo [job-tracer] Dependency installation or native module rebuild failed. Check Node.js 24.x and your network, then try again.
pause
exit /b 1
