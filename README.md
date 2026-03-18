# Alura Revisor de Conteúdo

Extensão Chrome para equipes de conteúdo da Alura.
Automatiza revisão de cursos, upload de vídeos, auditoria de transcrições e legendas.

---

## Instalação

1. Clone este repositório
2. Abra `chrome://extensions` no Chrome
3. Ative o **Modo do desenvolvedor**
4. Clique em **Carregar sem compactação** e selecione a pasta do projeto
5. A extensão aparecerá na barra do Chrome

> A extensão só funciona em `cursos.alura.com.br` e `app.aluracursos.com`.

---

## Módulos

### Aba Revisão

#### Start revisão

Executa auditoria completa de um curso. Deve ser iniciado na **Home do curso**.

O que verifica:
- Campos do admin: nome, meta título, meta descrição, público-alvo, ementa, horas estimadas
- Transcrição de cada vídeo (mínimo de 50 caracteres)
- Links quebrados (404)
- Links com `href` vazio
- Links do GitHub fora do padrão oficial
- Links de armazenamento em nuvem não oficiais (Dropbox, OneDrive, etc.)
- Presença do curso nos catálogos corretos
- Upload do ícone quando o curso está em uma subcategoria.

Ao finalizar, exibe um relatório completo com opção de download em `.txt` e `.json`.
O histórico das últimas 5 auditorias fica salvo na extensão.

---

### Aba Ferramentas

#### Fork → alura-cursos

Cria um fork de um repositório GitHub para a organização `alura-cursos`.

1. Cole a URL do repositório do instrutor
2. Clique em **Fazer Fork**

Se o fork já existir, retorna a URL existente sem criar um duplicado.

---

#### Auditoria de transcrições e legendagens

Audita múltiplos cursos de uma vez, identificando vídeos com pendências.

1. Cole os IDs dos cursos separados por vírgula ou espaço
2. Selecione o que deseja verificar:
   - **Transcrição** — verifica se o vídeo tem transcrição com mais de 50 caracteres
   - **Legendas em PT** — verifica se a legenda em Português está disponível no player
   - **Legendas em ESP** — verifica se a legenda em Espanhol está disponível no player
3. Clique em **Auditar lista**

O relatório final exibe `✅`/`❌` para cada check por vídeo, agrupado por curso, com opção de copiar o texto.

---

#### Token video-uploader

Salva o `X-API-TOKEN` necessário para autenticação no serviço `video-uploader.alura.com.br`.

- Cole o token e clique em **Salvar token**
- O token fica salvo no armazenamento local do Chrome e persiste entre sessões

Necessário para usar os módulos de **Baixar vídeos** e **Subir vídeos**.

---

#### Baixar vídeos do curso

Navega pelo curso automaticamente e baixa todos os vídeos para o computador. Deve ser iniciado na **Home do curso**.

Nomenclatura dos arquivos gerados:
```
{courseId}-video{seção}.{vídeo}-alura-{título}.mp4
```

Exemplo: `3775-video2.1-alura-nova ferramenta.mp4`

---

#### Subir vídeos do curso

Navega pelo curso e envia todos os vídeos para o `video-uploader.alura.com.br`. Deve ser iniciado na **Home do curso**.

O que faz automaticamente:
1. Cria ou localiza uma **showcase** com o ID do curso no video-uploader
2. Faz upload serial de cada vídeo (um por vez)
3. Após todos os uploads, abre cada vídeo no uploader e clica em **Gerar legenda**
4. Atualiza o campo `URI` de cada atividade no admin com o link do vídeo novo

Requer o **Token video-uploader** configurado previamente.

---

## Arquitetura

```
alura-revisor-conteudo/
├── manifest.json       # Configuração da extensão (MV3)
├── background.js       # Service worker — handlers de mensagens e operações em abas
├── content.js          # Script injetado nas páginas da Alura — orquestra os fluxos
├── popup.html          # Interface da extensão
├── popup.js            # Lógica da interface
└── icons/              # Ícones SVG por categoria de curso
```

**Fluxo de comunicação:**

```
popup.js
  └─► chrome.tabs.sendMessage ──► content.js
                                      └─► chrome.runtime.sendMessage ──► background.js
                                                                              └─► abre abas ocultas
                                                                              └─► executa scripts
                                                                              └─► retorna dados
```

As operações que exigem acesso ao admin ou ao video-uploader são feitas pelo `background.js`, que abre abas em segundo plano, extrai os dados necessários via `executeScript` e fecha as abas automaticamente.

---

## Permissões utilizadas

| Permissão | Uso |
|-----------|-----|
| `scripting` | Executa scripts em abas do admin e video-uploader |
| `storage` | Salva estado de execução, histórico de auditorias e token |
| `notifications` | Notifica ao finalizar auditorias e uploads |
| `downloads` | Baixa arquivos de vídeo e relatórios de auditoria |
| `activeTab` | Acessa a aba ativa ao iniciar operações |
| `https://*/*` | Acessa admin, video-uploader, CDN da Alura e GitHub API |
