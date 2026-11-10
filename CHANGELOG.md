# Changelog

## 2.0.0 — 2026-11-09

Entrega consolidada para uso local, pessoal e portfólio.

### Mudança de instalação

O servidor único com SQLite substitui Postgres, login e worker separado. Rode `npm ci` e `npm start` com Node 22.13+ (recomendado: Node 24). O banco é criado em `data/vigil.db`; não é necessário Docker ou conta externa. Não há migração automática do banco Postgres antigo. Preserve os dados anteriores em uma pasta separada se precisar deles.

### Experiência

- Nova entrada com criação direta do primeiro alerta e exemplo identificado.
- Extensão com caneta, ajuste do trecho, prévia no servidor e popup; seletores mais estáveis e leitura HTTP/2.
- Painel com busca, filtros, leitura atual e histórico com antes/depois; modos claro/escuro e navegação móvel recolhível.
- Menu de opções e exclusão com confirmação, foco inicial em manter o alerta e retorno ao controle de origem ao cancelar.
- Ajustes técnicos sob demanda e notificações de ações sem empilhamento sobre o conteúdo.

### Correções e validação

- Criação faz a primeira leitura do alerta correto, mesmo com outros alertas vencidos.
- Falha de uma requisição antiga não sobrescreve um alvo editado; mudanças de intervalo são respeitadas no reagendamento.
- Dependências atualizadas: adaptador Hono 2.1.6, Hono 4.13.17, diff 9.0.0 e Zod 4.6.7. `npm audit` sem vulnerabilidades conhecidas na validação da entrega.
- 77 testes automatizados e 28 verificações no Chrome com API, SQLite e extensão reais, usando fixtures locais.
- README, screenshots, licença MIT, instruções de contribuição e ZIP da extensão atualizados.

### Limites desta entrega

O computador e o processo precisam estar rodando para checar páginas; notificações dependem do Chrome e do sistema operacional. O servidor não executa JavaScript do site nem usa a sessão de login do navegador. O produto é local, sem configuração para hospedagem pública. Veja [README](README.md#limites-atuais) e [validação](docs/VALIDACAO.md).
