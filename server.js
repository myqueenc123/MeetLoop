const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// --- PERMANENT / SERVER-SIDE IP BAN STORAGE ---
// Hinding-hindi ito mabubura kahit mag-clear cookies o site data ang user!
const bannedIPs = new Map(); // ip -> { banUntil: timestamp, reason: string }
const ipStrikes = new Map(); // ip -> number ng verified reports

function getClientIP(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || socket.conn.remoteAddress;
}

// 🛑 SERVER-SIDE GATEKEEPER: Haharangin agad bago pa makapag-connect!
io.use((socket, next) => {
  const ip = getClientIP(socket);
  const banRecord = bannedIPs.get(ip);

  if (banRecord) {
    if (banRecord.banUntil > Date.now()) {
      // BANNED PA RIN ANG IP!
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
const matches = new Map();

io.on('connection', (socket) => {
  const userIP = getClientIP(socket);
  io.emit('online-count', io.engine.clientsCount);

  // Padalhan ang client ng signal na ligtas ang IP niya
  socket.emit('ip-verified');

  function leaveCurrent() {
    waitingQueue = waitingQueue.filter(id => id !== socket.id);
    const m = matches.get(socket.id);
    if (m) {
      const partner = io.sockets.sockets.get(m.partnerId);
      if (partner) {
        partner.emit('partner-disconnected');
        matches.delete(m.partnerId);
      }
      matches.delete(socket.id);
    }
  }

  function findMatch() {
    leaveCurrent();
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
  socket.on('stop-search', leaveCurrent);

  socket.on('signal', (data) => {
    const m = matches.get(socket.id);
    if (m && m.partnerId) {
      io.to(m.partnerId).emit('signal', data);
    }
  });

  // --- OMETV VERIFIED REPORT & IP BAN TRIGGER ---
  socket.on('report-user', (data) => {
    const m = matches.get(socket.id);
    if (!m || m.reported) return;
    m.reported = true;

    const partner = io.sockets.sockets.get(m.partnerId);
    if (!partner) return;

    // Tanging verified violations lang ang bibilangin ng server (Anti-Troll)
    if (data.verified === true) {
      const partnerIP = getClientIP(partner);
      const strikes = (ipStrikes.get(partnerIP) || 0) + 1;
      ipStrikes.set(partnerIP, strikes);

      if (strikes >= 2) {
        const ONE_HOUR = 60 * 60 * 1000;
        const banUntil = Date.now() + ONE_HOUR;

        // I-SAVE SA SERVER MEMORY ANG IP
        bannedIPs.set(partnerIP, {
          banUntil: banUntil,
          reason: data.reason || "Rule Violation"
        });

        partner.emit('ip-banned', {
          banUntil: banUntil,
          reason: data.reason || "Rule Violation"
        });

        setTimeout(() => {
          partner.disconnect(true);
        }, 300);
      }
    }

    leaveCurrent();
    findMatch();
  });

  socket.on('disconnect', () => {
    leaveCurrent();
    io.emit('online-count', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MeetLoop Server running on port ${PORT}`));
