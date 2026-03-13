import { startServer } from "../server.js";

process.env.PORT = process.env.PORT || "3210";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test";
process.env.WATI_HOST = process.env.WATI_HOST || "test.wati.io";
process.env.WATI_API_KEY = process.env.WATI_API_KEY || "Bearer test";

const server = startServer();

const baseUrl = `http://127.0.0.1:${process.env.PORT}`;

const response = await fetch(`${baseUrl}/health`);
if (!response.ok) {
  console.error(`Smoke falhou: /health retornou ${response.status}`);
  server.close(() => process.exit(1));
} else {
  const body = await response.json();
  if (body.status !== "ok") {
    console.error("Smoke falhou: payload inesperado de /health", body);
    server.close(() => process.exit(1));
  } else {
    console.log("Smoke ok:", body);
    server.close(() => process.exit(0));
  }
}
