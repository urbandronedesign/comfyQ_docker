@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  ComfyQ - public https address for this machine, through a Cloudflare quick
rem  tunnel. Start it beside Serve-ComfyQ.bat. See docs/home-machines-windows.md.
rem
rem  No Cloudflare account, no domain, nothing opened on the router. Students
rem  reach https://<random words>.trycloudflare.com on port 443.
rem
rem  The address stays the same while this window stays open, including when
rem  ComfyQ restarts. It CHANGES whenever the tunnel restarts: after a reboot,
rem  or if cloudflared stops. This file then restarts it by itself, and the
rem  new address is in tunnel.log (and in this window).
rem
rem  Close this window to take the machine off the internet.
rem ---------------------------------------------------------------------------

title ComfyQ tunnel
cd /d "%~dp0"

rem --- cloudflared -----------------------------------------------------------
rem A cloudflared.exe beside this file (on the portable disk) is found as well.
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo.
  echo   cloudflared was not found on this machine. Install it:
  echo.
  echo       winget install --id Cloudflare.cloudflared --exact
  echo.
  echo   Then open a NEW window and double-click this file again.
  echo.
  pause
  exit /b 1
)

:tunnel
rem Emptied at each start, so the only address in the file is the current one.
del /q tunnel.log >nul 2>&1
echo.
echo   Opening the tunnel to http://localhost:3000
echo   The address appears below, and in %CD%\tunnel.log
echo.
cloudflared tunnel --no-autoupdate --logfile tunnel.log --url http://localhost:3000
echo.
echo   [%date% %time%] The tunnel stopped - opening it again in 5 seconds.
echo   THE ADDRESS WILL CHANGE: send students the new link.
rem Not "timeout": it fails at once without a console (Task Scheduler).
ping -n 6 127.0.0.1 >nul
goto tunnel
