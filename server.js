/**
 * MeetLoop - Official Server Backend
 * Node.js + Express + Socket.IO
 * Features: Hardware ID + IP Multi-Layer Ban Engine, GCash Unban Sync & WebRTC Signaling
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 30000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;

// I-serve ang static frontend files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Main route kung iisang file lang ang gamit mo (hal. index.html)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ================= SERVER-SIDE BAN DATABASE ================= */
// Iniimbak ang ban records sa memory (Pwede ring i-connect sa MongoDB/Redis kung kinakailangan)
const bannedEntities = new Map(); // Key: IP o Hardware ID -> { banUntil, reason }
const usedGcashReferences = new Set(); // Iniimbak ang mga nagamit nang GCash reference numbers

// Helper para makuha ang tunay na IP ng user (Kahit nasa likod ng Cloudflare / Proxy)
function getClientIp(socket) {
  const headers = socket.handshake.headers;
  const cfIp = headers["cf-connecting-ip"];
  const forwarded = headers["x-forwarded-for"];
  if (cfIp) return cfIp;
  if (forwarded) return forwarded.split(",")[0].trim();
  return socket.handshake.address || socket.conn.remoteAddress;
}

// Helper para suriin kung banned ang user
function checkIsBanned(ip, hardwareId) {
  const now = Date.now();

  // 1. Check IP Ban
  if (bannedEntities.has(ip)) {
    const record = bannedEntities.get(ip);
    if (now < record.banUntil) return record;
    bannedEntities.delete(ip); // Expired na ang ban
  }

  // 2. Check Hardware Fingerprint Ban
  if (hardwareId && bannedEntities.has(hardwareId)) {
    const record = bannedEntities.get(hardwareId);
    if (now < record.banUntil) return record;
    bannedEntities.delete(hardwareId); // Expired na ang ban
  }

  return null;
}

// Helper para i-ban ang user (5 minuto standard cooldown)
function applyBan(ip, hardwareId, reason = "Violation of Community Rules", durationMs = 5 * 60 * 1000) {
  const banUntil = Date.now() + durationMs;
  const record = { banUntil, reason };

  if (ip) bannedEntities.set(ip, record);
  if (hardwareId) bannedEntities.set(hardwareId, record);

  return record;
}

/* ================= MATCHMAKING QUEUE & ROOMS ================= */
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

/* ================= SOCKET.IO CONNECTION ================= */
io.on("connection", (socket) => {
  const clientIp = getClientIp(socket);
  const hardwareId = socket.handshake.query.hardwareId || socket.handshake.query.deviceId;

  // I-broadcast ang live online counter
  io.emit("online-count", io.engine.clientsCount);

  // 1. Mahigpit na pagsusuri kung Banned ang IP o Hardware ID sa pagpasok pa lang
  const banStatus = checkIsBanned(clientIp, hardwareId);
  if (banStatus) {
    socket.emit("ip-banned", {
      banUntil: banStatus.banUntil,
      reason: banStatus.reason
    });
  }

  // 2. Simulan ang Paghahanap (Skip / Start)
  socket.on("skip", () => {
    // Siguraduhing hindi banned bago payagang maghanap
    const currentBan = checkIsBanned(clientIp, hardwareId);
    if (currentBan) {
      return socket.emit("ip-banned", { banUntil: currentBan.banUntil, reason: currentBan.reason });
    }

    // Tanggalin sa dating partner kung mayroon man
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

  // 3. WebRTC Signaling (Offer, Answer, ICE Candidate)
  socket.on("signal", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("signal", data);
      }
    }
  });

  // 4. Report System (Awtomatikong bina-ban ang kausap sa Server)
  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        const partnerIp = getClientIp(partnerSocket);
        const partnerHw = partnerSocket.handshake.query.hardwareId;

        // Server-Side permanent ban sa partner
        const banRecord = applyBan(partnerIp, partnerHw, data.reason || "Reported for inappropriate behavior");
        
        partnerSocket.emit("ip-banned", {
          banUntil: banRecord.banUntil,
          reason: banRecord.reason
        });

        // Putulin ang koneksyon ng partner
        activePairs.delete(partnerId);
        partnerSocket.disconnect(true);
      }
      activePairs.delete(socket.id);
    }
  });

  // 5. GCash Unban Verification mula sa Client
  socket.on("unban-request", (data) => {
    const ref = String(data.ref || "").trim();
    const reqHardware = data.hardwareId || hardwareId;

    if (ref && ref.length === 13 && !usedGcashReferences.has(ref)) {
      usedGcashReferences.add(ref);

      // Burahin ang ban sa Server Database
      bannedEntities.delete(clientIp);
      if (reqHardware) bannedEntities.delete(reqHardware);

      socket.emit("unban-success", { success: true });
    }
  });

  // 6. Stop Search
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

  // 7. Disconnect Handler
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

/* ================= START SERVER ================= */
server.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`🚀 MeetLoop Server is RUNNING on port ${PORT}`);
  console.log(`🛡️ Hardware & IP Security Engine: ACTIVE`);
  console.log(`💳 GCash Instant Unban Gateway: READY`);
  console.log(`===========================================`);
});
