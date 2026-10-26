@echo off
rem Aqvenor dev launcher: vite renderer + electron shell + .NET sidecar.
rem Detached-friendly: both processes run as children of this console, which
rem itself is started minimized via `start`.
cd /d "%~dp0"
start "aqvenor-vite" /MIN cmd /c "npx vite --port 5173 --strictPort"
rem give the dev server a beat before electron loads its URL
timeout /t 3 /nobreak > NUL
npx electron .
