# Vigil

Monitor de trecho em páginas: marque o texto, escolha se quer aviso quando **mudar**, **aparecer** ou **sumir**.

Stack: TypeScript, Hono, Postgres, Drizzle, Cheerio. Alertas por e-mail (padrão) e webhook opcional.

## Login (Google + magic link)

O caminho principal é **Continuar com Google**:
- cria/recupera o usuário pelo e-mail da conta Google
- salva sessão (cookie na web / Bearer na extensão)
- esse mesmo e-mail é usado nos **avisos de mudança** (`notifyEmail`)

Magic link continua disponível como fallback (dev / sem Google configurado).

### Configurar Google Cloud

1. Crie um projeto em [Google Cloud Console](https://console.cloud.google.com/)
2. APIs & Services → Credentials → **Create OAuth client ID**
3. Tipo: **Web application**
4. Authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback`
   - (produção) `https://SEU_DOMINIO/auth/google/callback`
   - (extensão) `https://SEU_EXTENSION_ID.chromiumapp.org/`
5. Copie Client ID e Client Secret para o `.env`:

```env
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
APP_URL=http://localhost:3000
```

O ID da extensão aparece em `chrome://extensions` (Modo do desenvolvedor).

Para e-mails reais de alerta, configure também `RESEND_API_KEY`. Sem isso, os avisos saem no console em dev.

### Endpoints

| Método | Rota | Uso |
|--------|------|-----|
| GET | `/auth/google` | Redirect OAuth (web) |
| GET | `/auth/google?format=json&redirect_uri=...` | URL OAuth para extensão |
| GET | `/auth/google/callback` | Callback web |
| POST | `/auth/google/code` | Troca `code` → sessão (extensão) |
| POST | `/auth/google/id-token` | Troca `idToken` → sessão |
| GET | `/auth/google/config` | `{ enabled, clientId }` |

## Fluxo principal (extensão)

1. Suba a API + worker localmente
2. Chrome → `chrome://extensions` → **Carregar sem compactação** → `extension/`
3. Painel Vigil → **Continuar com Google** (ou magic link)
4. Na página: **Ativar caneta** → circule → confirme o alerta

## UI web

- Landing: `http://localhost:3000/`
- Login: `http://localhost:3000/login.html`
- Painel: `http://localhost:3000/app.html`

O front estático em `web/` é servido pela mesma API.

## Setup local

### Requisitos

- Node 20+
- Docker (Postgres) **ou** um `DATABASE_URL` (Neon etc.)

```bash
cd projeto/vigil
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
```

Em dois terminais:

```bash
npm run dev      # API :3000
npm run worker   # scheduler
```

Sem `RESEND_API_KEY`, magic link e e-mails de alerta são **impressos no console** da API/worker.

## Modos de monitoramento

| Modo | Dispara quando |
|------|----------------|
| `text_changed` | O trecho (contexto ao redor) muda |
| `text_appears` | O texto passa a existir na página |
| `text_disappears` | O texto deixa de existir |

Cada watch exige `targetText`. Intervalo mínimo: **6 horas**. Máximo: **5 watches / user**.

## Fluxo rápido (curl)

```bash
# 1) Magic link (veja o link no log da API)
curl -s -X POST http://localhost:3000/auth/magic-link \
  -H "content-type: application/json" \
  -d "{\"email\":\"voce@exemplo.com\"}"

# 2) Trocar token por sessão (extensão / API)
curl -s -X POST http://localhost:3000/auth/exchange \
  -H "content-type: application/json" \
  -d "{\"token\":\"COLE_O_TOKEN\"}"

# 3) Criar alerta
curl -s -X POST http://localhost:3000/watches \
  -H "content-type: application/json" \
  -H "Authorization: Bearer SEU_SESSION_TOKEN" \
  -d "{\"url\":\"https://example.com\",\"targetText\":\"Hiring\",\"monitorMode\":\"text_appears\",\"intervalMinutes\":360,\"notifyEmail\":true}"

# 4) Check manual
curl -s -X POST http://localhost:3000/watches/WATCH_ID/check \
  -H "Authorization: Bearer SEU_SESSION_TOKEN"
```

## Limites MVP

- 5 watches / user
- Intervalo mínimo 6h
- Check manual 1 / 10 min
- HTML ≤ 2MB, texto ≤ 100KB
- 20 snapshots / watch
- Eventos retidos 90 dias (purge no worker)

## Scripts

| Script | Função |
|--------|--------|
| `npm run dev` | API com reload |
| `npm run worker` | Worker de checks |
| `npm run db:migrate` | Aplica SQL + views |
| `npm test` | Testes de extract/hash/diff |

## Estrutura

```
extension/      # Chrome MV3 (caneta + side panel)
src/api/        # Hono HTTP
src/worker/     # scheduler SKIP LOCKED
src/domain/     # auth, watches, check
src/lib/        # html, diff, notify, events
src/db/         # drizzle schema + migrate
sql/            # analytics views
web/            # UI (landing, login, painel)
```
