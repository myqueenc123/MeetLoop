/**
 * MeetLoop - Official Production Server Backend
 * 100% Filipino Made Random Video Chat 🇵🇭
 * High-Speed Telegram Auto-Pairing Bot + WebRTC Matchmaking
 * (Telegram 1-Click Inline Buttons + Auto-SMS Receiver)
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const https = require("https");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days in MS

// =========================================================================
// 🤖 TELEGRAM BOT CONFIGURATION (@MeetLoop_bot | Admin ID: 5779976596)
// =========================================================================
const _partA = "8648356765";
const _partB = "AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || (_partA + ":" + _partB);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

// Anti-Cache Headers
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= HARDWARE BAN DATABASE ================= */
const bannedDevices = new Map();
const pendingRequests = new Map();

// Helper para magpadala ng raw request sa Telegram API
function sendTelegramRaw(endpoint, payloadObj) {
  if (!TELEGRAM_BOT_TOKEN) return;

  const payload = JSON.stringify(payloadObj);
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, (res) => {
    let d = "";
    res.on("data", chunk => d += chunk);
  });
  req.on("error", e => console.log("Telegram Error:", e.message));
  req.write(payload);
  req.end();
}

// Function: Magpadala ng message na may Interactive 1-Click Buttons sa Telegram
function sendTelegramWithButtons(chatId, text, reqId) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🟢 1-CLICK APPROVE", callback_data: `approve_${reqId}` },
          { text: "🔴 REJECT", callback_data: `reject_${reqId}` }
        ]
      ]
    }
  };
  sendTelegramRaw("sendMessage", payload);
}

