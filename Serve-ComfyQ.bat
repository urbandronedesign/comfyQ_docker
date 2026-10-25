@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  ComfyQ - serve on ONE port (3000), for a machine reached over the internet
rem  (Tailscale Funnel, a Cloudflare tunnel). See docs/home-machines-windows.md.
rem
rem  Start-ComfyQ.bat runs the development setup: the page comes from Vite on
rem  :5173, which refuses requests addressed to any other host name - so a
rem  public link pointing at it shows "Blocked request". This launcher builds
rem  the page once, and the server then serves page + API together on :3000.
rem
rem  It also restarts ComfyQ whenever it stops. "Activate & serve" and
rem  "Reset to admin" end the process on purpose and expect to be started
rem  again (nodemon does that under Start-ComfyQ.bat); without this loop the
rem  machine would simply stop serving.
rem
rem  Close this window (or Ctrl+C, then answer Y) to stop ComfyQ for good.
rem ---------------------------------------------------------------------------

title ComfyQ (serving on port 3000)
cd /d "%~dp0"

echo.
echo   ComfyQ - serving on port 3000
echo   %CD%
echo.

rem --- Node ------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js was not found on this machine. Install the LTS build:
  echo.
  echo       winget install --id OpenJS.NodeJS.LTS --exact
  echo.
  echo   Then open a NEW window and double-click this file again.
  echo.
  pause
  exit /b 1
)

rem --- Already running? ------------------------------------------------------
rem Either launcher holds the server port; a second copy could only fail on it.
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo   Something already listens on port 3000 - ComfyQ is probably running,
  echo   from this launcher or from Start-ComfyQ.bat. Close it first.
  echo.
  pause
  exit /b 1
)

rem --- Dependencies ----------------------------------------------------------
if not exist "node_modules\" goto install
if not exist "client\node_modules\" goto install
if not exist "server\node_modules\" goto install
goto build

:install
echo   Installing dependencies. First run only, and it takes a few minutes.
echo.
call npm install
if errorlevel 1 (
  echo.
  echo   npm install did not finish - the reason is in the lines above.
  pause
  exit /b 1
)

:build
rem Built at every start, so a page left over from an older version of the
rem code (after a git pull) is never what students get. About half a minute.
echo   Building the web page...
call npm run build --prefix client
if errorlevel 1 (
  echo.
  echo   The page did not build - the reason is in the lines above.
  pause
  exit /b 1
)

echo.
echo   Students    http://localhost:3000/user?workflow=^<workflow id^>
echo   Admin       http://localhost:3000/admin
echo   From outside, use the Funnel address instead of localhost.
echo.

:serve
node server\index.js
echo.
echo   [%date% %time%] ComfyQ stopped - starting it again in 3 seconds.
echo   Close this window to stop it for good.
rem Not "timeout": it fails at once without a console (Task Scheduler), and a
rem server that crashes on start would then restart several times a second.
ping -n 4 127.0.0.1 >nul
goto serve
