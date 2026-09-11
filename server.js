/**
 * MeetLoop - High-Performance WebRTC Backend Server
 * 100% Low Latency + Hardened Security + Anti-Bypass + Smart Report Engine
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const https = require("https");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_VALIDITY_WINDOW = 60 * 60 * 1000;
const REPORT_RESET_WINDOW = 24 * 60 * 60 * 1000; // 24 oras bago ma-reset ang report count

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8648356765:AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.text({ type: "*/*", limit: "15mb" }));

/* ================= DATABASES & SECURITY ================= */
const bannedDevices = new Map();           // HardwareID -> { banUntil, reason, snapshot, ip }
const bannedIPs = new Map();               // IP -> { banUntil, reason, hardwareId }
const userReports = new Map();             // HardwareID -> [{ by: reporterHw, reason: string, time: number }]
const persistentDeviceTickets = new Map(); // HardwareID -> { phone, ref, time }
let availablePayments = [];
const burnedReceipts = new Set();
const attemptTracker = new Map();

function getClientIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return socket.handshake.address || "0.0.0.0";
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sendTelegramRaw(endpoint, payloadObj, callback) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const payload = JSON.stringify(payloadObj);
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };
  const req = https.request(options, (res) => {
    let d = "";
    res.on("data", chunk => d += chunk);
    res.on("end", () => { if (callback) callback(null, d); });
  });
  req.on("error", (e) => {
    console.error("❌ Telegram API Error:", e.message);
    if (callback) callback(e);
  });
  req.write(payload);
  req.end();
}

function sendTelegramMessage(chatId, text) {
  sendTelegramRaw("sendMessage", { chat_id: chatId, text: text, parse_mode: "HTML", disable_web_page_preview: true });
}

function sendTelegramWithButtons(chatId, text, reqId) {
  sendTelegramRaw("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🟢 1-CLICK APPROVE", callback_data: `approve_${reqId}` },
          { text: "🔴 REJECT", callback_data: `reject_${reqId}` }
        ]
      ]
    }
  });
}

function executeUnbanUser(hardwareId, phone, auto = false) {
  // Kunin ang nakatali na IP para sabay ding ma-unban
  const banRecord = bannedDevices.get(hardwareId);
  if (banRecord && banRecord.ip) {
    bannedIPs.delete(banRecord.ip);
  }

  bannedDevices.delete(hardwareId);
  persistentDeviceTickets.delete(hardwareId);
  attemptTracker.delete(hardwareId);
  userReports.delete(hardwareId);

  io.emit("real-admin-unban-signal", { hardwareId: hardwareId });

  if (auto) {
    const successMsg = `⚡ <b>AUTO-UNBAN SUCCESSFUL!</b> 🎉\n\n` +
                       `📱 <b>Matched Mobile:</b> <code>${escapeHtml(phone)}</code>\n` +
                       `💳 <b>Hardware ID:</b> <code>${escapeHtml(hardwareId)}</code>\n` +
                       `💰 <b>Status:</b> GCash Verified & Cleared!`;
    sendTelegramMessage(ADMIN_CHAT_ID, successMsg);
  }
}

function isPhoneMatch(gcashText, userPhone) {
  if (!gcashText || !userPhone) return false;
  const cleanUser = String(userPhone).replace(/[^0-9]/g, "");
  if (!cleanUser || cleanUser.length < 7) return false;
  const user10Digit = cleanUser.slice(-10);
  return gcashText.includes(cleanUser) || gcashText.includes(user10Digit);
}

app.all("/webhook/gcash-sms", (req, res) => {
  let rawData = req.body;
  let parsedContent = "";
  let senderTitle = "GCash App";

  if (typeof rawData === "string") {
    try {
      const parsedJson = JSON.parse(rawData);
      parsedContent = parsedJson.content || parsedJson.message || rawData;
      senderTitle = parsedJson.from || senderTitle;
    } catch(e) { parsedContent = rawData; }
  } else if (typeof rawData === "object" && rawData !== null) {
    parsedContent = rawData.content || rawData.message || JSON.stringify(rawData);
    senderTitle = rawData.from || senderTitle;
  }

  const fullPayloadString = `${senderTitle} ${parsedContent}`.trim();
  const paymentId = "tx_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const now = Date.now();
  
  availablePayments = availablePayments.filter(p => (now - p.time < PAYMENT_VALIDITY_WINDOW));
  availablePayments.push({ id: paymentId, text: fullPayloadString, time: now });

  let autoUnbanned = false;
  for (const [hwId, ticket] of persistentDeviceTickets.entries()) {
    if (isPhoneMatch(fullPayloadString, ticket.phone) || (ticket.ref && ticket.ref.length >= 6 && fullPayloadString.includes(ticket.ref))) {
      availablePayments = availablePayments.filter(p => p.id !== paymentId);
      burnedReceipts.add(paymentId);
      executeUnbanUser(hwId, ticket.phone, true);
      autoUnbanned = true;
      break;
    }
  }

  if (!autoUnbanned) {
    sendTelegramMessage(ADMIN_CHAT_ID, `💰 <b>GCASH RECEIVED</b>\n<code>${escapeHtml(fullPayloadString)}</code>`);
  }

  res.status(200).json({ success: true });
});

