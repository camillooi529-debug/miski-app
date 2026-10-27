@echo off
title MISKI APP - Enlace Publico para Otra Red / Datos Moviles
color 0B
cd /d "%~dp0"
echo ====================================================================
echo   🌐 MISKI APP - MODO ENLACE DE INTERNET (PARA CUALQUIER RED)
echo ====================================================================
echo.
echo 1. Asegurando que el servidor de Miski App este encendido...
start /min "" node server.js
timeout /t 2 /nobreak >nul
echo.
echo 2. Generando enlace publico de Internet y Codigo QR...
echo    (Copia el link https://...lhr.life que aparecera abajo y pasalo
echo     por WhatsApp a los encargados. Funcionara en cualquier red o
echo     con datos moviles!)
echo ====================================================================
echo.
ssh -o StrictHostKeyChecking=no -R 80:localhost:3000 nokey@localhost.run
pause
