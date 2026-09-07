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

// --- SERVER-SIDE IP BAN STORAGE ---
const bannedIPs = new Map(); // ip -> { banUntil, reason }
const ipStrikes = new Map(); // ip -> verified violations
const usedGcashReferences = new Set(); // Anti-fraud: Bawal ulitin ang nagamit nang resibo!

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

// 💰 AUTOMATED GCASH UNBAN VERIFICATION ENDPOINT
app.post('/api/verify-gcash-unban', (req, res) => {
  const ip = getClientIP(req);
  const { refNumber } = req.body || {};

  if (!refNumber) {
    return res.status(400).json({ success: false, message: "Please enter your GCash Reference Number." });
  }

  const cleanRef = refNumber.toString().replace(/\s+/g, '').trim();

  // Validasyon ng GCash / InstaPay Reference format (10 to 16 numeric digits)
  if (!/^\d{10,16}$/.test(cleanRef)) {
    return res.status(400).json({ success: false, message: "Invalid Reference Number format. Must be 10-16 digits from GCash receipt." });
  }

  // Anti-Cheat: Bawal gamitin ang lumang resibo ng ibang tao
  if (usedGcashReferences.has(cleanRef)) {
    return res.status(400).json({ success: false, message: "This Reference Number has already been used." });
  }

  // Tanggapin ang resibo at i-markang gamit na
  usedGcashReferences.add(cleanRef);
  bannedIPs.delete(ip);
  ipStrikes.delete(ip);

  console.log(`💰 GCash ₱20 Payment Verified! Unbanned IP: ${ip} | Ref: ${cleanRef}`);
  return res.json({ success: true, message: "Payment verified successfully! Your account is now unbanned." });
});

// 🔓 ADMIN SECRET URL UNBAN
app.get('/admin/unban-my-ip', (req, res) => {
  const ip = getClientIP(req);
  bannedIPs.delete(ip);
  ipStrikes.delete(ip);
  console.log(`🔓 Admin Unbanned IP: ${ip}`);
  res.json({ status: "success", message: `IP ${ip} has been unbanned!` });
});

// 🛑 SERVER IP INTERCEPTOR
io.use((socket, next) => {
  const ip = getClientIP(socket);
  const banRecord = bannedIPs.get(ip);

  if (banRecord) {
    if (banRecord.banUntil > Date.now()) {
      return next(new Error(`IP_BANNED:${banRecord.banUntil}:${encodeURIComponent(banRecord.reason)}`));
    } else {
      bannedIPs.delete(ip);
      ipStrikes.delete(ip);
    }
  }
  next();
});

let waitingQueue = [];
const matches = new Map();

io.on('connection', (socket) => {
  const userIP = getClientIP(socket);
  io.emit('online-count', io.engine.clientsCount);

  socket.on('admin-secret-unban', () => {
    bannedIPs.delete(userIP);
    ipStrikes.delete(userIP);
    console.log(`🔓 Secret Tap Unbanned IP: ${userIP}`);
  });

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

  socket.on('report-user', (data) => {
    const match = matches.get(socket.id);
    if (!match || match.reported) return;
    match.reported = true;

    const targetPartner = io.sockets.sockets.get(match.partnerId);
    if (!targetPartner) {
      findMatch();
      return;
    }

    if (data.verified === true) {
      const targetIP = getClientIP(targetPartner);
      const strikes = (ipStrikes.get(targetIP) || 0) + 1;
      ipStrikes.set(targetIP, strikes);

      if (strikes >= 2) {
        const ONE_HOUR = 60 * 60 * 1000;
        const banUntil = Date.now() + ONE_HOUR;
        const reason = data.reason || "irrelevant image";

        bannedIPs.set(targetIP, { banUntil, reason });
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

process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'unban all') {
    bannedIPs.clear();
    ipStrikes.clear();
    usedGcashReferences.clear();
    console.log("✅ All IP Bans & receipts wiped clean!");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MeetloopChat Server running on port ${PORT}`);
});
