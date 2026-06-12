# Gripharma — Entregas ao Domicílio

Aplicação **web** para a farmácia gerir internamente as entregas ao domicílio:
registar pedidos, faturar, marcar como prontos, o estafeta recolher e confirmar
a entrega — tudo com **rasto de quem fez o quê**.

Funciona no **PC da farmácia (Windows)** e no **telemóvel do estafeta**, lado a
lado com o **Sifarma/GLINTT** (não o substitui — apenas organiza as entregas).

## ✨ Funcionalidades

- **Fluxo de estados:** A preparar → Pronto p/ entrega → Com o estafeta → Entregue
- **Dados do pedido:** cliente (nome, telefone, morada), medicamentos/itens,
  valor e estado do pagamento (pago / a cobrar na entrega)
- **Marcadores:** 📄 receita médica · ❄️ refrigerado · 📞 ligar ao chegar
- **Instruções de entrega** e **registo do desfecho** (em mão, a vizinho,
  no correio, com nota livre)
- **Rasto de operador:** quem **recebeu** o pedido, quem **faturou** (Sifarma)
  e quem **entregou**, com data/hora — histórico por pedido
- **Estafeta no telemóvel:** vê os pedidos prontos, recolhe e confirma entregas
- **Localização opcional:** o estafeta pode partilhar a posição e a farmácia vê
  onde ele está (no mapa) e o que já foi entregue

## ▶️ Como correr na farmácia (versão real, partilhada)

1. Instalar o [Node.js](https://nodejs.org) (LTS) no PC.
2. Abrir a pasta do projeto e correr:
   ```bash
   node server.js
   ```
3. No PC abrir **http://localhost:3000**
4. O estafeta, **na mesma rede Wi-Fi**, abre **http://IP-DO-PC:3000**
   (o IP aparece no arranque do servidor / `ipconfig` no Windows).

Os dados ficam guardados no ficheiro `data.json` (no PC da farmácia).
Não há dependências externas — corre só com o Node.

## 💳 Pagamentos Easypay (MB WAY e Referência Multibanco)

Opcional. Permite **gerar MB WAY** (push para o telemóvel do cliente) e
**referências Multibanco** dentro da app, com confirmação automática por webhook.

1. Copiar `.env.example` para `.env` e preencher as credenciais Easypay:
   ```
   EASYPAY_ACCOUNT_ID=...
   EASYPAY_API_KEY=...
   EASYPAY_ENV=test            # ou production
   EASYPAY_DEFAULT_EMAIL=farmacia@exemplo.pt
   EASYPAY_WEBHOOK_SECRET=...  # opcional
   ```
   > As credenciais **nunca** vão para o GitHub (`.env` está no `.gitignore`).
2. Arrancar com as variáveis (Windows PowerShell):
   ```powershell
   $env:EASYPAY_ACCOUNT_ID="..."; $env:EASYPAY_API_KEY="..."; node server.js
   ```
   (ou usar um carregador de `.env`). Em macOS/Linux: `export $(cat .env | xargs) && node server.js`.
3. Na conta Easypay, configurar o **webhook** para apontar para
   `https://<o-vosso-servidor>/api/easypay/webhook` (com `?secret=` se definido).
   Assim que o cliente paga, o pedido fica **Pago** automaticamente.

Sem credenciais, a app funciona na mesma — os botões MB WAY / Ref. MB só
aparecem quando o Easypay está configurado. **Não funciona na demo do GitHub
Pages** (essa não tem servidor).

## 🌐 Demonstração online

A pasta `docs/` é uma versão **estática de demonstração** publicada via
**GitHub Pages**. Aberta sem servidor, guarda os dados apenas no próprio browser
(`localStorage`) — perfeita para **mostrar** a app, sem instalar nada.

## 🗂️ Estrutura

```
server.js          → servidor Node (API + ficheiros estáticos)
docs/index.html    → interface
docs/styles.css    → estilos
docs/app.js        → lógica (modo servidor ou demo)
docs/assets/       → logótipo
```

---

Built with ❤️ in Portugal by **BuildityLab**
