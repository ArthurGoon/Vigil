# Contribuir

Use Node 22.13+ (recomendado: Node 24). Instale as dependências com `npm ci`.

```bash
npm run check
npm run typecheck
npm test
npm run test:e2e
```

O ponta a ponta precisa de Chrome/Chromium (`CHROME_PATH` para outro caminho). Ele inicia um servidor com porta aleatória e SQLite temporário, usa uma fixture editável e testa painel, extensão e exclusão sem tocar no banco pessoal. A apresentação das notificações pelo sistema operacional exige conferência manual.

Inclua passos de reprodução e validação no pull request. Preserve as migrations existentes; acrescente uma nova para mudar o schema. Testes devem usar `:memory:` ou banco temporário, nunca `data/vigil.db`.

Para relatar falhas, informe Node, Chrome, modo do alerta e passos para reproduzir. Prefira `fixtures/` a páginas pessoais ou autenticadas. Não anexe bancos pessoais, URLs privadas de webhook, credenciais ou snapshots com dados sensíveis.

Código sob MIT; preserve os avisos de licença das fontes incluídas.
