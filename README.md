# Integração Agent + WATI CRM

Webhook em Node.js para conectar mensagens recebidas no WATI a um Agent da OpenAI e devolver a resposta ao WhatsApp.

## 1) Instalação

```bash
npm install
cp .env.example .env
```

Preencha o `.env` com suas chaves.

## 2) Executar

```bash
npm start
```

Servidor padrão: `http://localhost:3000`.

## 3) Configurar no WATI

No WATI, configure o webhook para:

- **URL**: `https://SEU_DOMINIO/wati/webhook`
- **Método**: `POST`
- **Content-Type**: `application/json`

## 4) Variáveis obrigatórias (Railway)

No serviço do Railway, configure:

- `OPENAI_API_KEY`
- `WATI_HOST` (ex.: `live-server-xxxxx.wati.io`)
- `WATI_API_KEY` (formato: `Bearer <token>`)
- `PORT` (o Railway normalmente injeta automaticamente)

## 5) Teste rápido

```bash
curl -X POST http://localhost:3000/wati/webhook \
  -H "Content-Type: application/json" \
  -d '{"whatsappNumber":"5511999999999","text":"Olá, tudo bem?"}'
```

Resposta esperada do endpoint: `ok`.

## 6) Diagnóstico

- `GET /health` retorna status do serviço e lista de variáveis faltantes.
- Se o deploy cair, confira os logs do Railway para identificar variável ausente ou erro de payload.

## 7) Smoke test local (anti-crash)

```bash
npm run smoke
```

Esse comando sobe o servidor, chama `GET /health` e derruba o processo. Se isso falhar, não faça deploy.


## 8) Erro `invalid_api_key` e mensagem não enviada

Se aparecer `Incorrect API key provided` nos logs, o Agent falha antes de gerar resposta.
Com esta versão, o webhook tenta enviar uma mensagem de fallback (configurada em `FALLBACK_MESSAGE`) para o usuário mesmo quando a OpenAI falhar.

Checklist no Railway:
- Corrigir `OPENAI_API_KEY` (sem espaços extras, chave ativa e válida).
- Confirmar `WATI_HOST` e `WATI_API_KEY` válidos.
- Testar `GET /health` após salvar variáveis.
- Rodar novo deploy e enviar uma mensagem de teste no WhatsApp.
