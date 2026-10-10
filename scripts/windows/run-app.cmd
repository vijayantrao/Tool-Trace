@echo off
rem ToolTrace: run the whole app on this computer (Windows).
rem Needs: Git, Node.js 22+, Docker Desktop running.
rem Opens http://localhost:3000. Passkeys work on localhost with Windows Hello.
setlocal
title ToolTrace - launcher
cd /d "%~dp0..\.."
set "LOG=%cd%\app-run.log"
echo ToolTrace launch %date% %time% > "%LOG%"

set "DATABASE_URL=postgres://tooltrace:tooltrace_local_only@localhost:5432/tooltrace"
set "APP_URL=http://localhost:3000"
set "RP_ID=localhost"
set "RP_ORIGINS=http://localhost:3000"
set "COOKIE_SECURE=false"
set "PORT=8080"
set "API_URL=http://localhost:8080"
set "NEXT_TELEMETRY_DISABLED=1"

echo.
echo  [1/5] Starting the database...
docker compose up -d --wait db >> "%LOG%" 2>&1 || goto fail
echo  [2/5] Installing libraries...
call npm.cmd install >> "%LOG%" 2>&1 || goto fail
echo  [3/5] Preparing the database and demo tools...
call npm.cmd run migrate -w apps/api >> "%LOG%" 2>&1 || goto fail
call npm.cmd run seed:demo -w apps/api >> "%LOG%" 2>&1 || goto fail
echo  [4/5] Building the web app (about a minute)...
call npm.cmd run build -w apps/web >> "%LOG%" 2>&1 || goto fail

echo  [5/5] Starting ToolTrace...
start "ToolTrace API (keep open)" cmd /k "set PORT=8080&& npm.cmd run start:dev -w apps/api"
start "ToolTrace Web (keep open)" cmd /k "set PORT=3000&& npm.cmd run start -w apps/web"
timeout /t 10 /nobreak > nul

rem First run only: create the admin invite and open it. Later runs just open sign-in.
set "INVITE="
call npm.cmd run --silent bootstrap-admin -w apps/api -- admin@tooltrace.local --replace > "%TEMP%\tooltrace-invite.txt" 2>&1
for /f "usebackq delims=" %%u in (`findstr /b "http" "%TEMP%\tooltrace-invite.txt"`) do set "INVITE=%%u"
del "%TEMP%\tooltrace-invite.txt" > nul 2>&1

echo RESULT: STARTED >> "%LOG%"
echo.
if defined INVITE (
  echo  First run: opening your admin invite. Create your passkey with Windows Hello.
  echo  If the browser doesn't open, paste this link into Chrome or Edge:
  echo  %INVITE%
  start "" "%INVITE%"
) else (
  echo  Opening sign-in. Use the passkey you created on the first run.
  start "" "http://localhost:3000/login"
)
echo.
echo  To stop ToolTrace, close the two "keep open" windows.
echo.
pause
exit /b 0

:fail
echo RESULT: FAIL >> "%LOG%"
echo.
echo  A step failed. Details are in app-run.log
echo.
pause
exit /b 1