// Function: Simple Text Message
function sendTelegramMessage(chatId, text) {
  sendTelegramRaw("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

// Function: Ipadala ang Unban Ticket kay JM na may Interactive Buttons
function sendTelegramNotification(reqId, name, ref) {
  const msgText = `🚨 <b>MEETLOOP ₱20 UNBAN REQUEST</b>\n\n` +
                  `👤 <b>Sender:</b> ${name}\n` +
                  `💳 <b>Ref No:</b> <code>${ref}</code>\n` +
                  `💰 <b>Amount:</b> ₱20.00\n\n` +
                  `<i>Pindutin ang 🟢 1-CLICK APPROVE kapag pumasok na ang bayad sa GCash mo:</i>`;

  sendTelegramWithButtons(ADMIN_CHAT_ID, msgText, reqId);
}

// =========================================================================
// 📲 GCASH SMS WEBHOOK RECEIVER (Galing sa Cellphone mo)
// =========================================================================
app.post("/webhook/gcash-sms", (req, res) => {
  const secret = req.query.secret || req.body.secret;
  if (secret !== "MEETLOOP2026") {
    return res.status(403).send("Unauthorized");
  }

  // Tanggapin ang text message galing sa SMS forwarder ng phone mo
  const smsBody = req.body.content || req.body.message || req.body.text || JSON.stringify(req.body);
  const fromNumber = req.body.from || req.body.sender || "GCash SMS";

  console.log(`[GCASH SMS RECEIVED]: ${smsBody}`);

  const alertText = `💰 <b>GCASH MONEY RECEIVED (PHONE NOTIF)</b>\n\n` +
                    `📲 <b>From:</b> ${fromNumber}\n` +
                    `📩 <b>Message:</b>\n<code>${smsBody}</code>`;

  sendTelegramMessage(ADMIN_CHAT_ID, alertText);
  res.json({ success: true, message: "SMS logged to Telegram" });
});

// =========================================================================
// ⚡ TELEGRAM POLLING LISTENER (With 1-Click Button Handler)
// =========================================================================
let lastUpdateId = 0;
function pollTelegramUpdates() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`;

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (json.ok && Array.isArray(json.result)) {
          json.result.forEach((update) => {
            lastUpdateId = update.update_id;

            // 1. HANDLER KAPAG PININDOT ANG INLINE BUTTONS (APPROVE / REJECT)
            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = cb.data || "";
              const messageId = cb.message?.message_id;
              const chatId = cb.message?.chat?.id;

              if (cbData.startsWith("approve_")) {
                const reqId = cbData.replace("approve_", "");
                const request = pendingRequests.get(reqId);

                if (request) {
                  // UNBAN DEVICE
                  bannedDevices.delete(request.hardwareId);
                  pendingRequests.delete(reqId);

                  // Send instant unlock to client browser
                  io.emit("real-admin-unban-signal", { hardwareId: request.hardwareId });

                  // Update Telegram message
                  sendTelegramRaw("editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: `✅ <b>APPROVED BY ADMIN!</b>\n\n👤 <b>User:</b> ${request.name}\n💳 <b>Ref:</b> <code>${request.ref}</code>\n💰 <b>Amount:</b> ₱20.00\n\n🎉 <i>Matagumpay na na-unban ang user sa MeetLoop!</i>`,
                    parse_mode: "HTML"
                  });

                  sendTelegramRaw("answerCallbackQuery", {
                    callback_query_id: cb.id,
                    text: "✅ User Unbanned Successfully!",
                    show_alert: true
                  });
                } else {
                  sendTelegramRaw("answerCallbackQuery", {
                    callback_query_id: cb.id,
                    text: "⚠️ Ticket already processed or expired.",
                    show_alert: true
                  });
                }
              } else if (cbData.startsWith("reject_")) {
                const reqId = cbData.replace("reject_", "");
                const request = pendingRequests.get(reqId);
                pendingRequests.delete(reqId);

                sendTelegramRaw("editMessageText", {
                  chat_id: chatId,
                  message_id: messageId,
                  text: `❌ <b>REJECTED BY ADMIN</b>\n\n👤 <b>User:</b> ${request ? request.name : "Unknown"}\n💳 <b>Ref:</b> <code>${request ? request.ref : ""}</code>\n\n🚫 <i>Hindi na-unban (Walang pumasok na bayad).</i>`,
                  parse_mode: "HTML"
                });

                sendTelegramRaw("answerCallbackQuery", {
                  callback_query_id: cb.id,
                  text: "❌ Request Rejected!",
                  show_alert: false
                });
              }
            }

            // 2. HANDLER PARA SA /start CHAT
            if (update.message && update.message.chat) {
              const incomingChatId = update.message.chat.id;
              const senderName = update.message.from?.first_name || "Boss";
              const text = (update.message.text || "").trim();

              if (text.startsWith("/start")) {
                const welcomeReply = `👋 <b>Kamusta Jm!</b>\n\n` +
                                     `✅ <b>100% Connected ang MeetLoop Admin Bot!</b>\n\n` +
                                     `Dito papasok ang:\n` +
                                     `1. 📲 <b>GCash SMS Notif mula sa phone mo</b>\n` +
                                     `2. 🚨 <b>1-Click Approve / Reject Buttons sa bawat ₱20 ticket</b> 🎉`;
                sendTelegramMessage(incomingChatId, welcomeReply);
              }
            }
          });
        }
      } catch (e) {}
      setTimeout(pollTelegramUpdates, 1000);
    });
  }).on("error", (e) => {
    setTimeout(pollTelegramUpdates, 3000);
  });
}

function checkDeviceBan(hardwareId) {
  if (!hardwareId) return null;
  const now = Date.now();

  if (bannedDevices.has(hardwareId)) {
    const record = bannedDevices.get(hardwareId);
    if (now < record.banUntil) return record;
    bannedDevices.delete(hardwareId);
  }
  return null;
}

function banDevice(hardwareId, reason, snapshot = null, durationMs = BAN_DURATION_7DAYS) {
  const finalId = String(hardwareId || "").trim();
  if (!finalId) return null;

  const banUntil = Date.now() + durationMs;
  const record = { banUntil, reason, snapshot, hardwareId: finalId };
  bannedDevices.set(finalId, record);
  return record;
}

/* ================= MATCHMAKING ENGINE ================= */
let waitingQueue = [];
const activePairs = new Map();

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(id => id !== socketId);
}

function matchUsers() {
  while (waitingQueue.length >= 2) {
    const user1Id = waitingQueue.shift();
    const user2Id = waitingQueue.shift();

    if (user1Id === user2Id) continue;

    const s1 = io.sockets.sockets.get(user1Id);
    const s2 = io.sockets.sockets.get(user2Id);

    if (s1 && s2 && s1.connected && s2.connected) {
      activePairs.set(user1Id, user2Id);
      activePairs.set(user2Id, user1Id);

      s1.emit("match", { initiator: true });
      s2.emit("match", { initiator: false });
    } else {
      if (s1 && s1.connected) waitingQueue.push(user1Id);
      if (s2 && s2.connected) waitingQueue.push(user2Id);
    }
  }
}

/* ================= SOCKET.IO EVENTS ================= */
io.on("connection", (socket) => {
  const hardwareId = String(socket.handshake.query.hardwareId || socket.handshake.query.deviceId || "").trim();

  io.emit("online-count", io.engine.clientsCount);

  // Strict Server Check
  const banInfo = checkDeviceBan(hardwareId);
  if (banInfo) {
    socket.emit("ip-banned", {
      banUntil: banInfo.banUntil,
      reason: banInfo.reason,
      snapshot: banInfo.snapshot
    });
  }

  socket.on("skip", () => {
    const currentBan = checkDeviceBan(hardwareId);
    if (currentBan) {
      return socket.emit("ip-banned", {
        banUntil: currentBan.banUntil,
        reason: currentBan.reason,
        snapshot: currentBan.snapshot
      });
    }

    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit("partner-disconnected");
        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }

    removeFromQueue(socket.id);
    waitingQueue.push(socket.id);
    socket.emit("waiting");

    matchUsers();
  });

  socket.on("signal", (data) => {
    const currentBan = checkDeviceBan(hardwareId);
    if (currentBan) return;

    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit("signal", data);
      }
    }
  });

  // REPORT USER
  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        const partnerHw = String(partner.handshake.query.hardwareId || partner.handshake.query.deviceId || partner.id).trim();
        const encounterSnapshot = data.snapshot || null;

        const record = banDevice(partnerHw, data.reason || "Policy Violation", encounterSnapshot, BAN_DURATION_7DAYS);

        partner.emit("ip-banned", {
          banUntil: record.banUntil,
          reason: record.reason,
          snapshot: record.snapshot
        });

        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }
    socket.emit("report-success");
  });

  // SUBMIT GCASH UNBAN TICKET
  socket.on("unban-request", (data) => {
    const ref = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const name = String(data.name || "Anonymous User").trim();
    const reqHardware = String(data.hardwareId || hardwareId).trim();

    if (!ref || ref.length < 8) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid Reference Number." });
    }

    const reqId = "req" + Math.floor(Math.random() * 900000 + 100000);
    pendingRequests.set(reqId, { hardwareId: reqHardware, ref, name, socketId: socket.id });

    // I-send sa Telegram mo na may [ 🟢 1-CLICK APPROVE ] at [ 🔴 REJECT ]
    sendTelegramNotification(reqId, name, ref);

    return socket.emit("unban-pending", {
      message: "⏳ Payment submitted! Waiting for Admin verification in Telegram..."
    });
  });

  socket.on("stop-search", () => {
    removeFromQueue(socket.id);
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit("partner-disconnected");
        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit("partner-disconnected");
        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }
    io.emit("online-count", io.engine.clientsCount);
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BIND TO 0.0.0.0 FOR RENDER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`🤖 Telegram 1-Click Inline Buttons: ACTIVE`);
  console.log(`📲 GCash SMS Receiver Webhook: READY`);
  console.log(`================================================`);
  pollTelegramUpdates();
});
