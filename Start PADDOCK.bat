@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org & pause & exit /b)
if not exist node_modules\electron (echo First run: installing Electron... & call npm install --no-audit --no-fund)
call npm start
