@echo off
rem Double-click: re-setup AfterTouch after a network/router change.
rem Runs scripts/fix-aftertouch.sh. Pure ASCII + CRLF, see scripts\windows\run-bash.cmd.
call "%~dp0scripts\windows\run-bash.cmd" scripts/fix-aftertouch.sh %*