app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

let lastUpdateId = 0;
function pollTelegramUpdates() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`;
  https.get(url, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (json.ok && Array.isArray(json.result)) {
          json.result.forEach((update) => {
            lastUpdateId = update.update_id;
            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = cb.data || "";
              if (cbData.startsWith("approve_")) {
                const hwId = cbData.replace("approve_", "");
                const ticket = persistentDeviceTickets.get(hwId);
                executeUnbanUser(hwId, ticket ? ticket.phone : "Manual", false);
                sendTelegramRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ User Unbanned!", show_alert: true });
              } else if (cbData.startsWith("reject_")) {
                const hwId = cbData.replace("reject_", "");
                persistentDeviceTickets.delete(hwId);
                sendTelegramRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Rejected!", show_alert: false });
              }
            }
          });
        }
      } catch(e){}
      setTimeout(pollTelegramUpdates, 1500);
    });
  }).on("error", () => { setTimeout(pollTelegramUpdates, 3000); });
}

// HARDENED SECURITY CHECK: DEVICE + IP BAN CHECK
function checkDeviceOrIpBan(hardwareId, clientIp) {
  const now = Date.now();

  // 1. Check Hardware ID
  if (hardwareId && bannedDevices.has(hardwareId)) {
    const record = bannedDevices.get(hardwareId);
    if (now < record.banUntil) return record;
    bannedDevices.delete(hardwareId);
    persistentDeviceTickets.delete(hardwareId);
  }

  // 2. Check Client IP
  if (clientIp && bannedIPs.has(clientIp)) {
    const record = bannedIPs.get(clientIp);
    if (now < record.banUntil) return record;
    bannedIPs.delete(clientIp);
  }

  return null;
}

function banDeviceAndIp(hardwareId, clientIp, reason, snapshot = null) {
  const finalId = String(hardwareId || "").trim();
  const banUntil = Date.now() + BAN_DURATION_7DAYS;
  const record = { banUntil, reason, snapshot, hardwareId: finalId, ip: clientIp };
  
  if (finalId) bannedDevices.set(finalId, record);
  if (clientIp && clientIp !== "0.0.0.0") bannedIPs.set(clientIp, record);

  return record;
}

let waitingQueue = [];
const activePairs = new Map();

function cleanupUserSession(socketId) {
  waitingQueue = waitingQueue.filter(id => id !== socketId);
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    io.to(partnerId).emit("partner-disconnected");
    activePairs.delete(partnerId);
  }
  activePairs.delete(socketId);
}

function matchUsers() {
  while (waitingQueue.length >= 2) {
    const user1Id = waitingQueue.shift();
    const user2Id = waitingQueue.shift();

    if (user1Id === user2Id) continue;

    const s1 = io.sockets.sockets.get(user1Id);
    const s2 = io.sockets.sockets.get(user2Id);

    if (s1?.connected && s2?.connected) {
      activePairs.set(user1Id, user2Id);
      activePairs.set(user2Id, user1Id);

      s1.emit("match", { initiator: true });
      s2.emit("match", { initiator: false });
    } else {
      if (s1?.connected) waitingQueue.push(user1Id);
      if (s2?.connected) waitingQueue.push(user2Id);
    }
  }
}

io.on("connection", (socket) => {
  const hardwareId = String(socket.handshake.query.hardwareId || socket.handshake.query.deviceId || "").trim();
  const clientIp = getClientIp(socket);

  io.emit("online-count", Math.max(1, io.engine.clientsCount));

  const banInfo = checkDeviceOrIpBan(hardwareId, clientIp);
  if (banInfo) {
    socket.emit("ip-banned", { banUntil: banInfo.banUntil, reason: banInfo.reason, snapshot: banInfo.snapshot });
  } else {
    socket.emit("real-admin-unban-signal", { hardwareId: hardwareId });
  }

  socket.on("check-ban-status", (data) => {
    const hwId = String(data?.hardwareId || hardwareId).trim();
    const b = checkDeviceOrIpBan(hwId, clientIp);
    if (!b) {
      socket.emit("real-admin-unban-signal", { hardwareId: hwId });
    } else {
      socket.emit("ip-banned", { banUntil: b.banUntil, reason: b.reason, snapshot: b.snapshot });
    }
  });

  socket.on("skip", () => {
    const currentBan = checkDeviceOrIpBan(hardwareId, clientIp);
    if (currentBan) {
      return socket.emit("ip-banned", { banUntil: currentBan.banUntil, reason: currentBan.reason, snapshot: currentBan.snapshot });
    }

    cleanupUserSession(socket.id);
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
    }
    socket.emit("waiting");
    matchUsers();
  });

  socket.on("signal", (data) => {
    const currentBan = checkDeviceOrIpBan(hardwareId, clientIp);
    if (currentBan) return;
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("signal", data);
    }
  });

  // 🚨 SMART REPORT ENGINE WITH 3-REPORT THRESHOLD
  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        const partnerHw = String(partner.handshake.query.hardwareId || partner.handshake.query.deviceId || partner.id).trim();
        const partnerIp = getClientIp(partner);
        const reason = data.reason || "Policy Violation";
        const snapshot = data.snapshot || null;
        const now = Date.now();

        // Linisin ang mga lumang report na lampas 24 hours na
        let reports = userReports.get(partnerHw) || [];
        reports = reports.filter(r => (now - r.time < REPORT_RESET_WINDOW));

        // Iwasan ang duplicate spam report mula sa iisang user
        const alreadyReported = reports.some(r => r.by === hardwareId);
        if (!alreadyReported) {
          reports.push({ by: hardwareId, reason: reason, time: now });
          userReports.set(partnerHw, reports);
        }

        const reportCount = reports.length;
        const isSevere = reason.includes("Nudity") || reason.includes("Underage") || reason.includes("Violence");
        const threshold = isSevere ? 2 : 3;

        console.log(`🚨 [REPORT LOGGED]: Target=${partnerHw}, Count=${reportCount}/${threshold}, Reason=${reason}`);

        // I-notify si Admin sa Telegram sa bawat report
        const reportAlert = `⚠️ <b>USER REPORT FILED (${reportCount}/${threshold})</b>\n\n` +
                            `🚨 <b>Reason:</b> ${escapeHtml(reason)}\n` +
                            `🆔 <b>Device:</b> <code>${escapeHtml(partnerHw)}</code>\n` +
                            `🌐 <b>IP:</b> <code>${escapeHtml(partnerIp)}</code>\n` +
                            `<i>${reportCount >= threshold ? "🛑 THRESHOLD REACHED: AUTO-BANNING FOR 7 DAYS!" : "Naka-log sa system. Hindi pa banned."}</i>`;
        sendTelegramMessage(ADMIN_CHAT_ID, reportAlert);

        // Kapag naabot ang 3 reports (o 2 reports sa nudity), i-BAN na siya!
        if (reportCount >= threshold) {
          const record = banDeviceAndIp(partnerHw, partnerIp, reason, snapshot);
          partner.emit("ip-banned", { banUntil: record.banUntil, reason: record.reason, snapshot: record.snapshot });
          userReports.delete(partnerHw);
        }

        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }
    socket.emit("report-success");
  });

  socket.on("unban-request", (data) => {
    const phone = String(data.phone || "").trim().replace(/[^0-9]/g, "");
    const ref = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const reqHardware = String(data.hardwareId || hardwareId).trim();

    if (!phone || phone.length < 10) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid 11-digit GCash Mobile Number." });
    }

    const now = Date.now();
    let matchedIndex = -1;

    for (let i = 0; i < availablePayments.length; i++) {
      const item = availablePayments[i];
      if ((now - item.time < PAYMENT_VALIDITY_WINDOW) && (isPhoneMatch(item.text, phone) || (ref && ref.length >= 6 && item.text.includes(ref)))) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex !== -1) {
      const matched = availablePayments[matchedIndex];
      availablePayments.splice(matchedIndex, 1);
      burnedReceipts.add(matched.id);
      executeUnbanUser(reqHardware, phone, true);
      return;
    }

    persistentDeviceTickets.set(reqHardware, { phone, ref, time: now });
    sendTelegramWithButtons(ADMIN_CHAT_ID, `🚨 <b>UNBAN REQUEST</b>\n📱 Mobile: <code>${escapeHtml(phone)}</code>\n💳 Ref: <code>${escapeHtml(ref || "N/A")}</code>\n🆔 HW: <code>${escapeHtml(reqHardware)}</code>`, reqHardware);

    socket.emit("unban-pending", { message: "⏳ Details submitted! Checking payment..." });
  });

  socket.on("stop-search", () => { cleanupUserSession(socket.id); });
  socket.on("disconnect", () => {
    cleanupUserSession(socket.id);
    io.emit("online-count", Math.max(1, io.engine.clientsCount));
  });
});

app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`🛡️ 3-Tier Smart Report Engine: ACTIVE`);
  console.log(`🔒 Anti-Bypass Device+IP Tracking: ACTIVE`);
  console.log(`================================================`);
  pollTelegramUpdates();
});
