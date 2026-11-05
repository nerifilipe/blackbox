@echo off
cd /d "%~dp0"
if not exist "dist\blackbox.exe" (
    echo Build the application first using scripts\build.ps1.
    pause
    exit /b 1
)
"dist\blackbox.exe" serve %*
if errorlevel 1 pause
