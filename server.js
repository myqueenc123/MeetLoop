const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Serve static files mula sa "public" folder (o root kung nandoon ang index.html)
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname));

// --- SERVER-SIDE IP BAN STORAGE ---
const bannedIPs = new Map(); // ip -> { banUntil: timestamp, reason: string }
const ipStrikes = new Map(); // ip -> number of verified violations

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

// 🔓 SECRET ADMIN HTTP UNBAN ENDPOINT
app.get('/admin/unban-my-ip', (req, res) => {
  const ip = getClientIP(req);
  bannedIPs.delete(ip);
  ipStrikes.delete(ip);
  console.log(`🔓 Admin URL Unbanned IP: ${ip}`);
  res.json({ status: "success", message: `IP ${ip} has been unbanned!` });
});

// 🛑 GLOBAL IP BAN INTERCEPTOR (Haharangan agad bago makakonekta)
io.use((socket, next) => {
  const ip = getClientIP(socket);
  const banRecord = bannedIPs.get(ip);

  if (banRecord) {
    if (banRecord.banUntil > Date.now()) {
      return next(new Error(`IP_BANNED:${banRecord.banUntil}:${encodeURIComponent(banRecord.reason)}`));
    } else {
      // Tapos na ang 1-Hour ban
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

  // 🔓 SECRET ADMIN SOCKET UNBAN (Galing sa Secret Tap sa Card)
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

  // --- OMETV VERIFIED REPORT HANDLER & 1-HOUR IP BAN ---
  socket.on('report-user', (data) => {
    const match = matches.get(socket.id);
    if (!match || match.reported) return;
    match.reported = true;

    const partner = io.sockets.sockets.get(match.partnerId);
    if (!partner) return;

    // Tanging verified violations lang ang bibilangin ng server (Anti-Troll)
    if (data.verified === true) {
      const partnerIP = getClientIP(partner);
      const strikes = (ipStrikes.get(partnerIP) || 0) + 1;
      ipStrikes.set(partnerIP, strikes);

      if (strikes >= 2) {
        const ONE_HOUR = 60 * 60 * 1000;
        const banUntil = Date.now() + ONE_HOUR;
        const reason = data.reason || "irrelevant image";

        // I-save ang ban sa Server Memory
        bannedIPs.set(partnerIP, { banUntil, reason });

        partner.emit('ip-banned', { banUntil, reason });

        setTimeout(() => {
          partner.disconnect(true);
        }, 300);
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

// 🔓 TERMINAL COMMAND PARA SA ADMIN ("unban all")
process.stdin.on('data', (data) => {
  const input = data.toString().trim();
  if (input === 'unban all') {
    bannedIPs.clear();
    ipStrikes.clear();
    console.log("✅ Server: All IP Bans have been wiped clean!");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MeetLoop Server running on port ${PORT}`);
  console.log(`💡 Tip: Type "unban all" in this console anytime to unban everyone.`);
});
