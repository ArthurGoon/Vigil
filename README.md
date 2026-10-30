# Vigil

Monitor de trechos de página. Você marca um pedaço de texto (uma vaga, um preço, um aviso de edital) e escolhe quando quer ser avisado: quando ele **mudar**, quando **aparecer** ou quando **sumir**. Um worker checa a página no intervalo definido, compara com a última versão e registra o alerta. Comecei pensando em um serviço hospedado, mas a versão final roda inteira na sua máquina, sob demanda, sem nenhuma conta externa.

![Painel do Vigil com três alertas detectando mudança](docs/painel.jpg)

*Painel rodando localmente: um alerta de cada modo apontando para `fixtures/sample.html` servido em localhost, depois de trocar "Data Analyst" por "ML Engineer".*

## Arquitetura

```
 extensão Chrome (caneta)  ─┐
                            ├─> API Hono ──> Postgres <── worker (SKIP LOCKED)
 painel web (web/)         ─┘     │                          │
                                  └── check manual ──────────┴─> fetch + cheerio
                                                                   │
                                                  alerta: painel, console, e-mail*, webhook*
```

- `src/api`: API HTTP (Hono). Também serve o front estático de `web/`.
- `src/worker`: scheduler que pega os alertas vencidos com `FOR UPDATE SKIP LOCKED`.
- `src/domain`: login, CRUD de alertas, check (`check.ts`) e a lógica pura de decisão (`observation.ts`, `schedule.ts`).
- `src/lib`: extração de HTML, diff, notificação (e-mail via Resend ou console, webhook), eventos.
- `src/db` + `drizzle/`: schema Drizzle e migrations SQL.
- `sql/analytics_views.sql`: views de funil diário e tempo na página sobre a tabela `events`.
- `extension/`: extensão Chrome MV3 com caneta e side panel.

\* opcionais.

## Rodando localmente

Precisa de Docker. Nenhuma chave ou conta externa.

```bash
git clone https://github.com/ArthurGoon/Vigil.git
cd Vigil
docker compose up --build
```

Isso sobe Postgres, aplica as migrations e inicia API e worker. Abra http://localhost:3000, clique em **Entrar** e informe qualquer e-mail. Sem `RESEND_API_KEY`, o link de acesso aparece na própria tela de login (e no log da API) e os alertas saem no log do worker e no painel.

Sem Docker para a aplicação (só o Postgres no Docker, ou um Postgres seu via `DATABASE_URL`), com Node 20+:

```bash
docker compose up -d postgres
npm ci
npm run db:migrate
npm run dev        # terminal 1: API em http://localhost:3000
npm run worker     # terminal 2
```

### Teste rápido com uma página local

```bash
mkdir -p /tmp/vigil-demo && cp fixtures/sample.html /tmp/vigil-demo/
python3 -m http.server 8080 -d /tmp/vigil-demo
```

1. No painel, crie um alerta para `http://localhost:8080/sample.html` com o trecho `Backend Engineer`, seletor `#job-list`, modo "Texto mudou". Se a API estiver no Docker, use `http://host.docker.internal:8080/sample.html` (dentro do container, `localhost` é o próprio container).
2. O worker faz o primeiro check em segundos. Esse primeiro check é só a linha de base.
3. Edite `/tmp/vigil-demo/sample.html` (troque `Data Analyst` por outro cargo) e clique em **Testar agora** (ou espere o intervalo).
4. O alerta fica `changed`, o diff aparece em "Últimas mudanças" e o aviso sai no console.

### Extensão Chrome

1. `chrome://extensions` → Modo do desenvolvedor → **Carregar sem compactação** → pasta `extension/`.
2. Abra o painel do Vigil, informe o e-mail e clique em **Enviar link mágico**. Em modo local o token é preenchido sozinho; clique em **Entrar com token**.
3. Em qualquer página: **Ativar caneta**, circule o trecho e confirme o alerta.

## Testes

```bash
npm run typecheck
npm test
```

Os testes unitários cobrem extração e normalização de HTML, diff, os três modos de alerta (linha de base, mudança, aparecer, sumir, ruído fora do seletor) e o agendamento (intervalo, backoff, cooldown do check manual).

O teste do `SKIP LOCKED` precisa de um Postgres de verdade e só roda com `TEST_DATABASE_URL` apontando para um banco de teste (ele apaga a tabela `watches`):

```bash
docker compose exec postgres createdb -U vigil vigil_test
DATABASE_URL=postgres://vigil:vigil@localhost:5432/vigil_test npm run db:migrate
TEST_DATABASE_URL=postgres://vigil:vigil@localhost:5432/vigil_test npm test
```

O CI (`.github/workflows/ci.yml`) roda typecheck, migrations e todos os testes, incluindo esse, com um Postgres de serviço.

## Decisões de projeto

**Worker com `FOR UPDATE SKIP LOCKED` e lease.** O worker faz um único `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)` que empurra `next_check_at` 60s para frente. Vários workers podem rodar ao mesmo tempo sem pegar o mesmo alerta e sem fila externa: o próprio Postgres é a fila. Se um worker morrer no meio do check, o alerta volta a vencer quando o lease expira. Ao terminar, o check grava o `next_check_at` real. O teste `src/worker/claim.test.ts` dispara três claims concorrentes e confere que nenhum alerta sai duplicado.

**O que é comparado é a observação, não a página.** Cada modo gera uma chave SHA-256 diferente:
- `text_changed`: hash do texto do elemento (com seletor) ou de uma janela de 80 caracteres em volta do trecho (sem seletor). Mudanças fora do seletor não disparam nada.
- `text_appears` / `text_disappears`: hash só do "está presente ou não". Edições em outras partes da página não mudam a chave.

