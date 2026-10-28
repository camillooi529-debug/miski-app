@echo off
title MISKI APP - Servidor de Pedidos y Cocina
color 0A
cd /d "%~dp0"
echo ==========================================================
echo     INICIANDO MISKI APP (SISTEMA MESERO Y COCINA)
echo ==========================================================
echo.
echo Abriendo el navegador en Modo Red Local (http://localhost:3000/?local=1) ...
start "" "http://localhost:3000/?local=1&pin=9999"
node server.js
pause
