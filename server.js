/**
 * MeetLoop - Official Production Server Backend
 * Complete Telegram Instant Approval + 7-Day Ban + WebRTC Signaling
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

// ==========================================
// 🤖 ANG IYONG OPISYAL NA TELEGRAM BOT TOKEN:
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || Buffer.from("ODY0ODM1Njc2NTpBQUdnbkVZOVc4VF9yV1VFazFEZ3hIUzQ4b05MT2hnMGQycw==", "base64").toString("utf-8");
let ADMIN_CHAT_ID = null; // Kusa itong kukunin kapag nag-chat ka ng /start sa @MeetLoop_bot!

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= BAN & PENDING DATABASE ================= */
const bannedDevices = new Map(); // hardwareId -> { banUntil, reason, snapshot }
const pendingRequests = new Map(); // reqId -> { hardwareId, ref, name, socketId }

// FUNCTION: Magpadala ng Alert sa Telegram mo kapag may nagbayad ng ₱20
function sendTelegramNotification(reqId, name, ref) {
  if (!ADMIN_CHAT_ID) {
    console.log("⚠️ Walang Admin Chat ID. Mag-chat muna ng /start sa @MeetLoop_bot");
    return;
  }

  const approveLink = `https://meetloop-om0m.onrender.com/admin/approve?id=${reqId}&secret=MEETLOOP2026`;

  const msgText = `🚨 *MEETLOOP ₱20 GCASH UNBAN REQUEST*\n\n` +
                  `👤 *Sender:* ${name}\n` +
                  `💳 *Ref No:* \`${ref}\`\n` +
                  `💰 *Amount:* ₱20 Support Payment\n\n` +
                  `👉 *Tingnan ang iyong GCash. Kung pumasok ang ₱20, i-click ang link sa ibaba para ma-unban agad siya:* \n\n` +
                  `${approveLink}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${ADMIN_CHAT_ID}&text=${encodeURIComponent(msgText)}&parse_mode=Markdown`;

  https.get(url, (res) => {}).on("error", (e) => {});
}

// AUTO-DETECT ADMIN CHAT ID POLLING
let lastUpdateId = 0;
function pollTelegramUpdates() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`;

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (json.ok && json.result.length > 0) {
          json.result.forEach((update) => {
            lastUpdateId = update.update_id;
            if (update.message && update.message.chat) {
              ADMIN_CHAT_ID = update.message.chat.id;
              console.log(`✅ [TELEGRAM CONNECTED] Admin Chat ID Auto-Detected: ${ADMIN_CHAT_ID}`);

              const replyUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${ADMIN_CHAT_ID}&text=${encodeURIComponent("✅ Connected to MeetLoop Server! Handa na akong magpadala ng ₱20 GCash Unban Alerts sa'yo.")}`;
              https.get(replyUrl, () => {});
            }
          });
        }
      } catch (err) {}
      setTimeout(pollTelegramUpdates, 3000);
    });
  }).on("error", () => {
    setTimeout(pollTelegramUpdates, 5000);
  });
}
pollTelegramUpdates();

// ==========================================
// 🔗 1-CLICK APPROVAL LINK MULA SA TELEGRAM
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

  // Tanggalin ang ban sa hardware ID ng user
  bannedDevices.delete(request.hardwareId);
  pendingRequests.delete(id);

  // Real-time unban signal papunta sa website ng user
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

  // REPORT USER: 7-Day suspension sa partner + reporter snapshot
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

  // SUBMIT GCASH UNBAN TICKET PARA SA TELEGRAM APPROVAL
  socket.on("unban-request", (data) => {
    const ref = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const name = String(data.name || "Anonymous User").trim();
    const reqHardware = data.hardwareId || hardwareId;

    if (!ref || ref.length < 8) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid Reference Number." });
    }

    const reqId = "req_" + Math.random().toString(36).substr(2, 9);
    pendingRequests.set(reqId, { hardwareId: reqHardware, ref, name, socketId: socket.id });

    // I-send agad ang alert sa Telegram mo!
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
  console.log(`📱 Telegram Instant Approval Gateway: ACTIVE`);
  console.log(`================================================`);
});
