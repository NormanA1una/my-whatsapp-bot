const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

// --- Manejo de errores globales ---
process.on("uncaughtException", (err) =>
  console.error("❌ Uncaught Exception:", err)
);
process.on("unhandledRejection", (err) =>
  console.error("❌ Unhandled Rejection:", err)
);

(async () => {
  // --- Configuración por variables de entorno ---
  const REPLY_TEXT =
    process.env.REPLY_TEXT || "👋 Espere un momento, pronto será atendido.";
  const COOLDOWN_MINUTES = Number(process.env.COOLDOWN_MINUTES || 10);
  const MAX_DAILY_REPLIES = Number(process.env.MAX_DAILY_REPLIES || 3);
  const THROTTLE_MS = Number(process.env.THROTTLE_MS || 1000); // mínimo 1s entre envíos
  const BUSINESS_SCHEDULE = process.env.BUSINESS_SCHEDULE; // JSON weekly schedule

  let lastSendAt = 0;

  function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function parseWeeklySchedule(json) {
    if (!json) return null;
    try {
      const data = JSON.parse(json);
      const normalized = {};
      for (const key of Object.keys(data)) {
        const day = String(Number(key));
        if (!(day in normalized)) normalized[day] = [];
        const ranges = Array.isArray(data[key]) ? data[key] : [];
        for (const range of ranges) {
          if (typeof range !== "string" || !range.includes("-")) continue;
          const [startStr, endStr] = range.split("-");
          const toMin = (hhmm) => {
            const [h, m] = hhmm.split(":");
            const hh = Math.max(0, Math.min(24, Number(h)));
            const mm = Math.max(0, Math.min(59, Number(m || 0)));
            return hh * 60 + mm;
          };
          const startMin = Math.min(24 * 60, toMin(startStr.trim()));
          let endMin = toMin(endStr.trim());
          if (endStr.trim() === "24:00") endMin = 24 * 60;
          normalized[day].push({ startMin, endMin });
        }
      }
      return normalized;
    } catch (_e) {
      return null;
    }
  }

  const weeklySchedule = parseWeeklySchedule(BUSINESS_SCHEDULE);

  function isWithinBusinessHours(date) {
    // If a weekly schedule is provided, enforce it strictly
    if (weeklySchedule) {
      const dow = String(date.getDay()); // 0=Sunday ... 6=Saturday
      const ranges = weeklySchedule[dow] || [];
      if (ranges.length === 0) return false; // closed that day
      const mins = minutesSinceMidnight(date);
      for (const r of ranges) {
        const s = r.startMin;
        const e = r.endMin;
        if (e >= s) {
          if (mins >= s && mins < Math.min(e, 24 * 60)) return true;
        } else {
          if (mins >= s || mins < e) return true; // overnight
        }
      }
      return false;
    }
    // If no schedule configured, treat as always open
    return true;
  }

  function getDateKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS reply_stats (
      chat_id TEXT,
      date TEXT,
      count INTEGER,
      PRIMARY KEY (chat_id, date)
    );
  `);

  // --- Persistencia de sesión: asegúrate de que el directorio exista ---
  const SESSION_DIR = process.env.WWEBJS_DATA_PATH || ".wwebjs_auth";
  try {
    fs.mkdirSync(path.resolve(SESSION_DIR), { recursive: true });
  } catch (e) {
    console.error("⚠️ No se pudo crear el directorio de sesión:", e);
  }

  // --- Cliente WhatsApp ---
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      executablePath: puppeteer.executablePath(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--single-process", // Reduces memory usage
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI",
        "--disable-ipc-flooding-protection",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-background-downloads",
        "--disable-add-to-shelf",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-features=AudioServiceOutOfProcess",
      ],
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
      const withinHours = isWithinBusinessHours(new Date(now));
      if (withinHours) {
        const dateKey = getDateKey(now);
        const stat = await db.get(
          "SELECT count FROM reply_stats WHERE chat_id = ? AND date = ?",
          [chatId, dateKey]
        );
        const currentCount = stat ? stat.count : 0;
        if (currentCount < MAX_DAILY_REPLIES) {
          const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSendAt));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          try {
            await client.sendMessage(chatId, REPLY_TEXT);
            lastSendAt = Date.now();
          } catch (e) {
            console.error("⚠️ Error enviando respuesta inicial:", e);
          }
          await db.run(
            "INSERT INTO reply_stats (chat_id, date, count) VALUES (?, ?, 1) ON CONFLICT(chat_id, date) DO UPDATE SET count = reply_stats.count + 1",
            [chatId, dateKey]
          );
          await db.run(
            "INSERT INTO messages (chat_id, last_message_at, last_auto_reply_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_message_at = excluded.last_message_at, last_auto_reply_at = excluded.last_auto_reply_at",
            [chatId, now, now]
          );
        } else {
          await db.run(
            "INSERT INTO messages (chat_id, last_message_at, last_auto_reply_at) VALUES (?, ?, 0) ON CONFLICT(chat_id) DO UPDATE SET last_message_at = excluded.last_message_at",
            [chatId, now]
          );
        }
      } else {
        await db.run(
          "INSERT INTO messages (chat_id, last_message_at, last_auto_reply_at) VALUES (?, ?, 0) ON CONFLICT(chat_id) DO UPDATE SET last_message_at = excluded.last_message_at",
          [chatId, now]
        );
      }
      return;
    }

    const diff = now - record.last_message_at;
    const cooldown = now - record.last_auto_reply_at;
    const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
    const withinHours = isWithinBusinessHours(new Date(now));

    if (diff > COOLDOWN_MS && cooldown > COOLDOWN_MS && withinHours) {
      const dateKey = getDateKey(now);
      const stat = await db.get(
        "SELECT count FROM reply_stats WHERE chat_id = ? AND date = ?",
        [chatId, dateKey]
      );
      const currentCount = stat ? stat.count : 0;
      if (currentCount < MAX_DAILY_REPLIES) {
        const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSendAt));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
          await client.sendMessage(chatId, REPLY_TEXT);
          lastSendAt = Date.now();
        } catch (e) {
          console.error("⚠️ Error enviando respuesta automática:", e);
        }
        await db.run(
          "INSERT INTO reply_stats (chat_id, date, count) VALUES (?, ?, 1) ON CONFLICT(chat_id, date) DO UPDATE SET count = reply_stats.count + 1",
          [chatId, dateKey]
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
    } else {
      await db.run(
        "UPDATE messages SET last_message_at = ? WHERE chat_id = ?",
        [now, chatId]
      );
    }
  });

  // Limpieza semanal y optimización de base de datos
  setInterval(async () => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    const result = await db.run(
      "DELETE FROM messages WHERE last_message_at < ?",
      [cutoff]
    );
    console.log(`🧹 Limpieza: ${result.changes} registros eliminados`);

    // Vacuum database to reclaim disk space
    await db.run("VACUUM");
    console.log("✅ Base de datos optimizada");
  }, 60 * 60 * 1000); // Every hour

  // Mantener proceso activo
  setInterval(() => {}, 60 * 1000);

  client.initialize();

  // Cierre limpio del proceso
  async function shutdown(signal) {
    try {
      console.log(`↘️ Recibida señal ${signal}, cerrando recursos...`);
      await client.destroy();
      await db.close();
    } catch (e) {
      console.error("Error en cierre:", e);
    } finally {
      process.exit(0);
    }
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
