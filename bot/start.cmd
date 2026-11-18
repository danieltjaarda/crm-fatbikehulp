@echo off
rem Start de DHL-labelbot. Laat dit venster open staan; sluiten stopt de bot.
cd /d "%~dp0"
:opnieuw
node bot.js
echo De bot is gestopt. Over 15 seconden start hij opnieuw (sluit dit venster om te stoppen).
timeout /t 15 /nobreak >nul
goto opnieuw
