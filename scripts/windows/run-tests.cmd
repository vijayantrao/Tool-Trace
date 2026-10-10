@echo off
rem ToolTrace: install everything and run the API test suite (Windows).
rem Needs: Git, Node.js 22+, Docker Desktop running.
setlocal
title ToolTrace - tests
cd /d "%~dp0..\.."
set "LOG=%cd%\test-run.log"
echo ToolTrace test run %date% %time% > "%LOG%"

echo.
echo  [1/3] Starting the database...
docker compose up -d --wait db >> "%LOG%" 2>&1 || goto fail
echo  [2/3] Installing libraries...
call npm.cmd install >> "%LOG%" 2>&1 || goto fail
echo  [3/3] Running the API tests...
set "TEST_DATABASE_ADMIN_URL=postgres://tooltrace:tooltrace_local_only@localhost:5432/postgres"
call npm.cmd test >> "%LOG%" 2>&1 || goto fail

echo RESULT: PASS >> "%LOG%"
echo.
echo  ALL DONE - every test passed.
echo.
pause
exit /b 0

:fail
echo RESULT: FAIL >> "%LOG%"
echo.
echo  A step failed. Details are in test-run.log
echo.
pause
exit /b 1
