@echo off
title Invoice and Summary Manager Web App
color 0b

echo =================================================================
echo        INVOICE ^& ORDER SUMMARY REPORT MANAGER
echo =================================================================
echo.
echo Starting Web Server...
echo.

:: Wait 2 seconds and open browser automatically
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5000"

:: Run Python Flask App
python app.py

pause
