app.post("/wati/webhook", async (req, res) => {
  try {
    console.log("Webhook bateu");
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

    console.log("Texto recebido:", text);
    console.log("Telefone recebido:", phone);

    if (!text || !phone) {
      console.log("Sem texto ou telefone.");
      return;
    }

    console.log("Antes de rodar agent");
    const reply = await runAgent(text);
    console.log("Depois de rodar agent");
    console.log("Resposta gerada:", reply);

    if (!reply || !String(reply).trim()) {
      console.log("Resposta vazia do agent.");
      return;
    }

    const watiSendUrl = `https://${process.env.WATI_HOST}/api/v1/sendSessionMessage/${phone}`;
    console.log("Antes de enviar pro WATI");
    console.log("URL WATI:", watiSendUrl);

    const body = new URLSearchParams();
    body.append("messageText", String(reply).trim());

    const watiResponse = await fetch(watiSendUrl, {
      method: "POST",
      headers: {
        Authorization: `${process.env.WATI_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    const watiData = await watiResponse.text();
    console.log("Resposta do WATI:", watiData);
  } catch (error) {
    console.error("Erro no webhook:", error);
  }
});
