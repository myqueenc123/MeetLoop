/**
 * MeetLoop - Production Server Backend (Render Ready)
 * Fixed: Isolated Hardware Ban (No Self-Ban), Real User Count & Snapshot Persistence
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 20000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BAN DATABASE (HARDWARE ISOLATED) ================= */
// Key: HardwareId -> { banUntil, reason, snapshot }
const bannedDevices = new Map();
const usedGcashReferences = new Set();

function checkDeviceBan(hardwareId) {
  if (!hardwareId) return null;
  const now = Date.now();
  if (bannedDevices.has(hardwareId)) {
    const record = bannedDevices.get(hardwareId);
    if (now < record.banUntil) return record;
    bannedDevices.delete(hardwareId); // Expired
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

/* ================= MATCHMAKING QUEUE ================= */
let waitingQueue = [];
const activePairs = new Map(); // socket.id -> partnerSocket.id

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(id => id !== socketId);
}

function matchUsers() {
  while (waitingQueue.length >= 2) {
    const user1Id = waitingQueue.shift();
    const user2Id = waitingQueue.shift();

    const socket1 = io.sockets.sockets.get(user1Id);
    const socket2 = io.sockets.sockets.get(user2Id);

    if (socket1 && socket2) {
      activePairs.set(user1Id, user2Id);
      activePairs.set(user2Id, user1Id);

      socket1.emit("match", { initiator: true });
      socket2.emit("match", { initiator: false });
    } else {
      if (socket1) waitingQueue.push(user1Id);
      if (socket2) waitingQueue.push(user2Id);
    }
  }
}

/* ================= SOCKET.IO ================= */
io.on("connection", (socket) => {
  const hardwareId = socket.handshake.query.hardwareId || socket.handshake.query.deviceId;

  // Real-time broadcast ng totoong bilang ng online users
  io.emit("online-count", io.engine.clientsCount);

  // Check kung banned ang device
  const banInfo = checkDeviceBan(hardwareId);
  if (banInfo) {
    socket.emit("ip-banned", {
      banUntil: banInfo.banUntil,
      reason: banInfo.reason,
      snapshot: banInfo.snapshot
    });
  }

  // START / NEXT
  socket.on("skip", () => {
    const currentBan = checkDeviceBan(hardwareId);
    if (currentBan) {
      return socket.emit("ip-banned", {
        banUntil: currentBan.banUntil,
        reason: currentBan.reason,
        snapshot: currentBan.snapshot
      });
    }

    const oldPartnerId = activePairs.get(socket.id);
    if (oldPartnerId) {
      const oldPartner = io.sockets.sockets.get(oldPartnerId);
      if (oldPartner) {
        oldPartner.emit("partner-disconnected");
        activePairs.delete(oldPartnerId);
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
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.emit("signal", data);
    }
  });

  // REPORT SYSTEM (Targeted ONLY to Partner - No Self Ban)
  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        const partnerHardwareId = partnerSocket.handshake.query.hardwareId;
        const snapshot = data.snapshot || null;

        // I-ban LAMANG ang partner hardware ID
        const banRecord = banDevice(partnerHardwareId, data.reason || "Inappropriate behavior / policy", snapshot);

        partnerSocket.emit("ip-banned", {
          banUntil: banRecord.banUntil,
          reason: banRecord.reason,
          snapshot: banRecord.snapshot
        });

        activePairs.delete(partnerId);
        partnerSocket.disconnect(true);
      }
      activePairs.delete(socket.id);
    }
    // Hindi ibaban ang reporter; hahayaan siyang magpatuloy
    socket.emit("report-success");
  });

  // GCASH UNBAN
  socket.on("unban-request", (data) => {
    const ref = String(data.ref || "").trim();
    const reqHardware = data.hardwareId || hardwareId;

    if (ref && ref.length === 13 && !usedGcashReferences.has(ref)) {
      usedGcashReferences.add(ref);
      if (reqHardware) bannedDevices.delete(reqHardware);
      socket.emit("unban-success", { success: true });
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

server.listen(PORT, () => {
  console.log(`🚀 MeetLoop Server is RUNNING on port ${PORT}`);
});
