@echo off
if not defined CURSOR2API_INNER (
  set "CURSOR2API_INNER=1"
  title cursor2api
  cmd /k "%~f0" %*
  exit /b
)
cd /d "%~dp0"

set "NODE_HOME="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_HOME=%ProgramFiles%\nodejs"
if not defined NODE_HOME if exist "%LOCALAPPDATA%\Temp\node-portable\node-v22.23.5-win-x64\node.exe" set "NODE_HOME=%LOCALAPPDATA%\Temp\node-portable\node-v22.23.5-win-x64"
if not defined NODE_HOME (
  where node >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%I in ('where node') do (
      if not defined NODE_HOME set "NODE_HOME=%%~dpI"
    )
  )
)
if not defined NODE_HOME if exist "%LOCALAPPDATA%\Programs\cursor\resources\app\resources\helpers\node.exe" set "NODE_HOME=%LOCALAPPDATA%\Programs\cursor\resources\app\resources\helpers"
if not defined NODE_HOME (
  echo Node.js 20 or newer was not found.
  pause
  exit /b 1
)
set "PATH=%NODE_HOME%;%PATH%"

"%NODE_HOME%\node.exe" "%~dp0scripts\deploy.mjs" %*
echo.
echo Service stopped.
pause
