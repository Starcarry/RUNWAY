import express from "express";
import dotenv from "dotenv";
import { Agent, run } from "@openai/agents";

dotenv.config();

function parsePort(value, fallback = 3000) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const PORT = parsePort(process.env.PORT, 3000);
  const agentModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  let assistant;

  function getAssistant() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY não configurada.");
    }

    if (!assistant) {
      assistant = new Agent({
        name: "Atendente WATI",
        instructions:
          process.env.AGENT_INSTRUCTIONS ||
          "Você é um agente de atendimento via WhatsApp. Responda de forma curta, objetiva e amigável em português do Brasil.",
        model: agentModel
      });
    }

    return assistant;
  }

  function extractInboundMessage(payload) {
    const text =
      payload?.text ||
      payload?.message ||
      payload?.data?.text ||
      payload?.conversation?.text ||
      payload?.conversation?.lastMessage ||
      "";

    const phone =
      payload?.whatsappNumber ||
      payload?.waId ||
      payload?.data?.waId ||
      payload?.data?.whatsappNumber ||
      payload?.conversation?.waId ||
      "";

    return { text: String(text).trim(), phone: String(phone).trim() };
  }

  async function runAgent(userInput) {
    const activeAssistant = getAssistant();
    const result = await run(activeAssistant, userInput);
    return String(result.finalOutput || "").trim();
  }

  async function sendMessageToWati(phone, messageText) {
    if (!process.env.WATI_HOST || !process.env.WATI_API_KEY) {
      throw new Error("WATI_HOST ou WATI_API_KEY não configurada.");
    }

    const watiSendUrl = `https://${process.env.WATI_HOST}/api/v1/sendSessionMessage/${encodeURIComponent(phone)}`;
    const body = new URLSearchParams();
    body.append("messageText", messageText);

    const watiResponse = await fetch(watiSendUrl, {
      method: "POST",
      headers: {
        Authorization: process.env.WATI_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const responseText = await watiResponse.text();
    if (!watiResponse.ok) {
      throw new Error(`Falha ao enviar mensagem para WATI (${watiResponse.status}): ${responseText}`);
    }

    return responseText;
  }

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      port: PORT,
      missing: ["OPENAI_API_KEY", "WATI_HOST", "WATI_API_KEY"].filter((k) => !process.env[k])
    });
  });

  app.post("/wati/webhook", async (req, res) => {
    try {
      console.log("Webhook recebido:", JSON.stringify(req.body, null, 2));
      res.status(200).send("ok");

      const { text, phone } = extractInboundMessage(req.body);
      if (!text || !phone) {
        console.log("Evento ignorado: payload sem texto ou telefone.");
        return;
      }

      const reply = await runAgent(text);
      if (!reply) {
        console.log("Agent retornou resposta vazia.");
        return;
      }

      const sendResult = await sendMessageToWati(phone, reply);
      console.log("Mensagem enviada para WATI:", sendResult);
    } catch (error) {
      console.error("Erro no processamento do webhook:", error);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error("Erro de request:", err?.message || err);
    res.status(400).json({ error: "Payload inválido." });
  });

  return { app, port: PORT };
}

export function startServer() {
  const { app, port } = createApp();

  const missing = ["OPENAI_API_KEY", "WATI_HOST", "WATI_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`Variáveis ausentes: ${missing.join(", ")}. Configure no ambiente de deploy.`);
  }

  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("uncaughtException:", error);
  });

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando na porta ${port}`);
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
