import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Webhook online");
});

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

  return "Olá! Recebi sua mensagem e já vou te ajudar.";
}

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
        model: "gpt-5.4",
        input: text,
      }),
    });

    const openaiData = await openaiResponse.json();
    console.log("OpenAI:", JSON.stringify(openaiData, null, 2));

    const reply = extractReply(openaiData);
    console.log("Resposta gerada:", reply);

    const cleanReply = String(reply).trim();
    if (!cleanReply) {
      console.log("Resposta vazia após limpeza.");
      return;
    }

    const watiSendUrl = `https://${process.env.WATI_HOST}/api/v1/sendSessionMessage/${phone}`;
    console.log("URL WATI:", watiSendUrl);

    const watiResponse = await fetch(watiSendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.WATI_API_KEY}`,
      },
      body: JSON.stringify({
        messageText: cleanReply,
      }),
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
