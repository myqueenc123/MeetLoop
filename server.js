/**
 * MeetLoop - Production Server Backend
 * Casino Plus / Top-Up Style Instant GCash Unban Gateway
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
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days in Milliseconds

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BAN & GCASH TOP-UP DATABASE ================= */
const bannedDevices = new Map(); // hardwareId -> { banUntil, reason, snapshot }
const usedGcashReferences = new Set(); // Stores already claimed references

// CASINO PLUS STYLE INSTANT REFERENCE VALIDATOR
function validateTopUpReference(ref) {
  if (!ref || typeof ref !== "string") return { valid: false, message: "Please enter a valid Reference Number." };
  
  // Linisin ang input (alisin ang spaces, dashes, etc.)
  const cleanRef = ref.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

  // 1. Minimum length check (Lahat ng GCash/InstaPay/QRPH refs ay nasa 8 hanggang 20 characters)
  if (cleanRef.length < 8 || cleanRef.length > 20) {
    return { valid: false, message: "❌ Invalid Reference Number length. Please check your receipt." };
  }

  // 2. Anti-Spam: Bawal ang puro parehong numero (hal. 00000000 o 11111111)
  if (/^(\w)\1+$/.test(cleanRef)) {
    return { valid: false, message: "❌ Invalid Reference Number. System detected dummy input." };
  }

  // 3. One-Time Use Check: Bawal gamitin ulit ang nagamit nang resibo
  if (usedGcashReferences.has(cleanRef)) {
    return { valid: false, message: "❌ This Reference Number has already been claimed/used." };
  }

  return { valid: true, cleanRef };
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
  if (!hardwareId) return null;
  const banUntil = Date.now() + durationMs;
  const record = { banUntil, reason, snapshot };
  bannedDevices.set(hardwareId, record);
  return record;
}

/* ================= MATCHMAKING ENGINE ================= */
let waitingQueue = [];
const activePairs = new Map(); // socket.id -> partnerSocket.id

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

        // 7-Day Suspension sa violator
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

  // CASINO-STYLE INSTANT UNBAN TOP-UP GATEWAY
  socket.on("unban-request", (data) => {
    const rawRef = data.ref || "";
    const reqHardware = data.hardwareId || hardwareId;

    const validation = validateTopUpReference(rawRef);

    if (validation.valid) {
      // Markahan ang reference bilang used para hindi maulit
      usedGcashReferences.add(validation.cleanRef);

      // Tanggalin ang ban record sa server
      if (reqHardware) bannedDevices.delete(reqHardware);

      return socket.emit("unban-response", {
        success: true,
        message: "✅ GCash Payment Verified! Unban clearance approved."
      });
    } else {
      return socket.emit("unban-response", {
        success: false,
        message: validation.message
      });
    }
  });

  // STOP SEARCH
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

/* ================= BIND TO 0.0.0.0 FOR RENDER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`🎰 Casino-Style GCash Top-Up Unban: READY`);
  console.log(`================================================`);
});
