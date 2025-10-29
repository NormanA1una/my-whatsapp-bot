import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// Captura errores no controlados
process.on("uncaughtException", (err) =>
  console.error("❌ Uncaught Exception:", err)
);
process.on("unhandledRejection", (err) =>
  console.error("❌ Unhandled Rejection:", err)
);

// ===== BASE DE DATOS =====
const db = await open({
  filename: "./messages.db",
  driver: sqlite3.Database,
});
await db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT PRIMARY KEY,
    last_message_at INTEGER,
    last_auto_reply_at INTEGER
  );
`);

// ===== WHATSAPP CLIENT =====
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("📱 Escanea este código QR con WhatsApp Business:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ WhatsApp conectado y listo para recibir mensajes");
});

client.on("message", async (msg) => {
  const now = Date.now();
  const chatId = msg.from;

  if (msg.fromMe) return; // Ignora mensajes enviados por el bot

  const record = await db.get("SELECT * FROM messages WHERE chat_id = ?", [
    chatId,
  ]);

  if (!record) {
    await db.run("INSERT INTO messages VALUES (?, ?, ?)", [chatId, now, 0]);
    return;
  }

  const diff = now - record.last_message_at;
  const cooldown = now - record.last_auto_reply_at;
  const TEN_MIN = 10 * 60 * 1000;

  if (diff > TEN_MIN && cooldown > TEN_MIN) {
    await client.sendMessage(
      chatId,
      "👋 Espere un momento, pronto será atendido."
    );
    await db.run(
      "UPDATE messages SET last_message_at = ?, last_auto_reply_at = ? WHERE chat_id = ?",
      [now, now, chatId]
    );
  } else {
    await db.run("UPDATE messages SET last_message_at = ? WHERE chat_id = ?", [
      now,
      chatId,
    ]);
  }
});

// Limpieza semanal de registros antiguos
setInterval(async () => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await db.run("DELETE FROM messages WHERE last_message_at < ?", [cutoff]);
}, 60 * 60 * 1000);

// Mantener proceso activo en Render
setInterval(() => {}, 60 * 1000);

client.initialize();
