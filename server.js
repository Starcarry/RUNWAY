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

function maskPhone(phone) {
  const value = String(phone || "");
  if (!value) return "nao_informado";
  const suffix = value.slice(-4);
  return `***${suffix}`;
}

function safeSnippet(value, limit = 500) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[truncated]`;
}

function maskSensitiveObject(input) {
  const sensitiveKeys = ["authorization", "token", "api_key", "apikey", "password", "secret"];

  if (Array.isArray(input)) {
    return input.map((item) => maskSensitiveObject(item));
  }

  if (input && typeof input === "object") {
    const output = {};
    for (const [key, value] of Object.entries(input)) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.some((part) => lower.includes(part))) {
        output[key] = "***";
      } else {
        output[key] = maskSensitiveObject(value);
      }
    }
    return output;
  }

  return input;
}

function logStructured(step, data = {}) {
  const safeData = maskSensitiveObject(data);
  console.log(`[webhook] ${step} ${JSON.stringify(safeData)}`);
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
  const EVENT_ID_LIMIT = 500;

  const processedFallbackKeys = new Map();
  const FALLBACK_DEDUP_WINDOW_MS = 30 * 1000;

  function normalizePhone(rawPhone) {
    return String(rawPhone || "").replace(/\D/g, "").trim();
  }

  function extractMessageText(payload) {
    const text =
      payload?.text ||
      payload?.message ||
      payload?.data?.text ||
      payload?.data?.message ||
      payload?.conversation?.text ||
      payload?.conversation?.lastMessage ||
      payload?.messageBody ||
      "";

    return String(text || "").trim();
  }

  function extractEventInfo(payload) {
    const eventId = String(
      payload?.id ||
        payload?.messageId ||
        payload?.eventId ||
        payload?.data?.id ||
        payload?.data?.messageId ||
        payload?.conversation?.id ||
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
      payload?.data?.isFromMe ??
      payload?.conversation?.fromMe;

    const statusRaw = payload?.status ?? payload?.messageStatus ?? payload?.data?.status ?? payload?.data?.messageStatus ?? "";
    const echoRaw = payload?.echo ?? payload?.isEcho ?? payload?.data?.echo ?? payload?.data?.isEcho;

    const direction = String(directionRaw ?? "").toLowerCase();
    const status = String(statusRaw ?? "").toLowerCase();
    const isEcho = String(echoRaw ?? "false").toLowerCase() === "true";

    return { eventId, eventType, direction, status, isEcho };
  }

  function extractInboundMessage(payload) {
    const text = extractMessageText(payload);

    const phoneRaw =
      payload?.whatsappNumber ||
      payload?.waId ||
      payload?.data?.waId ||
      payload?.data?.whatsappNumber ||
      payload?.conversation?.waId ||
      payload?.phone ||
      payload?.data?.phone ||
      "";

    const phone = normalizePhone(phoneRaw);

    return { text, phone };
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

  function isInboundRealMessage(eventInfo, text) {
    const type = String(eventInfo?.eventType || "").toLowerCase();
    const direction = String(eventInfo?.direction || "").toLowerCase();
    const status = String(eventInfo?.status || "").toLowerCase();

    const outboundDirections = ["out", "outbound", "outgoing", "sent", "true", "agent"];
    if (outboundDirections.includes(direction)) {
      return { ok: false, reason: "saida" };
    }

    if (eventInfo?.isEcho) {
      return { ok: false, reason: "echo" };
    }

    if (type.includes("status") || type.includes("delivery") || type.includes("read") || type.includes("ack")) {
      return { ok: false, reason: "status_evento" };
    }

    if (status && ["sent", "delivered", "read", "failed", "ack"].some((k) => status.includes(k))) {
      return { ok: false, reason: "status_payload" };
    }

    if (!text) {
      return { ok: false, reason: "sem_texto" };
    }

    return { ok: true, reason: "inbound_valido" };
  }

  function cleanupFallbackDedup(now) {
    for (const [key, ts] of processedFallbackKeys.entries()) {
      if (now - ts > FALLBACK_DEDUP_WINDOW_MS) {
        processedFallbackKeys.delete(key);
      }
    }
  }

  function isDuplicateEvent(eventInfo, phone, text) {
    const now = Date.now();

    if (eventInfo.eventId) {
      if (processedEventIds.has(eventInfo.eventId)) {
        return { duplicate: true, strategy: "event_id", key: eventInfo.eventId };
      }

      processedEventIds.add(eventInfo.eventId);
      processedEventOrder.push(eventInfo.eventId);

      if (processedEventOrder.length > EVENT_ID_LIMIT) {
        const oldest = processedEventOrder.shift();
        if (oldest) processedEventIds.delete(oldest);
      }

      return { duplicate: false, strategy: "event_id", key: eventInfo.eventId };
    }

    cleanupFallbackDedup(now);
    const fallbackKey = `${phone}|${String(text || "").trim().toLowerCase()}`;
    const lastTs = processedFallbackKeys.get(fallbackKey);

    if (lastTs && now - lastTs <= FALLBACK_DEDUP_WINDOW_MS) {
      return { duplicate: true, strategy: "fallback_window", key: fallbackKey };
    }

    processedFallbackKeys.set(fallbackKey, now);
    return { duplicate: false, strategy: "fallback_window", key: fallbackKey };
  }

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

  function buildAgentContext(phone, userInput) {
    const history = getConversationHistory(phone);
    const locationInfo = classifyLocationInput(userInput);

    let locationHint = "";
    if (locationInfo.type === "cep_invalido_7_digitos") {
      locationHint = "\nValidação: número com 7 dígitos não é CEP válido.";
    } else if (locationInfo.type === "cep_valido") {
      locationHint = "\nValidação: número com 8 dígitos pode ser tratado como CEP válido.";
    }

    if (!history.length) {
      return {
        hasHistory: false,
        input: `${userInput}${locationHint}`
      };
    }

    const historyText = history
      .map((item) => {
        const roleLabel = item?.role === "assistant" ? "Assistant" : "Usuário";
        return `${roleLabel}: ${String(item?.content || "")}`;
      })
      .join("\n");

    return {
      hasHistory: true,
      input: `Conversa em andamento com mesmo telefone. Continue do ponto atual sem reiniciar com saudação padrão.\n${historyText}\nUsuário: ${userInput}${locationHint}`
    };
  }

  async function runAgent(phone, userInput) {
    const activeAssistant = getAssistant();
    const context = buildAgentContext(phone, userInput);
    logStructured("agent_input", {
      phone: maskPhone(phone),
      hasHistory: context.hasHistory,
      historySize: getConversationHistory(phone).length,
      inputPreview: safeSnippet(context.input, 700)
    });

    const result = await run(activeAssistant, context.input);
    const finalOutput = String(result.finalOutput || "").trim();

    logStructured("agent_output", {
      phone: maskPhone(phone),
      outputPreview: safeSnippet(finalOutput, 700)
    });

    return finalOutput;
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
    logStructured("payload_received", { payload: req.body });
    res.status(200).send("ok");

    const { text, phone } = extractInboundMessage(req.body);
    const eventInfo = extractEventInfo(req.body);

    logStructured("payload_extracted", {
      phone: maskPhone(phone),
      textPreview: safeSnippet(text, 160),
      eventType: eventInfo.eventType,
      direction: eventInfo.direction || "unknown",
      status: eventInfo.status || "unknown",
      eventId: eventInfo.eventId || "none"
    });

    if (!phone) {
      logStructured("event_ignored", { reason: "telefone_ausente" });
      return;
    }

    const inboundCheck = isInboundRealMessage(eventInfo, text);
    if (!inboundCheck.ok) {
      logStructured("event_ignored", {
        phone: maskPhone(phone),
        reason: inboundCheck.reason,
        eventType: eventInfo.eventType,
        direction: eventInfo.direction,
        status: eventInfo.status
      });
      return;
    }

    const dedupeResult = isDuplicateEvent(eventInfo, phone, text);
    if (dedupeResult.duplicate) {
      logStructured("event_ignored", {
        phone: maskPhone(phone),
        reason: "duplicado",
        strategy: dedupeResult.strategy,
        keyPreview: safeSnippet(dedupeResult.key, 80)
      });
      return;
    }

    const history = getConversationHistory(phone);
    logStructured("event_processing", {
      phone: maskPhone(phone),
      historySize: history.length,
      conversationType: history.length ? "continuacao" : "nova_conversa",
      dedupeStrategy: dedupeResult.strategy
    });

    const locationInfo = classifyLocationInput(text);
    logStructured("location_classification", {
      phone: maskPhone(phone),
      type: locationInfo.type,
      normalized: safeSnippet(locationInfo.normalized, 32)
    });

    let reply = "";
    try {
      reply = await runAgent(phone, text);
      if (!reply) {
        logStructured("agent_empty_output", { phone: maskPhone(phone) });
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
    logStructured("history_saved", {
      phone: maskPhone(phone),
      historySize: getConversationHistory(phone).length
    });

    try {
      const sendResult = await sendMessageToWati(phone, reply);
      logStructured("wati_send_ok", {
        phone: maskPhone(phone),
        resultPreview: safeSnippet(sendResult, 200)
      });
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
