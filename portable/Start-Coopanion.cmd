@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%app\windows\Coopanion.exe" (
  echo Coopanion for Windows is not installed.
  call "%ROOT%Install-Coopanion-Windows.cmd"
  if errorlevel 1 exit /b 1
)
set "CORTICO_COMPANION_DATA=%ROOT%data"
set "ELECTRON_RUN_AS_NODE=1"
"%ROOT%app\windows\Coopanion.exe" "%ROOT%scripts\sync.cjs" launch
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
