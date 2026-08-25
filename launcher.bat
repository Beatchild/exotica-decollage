@echo off
rem Exotica Decollage launcher: starts the dev server if needed, then opens
rem a chromeless app window. Closing the window leaves the server running,
rem so the next launch is instant.
cd /d "%~dp0"

rem is the dev server already listening on 5173?
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient('localhost', 5173); $c.Close(); exit 0 } catch { exit 1 }"
if %errorlevel% neq 0 (
  start "exotica-dev-server" /min cmd /c "npm run dev"
)

rem wait until the server answers (max ~30s)
powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { try { $c = New-Object Net.Sockets.TcpClient('localhost', 5173); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if %errorlevel% neq 0 (
  echo Dev server did not start - run "npm run dev" manually to see the error.
  pause
  exit /b 1
)

start "" chrome --app=http://localhost:5173 --window-size=1500,950
