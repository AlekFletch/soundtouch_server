@echo off
rem Double-click: copy the stations on buttons 1-6 from one speaker to the other.
rem Runs scripts/copy-presets.sh. Pure ASCII + CRLF, see scripts\windows\run-bash.cmd.
call "%~dp0scripts\windows\run-bash.cmd" scripts/copy-presets.sh %*
