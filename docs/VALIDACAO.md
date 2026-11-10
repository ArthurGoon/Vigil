# Validação local — 9 de novembro de 2026

Objetivo desta revisão: uso pessoal confiável e portfólio.

Ambiente: Node 24.21.0 e Google Chrome 157.0.8103.38, Linux.

## Resultado

- `npm test`: **77/77**, sem testes pulados.
- `npm run typecheck`: aprovado.
- `npm run check`: **8/8** arquivos JavaScript do painel, extensão e scripts sem erro de sintaxe.
- `npm run test:e2e`: **28/28** no Chrome headless, com API, SQLite e extensão reais. Página de exemplo local, sem serviços externos.
- Imagens do painel, caneta, popup e largura de celular inspecionadas visualmente.

O teste ponta a ponta inicia outro processo com porta aleatória e banco temporário. Não toca no banco pessoal. A imagem do painel foi preservada em `docs/painel.png` e os resultados das verificações em `docs/e2e-checks.json`.

## Correções verificadas

1. Ao criar um alerta, a primeira checagem agora pertence ao alerta criado. Antes, se outro alerta estivesse vencido, a criação podia reservar o antigo e deixar o novo sem referência inicial. O teste reproduziu a falha antes da correção.
2. Se o alvo for editado durante uma requisição que falha, o erro do alvo antigo não substitui o estado nem o próximo horário do novo alvo. O teste reproduziu a falha antes da correção.
3. Se só o intervalo mudar durante uma requisição que falha, o agendamento respeita o intervalo atualizado. O teste reproduziu a falha antes da correção.
4. README atualizado para o produto atual: servidor único, SQLite embutido, sem login, sem Postgres e sem Docker. Inclui instalação da extensão, backup, variáveis corretas, API e limitações.

## O que o Chrome exercitou

Caneta desenhada por eventos de mouse → identificação do preço → prévia no servidor → salvar alerta com seletor e referência inicial → criar alertas de aparecer e sumir pelo editor → alterar HTML servido → checar pelos botões do painel → conferir os três tipos no histórico → atualizar cursor de notificações → abrir popup → recarregar painel → conferir ausência de rolagem horizontal a 390 px → HTTP 503 tratado como erro sem mudança falsa.

## Limites da validação

- Não foi feito teste contínuo de vários dias em sites reais.
- Notificações: o teste confere o fluxo da extensão e seu cursor, mas a apresentação visual pelo sistema operacional ainda precisa de teste manual.
- Webhook com destino externo não foi validado nesta revisão.
- Páginas que exigem login, renderização por JavaScript ou desafios antirobô continuam fora da cobertura garantida.

## Próximo uso recomendado

Rodar `npm start`, recarregar a extensão em `chrome://extensions` e acompanhar poucos alertas reais por alguns dias. Conferir as notificações no sistema operacional e manter um backup da pasta `data/` com o Vigil parado. Registrar falhas por site antes de ampliar recursos.

## Revisão da interface

Entrada com ação direta para criar o primeiro alerta e prévia explicitamente ilustrativa. Instruções da extensão aparecem quando solicitadas. O painel ganhou busca, filtros, escopo do trecho sob demanda, menu de opções e confirmação de exclusão com foco inicial em manter o alerta. No celular, a navegação se recolhe e o detalhe permanece em primeiro plano. Notificações de ações se substituem para não empilhar sobre o conteúdo.

As 28 verificações do Chrome incluem busca com e sem resultado, filtro de pausados, entrada e navegação móvel, modo escuro, foco do editor, cancelamento e confirmação de exclusão e retorno do foco ao controle de origem. O histórico dos demais alertas permanece após excluir um alerta de teste. As imagens de início, editor, detalhe, celular, popup e modo escuro foram inspecionadas.

## Preparação da release v2.0.0

Instalação limpa com `npm ci` validada após atualizar Hono/adaptador, diff e Zod. `npm audit` retornou zero vulnerabilidades conhecidas nesta execução. CI configurado em Node 22 e 24. A fonte Inter mantém a licença OFL; o código tem licença MIT. Versões do pacote e da extensão alinhadas em 2.0.0.
