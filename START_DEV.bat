@echo off
REM OrderManager Full-Stack Development Start Script

echo.
echo ========================================
echo  OrderManager - Full Stack Setup
echo ========================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Please install Node.js 18+ from https://nodejs.org/
    exit /b 1
)

echo ✓ Node.js detected: 
node --version

REM Check if MongoDB is accessible
mongo --eval "db.adminCommand({ping:1})" >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: mongo shell not found or server not running.
    echo Please ensure MongoDB is running on localhost:27017
    echo.
)

echo.
echo ========================================
echo  Starting Backend...
echo ========================================
echo.

REM Start Backend in new window
cd server
npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install backend dependencies
    exit /b 1
)

start cmd /k npm run dev

timeout /t 3 /nobreak

echo.
echo ========================================
echo  Starting Frontend...
echo ========================================
echo.

REM Navigate to frontend
cd ..\ordermanager-deploy\ordermanager-deploy
npm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install frontend dependencies
    exit /b 1
)

start cmd /k npm run dev

echo.
echo ========================================
echo  Setup Complete!
echo ========================================
echo.
echo Backend:  http://localhost:5000
echo Frontend: http://localhost:5173
echo.
echo Demo Accounts:
echo   - admin / admin123
echo   - store1-store5 / pass123
echo.
echo Press Ctrl+C in each terminal to stop servers
echo.
timeout /t 10
