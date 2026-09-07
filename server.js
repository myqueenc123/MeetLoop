const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname));

// --- SERVER-SIDE IP BAN STORAGE ---
const bannedIPs = new Map(); // ip -> { banUntil, reason }
const ipStrikes = new Map(); // ip -> verified strike count

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

// 🔓 ADMIN UNBAN VIA URL
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
const matches = new Map(); // socket.id -> { partnerId, reported: boolean }

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

  // --- REPORT HANDLER (IKAW NA NAG-REPORT AY LIGTAS 100%) ---
  socket.on('report-user', (data) => {
    const match = matches.get(socket.id);
    if (!match || match.reported) return;
    match.reported = true; // Mark as reported

    const targetPartner = io.sockets.sockets.get(match.partnerId);
    if (!targetPartner) {
      findMatch();
      return;
    }

    // Ang targetPartner LAMANG ang paparusahan, HINDI ang nag-report!
    if (data.verified === true) {
      const targetIP = getClientIP(targetPartner);
      const strikes = (ipStrikes.get(targetIP) || 0) + 1;
      ipStrikes.set(targetIP, strikes);

      if (strikes >= 2) {
        const ONE_HOUR = 60 * 60 * 1000;
        const banUntil = Date.now() + ONE_HOUR;
        const reason = data.reason || "irrelevant image";

        bannedIPs.set(targetIP, { banUntil, reason });

        // Ipadala ang ban signal sa target partner LAMANG
        targetPartner.emit('ip-banned', { banUntil, reason });

        setTimeout(() => {
          targetPartner.disconnect(true);
        }, 400);
      }
    }

    // Ilipat agad ang nag-report sa ibang stranger
    leaveCurrentMatch();
    findMatch();
  });

  socket.on('disconnect', () => {
    leaveCurrentMatch();
    io.emit('online-count', io.engine.clientsCount);
  });
});

// Terminal unban: type "unban all"
process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'unban all') {
    bannedIPs.clear();
    ipStrikes.clear();
    console.log("✅ All IP Bans wiped!");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MeetloopChat Server running on port ${PORT}`);
});
