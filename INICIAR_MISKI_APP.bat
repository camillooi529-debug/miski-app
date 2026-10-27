@echo off
title MISKI APP - Servidor de Pedidos y Cocina
color 0A
cd /d "%~dp0"
echo ==========================================================
echo     INICIANDO MISKI APP (SISTEMA MESERO Y COCINA)
echo ==========================================================
echo.
echo Abriendo el navegador en http://localhost:3000 ...
start "" "http://localhost:3000"
node server.js
pause
