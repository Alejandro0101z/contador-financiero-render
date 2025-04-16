// index.js usando directamente google-credentials.json ✅
const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const OpenAI = require("openai");
const cron = require("node-cron");
require("dotenv").config();

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const auth = new google.auth.GoogleAuth({
  credentials: require("./google-credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.SHEET_ID;
const twilioNumber = process.env.TWILIO_NUMBER;
const userNumber = process.env.USER_NUMBER;

function extraerMonto(texto) {
  const match = texto.match(/(?:\$)?(\d{1,3}(?:[.,]\d{3})*|\d+)/);
  if (!match) return "";
  return match[1].replace(/[.,]/g, "");
}

function fechaEsHoy(fechaStr) {
  const hoy = new Date();
  const fecha = new Date(fechaStr);
  return fecha.getFullYear() === hoy.getFullYear() &&
         fecha.getMonth() === hoy.getMonth() &&
         fecha.getDate() === hoy.getDate();
}

function estaEnEstaSemana(fechaStr) {
  const hoy = new Date();
  const fecha = new Date(fechaStr);
  const primerDia = new Date(hoy);
  primerDia.setDate(hoy.getDate() - hoy.getDay());
  return fecha >= primerDia && fecha <= hoy;
}

async function obtenerResumen(tipo) {
  const authClient = await auth.getClient();
  const sheet = await sheets.spreadsheets.values.get({
    auth: authClient,
    spreadsheetId,
    range: "Gastos!A:E",
  });

  const rows = sheet.data.values || [];
  const registros = rows.slice(1);

  const gastos = registros.map(([fecha, , monto, categoria]) => ({
    fecha: new Date(fecha),
    monto: parseFloat(monto) || 0,
    categoria: (categoria || "Otro").toLowerCase(),
  }));

  const resumen = {
    total: 0,
    categorias: {},
  };

  for (const g of gastos) {
    const fechaValida = tipo === "hoy" ? fechaEsHoy(g.fecha) : estaEnEstaSemana(g.fecha);
    if (fechaValida) {
      resumen.total += g.monto;
      resumen.categorias[g.categoria] = (resumen.categorias[g.categoria] || 0) + g.monto;
    }
  }

  return resumen;
}

function formatearResumen(resumen, periodo = "semana") {
  let msg = `📊 Resumen de la ${periodo}:\nTotal: $${resumen.total.toLocaleString("es-CL")}`;
  for (const [cat, val] of Object.entries(resumen.categorias)) {
    msg += `\n• ${cat}: $${val.toLocaleString("es-CL")}`;
  }
  return msg;
}

app.post("/webhook", async (req, res) => {
  const message = req.body.Body || "";
  const sender = req.body.From || "";

  try {
    const monto = extraerMonto(message);
    const authClient = await auth.getClient();

    if (monto) {
      await sheets.spreadsheets.values.append({
        auth: authClient,
        spreadsheetId,
        range: "Gastos!A:E",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[new Date(), message, monto]],
        },
      });

      const resumenHoy = await obtenerResumen("hoy");
      if (resumenHoy.total > 50000) {
        const twiml = `<Response><Message>⚠️ Hoy llevas gastado $${resumenHoy.total.toLocaleString("es-CL")}\n${formatearResumen(resumenHoy, "día")}</Message></Response>`;
        return res.send(twiml);
      }

      return res.send(`<Response><Message>✅ Gasto registrado: $${monto}</Message></Response>`);
    }

    const chat = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Eres un asistente financiero." },
        { role: "user", content: message },
      ],
    });

    const respuesta = chat.choices[0].message.content.trim();
    return res.send(`<Response><Message>${respuesta}</Message></Response>`);
  } catch (err) {
    console.error("❌ Error:", err);
    res.send(`<Response><Message>❌ Ocurrió un error procesando tu mensaje.</Message></Response>`);
  }
});

cron.schedule("0 10 * * 0", async () => {
  const resumen = await obtenerResumen("semana");
  const texto = formatearResumen(resumen);

  const twilio = require("twilio");
  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

  await client.messages.create({
    body: texto,
    from: twilioNumber,
    to: userNumber,
  });
});

app.get("/", (req, res) => {
  res.send("🤖 Contador personal activo y escuchando.");
});

app.listen(port, () => {
  console.log(`✅ Bot corriendo en http://localhost:${port}`);
});

