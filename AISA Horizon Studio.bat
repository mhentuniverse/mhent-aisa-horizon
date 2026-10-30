@echo off
setlocal
title AISA Horizon Studio (Miyazaki Haruto Entertainment)

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

echo ========================================================
echo       Miyazaki Haruto Entertainment Co., Ltd.
echo               AISA HORIZON STUDIO
echo ========================================================
echo.

:: 1. Don tien trinh cu va file lock neu bi treo
taskkill /F /IM "AISA Horizon.exe" >nul 2>&1
if exist "%ROOT%\.data\code.lock" del /f /q "%ROOT%\.data\code.lock" >nul 2>&1

:: 2. Cau hinh moi truong & bo qua preLaunch de mo ngay trong 1 giay
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set ELECTRON_RUN_AS_NODE=
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1
set VSCODE_SKIP_PRELAUNCH=1

:: 3. Kiem tra file thuc thi
set "EXE=%ROOT%\.build\electron\AISA Horizon.exe"
if not exist "%EXE%" (
    echo [Loi] Khong tim thay: "%EXE%"
    pause
    exit /b 1
)

:: 4. Khoi dong AISA Horizon Studio
echo Dang khoi dong AISA Horizon Studio...
start "" "%EXE%" . --user-data-dir="%ROOT%\.data" --disable-extension=vscode.vscode-api-tests %*

exit /b 0
