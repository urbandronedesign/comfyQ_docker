@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  ComfyQ RunPod console - double-click launcher
rem
rem  Opens a page on THIS machine for entering the RunPod credentials, picking
rem  workflows and a GPU, launching a Pod and watching it. Keep this window
rem  open while you use the page; closing it stops the console (Pods keep
rem  running on RunPod - stop them from the page or the RunPod website).
rem
rem  Needs only Node.js: no npm install.
rem ---------------------------------------------------------------------------

title ComfyQ RunPod console
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine. Install the LTS build:
  echo.
  echo       winget install --id OpenJS.NodeJS.LTS --exact
  echo.
  pause
  exit /b 1
)

node tools\runpod\console\server.mjs
if errorlevel 1 pause
