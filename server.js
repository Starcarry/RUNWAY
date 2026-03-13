import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Agent, Runner, withTrace } from "@openai/agents";

dotenv.config();

const app = express();
app.use(express.json());

const myAgent = new Agent({
  name: "Almeida Entulho Agent",
  instructions: `SEU PROMPT REAL AQUI`,
  model: "o3-mini",
  modelSettings: {
    reasoning: {
      effort: "medium"
    },
    store: true
  }
});

async function runAgent(text) {
  const result = await withTrace("Almeida Entulho Workflow", async () => {
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "SEU_WORKFLOW_ID"
      }
    });

    return await runner.run(myAgent, text);
  });

  return result.finalOutput || "Olá! Me informa o local da entrega, por favor.";
}

app.post("/wati/webhook", async (req, res) => {
  res.status(200).send("ok");

  const text = req.body?.text || "";
  const phone = req.body?.whatsappNumber || "";

  if (!text || !phone) return;

  const reply = await runAgent(text);

  const body = new URLSearchParams();
  body.append("messageText", String(reply));

  await fetch(`https://${process.env.WATI_HOST}/api/v1/sendSessionMessage/${phone}`, {
    method: "POST",
    headers: {
      Authorization: `${process.env.WATI_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
