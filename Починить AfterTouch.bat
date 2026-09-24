@echo off
rem Double-click launcher for scripts\fix-aftertouch.sh (AfterTouch re-setup).
rem
rem KEEP THIS FILE PURE ASCII WITH CRLF LINE ENDINGS (see .gitattributes).
rem cmd.exe misreads batch files with LF endings or UTF-8 text: after
rem chcp 65001 it re-reads the file at shifted byte offsets and runs
rem fragments of lines as commands. Russian messages live in
rem scripts\windows\*.txt and are printed with "type".
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0" || goto :no_dir

set "BASH_EXE="
set "GIT_ROOT="

rem 1) Usual Git for Windows folders: 64/32-bit, per-user, Scoop.
for %%D in (
  "%ProgramW6432%\Git"
  "%ProgramFiles%\Git"
  "%ProgramFiles(x86)%\Git"
  "%LocalAppData%\Programs\Git"
  "%UserProfile%\scoop\apps\git\current"
  "C:\Git"
) do if not defined BASH_EXE call :try_root "%%~D"

rem 2) Wherever git.exe is on PATH (...\Git\cmd or ...\Git\mingw64\bin).
if not defined BASH_EXE for /f "delims=" %%G in ('where git.exe 2^>nul') do (
  if not defined BASH_EXE call :try_root "%%~dpG.."
  if not defined BASH_EXE call :try_root "%%~dpG..\.."
)

rem 3) Install path recorded by the Git for Windows installer.
if not defined BASH_EXE for %%K in (HKLM HKCU) do (
  for /f "tokens=2,*" %%A in ('reg query "%%K\SOFTWARE\GitForWindows" /v InstallPath 2^>nul ^| find "InstallPath"') do (
    if not defined BASH_EXE call :try_root "%%~B"
  )
)

if not defined BASH_EXE goto :no_bash

rem Git's grep/sed/curl/ssh first, so same-named Windows tools do not
rem shadow them. Windows ipconfig stays reachable further down PATH.
set "PATH=%GIT_ROOT%\usr\bin;%GIT_ROOT%\mingw64\bin;%PATH%"

"%BASH_EXE%" scripts/fix-aftertouch.sh %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

:try_root
rem %1 = candidate Git root. bash.exe is in bin\ or usr\bin\ (never
rem System32\bash.exe, that one is WSL).
if "%~1"=="" exit /b 0
if exist "%~f1\bin\bash.exe" (
  set "GIT_ROOT=%~f1"
  set "BASH_EXE=%~f1\bin\bash.exe"
  exit /b 0
)
if exist "%~f1\usr\bin\bash.exe" (
  set "GIT_ROOT=%~f1"
  set "BASH_EXE=%~f1\usr\bin\bash.exe"
)
exit /b 0

:no_bash
if exist "scripts\windows\no-git-bash.txt" (
  type "scripts\windows\no-git-bash.txt"
) else (
  echo Git Bash not found. Install Git for Windows: https://git-scm.com/download/win
)
echo.
pause
exit /b 1

:no_dir
echo Cannot open the folder of this .bat file: "%~dp0"
pause
exit /b 1
