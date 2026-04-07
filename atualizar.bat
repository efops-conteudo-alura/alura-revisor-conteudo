@echo off
echo Baixando atualizacao do Revisor de Conteudo...
powershell -Command "Invoke-WebRequest -Uri 'https://hub-producao-conteudo.vercel.app/alura-revisor-conteudo.zip' -OutFile '%TEMP%\ext-update.zip'; Expand-Archive -Path '%TEMP%\ext-update.zip' -DestinationPath '%~dp0' -Force"
echo.
echo Feito! Agora:
echo 1. Abra o Chrome e acesse chrome://extensions
echo 2. Clique em "Recarregar" na extensao Revisor de Conteudo
echo.
start chrome "chrome://extensions"
pause
