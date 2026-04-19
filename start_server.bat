@echo off
setlocal
chcp 65001 >nul

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

call "%PROJECT_DIR%ensure-node-deps.bat"
if errorlevel 1 exit /b 1

if exist "%PROJECT_DIR%vcp.stdout.prev.log" del /q "%PROJECT_DIR%vcp.stdout.prev.log" >nul 2>nul
if exist "%PROJECT_DIR%vcp.stderr.prev.log" del /q "%PROJECT_DIR%vcp.stderr.prev.log" >nul 2>nul
if exist "%PROJECT_DIR%vcp.stdout.log" move /y "%PROJECT_DIR%vcp.stdout.log" "%PROJECT_DIR%vcp.stdout.prev.log" >nul
if exist "%PROJECT_DIR%vcp.stderr.log" move /y "%PROJECT_DIR%vcp.stderr.log" "%PROJECT_DIR%vcp.stderr.prev.log" >nul

echo [VCPToolBox] Starting the intermediate server...
node server.js
pause
