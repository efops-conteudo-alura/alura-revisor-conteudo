@echo off
echo Baixando atualizacao do Revisor de Conteudo...

powershell -Command " ^
  try { ^
    Invoke-WebRequest -Uri 'https://hub-producao-conteudo.vercel.app/alura-revisor-conteudo.zip' -OutFile '%TEMP%\ext-update.zip' -UseBasicParsing -ErrorAction Stop; ^
    $size = (Get-Item '%TEMP%\ext-update.zip').length; ^
    if ($size -lt 10000) { throw 'Arquivo baixado invalido ou URL incorreta (tamanho: ' + $size + ' bytes)' }; ^
    Expand-Archive -Path '%TEMP%\ext-update.zip' -DestinationPath '%~dp0' -Force -ErrorAction Stop; ^
    Write-Host 'Arquivos atualizados com sucesso!' -ForegroundColor Green ^
  } catch { ^
    Write-Host ('ERRO: ' + $_) -ForegroundColor Red; ^
    exit 1 ^
  } ^
"

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
