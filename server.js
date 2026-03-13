import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const SYSTEM_PROMPT = `
Você é a IA de atendimento comercial da Almeida Entulho.

Fale sempre em português do Brasil.
Seja simpático, profissional, direto e objetivo.
Faça apenas uma pergunta por vez.
Nunca peça várias informações na mesma mensagem.
Nunca mande lista grande de perguntas.
Nunca invente informações.

Fluxo obrigatório:
1. pedir local da entrega
2. mostrar tamanhos e valores
3. perguntar o tamanho
4. perguntar a data
5. mostrar horários
6. confirmar horário
7. pedir dados faltantes
8. pedir e-mail
9. gerar resumo
10. enviar link de pagamento
11. pedir comprovante
12. confirmar pedido

Regras:
- endereço, rua, bairro, CEP ou ponto de referência contam como local válido
- não pedir CEP se o cliente já informou endereço
- não confundir CEP com CPF ou CNPJ
- se já souber local + tamanho + data, o próximo passo é mostrar horários
- nunca pedir nome, CPF, CNPJ, endereço completo ou e-mail antes da escolha do horário
- respostas curtas e objetivas

Valores:
4m³ = R$ 280,00
5m³ = R$ 320,00
7m³ = R$ 380,00
10m³ = R$ 450,00

Incluso:
- entrega
- retirada
- até 7 dias
- descarte regularizado

Links:
4m³: https://pay.entulhoexpressreserva.shop/nWrxGWAJ9pX3654
5m³: https://pay.entulhoexpressreserva.shop/2wq7Gr4V0813BAN
7m³: https://pay.entulhoexpressreserva.shop/JqoR32bqmE63Vj5
10m³: https://pay.entulhoexpressreserva.shop/NDr8gmKxANqZBmj
`;

function extractReply(openaiData) {
  if (openaiData?.output_text && openaiData.output_text.trim()) {
    return openaiData.output_text.trim();
  }

  if (Array.isArray(openaiData?.output)) {
    for (const item of openaiData.output) {
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (content?.type === "output_text" && content?.text?.trim()) {
            return content.text.trim();
          }
        }
      }
    }
  }

  return "Olá! Me informa o local da entrega, por favor.";
}

app.get("/", (req, res) => {
  res.send("Webhook online");
});

app.post("/wati/webhook", async (req, res) => {
  try {
    console.log("Payload WATI:", JSON.stringify(req.body, null, 2));
    res.status(200).send("ok");

    const text =
      req.body?.text ||
      req.body?.message ||
      req.body?.data?.text ||
      req.body?.conversation?.text ||
      "";

    const phone =
      req.body?.whatsappNumber ||
      req.body?.waId ||
      req.body?.data?.waId ||
      req.body?.data?.whatsappNumber ||
      "";

    if (!text || !phone) {
      console.log("Sem texto ou telefone no payload.");
      return;
    }

    console.log("Telefone recebido:", phone);
    console.log("Texto recebido:", text);

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        instructions: SYSTEM_PROMPT,
        input: text,
      }),
    });

    const openaiData = await openaiResponse.json();
    console.log("OpenAI:", JSON.stringify(openaiData, null, 2));

    const reply = extractReply(openaiData);
    const cleanReply = String(reply).trim();

    if (!cleanReply) {
      console.log("Resposta vazia após limpeza.");
      return;
    }

    console.log("Resposta gerada:", cleanReply);

    const watiSendUrl = `https://${process.env.WATI_HOST}/api/v1/sendSessionMessage/${phone}`;
    console.log("URL WATI:", watiSendUrl);

    const body = new URLSearchParams();
    body.append("messageText", cleanReply);

    const watiResponse = await fetch(watiSendUrl, {
      method: "POST",
      headers: {
        Authorization: `${process.env.WATI_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const watiData = await watiResponse.text();
    console.log("Resposta do WATI:", watiData);
    console.log("Resposta enviada para o WATI.");
  } catch (error) {
    console.error("Erro:", error);
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
