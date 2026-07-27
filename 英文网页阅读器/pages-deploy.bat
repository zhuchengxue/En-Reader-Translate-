@echo off
chcp 65001 >nul
title Deploy EN Reader to Cloudflare Pages
echo.
echo ============================================================
echo  Deploy the English Reader to Cloudflare Pages (public, free)
echo ============================================================
echo  This deploys the web app so anyone can open it in a browser.
echo  Requirements: Node.js installed.  Get it at https://nodejs.org
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo   Install Node.js LTS first (https://nodejs.org , default options),
  echo   then re-open this script.
  pause
  exit /b 1
)
cd /d "%~dp0"
echo.
echo Step 1/2: Login to Cloudflare (your browser will open)...
npx wrangler login
if errorlevel 1 (
  echo [ERROR] Cloudflare login failed. Check the browser popup and your network, then retry.
  pause
  exit /b 1
)
echo.
echo Step 2/2: Deploy the app to Cloudflare Pages...
npx wrangler pages deploy . --project-name en-reader
if errorlevel 1 (
  echo [ERROR] Deploy failed. Read the messages above. Common fix: the project name may
  echo   already be taken; edit "--project-name en-reader" near the end of this file to a unique name.
  pause
  exit /b 1
)
echo.
echo ============================================================
echo  DONE. Your public URL is printed above (ends with .pages.dev).
echo  Open it on any device / share it with anyone.
echo ============================================================
echo.
pause
