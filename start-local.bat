@echo off
title Pullman Home Cleaning — Local Test Server
echo.
echo ============================================
echo  Pullman Home Cleaning — Local Test Server
echo ============================================
echo.

:: Check if npm is available
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm is not installed or not in your PATH.
    echo Download Node.js from https://nodejs.org and re-run this file.
    pause
    exit /b 1
)

:: Install dependencies if needed
echo [1/3] Installing dependencies...
call npm install --prefix . 2>nul
echo.

:: Install Netlify CLI globally if not already installed
where netlify >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [2/3] Installing Netlify CLI (one time only)...
    call npm install -g netlify-cli
) else (
    echo [2/3] Netlify CLI already installed.
)
echo.

:: Check that .env has been filled out
findstr /C:"REPLACE_ME" .env >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo.
    echo ============================================
    echo  STOP: You still have REPLACE_ME values in
    echo  your .env file. Open it in Notepad, fill
    echo  in your Stripe secret key and Firebase
    echo  service account JSON, then re-run this.
    echo ============================================
    echo.
    echo Opening .env in Notepad now...
    notepad .env
    pause
    exit /b 1
)

echo [3/3] Starting local server...
echo.
echo  Booking page will open at:
echo  http://localhost:8888/booking.html
echo.
echo  Press Ctrl+C to stop the server.
echo.

:: Start netlify dev
netlify dev

pause
