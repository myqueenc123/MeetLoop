/**
 * MeetLoop - Production Server Backend
 * Real GCash SMS Auto-Sync Gateway + WebRTC Matchmaking
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days
const WEBHOOK_SECRET = "MEETLOOP_SECURE_KEY_2026"; // Secret key para sa SMS forwarder

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= REAL GCASH TRANSACTION DATABASE ================= */
const bannedDevices = new Map(); // hardwareId -> { banUntil, reason, snapshot }
const realPaidTransactions = new Set(); // Dito pumapasok ang mga TOTOONG bayad galing sa GCash SMS mo!
const usedGcashReferences = new Set(); // Mga nagamit nang resibo

// =========================================================================
// 📲 AUTOMATIC GCASH SMS WEBHOOK RECEIVER (Galing sa Cellphone mo)
// Kapag may nag-send sa GCash mo, kusa itong ipapasa ng phone mo dito:
// =========================================================================
app.post("/api/gcash-sms-webhook", (req, res) => {
  const { secret, message, ref } = req.body;

  // Security Check
  if (secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ success: false, message: "Unauthorized webhook request." });
  }

  let extractedRef = ref;

  // Kung buong SMS text ang ipinadala ng app, kukunin ng server ang Ref. No.
  if (message && !extractedRef) {
    const match = message.match(/Ref(?:erence)?\.?\s*(?:No\.?)?\s*[:.]?\s*([0-9]{10,16})/i);
    if (match) extractedRef = match[1];
  }

  if (extractedRef) {
    const cleanRef = extractedRef.trim().replace(/[^0-9]/g, "");
    realPaidTransactions.add(cleanRef);
    console.log(`💰 [GCash Real Payment Received] Ref No: ${cleanRef}`);

    return res.json({
      success: true,
      message: `Transaction ${cleanRef} verified and logged into server memory.`,
      active_paid_codes: realPaidTransactions.size
    });
  }

  return res.status(400).json({ success: false, message: "No valid reference number found in SMS." });
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

  // Check 7-day ban upon connection
  const banInfo = checkDeviceBan(hardwareId);
  if (banInfo) {
    socket.emit("ip-banned", {
      banUntil: banInfo.banUntil,
      reason: banInfo.reason,
      snapshot: banInfo.snapshot
    });
  }

  // SEARCH / SKIP
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

  // WebRTC SIGNALING
  socket.on("signal", (data) => {
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

  // =========================================================================
  // 🔒 STRICT VERIFICATION: Tanging ang nasa Real GCash Transactions lang ang tatanggapin!
  // =========================================================================
  socket.on("unban-request", (data) => {
    const cleanRef = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const reqHardware = data.hardwareId || hardwareId;

    // 1. Bawal kung nagamit na dati
    if (usedGcashReferences.has(cleanRef)) {
      return socket.emit("unban-response", {
        success: false,
        message: "❌ This Reference Number has already been used/claimed."
      });
    }

    // 2. Suriin kung pumasok talaga ang bayad sa GCash account mo
    const isRealPaid = realPaidTransactions.has(cleanRef);

    if (isRealPaid) {
      // Markahan bilang nagamit na
      usedGcashReferences.add(cleanRef);
      realPaidTransactions.delete(cleanRef);

      // Tanggalin ang ban
      if (reqHardware) bannedDevices.delete(reqHardware);

      return socket.emit("unban-response", {
        success: true,
        message: "✅ Real GCash Payment Confirmed! 7-day suspension lifted."
      });
    } else {
      // BUMAGSAK: Walang natanggap na bayad sa totoong GCash mo na may ganitong Reference Number
      return socket.emit("unban-response", {
        success: false,
        message: "❌ Payment not found. We have not received any payment with this Reference Number on our GCash account."
      });
    }
  });

  // STOP
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

  // DISCONNECT
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
  console.log(`🚀 MeetLoop Real GCash Server LIVE on port ${PORT}`);
  console.log(`📱 SMS Webhook Endpoint: /api/gcash-sms-webhook`);
  console.log(`================================================`);
});
