@echo off
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%"
node "%ROOT%\scripts\tracked-cli.mjs" copilot %*
set "EXITCODE=%ERRORLEVEL%"
popd
exit /b %EXITCODE%
