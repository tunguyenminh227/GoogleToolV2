@echo off
chcp 65001 >nul
title GoogleTool v2 - Quan ly profile Chromium
cd /d "%~dp0"

REM Them Node vao PATH cho phien nay (Node cai o C:\Program Files\nodejs nhung chua tren PATH)
set "PATH=C:\Program Files\nodejs;%PATH%"

REM Kiem tra node
where node >nul 2>nul
if errorlevel 1 (
  echo [LOI] Khong tim thay Node.js. Hay cai dat tu https://nodejs.org
  pause
  exit /b 1
)

REM Cai dependencies neu chua co
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dang cai dat dependencies lan dau...
  call npm install
)

echo Dang khoi dong GoogleTool v2...
call npm start