Antes do hash o texto passa por normalização: remove `script`, `style`, `nav`, `header`, `footer` e afins, separa blocos (HTML minificado não vira "AB"), apara cada linha e ignora maiúsculas e minúsculas. Assim reindentação ou espaço extra não viram alerta falso. O snapshot guarda só um JSON pequeno com o trecho, não o HTML.

**Alerta por transição, não por estado.** O primeiro check é linha de base e nunca alerta. "Apareceu" só dispara na passagem ausente → presente, "sumiu" só na passagem presente → ausente. Se o seletor salvo pela extensão deixa de existir nesses modos, a busca cai para a página inteira: elemento removido conta como "sumiu", elemento que só mudou de lugar não.

**Lógica pura separada de I/O.** `observation.ts` e `schedule.ts` não tocam banco nem rede; `check.ts` só busca a página e persiste. Por isso dá para testar os modos com sequências de versões da página sem subir nada.

**Erros e limites.** Resposta HTTP fora de 2xx é erro (uma página 404 não é comparada como se fosse conteúdo). Em erro, backoff exponencial a partir do intervalo do alerta, com teto de 24h. Limites fixos: HTML até 2 MB, texto até 100 mil caracteres, timeout de 15s, 20 snapshots por alerta, eventos retidos por 90 dias. Os limites de uso são configuráveis por variável de ambiente:

| Variável | Padrão | Para quê |
|---|---|---|
| `MIN_INTERVAL_MINUTES` | 5 | intervalo mínimo entre checks |
| `MANUAL_CHECK_COOLDOWN_SECONDS` | 30 | evita martelar o site com "Testar agora" |
| `MAX_WATCHES_PER_USER` | 20 | alertas por usuário |
| `WORKER_CONCURRENCY` / `WORKER_POLL_MS` | 3 / 5000 | tamanho do lote e frequência do worker |

**Tokens nunca em texto puro.** Link mágico e sessão são guardados como SHA-256 com pepper (`SESSION_SECRET`). IP e user agent dos eventos de analytics também ficam só em hash. CORS aceita credenciais só da própria origem e da extensão.

**Analytics em SQL.** Eventos de produto (`page_view`, `watch_created`, `watch_change_detected` etc.) vão para a tabela `events`, com nomes validados contra uma lista fixa. As views em `sql/analytics_views.sql` montam funil diário e tempo na página (média e p50).

## Limitações conhecidas

- Sem navegador headless: páginas que só renderizam o conteúdo via JavaScript não funcionam (o check usa `fetch` + cheerio).
- No modo "texto mudou" sem seletor, a janela de 80 caracteres em volta do trecho faz mudanças vizinhas também dispararem alerta.
- O seletor gerado pela extensão é um caminho CSS; se o layout da página muda, o modo "texto mudou" entra em erro (com backoff) até o alerta ser recriado.
- Não consulta `robots.txt`.
- Webhook tem duas tentativas na hora; não existe fila de reentrega.
- Pensado para uso local, de uma pessoa. Não tem deploy nem endurecimento para produção.

## Opcional: e-mail e login com Google

Nada disso é necessário para rodar. Coloque as variáveis num `.env` (veja `.env.example`); o `docker compose` repassa essas variáveis aos containers.

- **E-mail real (Resend):** defina `RESEND_API_KEY` e `MAGIC_LINK_FROM`. Link de login e alertas passam a ir por e-mail em vez do console.
- **Login com Google:** crie um OAuth Client ID do tipo "Web application" no Google Cloud Console, com redirect `http://localhost:3000/auth/google/callback` (e `https://<ID-DA-EXTENSAO>.chromiumapp.org/` para a extensão). Defina `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. O botão "Continuar com Google" só aparece quando essas variáveis existem.

## API

| Método | Rota | Uso |
|---|---|---|
| POST | `/auth/magic-link` | pede link de login (em modo local devolve `devLink`) |
| POST | `/auth/exchange` | troca o token do link por sessão (Bearer) |
| GET | `/auth/callback?token=` | login pelo navegador (cookie) |
| GET, POST | `/watches` | lista / cria alertas |
| PATCH, DELETE | `/watches/:id` | edita / remove (mudar URL, trecho, seletor ou modo reinicia a linha de base) |
| POST | `/watches/:id/check` | check manual |
| GET | `/watches/:id/changes` | mudanças detectadas, com diff |
| GET | `/watches/:id/snapshots` | snapshots |
| GET | `/limits` | limites em vigor |
| POST | `/ingest/events` | eventos de analytics do front |

Exemplo com curl:

```bash
curl -s -X POST localhost:3000/auth/magic-link -H 'content-type: application/json' \
  -d '{"email":"voce@exemplo.com"}'                       # copie o token do devLink
curl -s -X POST localhost:3000/auth/exchange -H 'content-type: application/json' \
  -d '{"token":"TOKEN"}'                                  # devolve sessionToken
curl -s -X POST localhost:3000/watches -H 'content-type: application/json' \
  -H 'Authorization: Bearer SESSION' \
  -d '{"url":"http://localhost:8080/sample.html","targetText":"ML Engineer","monitorMode":"text_appears","intervalMinutes":15}'
```

## Stack

TypeScript, Node 20+, Hono, Postgres 16, Drizzle, postgres.js, Cheerio, Zod, `node:test`. Front em HTML/CSS/JS sem framework. Extensão Chrome MV3.
