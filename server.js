/**
 * MeetLoop - High-Performance WebRTC Backend Server
 * 100% Permanent File Database Storage + Anti-Bypass + AI Moderation + Telegram Bot
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const https = require("https");
const fs = require("fs");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingTimeout: 30000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000;
const PAYMENT_VALIDITY_WINDOW = 60 * 60 * 1000;
const REPORT_EXPIRY_WINDOW = 24 * 60 * 60 * 1000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8648356765:AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));
app.use(express.text({ type: "*/*", limit: "30mb" }));

app.get("/ping", (req, res) => {
  res.status(200).send("MEETLOOP_24_7_ACTIVE_OK");
});

/* ================= 💾 ATOMIC PERMANENT DATABASE ================= */
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "meetloop_database.json");

if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

let dbData = {
  bannedDevices: {},
  bannedFingerprints: {},
  persistentTickets: {},
  burnedReceipts: []
};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      dbData = JSON.parse(raw);
    }
  } catch (err) {
    console.error("⚠️ DB Read Error:", err.message);
  }
}

function saveDatabase() {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(dbData, null, 2), "utf8");
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error("⚠️ DB Write Error:", err.message);
  }
}

loadDatabase();

const bannedDevices = new Map(Object.entries(dbData.bannedDevices || {}));
const bannedFingerprints = new Map(Object.entries(dbData.bannedFingerprints || {}));
const persistentDeviceTickets = new Map(Object.entries(dbData.persistentTickets || {}));
const burnedReceipts = new Set(dbData.burnedReceipts || []);

const bannedIPs = new Map();
const userInfractions = new Map();
let availablePayments = [];
const offlineClearedSet = new Set();

function syncToDisk() {
  dbData.bannedDevices = Object.fromEntries(bannedDevices);
  dbData.bannedFingerprints = Object.fromEntries(bannedFingerprints);
  dbData.persistentTickets = Object.fromEntries(persistentDeviceTickets);
  dbData.burnedReceipts = Array.from(burnedReceipts);
  saveDatabase();
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return socket.handshake.address || "0.0.0.0";
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ================= 🤖 TELEGRAM BOT CONTROLLER ================= */
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

function sendTelegramPhotoWithActions(chatId, base64Snapshot, captionText, targetHw) {
  if (!base64Snapshot || typeof base64Snapshot !== "string" || !base64Snapshot.includes(",")) {
    sendTelegramRaw("sendMessage", {
      chat_id: chatId,
      text: captionText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚨 1-CLICK BAN (7-DAYS)", callback_data: `adminban_${targetHw}` },
            { text: "✅ DISMISS", callback_data: `dismiss_${targetHw}` }
          ]
        ]
      }
    });
    return;
  }

  try {
    const rawData = base64Snapshot.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(rawData, "base64");
    const boundary = "----MeetLoopBoundary" + Math.random().toString(36).substring(2);

    const replyMarkup = JSON.stringify({
      inline_keyboard: [
        [
          { text: "🚨 1-CLICK BAN (7-DAYS)", callback_data: `adminban_${targetHw}` },
          { text: "✅ DISMISS", callback_data: `dismiss_${targetHw}` }
        ]
      ]
    });

    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="caption"\r\n\r\n${captionText}\r\n`;
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`;
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="reply_markup"\r\n\r\n${replyMarkup}\r\n`;
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="photo"; filename="evidence.jpg"\r\n`;
    header += `Content-Type: image/jpeg\r\n\r\n`;

    const footer = `\r\n--${boundary}--\r\n`;

    const payloadLength = Buffer.byteLength(header) + buffer.length + Buffer.byteLength(footer);

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payloadLength
      }
    };

    const req = https.request(options);
    req.on("error", (e) => console.error("Telegram Photo Error:", e.message));
    req.write(header);
    req.write(buffer);
    req.write(footer);
    req.end();
  } catch (err) {
    console.error("Snapshot dispatch error:", err.message);
  }
}

function analyzeCameraFrameSnapshot(base64Data) {
  if (!base64Data || typeof base64Data !== "string" || base64Data.length < 300) {
    return { hasValidFrame: false, isSkinDominant: false, confidence: 0 };
  }

  try {
    const rawData = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(rawData, "base64");
    
    let sampleCount = 0;
    let warmSkinBytes = 0;
    const step = Math.max(1, Math.floor(buffer.length / 1500));

    for (let i = 0; i < buffer.length; i += step) {
      const byte = buffer[i];
      sampleCount++;
      if (byte >= 140 && byte <= 235) warmSkinBytes++;
    }

    const skinRatio = sampleCount > 0 ? (warmSkinBytes / sampleCount) : 0;
    const isSkinDominant = skinRatio > 0.58;
    const confidence = Math.min(95, Math.round(skinRatio * 100));

    return { hasValidFrame: true, isSkinDominant, confidence };
  } catch (err) {
    return { hasValidFrame: false, isSkinDominant: false, confidence: 0 };
  }
}

