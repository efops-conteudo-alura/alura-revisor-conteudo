@echo off
echo Baixando atualizacao do Revisor de Conteudo...
powershell -Command "Invoke-WebRequest -Uri 'https://hub-producao-conteudo.vercel.app/alura-revisor-conteudo.zip' -OutFile '%TEMP%\ext-update.zip' -UseBasicParsing"

powershell -Command "$zip = '%TEMP%\ext-update.zip'; $size = (Get-Item $zip).length; if ($size -lt 10000) { Write-Host 'ERRO: arquivo baixado invalido ou URL incorreta.' -ForegroundColor Red; exit 1 }; Expand-Archive -Path $zip -DestinationPath '%~dp0' -Force; Write-Host 'Arquivos atualizados com sucesso!' -ForegroundColor Green"

if %errorlevel% neq 0 (
  echo.
  echo Falha na atualizacao. Verifique sua conexao ou fale com o suporte.
  pause
  exit /b 1
)

echo.
echo Feito! Agora:
echo 1. Acesse chrome://extensions
echo 2. Clique em "Recarregar" na extensao Revisor de Conteudo
echo.
pause
