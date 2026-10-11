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
rem Smart stations: a built-in MQTT broker on port 1883 and a master key made once for this computer.
set "DEV_MQTT_BROKER_PORT=1883"
if not exist "apps\api\.station-master-key" node -e "require('fs').writeFileSync('apps/api/.station-master-key', require('crypto').randomBytes(32).toString('hex'))"
set /p STATION_MASTER_KEY=<"apps\api\.station-master-key"

echo.
echo  [1/6] Starting the database...
docker compose up -d --wait db >> "%LOG%" 2>&1 || goto fail
echo  [2/6] Installing libraries...
call npm.cmd install >> "%LOG%" 2>&1 || goto fail
echo  [3/6] Preparing the database and demo tools...
call npm.cmd run migrate -w apps/api >> "%LOG%" 2>&1 || goto fail
call npm.cmd run seed:demo -w apps/api >> "%LOG%" 2>&1 || goto fail
echo  [4/6] Demo history and the nightly model (first time: a few minutes)...
rem Runs the Python ML job in Docker, so Python isn't needed on this computer. Optional: the app works without it.
docker compose run --rm --no-deps ml python -m tooltrace_ml seed-history --open >> "%LOG%" 2>&1 && docker compose run --rm --no-deps ml python -m tooltrace_ml run >> "%LOG%" 2>&1 || echo         Skipped: insights will appear after the model has run.
echo  [5/6] Building the web app (about a minute)...
call npm.cmd run build -w apps/web >> "%LOG%" 2>&1 || goto fail

echo  [6/6] Starting ToolTrace...
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
echo  Smart stations: open Stations in the app, add one, then run the command it shows
echo  in a new terminal to try a station without hardware.
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
