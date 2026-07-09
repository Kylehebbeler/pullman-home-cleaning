@echo off
echo === Pullman Home Cleaning - Pushing to GitHub ===
echo.

set TEMP_DIR=C:\Temp\pullman-push
set SOURCE_DIR=%~dp0

echo Cleaning up any previous temp folder...
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"

echo Copying files to temp folder (outside OneDrive)...
mkdir "%TEMP_DIR%"
xcopy "%SOURCE_DIR%*" "%TEMP_DIR%\" /E /I /Q /EXCLUDE:%SOURCE_DIR%xcopy-exclude.txt

echo.
echo Setting up git...
cd /d "%TEMP_DIR%"
git init
git branch -M main
git config user.email "kylehebbeler@gmail.com"
git config user.name "Kyle Hebbeler"
git add -A
git commit -m "Update: website + email automation functions"
git remote add origin https://github.com/Kylehebbeler/pullman-home-cleaning.git

echo.
echo Pushing to GitHub...
git push -u origin main --force

echo.
echo === Cleaning up temp folder... ===
cd /d "%SOURCE_DIR%"
rmdir /s /q "%TEMP_DIR%"

echo.
echo === Done! Check https://github.com/Kylehebbeler/pullman-home-cleaning ===
echo.
pause
