@echo off
setlocal
chcp 65001 >nul

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

if exist "node_modules\express\package.json" (
    exit /b 0
)

echo [VCPToolBox] Local Node dependencies were not found.
echo [VCPToolBox] Running npm install. First launch may take a few minutes.
call npm install
if errorlevel 1 (
    echo [VCPToolBox] Dependency installation failed.
    echo [VCPToolBox] Please check your network, Node.js, and npm config, then try again.
    pause
    exit /b 1
)

if not exist "node_modules\express\package.json" (
    echo [VCPToolBox] npm install finished, but required packages are still missing.
    echo [VCPToolBox] Try deleting node_modules and running npm install again.
    pause
    exit /b 1
)

exit /b 0
