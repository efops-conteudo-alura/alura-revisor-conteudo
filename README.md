# Alura Revisor de Conteúdo

Extensão de navegador para equipes de conteúdo da Alura.
Automatiza revisão de cursos, upload de vídeos, auditoria de transcrições e legendas.

---

## Instalação

1. Baixe este repositório no botão verde "< > Code" > Download ZIP.
2. Abra o gerenciador de extensões no navegador
3. Ative o **Modo do desenvolvedor**
4. Clique em **Carregar sem compactação** e selecione a pasta do projeto (a pasta fora do zip)
5. A extensão aparecerá na barra do seu navegador

> A extensão só funciona em `cursos.alura.com.br` e `app.aluracursos.com`.

---

## Configuração inicial

Antes de usar, configure os tokens necessários na **aba Ferramentas**:

| Token | Para que serve |
|-------|----------------|
| **Token GitHub** | Upload de ícones e criação de forks |
| **Token video-uploader** | Upload e hospedagem de vídeos |

Cada token é salvo localmente no navegador e persiste entre sessões. Nunca fica exposto no código-fonte.

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
- Presença do curso em uma subcategoria
- Upload do ícone quando o curso está em uma subcategoria

Durante a revisão, se o curso não estiver em um catálogo, um modal aparece para selecionar e adicionar automaticamente. O mesmo acontece para subcategoria: se o curso não estiver em nenhuma, é exibido um dropdown agrupado por categoria para escolher e adicionar sem sair da revisão.

Para cada vídeo encontrado, a extensão abre a atividade em segundo plano para forçar o registro da duração no player, mantendo a estimativa de horas do curso atualizada no admin.

Se a ordem das atividades estiver com atividade inativa na frente bloqueando o acesso ao curso, a ferramenta faz a correção automaticamente em todas as aulas.

Ao finalizar, exibe um relatório completo com opção de download em `.txt` e `.json`.
O histórico das últimas 5 auditorias fica salvo na extensão.

Quando há erros nos campos admin (meta título, carga horária ou ementa), um botão **Corrigir Admin** aparece no relatório final. Ao clicar, a extensão abre a página admin em segundo plano, aplica as correções automáticas possíveis e salva:

| Campo | Correção automática |
|-------|---------------------|
| Meta título | `{Nome do curso} \| Alura` |
| Carga horária | Horas estimadas pelo sistema + 2h (máximo 20h) |
| Ementa | Clica em "Gerar Ementa" e aguarda a geração |

---

#### Cursos Em Breve

Cursos com "Em Breve" no nome (ex: "Em Breve", "[EM BREVE]") seguem um fluxo reduzido, pois suas aulas estão desativadas e os campos admin são provisórios.

O que **muda** em relação à revisão normal:

- **Todas as seções e aulas são revisadas** — inclusive as desativadas, pois é o único momento em que o conteúdo fica acessível para verificação
- **Links e transcrições são verificados normalmente** via admin
- **Carga de duração dos vídeos é pulada** — a extensão não tenta abrir as activity pages, que retornariam erro enquanto o curso está inativo
- **Campos admin não são verificados nem corrigidos** — nome, horas e ementa ainda estão em versão provisória; o botão "Corrigir Admin" não aparece
- O relatório exibe um aviso **🚧 Curso Em Breve** para deixar claro o contexto

---

### Aba Ferramentas

#### Token GitHub

Salva o Personal Access Token (PAT) do GitHub necessário para upload de ícones e criação de forks.

- Cole o token e clique em **Salvar token**
- O token fica salvo no armazenamento local do navegador e persiste entre sessões
- Nunca é armazenado no código-fonte da extensão

Necessário para usar os módulos de **Fork → alura-cursos** e o upload de ícones durante o **Start revisão**.

Para gerar um token: `Entre em contato com a Eficiência Operacional`

---

#### Fork → alura-cursos

Cria um fork de um repositório GitHub para a organização `alura-cursos`.

1. Cole a URL do repositório do instrutor
2. Clique em **Fazer Fork**

