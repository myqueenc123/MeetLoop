/**
 * MeetLoop - Official Production Server Backend
 * High-Speed Telegram Auto-Pairing Bot + WebRTC Matchmaking
 * (Single-Tab Enforced + Anti-Bypass Security)
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

// Helper para magpadala ng alert sa Telegram
function sendTelegramMessage(chatId, text) {
  if (!chatId || !TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=HTML&disable_web_page_preview=true`;

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
  }).on("error", (e) => {
    console.log("❌ Telegram Send Error:", e.message);
  });
}

// Function: Magpadala ng ₱20 Unban Alert sa Telegram mo
function sendTelegramNotification(reqId, name, ref) {
  const approveLink = `https://meetloop-om0m.onrender.com/admin/approve?id=${reqId}&secret=MEETLOOP2026`;

  const msgText = `🚨 <b>MEETLOOP ₱20 GCASH UNBAN REQUEST</b>\n\n` +
                  `👤 <b>Sender Name:</b> ${name}\n` +
                  `💳 <b>GCash Ref No:</b> <code>${ref}</code>\n` +
                  `💰 <b>Amount:</b> ₱20 Support Payment\n\n` +
                  `👉 <b>Kung pumasok ang ₱20 sa GCash mo, i-click ang link na ito para buksan ang Approval Portal:</b>\n\n` +
                  `${approveLink}`;

  sendTelegramMessage(ADMIN_CHAT_ID, msgText);
}

// ==========================================
// 🔒 ADMIN CONFIRMATION PORTAL
// ==========================================
app.get("/admin/approve", (req, res) => {
  const { id, secret } = req.query;

  if (secret !== "MEETLOOP2026") {
    return res.status(403).send("<h1>Unauthorized</h1>");
  }

  const request = pendingRequests.get(id);
  if (!request) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0e17;color:#fff;min-height:100vh;">
        <h1 style="color:#ef4444;">⚠️ Ticket Not Found or Already Handled</h1>
        <p style="color:#94a3b8;">Baka na-approve na ito dati o nag-expire na.</p>
      </div>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>MeetLoop Admin - Unban Approval</title>
      <style>
        body{background:#0a0e17;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;}
        .card{background:#111827;border:1.5px solid #1f293d;border-radius:20px;max-width:420px;width:100%;padding:24px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.8);}
        .title{font-size:20px;font-weight:900;color:#38bdf8;margin-bottom:16px;}
        .info-box{background:#070b14;border:1px solid #1f293d;border-radius:12px;padding:14px;text-align:left;font-size:13px;line-height:1.7;margin-bottom:20px;}
        .btn-confirm{width:100%;height:50px;border:0;border-radius:12px;background:#16a34a;color:#fff;font-size:15px;font-weight:900;cursor:pointer;box-shadow:0 4px 15px rgba(22,163,74,0.4);}
        .btn-confirm:hover{background:#15803d;}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="title">MeetLoop Admin Verification</div>
        <div class="info-box">
          <div>👤 <b>Sender Name:</b> <span style="color:#38bdf8;">${request.name}</span></div>
          <div>💳 <b>GCash Ref No:</b> <code style="color:#facc15;font-size:14px;">${request.ref}</code></div>
          <div>💰 <b>Amount:</b> <b>₱20.00 GCash</b></div>
          <div>📱 <b>Device ID:</b> <span style="color:#94a3b8;font-size:11px;">${request.hardwareId}</span></div>
        </div>
        <form method="POST" action="/admin/confirm-unban">
          <input type="hidden" name="id" value="${id}">
          <input type="hidden" name="secret" value="MEETLOOP2026">
          <button type="submit" class="btn-confirm">✅ CONFIRM & UNBAN USER NOW</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// POST ACTION: Confirm Unban
app.post("/admin/confirm-unban", (req, res) => {
  const { id, secret } = req.body;

  if (secret !== "MEETLOOP2026") {
    return res.status(403).send("<h1>Unauthorized</h1>");
  }

  const request = pendingRequests.get(id);
  if (!request) {
    return res.send("<h1 style='font-family:sans-serif;text-align:center;margin-top:50px;color:#fff;background:#0a0e17;min-height:100vh;'>⚠️ Request already processed.</h1>");
  }

  // TANGGALIN ANG BAN
  bannedDevices.delete(request.hardwareId);
  pendingRequests.delete(id);

  // REAL UNBAN SIGNAL TO CLIENT
  io.emit("real-admin-unban-signal", { hardwareId: request.hardwareId });

  res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:50px;background:#0a0e17;color:#fff;min-height:100vh;">
      <h1 style="color:#16a34a;font-size:32px;">🎉 Unban Approved!</h1>
      <p style="font-size:18px;color:#cbd5e1;">The user with Ref No: <b style="color:#38bdf8;">${request.ref}</b> has been successfully unbanned.</p>
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

    // Send notification to JM's Telegram
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
  console.log(`🤖 Telegram Admin Bot: ACTIVE (@MeetLoop_bot)`);
  console.log(`🛡️ Single-Tab & Anti-Cheat Engine: LOCKED`);
  console.log(`================================================`);
});
