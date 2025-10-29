const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const puppeteer = require("puppeteer");

// --- Manejo de errores globales ---
process.on("uncaughtException", (err) =>
  console.error("❌ Uncaught Exception:", err)
);
process.on("unhandledRejection", (err) =>
  console.error("❌ Unhandled Rejection:", err)
);

(async () => {
  // --- Base de datos ---
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

  // --- Cliente WhatsApp ---
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      executablePath: puppeteer.executablePath(),
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

    if (msg.fromMe) return; // Ignorar tus propios mensajes

    const record = await db.get("SELECT * FROM messages WHERE chat_id = ?", [
      chatId,
    ]);

    if (!record) {
      // First message: always respond immediately
      await client.sendMessage(
        chatId,
        "👋 Espere un momento, pronto será atendido."
      );
      await db.run("INSERT INTO messages VALUES (?, ?, ?)", [chatId, now, now]);
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
      await db.run(
        "UPDATE messages SET last_message_at = ? WHERE chat_id = ?",
        [now, chatId]
      );
    }
  });

  // Limpieza semanal
  setInterval(async () => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await db.run("DELETE FROM messages WHERE last_message_at < ?", [cutoff]);
  }, 60 * 60 * 1000);

  // Mantener proceso activo
  setInterval(() => {}, 60 * 1000);

  client.initialize();
})();
