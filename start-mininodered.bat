@echo off
title MiniNodeRed server
cd /d "%~dp0"
rem Publish the server at https://micrologiclink.com through the Cloudflare tunnel.
set CLOUDFLARED=%USERPROFILE%\bin\cloudflared.exe
set TUNNEL_CONFIG=%USERPROFILE%\.cloudflared\microflow.yml
if exist "%CLOUDFLARED%" if exist "%TUNNEL_CONFIG%" (
  echo Starting tunnel to https://micrologiclink.com ...
  start "MiniNodeRed tunnel" /min "%CLOUDFLARED%" tunnel --config "%TUNNEL_CONFIG%" run microflow
)
echo Starting MiniNodeRed on http://127.0.0.1:3000 ...
call npm start
echo.
echo Server stopped.
pause
