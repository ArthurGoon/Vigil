# Extensão Vigil

Chrome MV3: caneta vermelha para circular o trecho na página e side panel para criar e acompanhar os alertas.

## Instalar

1. Suba a API local (`docker compose up --build` ou `npm run dev`, veja o README principal).
2. `chrome://extensions` → Modo do desenvolvedor → **Carregar sem compactação** → esta pasta.
3. Abra o painel do Vigil pelo ícone da extensão. O campo **API** já vem com `http://localhost:3000`.

## Login

- Padrão: e-mail + **Enviar link mágico**. Sem `RESEND_API_KEY` na API o token já volta preenchido; clique em **Entrar com token**. A sessão fica no `chrome.storage.local` e vai como `Authorization: Bearer`.
- Opcional: **Continuar com Google** aparece só se a API tiver `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Usa `chrome.identity.launchWebAuthFlow` e `POST /auth/google/code`; o redirect `https://<ID-DA-EXTENSAO>.chromiumapp.org/` precisa estar cadastrado no OAuth client.

## Criar um alerta

1. **Ativar caneta nesta aba** e circule o texto, preço ou imagem.
2. A extensão captura o texto e um seletor CSS do elemento.
3. Escolha o modo (mudou, apareceu, sumiu), o intervalo em minutos e, se quiser, um webhook. **Criar alerta**.
