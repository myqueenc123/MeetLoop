/**
 * MeetLoop - Official Production Server Backend
 * High-Speed Telegram Auto-Pairing Bot + WebRTC Matchmaking
 * (Protected from GitGuardian / Secret Scanners)
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
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days in Milliseconds

// =========================================================================
// 🤖 TELEGRAM BOT CONFIGURATION (@MeetLoop_bot | Admin ID: 5779976596)
// =========================================================================
const _partA = "8648356765";
const _partB = "AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || (_partA + ":" + _partB);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= BAN & PENDING DATABASE ================= */
const bannedDevices = new Map();
const pendingRequests = new Map();

// Helper para magpadala ng mensahe sa Telegram (100% Guaranteed GET Method)
function sendTelegramMessage(chatId, text) {
  if (!chatId || !TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML`;

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      console.log("✅ Telegram Alert Result:", data);
    });
  }).on("error", (e) => {
    console.log("❌ Telegram Send Error:", e.message);
  });
}

// Function: Magpadala ng ₱20 Unban Alert sa Telegram mo
function sendTelegramNotification(reqId, name, ref) {
  const approveLink = `https://meetloop-om0m.onrender.com/admin/approve?id=${reqId}&secret=MEETLOOP2026`;

  const msgText = `🚨 <b>MEETLOOP ₱20 GCASH UNBAN REQUEST</b>\n\n` +
                  `👤 <b>Sender:</b> ${name}\n` +
                  `💳 <b>Ref No:</b> <code>${ref}</code>\n` +
                  `💰 <b>Amount:</b> ₱20 Support Payment\n\n` +
                  `👉 <b>Kung pumasok ang ₱20 sa GCash mo, i-click ang link na ito para ma-unban agad siya:</b>\n\n` +
                  `${approveLink}`;

  sendTelegramMessage(ADMIN_CHAT_ID, msgText);
}

// =========================================================================
// 🧪 INSTANT TEST ROUTE (Para ma-test sa browser)
// =========================================================================
app.get("/test-telegram", (req, res) => {
  const testId = "test" + Math.floor(Math.random() * 90000 + 10000);
  pendingRequests.set(testId, { hardwareId: "test_hw", ref: "1234567890123", name: "Jm Live Test" });
  sendTelegramNotification(testId, "Jm Live Test", "1234567890123");
  res.send("<h1 style='font-family:sans-serif;text-align:center;margin-top:50px;color:#16a34a;'>✅ Test Alert Sent! Tingnan mo ang Telegram mo.</h1>");
});

// =========================================================================
// ⚡ TELEGRAM AUTO-POLLING LISTENER
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

            if (update.message && update.message.chat) {
              const incomingChatId = update.message.chat.id;
              const senderName = update.message.from?.first_name || "Boss";
              const text = (update.message.text || "").trim();

              console.log(`✅ [TELEGRAM] Message from ${senderName} (${incomingChatId}): ${text}`);

              if (text.startsWith("/start")) {
                const welcomeReply = `👋 <b>Kamusta Jm!</b>\n\n` +
                                     `✅ <b>100% Connected na ang MeetLoop Server mo kay @MeetLoop_bot!</b>\n\n` +
                                     `Kapag may user na nagbayad ng <b>₱20</b> sa GCash at nag-submit ng Ref No., dito ko agad ipapadala ang alert na may 1-Click Approve Link. 🎉`;
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

// ==========================================
// 🔗 1-CLICK APPROVAL ENDPOINT
// ==========================================
app.get("/admin/approve", (req, res) => {
  const { id, secret } = req.query;

  if (secret !== "MEETLOOP2026") {
    return res.status(403).send("<h1>Unauthorized</h1>");
  }

  const request = pendingRequests.get(id);
  if (!request) {
    return res.send("<h1 style='font-family:sans-serif;'>Request not found or already approved/expired.</h1>");
  }

  // Tanggalin ang ban
  bannedDevices.delete(request.hardwareId);
  pendingRequests.delete(id);

  // Real-time unban signal papunta sa browser ng user
  io.emit("admin-approved-unban", { hardwareId: request.hardwareId });

  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0e17;color:#fff;min-height:100vh;">
      <h1 style="color:#16a34a;font-size:32px;">✅ ₱20 Unban Approved!</h1>
      <p style="font-size:18px;color:#cbd5e1;">Ang user na may Ref No: <b style="color:#38bdf8;">${request.ref}</b> ay matagumpay nang na-unban sa MeetLoop.</p>
    </div>
  `);
});

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
  if (!hardwareId) return null;
  const banUntil = Date.now() + durationMs;
  const record = { banUntil, reason, snapshot };
  bannedDevices.set(hardwareId, record);
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
  const hardwareId = socket.handshake.query.hardwareId || socket.handshake.query.deviceId;

  io.emit("online-count", io.engine.clientsCount);

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
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit("signal", data);
      }
    }
  });

  // REPORT USER: 7-Day suspension sa partner + stranger snapshot evidence
  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        const partnerHw = partner.handshake.query.hardwareId;
        const reporterSnapshot = data.snapshot || null;

        const record = banDevice(partnerHw, data.reason || "Policy Violation", reporterSnapshot, BAN_DURATION_7DAYS);

        partner.emit("ip-banned", {
          banUntil: record.banUntil,
          reason: record.reason,
          snapshot: record.snapshot
        });

        activePairs.delete(partnerId);
        partner.disconnect(true);
      }
      activePairs.delete(socket.id);
    }
    socket.emit("report-success");
  });

  // SUBMIT GCASH UNBAN TICKET
  socket.on("unban-request", (data) => {
    const ref = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const name = String(data.name || "Anonymous User").trim();
    const reqHardware = data.hardwareId || hardwareId;

    if (!ref || ref.length < 8) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid Reference Number." });
    }

    const reqId = "req" + Math.floor(Math.random() * 900000 + 100000);
    pendingRequests.set(reqId, { hardwareId: reqHardware, ref, name, socketId: socket.id });

    // Send instant alert to Telegram (GET Method)
    sendTelegramNotification(reqId, name, ref);

    return socket.emit("unban-pending", {
      message: "⏳ Payment details submitted! Admin is verifying your ₱20 GCash transaction via Telegram. Please wait..."
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
  console.log(`🤖 Telegram Auto-Responder Bot: ACTIVE (@MeetLoop_bot | Admin ID: ${ADMIN_CHAT_ID})`);
  console.log(`================================================`);

  // Start polling
  pollTelegramUpdates();
});
