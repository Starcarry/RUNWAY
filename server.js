import express from "express";
import dotenv from "dotenv";
import { Agent, run } from "@openai/agents";

dotenv.config();

function parsePort(value, fallback = 3000) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isInvalidOpenAiKeyError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  return message.includes("invalid api key") || code === "invalid_api_key";
}

function getFallbackMessage() {
  return (
    process.env.FALLBACK_MESSAGE ||
    "Estou com instabilidade para responder agora. Me chama novamente em alguns instantes."
  );
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const PORT = parsePort(process.env.PORT, 3000);
  const agentModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  let assistant;
  const conversationStore = new Map();
  const HISTORY_LIMIT = 20;
  const processedEventIds = new Set();
  const processedEventOrder = [];
  const EVENT_DEDUP_LIMIT = 500;

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

  function getConversationHistory(phone) {
    const history = conversationStore.get(phone) || [];
    return history.slice(-HISTORY_LIMIT);
  }

  function saveConversationTurn(phone, userMessage, assistantMessage) {
    const history = getConversationHistory(phone);
    history.push({ role: "user", content: String(userMessage || "") });
    history.push({ role: "assistant", content: String(assistantMessage || "") });
    conversationStore.set(phone, history.slice(-HISTORY_LIMIT));
  }

  function classifyLocationInput(userInput) {
    const digitsOnly = String(userInput || "").replace(/\D/g, "");

    if (/^\d+$/.test(String(userInput || "").trim())) {
      if (digitsOnly.length === 8) {
        return { type: "cep_valido", normalized: digitsOnly };
      }

      if (digitsOnly.length === 7) {
        return { type: "cep_invalido_7_digitos", normalized: digitsOnly };
      }

      return { type: "numerico_outro", normalized: digitsOnly };
    }

    return { type: "texto_endereco", normalized: String(userInput || "").trim() };
  }

  function extractEventMetadata(payload) {
    const eventId = String(
      payload?.id ||
        payload?.messageId ||
        payload?.eventId ||
        payload?.data?.id ||
        payload?.data?.messageId ||
        ""
    ).trim();

    const eventType = String(
      payload?.eventType || payload?.event || payload?.type || payload?.data?.eventType || payload?.data?.type || "unknown"
    ).trim();

    const directionRaw =
      payload?.direction ??
      payload?.messageDirection ??
      payload?.data?.direction ??
      payload?.data?.messageDirection ??
      payload?.fromMe ??
      payload?.isFromMe ??
      payload?.data?.fromMe ??
      payload?.data?.isFromMe;

    const direction = String(directionRaw ?? "unknown").toLowerCase();

    return { eventId, eventType, direction };
  }

  function isOutgoingOrNonUserEvent(payload, text, metadata) {
    const type = String(metadata?.eventType || "").toLowerCase();
    const direction = String(metadata?.direction || "").toLowerCase();

    if (direction === "true" || direction === "out" || direction === "outgoing" || direction === "sent") {
      return { ignore: true, reason: "saida" };
    }

    if (type.includes("status") || type.includes("delivery") || type.includes("read")) {
      return { ignore: true, reason: "status" };
    }

    if (!text) {
      return { ignore: true, reason: "sem_texto_util" };
    }

    return { ignore: false, reason: "ok" };
  }

  function markEventAsProcessed(eventId) {
    if (!eventId) return;
    if (processedEventIds.has(eventId)) return;

    processedEventIds.add(eventId);
    processedEventOrder.push(eventId);

    if (processedEventOrder.length > EVENT_DEDUP_LIMIT) {
      const oldest = processedEventOrder.shift();
      if (oldest) {
        processedEventIds.delete(oldest);
      }
    }
  }

  function buildAgentInput(phone, userInput) {
    const history = getConversationHistory(phone);
    const locationInfo = classifyLocationInput(userInput);

    if (!history.length) {
      if (locationInfo.type === "cep_invalido_7_digitos") {
        return `${userInput}\n\nObservação de validação: entrada numérica com 7 dígitos não é CEP válido.`;
      }

      if (locationInfo.type === "cep_valido") {
        return `${userInput}\n\nObservação de validação: entrada numérica com 8 dígitos pode ser tratada como CEP válido.`;
      }

      return userInput;
    }

    const historyText = history
      .map((item) => `${item.role === "assistant" ? "Assistant" : "Usuário"}: ${item.content}`)
      .join("\n");

    let locationHint = "";
    if (locationInfo.type === "cep_invalido_7_digitos") {
      locationHint = "\nValidação: número com 7 dígitos não é CEP válido.";
    } else if (locationInfo.type === "cep_valido") {
      locationHint = "\nValidação: número com 8 dígitos pode ser tratado como CEP válido.";
    }

    return `Conversa em andamento com mesmo telefone. Continue do ponto atual sem reiniciar com saudação padrão.\n${historyText}\nUsuário: ${userInput}${locationHint}`;
  }

  async function runAgent(phone, userInput) {
    const activeAssistant = getAssistant();
    const inputWithHistory = buildAgentInput(phone, userInput);
    const result = await run(activeAssistant, inputWithHistory);
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

  app.get("/wati/webhook", (_req, res) => {
    res.status(200).send("webhook ok");
  });

  app.post("/wati/webhook", async (req, res) => {
    console.log("Webhook recebido:", JSON.stringify(req.body, null, 2));
    res.status(200).send("ok");

    const { text, phone } = extractInboundMessage(req.body);
    const metadata = extractEventMetadata(req.body);

    console.log(`Telefone extraído: ${phone || "nao_informado"}`);
    console.log(`Tipo/evento recebido: ${metadata.eventType}`);

    if (!phone) {
      console.log("Evento ignorado: telefone ausente.");
      return;
    }

    if (metadata.eventId && processedEventIds.has(metadata.eventId)) {
      console.log(`Evento ignorado: duplicado (${metadata.eventId}).`);
      return;
    }

    const eventDecision = isOutgoingOrNonUserEvent(req.body, text, metadata);
    if (eventDecision.ignore) {
      console.log(`Evento ignorado: ${eventDecision.reason}.`);
      return;
    }

    if (metadata.eventId) {
      markEventAsProcessed(metadata.eventId);
    }

    const history = getConversationHistory(phone);
    console.log(`Histórico atual: ${history.length} mensagens`);
    console.log(`Tipo de conversa: ${history.length ? "continuação" : "nova"}`);

    const locationInfo = classifyLocationInput(text);
    console.log(`Classificação de localização: ${locationInfo.type}`);

    let reply = "";
    try {
      reply = await runAgent(phone, text);
      if (!reply) {
        console.log("Agent retornou resposta vazia. Enviando fallback.");
        reply = getFallbackMessage();
      }
    } catch (error) {
      console.error("Erro ao executar agent:", error);

      if (isInvalidOpenAiKeyError(error)) {
        console.error("OPENAI_API_KEY inválida no ambiente. Atualize a variável no Railway.");
      }

      reply = getFallbackMessage();
    }

    saveConversationTurn(phone, text, reply);

    try {
      const sendResult = await sendMessageToWati(phone, reply);
      console.log("Mensagem enviada para WATI:", sendResult);
    } catch (error) {
      console.error("Erro ao enviar mensagem para WATI:", error);
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
