@echo off
title Token Framer
cd /d "%~dp0app"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron is not installed. Run "npm install" in the "app" folder first,
  echo then "node node_modules\electron\install.js" if electron.exe is still missing.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" .
