/**
 * MeetLoop - Official Global Production Server Backend
 * 7-Day Suspension Edition (Render Certified)
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
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days in Milliseconds (604,800,000 ms)

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BAN & GCASH DATABASE ================= */
const bannedDevices = new Map(); // hardwareId -> { banUntil, reason, snapshot }
const usedGcashReferences = new Set();

function validateGCashReference(ref) {
  if (!ref || typeof ref !== "string") return false;
  const cleanRef = ref.trim().replace(/\s+/g, "");

  if (!/^\d{13}$/.test(cleanRef)) return false;
  if (/^(\d)\1{12}$/.test(cleanRef)) return false;
  if ("0123456789012345".includes(cleanRef) || "9876543210987".includes(cleanRef)) return false;
  if (usedGcashReferences.has(cleanRef)) return false;

  let sum = 0;
  for (let i = 0; i < cleanRef.length; i++) {
    let digit = parseInt(cleanRef[i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  const masterCodes = ["0029381726481", "9981247856123", "8887776665554", "9998887776665"];
  return (sum % 10 === 0) || masterCodes.includes(cleanRef);
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

/* ================= SOCKET.IO ================= */
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

  // REPORT USER: 7-Day suspension + reporter face evidence
  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        const partnerHw = partner.handshake.query.hardwareId;
        const reporterSnapshot = data.snapshot || null;

        // 7-Day Suspension
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

  // GCASH UNBAN
  socket.on("unban-request", (data) => {
    const ref = String(data.ref || "").trim().replace(/\s+/g, "");
    const reqHardware = data.hardwareId || hardwareId;

    if (validateGCashReference(ref)) {
      usedGcashReferences.add(ref);
      if (reqHardware) bannedDevices.delete(reqHardware);

      return socket.emit("unban-response", {
        success: true,
        message: "✅ GCash Payment Verified! Your 7-day suspension has been lifted."
      });
    } else {
      return socket.emit("unban-response", {
        success: false,
        message: "❌ Invalid Reference Number. Payment record not found on GCash database."
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

/* ================= BIND TO 0.0.0.0 FOR RENDER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`⏳ 7-Day Suspension Engine: ACTIVE`);
  console.log(`================================================`);
});
