const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname));

// 🔐 ADMIN PASSCODE (Para sa secure manual unban)
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY || "meetloop_admin_9988";

// --- BAN & STRIKES STORAGE (Keyed by Device ID + Fallback IP) ---
const bannedEntities = new Map(); // entityKey -> { banUntil, reason }
const entityStrikes = new Map();  // entityKey -> strikes count

// --- GCASH ANTI-CHEAT ENGINE ---
const approvedGcashReceipts = new Set();
const usedGcashReferences = new Set();

function getClientIP(reqOrSocket) {
  const headers = reqOrSocket.headers || reqOrSocket.handshake?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return reqOrSocket.connection?.remoteAddress || 
         reqOrSocket.socket?.remoteAddress || 
         reqOrSocket.handshake?.address || 
         "127.0.0.1";
}

function getEntityKey(reqOrSocket) {
  const query = reqOrSocket.query || reqOrSocket.handshake?.query || {};
  const deviceId = query.deviceId || reqOrSocket.headers?.['x-device-id'];
  const ip = getClientIP(reqOrSocket);
  // Proteksyon sa Same-WiFi test: Gumagamit ng persistent device ID para hindi madamay ang reporter
  return deviceId ? `dev_${deviceId}` : `ip_${ip}`;
}

// 💰 GCASH UNBAN VERIFICATION ENDPOINT
app.post('/api/verify-gcash-unban', (req, res) => {
  const entityKey = getEntityKey(req);
  const { refNumber } = req.body || {};

  if (!refNumber) {
    return res.status(400).json({ success: false, message: "Please enter your GCash Reference Number." });
  }

  const cleanRef = refNumber.toString().replace(/\s+/g, '').trim();

  // Validate reference length (Standard GCash 10-16 digits)
  if (!/^\d{10,16}$/.test(cleanRef)) {
    return res.status(400).json({ success: false, message: "Invalid Reference format. Must be 10-16 digits." });
  }

  // Anti-Replay: Bawal i-recycle ang nagamit na resibo
  if (usedGcashReferences.has(cleanRef)) {
    return res.status(400).json({ success: false, message: "This Reference Number has already been used." });
  }

  // Anti-Cheat: HINDI na gagana ang random numbers; kailangan nasa approved list
  if (!approvedGcashReceipts.has(cleanRef)) {
    return res.status(400).json({ 
      success: false, 
      message: "Reference number not found or payment not yet received. Please confirm you sent ₱20." 
    });
  }

  approvedGcashReceipts.delete(cleanRef);
  usedGcashReferences.add(cleanRef);

  bannedEntities.delete(entityKey);
  entityStrikes.delete(entityKey);

  console.log(`✅ [GCASH PAYMENT VERIFIED] Unbanned: ${entityKey} | Ref: ${cleanRef}`);
  return res.json({ success: true, message: "Payment verified successfully! Your account is now unbanned." });
});

// 🔓 PROTECTED ADMIN UNBAN ENDPOINT
app.post('/admin/unban-my-ip', (req, res) => {
  const { adminKey } = req.body || {};
  if (adminKey !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: "Invalid Admin Passcode." });
  }

  const entityKey = getEntityKey(req);
  bannedEntities.delete(entityKey);
  entityStrikes.delete(entityKey);

  console.log(`🔓 Admin Unbanned: ${entityKey}`);
  return res.json({ success: true, message: `Account has been unbanned by admin.` });
});

// 🛑 SERVER CONNECTION BAN INTERCEPTOR
io.use((socket, next) => {
  const entityKey = getEntityKey(socket);
  const banRecord = bannedEntities.get(entityKey);

  if (banRecord) {
    if (banRecord.banUntil > Date.now()) {
      return next(new Error(`IP_BANNED:${banRecord.banUntil}:${encodeURIComponent(banRecord.reason)}`));
    } else {
      bannedEntities.delete(entityKey);
      entityStrikes.delete(entityKey);
    }
  }
  next();
});

let waitingQueue = [];
const matches = new Map();

io.on('connection', (socket) => {
  io.emit('online-count', io.engine.clientsCount);

  function leaveCurrentMatch() {
    waitingQueue = waitingQueue.filter(id => id !== socket.id);
    const match = matches.get(socket.id);
    if (match) {
      const partner = io.sockets.sockets.get(match.partnerId);
      if (partner) {
        partner.emit('partner-disconnected');
        matches.delete(match.partnerId);
      }
      matches.delete(socket.id);
    }
  }

  function findMatch() {
    leaveCurrentMatch();
    waitingQueue = waitingQueue.filter(id => id !== socket.id && io.sockets.sockets.has(id));

    if (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      const partner = io.sockets.sockets.get(partnerId);

      if (partner) {
        matches.set(socket.id, { partnerId, reported: false });
        matches.set(partnerId, { partnerId: socket.id, reported: false });

        socket.emit('match', { initiator: true });
        partner.emit('match', { initiator: false });
      } else {
        waitingQueue.push(socket.id);
        socket.emit('waiting');
      }
    } else {
      waitingQueue.push(socket.id);
      socket.emit('waiting');
    }
  }

  socket.on('skip', findMatch);
  socket.on('stop-search', leaveCurrentMatch);

  socket.on('signal', (data) => {
    const match = matches.get(socket.id);
    if (match && match.partnerId) {
      io.to(match.partnerId).emit('signal', data);
    }
  });

  // 🛑 REPORT HANDLER: TARGET KAUSAP LANG ANG MABABAN!
  socket.on('report-user', (data) => {
    const match = matches.get(socket.id);
    if (!match || match.reported) return;
    match.reported = true;

    const targetPartner = io.sockets.sockets.get(match.partnerId);
    if (!targetPartner) {
      leaveCurrentMatch();
      findMatch();
      return;
    }

    if (data.verified === true) {
      const targetEntity = getEntityKey(targetPartner);
      const strikes = (entityStrikes.get(targetEntity) || 0) + 1;
      entityStrikes.set(targetEntity, strikes);

      if (strikes >= 2) {
        const ONE_HOUR = 60 * 60 * 1000;
        const banUntil = Date.now() + ONE_HOUR;
        const reason = data.reason || "irrelevant image";

        bannedEntities.set(targetEntity, { banUntil, reason });
        targetPartner.emit('ip-banned', { banUntil, reason });

        setTimeout(() => {
          targetPartner.disconnect(true);
        }, 400);
      }
    }

    leaveCurrentMatch();
    findMatch();
  });

  socket.on('disconnect', () => {
    leaveCurrentMatch();
    io.emit('online-count', io.engine.clientsCount);
  });
});

// 💻 TERMINAL COMMANDS (Direct controls via Server Console)
process.stdin.on('data', (data) => {
  const cmd = data.toString().trim();

  if (cmd.startsWith('add ref ')) {
    const ref = cmd.replace('add ref ', '').trim();
    if (ref) {
      approvedGcashReceipts.add(ref);
      console.log(`✅ [ADMIN] Added Valid GCash Ref: ${ref}`);
    }
  } else if (cmd === 'unban all') {
    bannedEntities.clear();
    entityStrikes.clear();
    usedGcashReferences.clear();
    console.log("✅ All Bans and receipt caches wiped clean!");
  } else if (cmd === 'list bans') {
    console.log("Current Bans:", Array.from(bannedEntities.entries()));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MeetloopChat Server running on port ${PORT}`);
  console.log(`💡 Para mag-approve ng GCash bayad, i-type sa terminal: add ref <reference_number>`);
});
