import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

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

    const reply =
      openaiData.output_text ||
      "Desculpe, tive um problema para responder agora.";

    const watiSendUrl = `https://${process.env.WATI_HOST}/api/v1/sendSessionMessage/${phone}`;

    await fetch(watiSendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${process.env.WATI_API_KEY}`,
      },
      body: JSON.stringify({
        messageText: reply,
      }),
    });

    console.log("Resposta enviada para o WATI.");
  } catch (error) {
    console.error("Erro:", error);
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