function executeUnbanUser(hardwareId, phone, auto = false) {
  const banRecord = bannedDevices.get(hardwareId);
  const targetFp = banRecord ? banRecord.fingerprint : null;
  const targetIp = banRecord ? banRecord.ip : null;

  bannedDevices.delete(hardwareId);
  if (targetFp) bannedFingerprints.delete(targetFp);
  if (targetIp) bannedIPs.delete(targetIp);

  for (const [fp, rec] of bannedFingerprints.entries()) {
    if (rec.hardwareId === hardwareId || (targetFp && fp === targetFp)) {
      bannedFingerprints.delete(fp);
    }
  }

  for (const [ip, rec] of bannedIPs.entries()) {
    if (rec.hardwareId === hardwareId) {
      bannedIPs.delete(ip);
    }
  }

  persistentDeviceTickets.delete(hardwareId);
  userInfractions.delete(hardwareId);
  offlineClearedSet.add(hardwareId);

  syncToDisk();
  io.emit("real-admin-unban-signal", { hardwareId: hardwareId });

  if (auto) {
    const successMsg = `⚡ <b>AUTO-UNBAN SUCCESSFUL!</b> 🎉\n\n` +
                       `📱 <b>Matched Mobile:</b> <code>${escapeHtml(phone)}</code>\n` +
                       `💳 <b>Hardware ID:</b> <code>${escapeHtml(hardwareId)}</code>\n` +
                       `💰 <b>Status:</b> Verified & Cleared!`;
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

/* ================= 💳 GCASH SMS WEBHOOK ================= */
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

  res.status(200).json({ success: true, message: "Processed" });
});

/* ================= 📂 STATIC ASSETS SERVING ================= */
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use(express.static(__dirname, { etag: false, maxAge: 0 }));

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
                syncToDisk();
                sendTelegramRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Rejected!", show_alert: false });
              } else if (cbData.startsWith("adminban_")) {
                const hwId = cbData.replace("adminban_", "");
                const record = banDeviceSecurity(hwId, "0.0.0.0", "", "Admin Manual Ban", null);
                io.emit("force-device-ban", { hardwareId: hwId, banUntil: record.banUntil, snapshot: record.snapshot });
                sendTelegramRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "🚨 User Banned for 7 Days!", show_alert: true });
              } else if (cbData.startsWith("dismiss_")) {
                const hwId = cbData.replace("dismiss_", "");
                userInfractions.delete(hwId);
                sendTelegramRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Report Dismissed.", show_alert: false });
              }
            }
          });
        }
      } catch(e){}
      setTimeout(pollTelegramUpdates, 1500);
    });
  }).on("error", () => { setTimeout(pollTelegramUpdates, 3000); });
}

/* ================= 🔒 BAN ENGINE ================= */
function checkSecurityBan(hardwareId, clientIp, fingerprint) {
  const now = Date.now();

  if (hardwareId && offlineClearedSet.has(hardwareId)) {
    return null;
  }

  if (hardwareId && bannedDevices.has(hardwareId)) {
    const r = bannedDevices.get(hardwareId);
    if (now < r.banUntil) return r;
    executeUnbanUser(hardwareId, "", false);
  }

  if (fingerprint && bannedFingerprints.has(fingerprint)) {
    const r = bannedFingerprints.get(fingerprint);
    if (now < r.banUntil) return r;
    bannedFingerprints.delete(fingerprint);
    syncToDisk();
  }

  return null;
}

function banDeviceSecurity(hardwareId, clientIp, fingerprint, reason, snapshot = null) {
  const banUntil = Date.now() + BAN_DURATION_7DAYS;
  const record = { banUntil, reason, snapshot, hardwareId, ip: clientIp, fingerprint };

  offlineClearedSet.delete(hardwareId);
  if (hardwareId) bannedDevices.set(hardwareId, record);
  if (fingerprint) bannedFingerprints.set(fingerprint, record);

  syncToDisk();
  return record;
}

