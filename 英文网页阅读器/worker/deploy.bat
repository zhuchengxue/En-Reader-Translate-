@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   EN Reader - One-click Deploy of the Translate Worker
echo ============================================================
echo.

REM Make sure Node.js / npx is available before doing anything
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo          Please install it from https://nodejs.org (LTS), then re-run this script.
  echo          After installing, open a new terminal so "node" is on the PATH.
  pause
  exit /b 1
)
node -v
echo.

echo [Step 1/2] Your default browser will open the Cloudflare login page.
echo            Since you are already logged in, just click "Allow".
echo.
pause
npx wrangler login
if errorlevel 1 (
  echo.
  echo [ERROR] Login failed. Check that Node.js works and you can reach cloudflare.com, then retry.
  pause
  exit /b 1
)

echo.
echo [Step 2/2] Deploying the Worker now...
echo            (The first run downloads "wrangler" over the network; please wait.)
echo.
npx wrangler deploy
if errorlevel 1 (
  echo.
  echo [ERROR] Deploy failed. Check the output above. Common fixes:
  echo   - Run "npx wrangler login" again and click Allow.
  echo   - Make sure the worker name in wrangler.toml is not taken.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Deploy finished!
echo   The "*.workers.dev" URL printed above is your translate proxy.
echo   Copy it and paste it into the reader's Settings -> Translate Proxy.
echo ============================================================
pause