Se o fork já existir, retorna a URL existente sem criar um duplicado.

Requer o **Token GitHub** configurado previamente.

---

#### Auditoria de transcrições e legendagens

Audita múltiplos cursos de uma vez, identificando vídeos com pendências.

1. Cole os IDs dos cursos separados por vírgula ou espaço
2. Selecione o que deseja verificar:
   - **Transcrição** — verifica se o vídeo tem transcrição com mais de 50 caracteres
   - **Legendas em PT** — verifica se a legenda em Português está disponível no player
   - **Legendas em ESP** — verifica se a legenda em Espanhol está disponível no player
   - **Download textual** — extrai e baixa o conteúdo completo dos cursos em Markdown (ver abaixo)
3. Clique em **Auditar lista**

O relatório final é dividido em duas seções:

**Resumo** — visão consolidada por curso:
- Cursos com vídeos sem transcrição (com contagem)
- Cursos com legendas incompletas (com contagem)
- Cursos 100% corretos

**Detalhado** — lista completa de cada vídeo com pendência, com `✅`/`❌` por check.

Opções de exportação: **Copiar** (texto com resumo + detalhado) e **Baixar .txt**.

A auditoria fica salva no **Histórico** da extensão com data e hora, podendo ser reaberta a qualquer momento.

---

#### Download textual de cursos

Disponível como opção na auditoria em lote (checkbox **Download textual**). Quando ativado, ao finalizar a auditoria a extensão também baixa o conteúdo estruturado de cada curso em Markdown.

O que é extraído por curso:
- Nome, traduções (EN/ES), carga horária, meta description, público-alvo, autores e ementa
- Todas as seções e atividades com seus tipos (vídeo, texto, atividade)
- Transcrições dos vídeos
- Alternativas corretas de atividades

Formatos de download gerados:
- **Um arquivo por curso** — `{id}-{slug}.md`
- **Arquivo consolidado** — todos os cursos em um único `.md`

---

#### Token video-uploader

Salva o `X-API-TOKEN` necessário para autenticação no serviço `video-uploader.alura.com.br`.

- Cole o token e clique em **Salvar token**
- O token fica salvo no armazenamento local do navegador e persiste entre sessões

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
1. Valida se o token está configurado antes de navegar (exibe alerta imediato se não estiver)
2. Cria ou localiza uma **showcase** com o ID do curso no video-uploader
3. Faz upload serial de cada vídeo (um por vez)
4. Após todos os uploads, abre cada vídeo no uploader e clica em **Gerar legenda** — gerando as legendas em português e espanhol
5. Atualiza o campo `URI` de cada atividade no admin com o link do vídeo na nova hospedagem

Vídeos cuja URL não pode ser capturada (ex: cursos com streaming HLS) são marcados com `⚠️` no relatório final e não são enviados. Erros de upload exibem notificação do navegador com o motivo.

Aguarde alguns minutos e rode a auditoria com a ID do curso para verificar se todos os vídeos carregaram as legendas.

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

O estado de execução é persistido em `chrome.storage.local`. Se a aba do curso for fechada acidentalmente durante um fluxo (download, upload ou revisão), a extensão retoma de onde parou ao reabrir a página do curso.

---

## Permissões utilizadas

| Permissão | Uso |
|-----------|-----|
| `scripting` | Executa scripts em abas do admin e video-uploader |
| `storage` | Salva estado de execução, histórico de auditorias e tokens |
| `notifications` | Notifica ao finalizar auditorias e uploads |
| `downloads` | Baixa arquivos de vídeo e relatórios de auditoria |
| `activeTab` | Acessa a aba ativa ao iniciar operações |
| `https://*/*` | Acessa admin, video-uploader, CDN da Alura e GitHub API |

---

## Roadmap

Funcionalidades planejadas (visíveis na seção "Em breve" da interface):

- Upload de atividades Latam
- Upload de ícones customizados
- Adicionar transcrição em um só vídeo
- Duplicar cursos
