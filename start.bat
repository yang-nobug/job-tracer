@echo off
chcp 65001 >nul
cd /d %~dp0

if not exist node_modules (
    echo [job-tracer] 首次运行，正在安装依赖（需要几分钟）...
    call npm install
    if errorlevel 1 (
        echo 依赖安装失败，请检查网络后重试
        pause
        exit /b 1
    )
)

if not exist server\public (
    echo [job-tracer] 正在构建前端（仅首次或代码更新后需要）...
    call npm run build
    if errorlevel 1 (
        echo 构建失败
        pause
        exit /b 1
    )
)

echo [job-tracer] 启动中，浏览器将自动打开...
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3210"
call npm start
pause
