@echo off
REM Un relevé de l'étude driftprobe (tâche planifiée Driftprobe-Sonde, 2 fois par jour).
REM Le script se protège seul : date de fin de l'étude, écart minimal entre 2 relevés, minuteur de 15 min.
chcp 65001 >nul
cd /d "%~dp0"
node run.mjs >> data\_sonde.log 2>&1
exit /b %ERRORLEVEL%
