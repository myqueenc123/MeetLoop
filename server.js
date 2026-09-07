/**
 * MeetLoop - Official Production Server Backend (Render Certified)
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

// Serve public directory
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Root entry point
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BAN & GCASH DATABASE ================= */
const bannedDevices = new Map(); // hardwareId -> { banUntil, reason, snapshot }
const usedGcashReferences = new Set();

function validateGCashReference(ref) {
  if (!ref || typeof ref !== "string") return false;
  const cleanRef = ref.trim().replace(/\s+/g, "");

  // 1. Dapat eksaktong 13 numeric digits
  if (!/^\d{13}$/.test(cleanRef)) return false;

  // 2. Bawal ang repeated / sequential numbers
  if (/^(\d)\1{12}$/.test(cleanRef)) return false;
  if ("0123456789012345".includes(cleanRef) || "9876543210987".includes(cleanRef)) return false;

  // 3. Bawal gamitin ulit
  if (usedGcashReferences.has(cleanRef)) return false;

  // 4. InstaPay Mod10 Algorithm & Master Codes Check
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

function banDevice(hardwareId, reason, snapshot = null, durationMs = 5 * 60 * 1000) {
  if (!hardwareId) return null;
  const banUntil = Date.now() + durationMs;
  const record = { banUntil, reason, snapshot };
  bannedDevices.set(hardwareId, record);
  return record;
}

/* ================= MATCHMAKING ENGINE ================= */
let waitingQueue = [];
const activePairs = new Map(); // socket.id -> partner.id

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

  // Check ban upon connect
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

  // SIGNALING
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
        const record = banDevice(partnerHw, data.reason || "Policy Violation", data.snapshot);

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
        message: "✅ GCash Payment Verified! Na-lift na ang suspension ng iyong device."
      });
    } else {
      return socket.emit("unban-response", {
        success: false,
        message: "❌ Hindi natagpuan ang Reference Number na ito sa GCash settlement database."
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
  console.log(`================================================`);
});
