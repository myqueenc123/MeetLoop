/**
 * MeetLoop - Production Server Backend
 * Universal SMS Webhook Receiver + WebRTC Matchmaking
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
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days in ms

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= REAL GCASH DATABASE ================= */
const bannedDevices = new Map();
const realPaidTransactions = new Set([
  "4044808505649", // Pre-approved your reference code
  "0029381726481"
]);
const usedGcashReferences = new Set();

// =========================================================================
// 📲 UNIVERSAL GCASH SMS WEBHOOK (Tumatanggap ng kahit anong app format)
// =========================================================================
app.all("/api/gcash-sms-webhook", (req, res) => {
  // Kunin ang message mula sa kahit anong field (body, query, o JSON)
  const message = req.body?.message || req.query?.message || req.body?.content || req.body?.msg || req.body?.sms || JSON.stringify(req.body);
  const directRef = req.body?.ref || req.query?.ref;

  let extractedRef = directRef;

  // Hanapin ang 10-16 digit Reference Number sa text
  if (message && !extractedRef) {
    const match = String(message).match(/Ref(?:erence)?\.?\s*(?:No\.?)?\s*[:.]?\s*([0-9]{10,16})/i) || String(message).match(/([0-9]{10,16})/);
    if (match) extractedRef = match[1];
  }

  if (extractedRef) {
    const cleanRef = String(extractedRef).trim().replace(/[^0-9]/g, "");
    realPaidTransactions.add(cleanRef);
    console.log(`💰 [GCASH REAL SMS RECEIVED] Ref No: ${cleanRef}`);
    return res.status(200).json({ success: true, message: "Transaction logged successfully!", ref: cleanRef });
  }

  // Laging ibalik ang 200 OK para maging SUCCESS ang test ng app
  return res.status(200).json({ success: true, message: "Webhook active and ready!" });
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

  // STRICT GCASH UNBAN
  socket.on("unban-request", (data) => {
    const cleanRef = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const reqHardware = data.hardwareId || hardwareId;

    if (usedGcashReferences.has(cleanRef)) {
      return socket.emit("unban-response", {
        success: false,
        message: "❌ This Reference Number has already been used/claimed."
      });
    }

    // Tanggapin kapag natanggap sa SMS ng phone mo o kasama sa listahan
    if (realPaidTransactions.has(cleanRef)) {
      usedGcashReferences.add(cleanRef);
      realPaidTransactions.delete(cleanRef);

      if (reqHardware) bannedDevices.delete(reqHardware);

      return socket.emit("unban-response", {
        success: true,
        message: "✅ Real GCash Payment Confirmed! 7-day suspension lifted."
      });
    } else {
      return socket.emit("unban-response", {
        success: false,
        message: "❌ Payment not found. No matching transaction received on our GCash account."
      });
    }
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
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
});
