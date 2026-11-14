@echo off
rem Starts the local map server and opens the 3D map in your default browser.
rem The server starts itself again whenever the map's code is updated (server\watch.js), and
rem the page reloads itself: leave this window open, there is nothing to restart by hand.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node server\watch.js --open
rem (75: the map tool has updated its own starter, and asks to be started again)
:again
if %errorlevel%==75 (
  node server\watch.js
  goto again
)
if errorlevel 1 pause
