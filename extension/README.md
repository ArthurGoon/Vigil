# Vigil Extension

Chrome MV3 — caneta vermelha + alertas.

## Instalar (dev)

1. API em `http://localhost:3000` com `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (opcional mas recomendado)
2. `chrome://extensions` → Modo do desenvolvedor → **Carregar sem compactação** → esta pasta
3. Copie o **ID da extensão** e adicione no Google Cloud:
   `https://<ID>.chromiumapp.org/`
4. Recarregue a extensão → **Continuar com Google**

## Auth

- Google via `chrome.identity.launchWebAuthFlow` → `POST /auth/google/code`
- Fallback: magic link + `POST /auth/exchange`

O e-mail da conta Google é o destino dos avisos de mudança.
