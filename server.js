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

// 🔐 PALITAN MO ITO NG SARILI MONG SECRET PASSWORD
const ADMIN_SECRET_KEY = process.env.ADMIN_KEY || "meetloop_admin_9988";

// --- SERVER-SIDE IP BAN STORAGE ---
const bannedIPs = new Map(); // ip -> { banUntil, reason }
const ipStrikes = new Map(); // ip -> verified violations

// 💰 GCASH ANTI-FRAUD ENGINE
// Dito papasok ang mga totoong resibo na natanggap mo sa GCash mo:
const approvedGcashReceipts = new Set([
  // Halimbawa: puwede kang maglagay dito nang manual, o gamitin ang terminal command sa baba:
  // "1002938475812"
]);
const usedGcashReferences = new Set(); // Bawal gamitin ulit ang nagamit na

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

// 💰 SECURE GCASH UNBAN VERIFICATION (HINDI NA GAGANA ANG RANDOM NUMBER!)
app.post('/api/verify-gcash-unban', (req, res) => {
  const ip = getClientIP(req);
  const { refNumber } = req.body || {};

  if (!refNumber) {
    return res.status(400).json({ success: false, message: "Please enter your GCash Reference Number." });
  }

  const cleanRef = refNumber.toString().replace(/\s+/g, '').trim();

  // 1. Format check
  if (!/^\d{10,16}$/.test(cleanRef)) {
    return res.status(400).json({ success: false, message: "Invalid Reference Number format. Must be 10-16 digits." });
  }

  // 2. Anti-Replay: Check kung nagamit na
  if (usedGcashReferences.has(cleanRef)) {
    return res.status(400).json({ success: false, message: "This Reference Number has already been claimed." });
  }

  // 3. STRICT CHECK: Dapat nasa approved list ng binayaran sa GCash
  if (!approvedGcashReceipts.has(cleanRef)) {
    return res.status(400).json({ 
      success: false, 
      message: "Reference number not found or payment not yet received. Please ensure you sent ₱20." 
    });
  }

  // Kapag verified at totoo:
  approvedGcashReceipts.delete(cleanRef);
  usedGcashReferences.add(cleanRef);

  bannedIPs.delete(ip);
  ipStrikes.delete(ip);

  console.log(`✅ [GCASH UNBAN] Legitimate payment confirmed! IP: ${ip} | Ref: ${cleanRef}`);
  return res.json({ success: true, message: "Payment verified successfully! Your account is now unbanned." });
});

// 🔓 PROTECTED ADMIN UNBAN (Nangangailangan na ng Admin Key)
app.post('/admin/unban-my-ip', (req, res) => {
  const { adminKey } = req.body || {};
  if (adminKey !== ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, message: "Invalid Admin Passcode." });
  }

  const ip = getClientIP(req);
  bannedIPs.delete(ip);
  ipStrikes.delete(ip);
  console.log(`🔓 Admin Unbanned IP: ${ip}`);
  return res.json({ success: true, message: `IP ${ip} has been unbanned by admin.` });
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

  // Inalis ang unauthenticated socket admin bypass

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

// 💻 TERMINAL COMMANDS (Puwede kang mag-input sa console habang tumatakbo ang server)
process.stdin.on('data', (data) => {
  const cmd = data.toString().trim();

  // 1. Kapag may nagbayad sa GCash mo, i-type mo lang: add ref 1002938475812
  if (cmd.startsWith('add ref ')) {
    const ref = cmd.replace('add ref ', '').trim();
    if (ref) {
      approvedGcashReceipts.add(ref);
      console.log(`✅ [ADMIN] Added valid GCash Ref: ${ref}. Ready for unban!`);
    }
  }
  // 2. I-unban lahat ng bans
  else if (cmd === 'unban all') {
    bannedIPs.clear();
    ipStrikes.clear();
    usedGcashReferences.clear();
    console.log("✅ All IP Bans & receipts wiped clean!");
  }
  // 3. I-check ang mga active bans
  else if (cmd === 'list bans') {
    console.log("Active Bans:", Array.from(bannedIPs.entries()));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MeetloopChat Server running on port ${PORT}`);
  console.log(`💡 Tip: Kapag may nagbayad sa GCash mo, i-type sa terminal: add ref <reference_number>`);
});
