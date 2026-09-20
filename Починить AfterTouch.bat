@echo off
chcp 65001 >nul
rem Двойной клик: перенастраивает AfterTouch под текущую сеть.
setlocal
set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if not exist "%BASH%" (
  echo Не найден Git Bash. Установи Git for Windows или запусти скрипт вручную:
  echo     bash scripts/fix-aftertouch.sh
  pause
  exit /b 1
)
cd /d "%~dp0"
"%BASH%" scripts/fix-aftertouch.sh
echo.
pause
