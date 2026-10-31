@echo off
REM One round of the driftprobe study (scheduled task Driftprobe-Sonde, twice a day).
REM ASCII only: cmd loses its place in a file with accents after chcp.
chcp 65001 >nul
cd /d "%~dp0"
node run.mjs >> data\_sonde.log 2>&1
set RUN_ERROR=%ERRORLEVEL%
REM Second panel, keyed APIs: a failure there must not hide or stop the first one.
set "DRIFTPROBE_STUDY_KEYS=%USERPROFILE%\Desktop\Coffre-Perso\driftprobe-cles-etude.env"
node keyed-run.mjs >> data\_sonde-cles.log 2>&1
if %ERRORLEVEL% NEQ 0 set RUN_ERROR=%ERRORLEVEL%
exit /b %RUN_ERROR%