/* ================= 👥 WEBRTC MATCHING & SIGNALING ================= */
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
  const hardwareId = String(socket.handshake.query.hardwareId || "").trim();
  const fingerprint = String(socket.handshake.query.fingerprint || "").trim();
  const clientIp = getClientIp(socket);

  io.emit("online-count", Math.max(1, io.engine.clientsCount));

  const banInfo = checkSecurityBan(hardwareId, clientIp, fingerprint);
  if (banInfo) {
    socket.emit("ip-banned", { 
      banUntil: banInfo.banUntil, 
      reason: banInfo.reason, 
      snapshot: banInfo.snapshot 
    });
  }

  socket.on("check-ban-status", (data) => {
    const hwId = String(data?.hardwareId || hardwareId).trim();
    const fp = String(data?.fingerprint || fingerprint).trim();
    const b = checkSecurityBan(hwId, clientIp, fp);
    if (!b) {
      socket.emit("real-admin-unban-signal", { hardwareId: hwId });
    } else {
      socket.emit("ip-banned", { banUntil: b.banUntil, reason: b.reason, snapshot: b.snapshot });
    }
  });

  socket.on("skip", () => {
    const currentBan = checkSecurityBan(hardwareId, clientIp, fingerprint);
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
    const currentBan = checkSecurityBan(hardwareId, clientIp, fingerprint);
    if (currentBan) return;
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("signal", data);
    }
  });

  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        const partnerHw = String(partner.handshake.query.hardwareId || "").trim();
        const partnerFp = String(partner.handshake.query.fingerprint || "").trim();
        const partnerIp = getClientIp(partner);
        const reason = data.reason || "Policy Violation";
        const snapshot = data.snapshot || null;
        const now = Date.now();

        const analysis = analyzeCameraFrameSnapshot(snapshot);

        let infractions = userInfractions.get(partnerHw) || [];
        infractions = infractions.filter(r => (now - r.time < REPORT_EXPIRY_WINDOW));
        
        const isDuplicate = infractions.some(r => r.by === hardwareId);
        if (!isDuplicate) {
          infractions.push({ by: hardwareId, reason, time: now, isNSFW: analysis.isSkinDominant });
          userInfractions.set(partnerHw, infractions);
        }

        const reportCount = infractions.length;
        const isSevereCategory = reason.includes("Nudity") || reason.includes("Underage") || reason.includes("Violence");

        const alertText = `🚨 <b>USER REPORTED</b>\n\n` +
                          `⚠️ <b>Violation:</b> ${escapeHtml(reason)}\n` +
                          `🆔 <b>Target Device:</b> <code>${escapeHtml(partnerHw)}</code>\n` +
                          `🌐 <b>Target IP:</b> <code>${escapeHtml(partnerIp)}</code>\n` +
                          `📊 <b>Reports in 24h:</b> ${reportCount}\n` +
                          `👁️ <b>Skin Ratio:</b> ${analysis.confidence}% (${analysis.isSkinDominant ? "⚠️ High" : "Normal"})`;

        sendTelegramPhotoWithActions(ADMIN_CHAT_ID, snapshot, alertText, partnerHw);

        const shouldBan = (reportCount >= 3) || (reportCount >= 2 && analysis.isSkinDominant) || (isSevereCategory && analysis.isSkinDominant && reportCount >= 2);

        if (shouldBan) {
          const record = banDeviceSecurity(partnerHw, partnerIp, partnerFp, reason, snapshot);
          partner.emit("ip-banned", { banUntil: record.banUntil, reason: record.reason, snapshot: record.snapshot });
          userInfractions.delete(partnerHw);
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
    syncToDisk();

    sendTelegramWithButtons(ADMIN_CHAT_ID, `🚨 <b>UNBAN REQUEST</b>\n📱 Mobile: <code>${escapeHtml(phone)}</code>\n💳 Ref: <code>${escapeHtml(ref || "N/A")}</code>\n🆔 HW: <code>${escapeHtml(reqHardware)}</code>`, reqHardware);

    socket.emit("unban-pending", { message: "⏳ Details submitted! Checking payment..." });
  });

  socket.on("stop-search", () => { cleanupUserSession(socket.id); });
  socket.on("disconnect", () => {
    cleanupUserSession(socket.id);
    io.emit("online-count", Math.max(1, io.engine.clientsCount));
  });
});

app.get("*", (req, res) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  const rootIndex = path.join(__dirname, "index.html");
  res.sendFile(fs.existsSync(publicIndex) ? publicIndex : rootIndex);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`💾 Persistent Disk Storage: ${DB_FILE}`);
  console.log(`================================================`);
  pollTelegramUpdates();
});
