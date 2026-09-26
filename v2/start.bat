@echo off
chcp 65001 >nul
title GoogleTool v2 - Quan ly profile Chromium
cd /d "%~dp0"

REM Them Node vao PATH cho phien nay
set "PATH=C:\Program Files\nodejs;%PATH%"

REM Kiem tra node
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Node.js. Hay cai dat tu https://nodejs.org
  pause
  exit /b 1
)

REM Kiem tra Electron: trong v2/node_modules hoac ../node_modules
if exist "node_modules\electron\dist\electron.exe" (
  call npx electron .
) else if exist "..\node_modules\electron\dist\electron.exe" (
  call ..\node_modules\.bin\electron .
) else (
  echo Dang cai dat dependencies cho GoogleTool v2...
  call npm install
  call npx electron .
)
