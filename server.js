/**
 * MeetLoop - Secure Production Server Backend
 * 100% Anti-Fraud Locked GCash Gateway + Admin Control Engine
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
const ADMIN_SECRET_KEY = "MEETLOOP2026"; // Ang iyong Secret Admin Password

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/* ================= BAN & STRICT GCASH DATABASE ================= */
const bannedDevices = new Map(); // hardwareId -> { banUntil, reason, snapshot }

// ITO ANG WHITELIST: Tanging ang mga Reference Codes lamang na nandito ang tatanggapin ng server!
const authorizedPaidReferences = new Set([
  "0029381726481", // Sample Approved Code
  "9981247856123", // Sample Approved Code
  "8887776665554"  // Sample Approved Code
]);

const usedGcashReferences = new Set();

/* ================= ADMIN INSTANT ADD-REFERENCE ROUTE ================= */
// Kapag may nagbayad sa GCash mo, i-open mo lang ito sa browser:
// https://meetloop.onrender.com/admin/add?secret=MEETLOOP2026&ref=ILAGAY_ANG_REF_NO_DITO
app.get("/admin/add", (req, res) => {
  const { secret, ref } = req.query;

  if (secret !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: "Unauthorized: Invalid Admin Secret Key." });
  }

  if (!ref || ref.trim().length < 6) {
    return res.status(400).json({ success: false, message: "Invalid Reference Number provided." });
  }

  const cleanRef = ref.trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  authorizedPaidReferences.add(cleanRef);

  return res.json({
    success: true,
    message: `Reference Code [${cleanRef}] has been APPROVED. User can now unban their device!`,
    total_active_approved_codes: authorizedPaidReferences.size
  });
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

/* ================= SOCKET EVENTS ================= */
io.on("connection", (socket) => {
  const hardwareId = socket.handshake.query.hardwareId || socket.handshake.query.deviceId;

  io.emit("online-count", io.engine.clientsCount);

  // Check ban upon connection
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

  // 100% LOCKED SERVER-SIDE GCASH UNBAN VALIDATION
  socket.on("unban-request", (data) => {
    const rawRef = String(data.ref || "").trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const reqHardware = data.hardwareId || hardwareId;

    // 1. Check kung nagamit na dati
    if (usedGcashReferences.has(rawRef)) {
      return socket.emit("unban-response", {
        success: false,
        message: "❌ This Reference Number has already been used/expired."
      });
    }

    // 2. Check kung APPROVED sa Admin Whitelist Database
    if (authorizedPaidReferences.has(rawRef)) {
      // Markahan bilang used at alisin sa active list (One-Time Use Only)
      usedGcashReferences.add(rawRef);
      authorizedPaidReferences.delete(rawRef);

      // Tanggalin ang ban
      if (reqHardware) bannedDevices.delete(reqHardware);

      return socket.emit("unban-response", {
        success: true,
        message: "✅ GCash Payment Verified! Your 7-day suspension has been lifted."
      });
    } else {
      // BAWAL ANG FAKE NUMBERS: Automatic Rejection
      return socket.emit("unban-response", {
        success: false,
        message: "❌ Payment not found. Please wait for verification or check your Reference No."
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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BIND TO 0.0.0.0 FOR RENDER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`🔒 100% Anti-Fraud Locked GCash Gateway: READY`);
  console.log(`================================================`);
});
