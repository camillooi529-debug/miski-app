@echo off
title Conectar Miski App con tu cuenta de Google
color 0E
echo ====================================================================
echo   🔑 VINCULAR TU CUENTA DE GOOGLE (GMAIL) CON MISKI APP
echo ====================================================================
echo.
echo 1. Si te pregunta "Allow Firebase to collect CLI usage...", presiona
echo    la tecla ENTER.
echo 2. Se abrira tu navegador de Google Chrome automaticamente.
echo 3. Elige tu correo de Gmail y dale a "Permitir / Continuar".
echo 4. Cuando aqui abajo diga "Success! Logged in as...", ya habras
echo    terminado y puedes volver al chat con el agente!
echo ====================================================================
echo.
call firebase login
echo.
echo ====================================================================
echo   ✅ LISTO! Vuelve al chat y escribe "Listo"
echo ====================================================================
pause
