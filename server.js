/**
 * MeetLoop - High-Performance WebRTC Backend Server
 * DUAL-BOT ARCHITECTURE:
 *  1. Admin Control Bot (Reports, 1-Click Ban, 1-Click Approve, GCash Alerts)
 *  2. Customer Support Bot (Public Tickets, User Chats, Receipt Submissions)
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
const UNBAN_SUBMIT_COOLDOWN = 5 * 1000;

/* ================= 🤖 DUAL-BOT CONFIGURATION ================= */
// 🔴 BOT 1 (ADMIN CONTROL): Para sa bans, reports, at unban approvals
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "8648356765:AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

// 🔵 BOT 2 (SUPPORT BOT): Para sa customer inquiries & ticket submissions
// (Kung wala ka pang 2nd token, gagamitin muna nito ang default bot token)
const SUPPORT_BOT_TOKEN = process.env.SUPPORT_BOT_TOKEN || ADMIN_BOT_TOKEN;

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
const unbanRequestCooldowns = new Map();
const snapshotCache = new Map();

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

/* ================= 🤖 BOT 1: ADMIN CONTROL SENDER ================= */
function sendTelegramAdminRaw(endpoint, payloadObj, callback) {
  if (!ADMIN_BOT_TOKEN) return;
  const payload = JSON.stringify(payloadObj);
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${ADMIN_BOT_TOKEN}/${endpoint}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };
  const req = https.request(options, (res) => {
    let d = "";
    res.on("data", chunk => d += chunk);
    res.on("end", () => {
      try {
        const json = JSON.parse(d);
        if (!json.ok) console.error(`❌ Admin Bot API Error [${endpoint}]:`, json.description);
      } catch(e){}
      if (callback) callback(null, d);
    });
  });
  req.on("error", (e) => {
    console.error("❌ Admin Bot Network Error:", e.message);
    if (callback) callback(e);
  });
  req.write(payload);
  req.end();
}

function sendTelegramAdminMessage(chatId, text) {
  sendTelegramAdminRaw("sendMessage", { chat_id: String(chatId).trim(), text: text, parse_mode: "HTML", disable_web_page_preview: true });
}

function sendTelegramWithButtons(chatId, text, hardwareId) {
  const cleanId = String(hardwareId || "").trim();
  sendTelegramAdminRaw("sendMessage", {
    chat_id: String(chatId).trim(),
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🟢 1-CLICK APPROVE", callback_data: `ap:${cleanId}` },
          { text: "🔴 REJECT", callback_data: `rj:${cleanId}` }
        ]
      ]
    }
  });
}

function sendTelegramPhotoWithActions(chatId, base64Snapshot, captionText, targetHw) {
  const cleanId = String(targetHw || "").trim();
  if (base64Snapshot) {
    snapshotCache.set(cleanId, base64Snapshot);
  }

  const replyMarkup = JSON.stringify({
    inline_keyboard: [
      [
        { text: "🚨 1-CLICK BAN (7-DAYS)", callback_data: `ab:${cleanId}` },
        { text: "✅ DISMISS", callback_data: `ds:${cleanId}` }
      ]
    ]
  });

  if (!base64Snapshot || typeof base64Snapshot !== "string" || !base64Snapshot.includes(",")) {
    sendTelegramAdminRaw("sendMessage", {
      chat_id: String(chatId).trim(),
      text: captionText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: JSON.parse(replyMarkup)
    });
    return;
  }

  try {
    const rawData = base64Snapshot.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(rawData, "base64");
    const boundary = "----MeetLoopBoundary" + Math.random().toString(36).substring(2);

    let header = `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${String(chatId).trim()}\r\n`;
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
      path: `/bot${ADMIN_BOT_TOKEN}/sendPhoto`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payloadLength
      }
    };

    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", chunk => d += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(d);
          if (!json.ok) console.error("❌ SendPhoto Error:", json.description);
        } catch(e){}
      });
    });
    req.on("error", (e) => console.error("Admin Photo Error:", e.message));
    req.write(header);
    req.write(buffer);
    req.write(footer);
    req.end();
  } catch (err) {
    console.error("Snapshot dispatch error:", err.message);
  }
}

/* ================= 🤖 BOT 2: PUBLIC SUPPORT SENDER ================= */
function sendTelegramSupportMessage(chatId, text) {
  if (!SUPPORT_BOT_TOKEN) return;
  const payload = JSON.stringify({ chat_id: String(chatId).trim(), text: text, parse_mode: "HTML", disable_web_page_preview: true });
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${SUPPORT_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };
  const req = https.request(options);
  req.on("error", (e) => console.error("❌ Support Bot Error:", e.message));
  req.write(payload);
  req.end();
}

/* ================= 🧠 UMINGLE-STYLE VISION AI ================= */
function analyzeCameraFrameSnapshot(base64Data) {
  if (!base64Data || typeof base64Data !== "string" || base64Data.length < 300) {
    return { hasValidFrame: false, verdict: "INVALID_FRAME", isSafeUser: true, shouldAutoBan: false, confidence: 0 };
  }

  try {
    const rawData = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(rawData, "base64");
    
    let sampleCount = 0;
    let skinToneBytes = 0;
    let darkBlackBytes = 0;
    let totalLuminance = 0;

    const step = Math.max(1, Math.floor(buffer.length / 2000));

    for (let i = 0; i < buffer.length; i += step) {
      const byte = buffer[i];
      sampleCount++;
      totalLuminance += byte;

      if (byte >= 140 && byte <= 230) skinToneBytes++;
      if (byte < 30) darkBlackBytes++;
    }

    const avgLuminance = sampleCount > 0 ? (totalLuminance / sampleCount) : 0;
    const skinRatio = sampleCount > 0 ? (skinToneBytes / sampleCount) : 0;
    const blackRatio = sampleCount > 0 ? (darkBlackBytes / sampleCount) : 0;

    const isNormalFace = (skinRatio >= 0.12 && skinRatio <= 0.48) && (avgLuminance > 50);
    const isCoveredCamera = (blackRatio > 0.85) || (avgLuminance < 20);
    const isSevereNudity = (skinRatio > 0.68);

    let verdict = "SAFE_NORMAL_USER";
    let shouldAutoBan = false;
    let isSafeUser = true;

    if (isSevereNudity) {
      verdict = "CONFIRMED_EXCESSIVE_NSFW";
      shouldAutoBan = true;
      isSafeUser = false;
    } else if (isCoveredCamera) {
      verdict = "COVERED_CAMERA_OR_BLACK_SCREEN";
      shouldAutoBan = false;
      isSafeUser = false;
    } else if (isNormalFace) {
      verdict = "NORMAL_HUMAN_FACE_VERIFIED";
      shouldAutoBan = false;
      isSafeUser = true;
    } else {
      verdict = "NORMAL_BACKGROUND_ACTIVITY";
      shouldAutoBan = false;
      isSafeUser = true;
    }

    return {
      hasValidFrame: true,
      verdict,
      isSafeUser,
      shouldAutoBan,
      skinPercentage: Math.round(skinRatio * 100),
      confidence: Math.round(skinRatio * 100),
      avgLuminance: Math.round(avgLuminance)
    };
  } catch (err) {
    return { hasValidFrame: false, verdict: "ANALYSIS_ERROR", isSafeUser: true, shouldAutoBan: false, confidence: 0 };
  }
}

/* ================= ⚡ REALTIME UNBAN DISPATCHER ================= */
function executeUnbanUser(hardwareId, phone = "Manual", auto = false) {
  if (!hardwareId) return;

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
  unbanRequestCooldowns.delete(hardwareId);
  offlineClearedSet.add(hardwareId);

  syncToDisk();

  io.emit("real-admin-unban-signal", { hardwareId: hardwareId });

  if (auto) {
    const successMsg = `⚡ <b>AUTO-UNBAN SUCCESSFUL (₱20.00 PAID)!</b> 🎉\n\n` +
                       `📱 <b>Mobile:</b> <code>${escapeHtml(phone)}</code>\n` +
                       `💳 <b>Hardware ID:</b> <code>${escapeHtml(hardwareId)}</code>\n` +
                       `💰 <b>Amount:</b> ₱20.00 Verified & Cleared!`;
    sendTelegramAdminMessage(ADMIN_CHAT_ID, successMsg);
  }
}

function isPhoneMatch(gcashText, userPhone) {
  if (!gcashText || !userPhone) return false;
  const cleanUser = String(userPhone).replace(/[^0-9]/g, "");
  if (!cleanUser || cleanUser.length < 7) return false;
  const user10Digit = cleanUser.slice(-10);
  return gcashText.includes(cleanUser) || gcashText.includes(user10Digit);
}

function isExact20Pesos(text) {
  if (!text) return false;
  const clean = text.toLowerCase();
  return clean.includes("20.00") || clean.includes("php 20") || clean.includes("php20") || clean.includes("₱20") || clean.includes("p20.00");
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
  
  const is20Pesos = isExact20Pesos(fullPayloadString);

  if (is20Pesos) {
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
      sendTelegramAdminMessage(ADMIN_CHAT_ID, `💰 <b>GCASH RECEIVED (₱20.00 VERIFIED)</b>\n<code>${escapeHtml(fullPayloadString)}</code>`);
    }
  } else {
    sendTelegramAdminMessage(ADMIN_CHAT_ID, `⚠️ <b>INVALID GCASH AMOUNT (Not ₱20)</b>\n<code>${escapeHtml(fullPayloadString)}</code>\n<i>Auto-unban blocked. Only exact ₱20.00 is allowed.</i>`);
  }

  res.status(200).json({ success: true, message: "Processed" });
});

/* ================= 📂 STATIC ASSETS SERVING ================= */
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use(express.static(__dirname, { etag: false, maxAge: 0 }));

/* ================= 🤖 TELEGRAM POLLING (BOT 1: ADMIN CONTROLS) ================= */
let adminLastUpdateId = 0;

function pollAdminBotUpdates() {
  const payload = JSON.stringify({
    offset: adminLastUpdateId + 1,
    timeout: 15,
    allowed_updates: ["callback_query"]
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${ADMIN_BOT_TOKEN}/getUpdates`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (json.ok && Array.isArray(json.result)) {
          json.result.forEach((update) => {
            adminLastUpdateId = update.update_id;
            
            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = String(cb.data || "");
              const msgId = cb.message?.message_id;
              const chatId = cb.message?.chat?.id || ADMIN_CHAT_ID;

              const parts = cbData.split(":");
              const action = parts[0];
              const hwId = parts.slice(1).join(":");

              if (action === "ab") {
                const snapshot = snapshotCache.get(hwId) || null;
                const record = banDeviceSecurity(hwId, "0.0.0.0", "", "Admin 1-Click Ban", snapshot);

                for (const [, s] of io.sockets.sockets.entries()) {
                  const socketHw = String(s.handshake.query.hardwareId || "").trim();
                  if (socketHw === hwId) {
                    s.emit("force-device-ban", { hardwareId: hwId, banUntil: record.banUntil, snapshot: record.snapshot });
                    s.emit("ip-banned", { banUntil: record.banUntil, reason: record.reason, snapshot: record.snapshot });
                    cleanupUserSession(s.id);
                  }
                }
                io.emit("force-device-ban", { hardwareId: hwId, banUntil: record.banUntil, snapshot: record.snapshot });

                sendTelegramAdminRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "🚨 User BANNED for 7 Days!", show_alert: true });

                if (msgId) {
                  sendTelegramAdminRaw("editMessageCaption", {
                    chat_id: chatId,
                    message_id: msgId,
                    caption: `🚨 <b>USER BANNED (7 DAYS ACTIVE)</b>\n🆔 Target ID: <code>${escapeHtml(hwId)}</code>\nAction Executed by Admin.`,
                    parse_mode: "HTML"
                  });
                }
              } else if (action === "ds") {
                userInfractions.delete(hwId);
                snapshotCache.delete(hwId);

                sendTelegramAdminRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Report Dismissed.", show_alert: false });

                if (msgId) {
                  sendTelegramAdminRaw("editMessageCaption", {
                    chat_id: chatId,
                    message_id: msgId,
                    caption: `✅ <b>REPORT DISMISSED</b>\nTarget: <code>${escapeHtml(hwId)}</code> (No Action Taken)`,
                    parse_mode: "HTML"
                  });
                }
              } else if (action === "ap") {
                const ticket = persistentDeviceTickets.get(hwId);
                executeUnbanUser(hwId, ticket ? ticket.phone : "Manual", false);

                sendTelegramAdminRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ APPROVED: User is UNBANNED!", show_alert: true });

                if (msgId) {
                  sendTelegramAdminRaw("editMessageText", {
                    chat_id: chatId,
                    message_id: msgId,
                    text: `✅ <b>UNBAN APPROVED BY ADMIN</b>\n🆔 Hardware ID: <code>${escapeHtml(hwId)}</code>\nStatus: <b>Clean Slate / Active</b>`,
                    parse_mode: "HTML"
                  });
                }
              } else if (action === "rj") {
                persistentDeviceTickets.delete(hwId);
                syncToDisk();

                sendTelegramAdminRaw("answerCallbackQuery", { callback_query_id: cb.id, text: "❌ Request REJECTED.", show_alert: false });

                if (msgId) {
                  sendTelegramAdminRaw("editMessageText", {
                    chat_id: chatId,
                    message_id: msgId,
                    text: `❌ <b>UNBAN REQUEST REJECTED</b>\n🆔 Hardware ID: <code>${escapeHtml(hwId)}</code>`,
                    parse_mode: "HTML"
                  });
                }
              }
            }
          });
        }
      } catch(e){}
      setTimeout(pollAdminBotUpdates, 1000);
    });
  });

  req.on("error", () => { setTimeout(pollAdminBotUpdates, 3000); });
  req.setTimeout(18000, () => { req.destroy(); });
  req.write(payload);
  req.end();
}

/* ================= 🤖 TELEGRAM POLLING (BOT 2: CUSTOMER SUPPORT) ================= */
let supportLastUpdateId = 0;

function pollSupportBotUpdates() {
  if (SUPPORT_BOT_TOKEN === ADMIN_BOT_TOKEN) return; // Skip if using single bot

  const payload = JSON.stringify({
    offset: supportLastUpdateId + 1,
    timeout: 15,
    allowed_updates: ["message"]
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${SUPPORT_BOT_TOKEN}/getUpdates`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      try {
        const json = JSON.parse(data);
        if (json.ok && Array.isArray(json.result)) {
          json.result.forEach((update) => {
            supportLastUpdateId = update.update_id;
            
            if (update.message) {
              const msg = update.message;
              const senderChatId = msg.chat?.id;
              const text = msg.text || "";
              const senderName = `${msg.from?.first_name || ""} ${msg.from?.last_name || ""}`.trim();
              const username = msg.from?.username ? `@${msg.from.username}` : "No Username";

              if (text === "/start") {
                sendTelegramSupportMessage(senderChatId, 
                  `👋 <b>Welcome to MeetLoop Live Customer Support!</b>\n\n` +
                  `Kung nais mag-apela sa ban o mag-submit ng GCash proof:\n` +
                  `1. I-send dito ang iyong <b>Device Ban ID</b>\n` +
                  `2. I-send ang iyong <b>GCash Ref No. o Screenshot ng bayad</b>\n\n` +
                  `<i>Matatanggap agad ito ng Admin team para ma-unban ka.</i>`
                );
              } else {
                sendTelegramSupportMessage(senderChatId, `✅ <b>Nai-forward na ang mensahe mo kay Admin.</b> Pakihintay ang unban clearance.`);
                
                // I-forward sa Admin Alert Channel
                sendTelegramAdminMessage(ADMIN_CHAT_ID, 
                  `📩 <b>CUSTOMER SUPPORT TICKET</b>\n\n` +
                  `👤 <b>Sender:</b> ${escapeHtml(senderName)} (${escapeHtml(username)})\n` +
                  `🆔 <b>User Telegram ID:</b> <code>${senderChatId}</code>\n` +
                  `💬 <b>Mensahe:</b>\n<i>${escapeHtml(text)}</i>`
                );
              }
            }
          });
        }
      } catch(e){}
      setTimeout(pollSupportBotUpdates, 1000);
    });
  });

  req.on("error", () => { setTimeout(pollSupportBotUpdates, 3000); });
  req.setTimeout(18000, () => { req.destroy(); });
  req.write(payload);
  req.end();
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
  } else {
    socket.emit("real-admin-unban-signal", { hardwareId: hardwareId });
  }

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

  /* ================= 🚨 REPORT & AI INSPECTION ================= */
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

        const ai = analyzeCameraFrameSnapshot(snapshot);

        let infractions = userInfractions.get(partnerHw) || [];
        infractions = infractions.filter(r => (now - r.time < REPORT_EXPIRY_WINDOW));
        
        const isDuplicate = infractions.some(r => r.by === hardwareId);
        if (!isDuplicate) {
          infractions.push({ by: hardwareId, reason, time: now, aiVerdict: ai.verdict });
          userInfractions.set(partnerHw, infractions);
        }

        const reportCount = infractions.length;
        const shouldAutoBan = ai.shouldAutoBan === true;

        const aiBadge = ai.isSafeUser 
          ? "🟢 <b>SAFE / INNOCENT (Auto-Ban Blocked)</b>" 
          : (shouldAutoBan ? "🛑 <b>VIOLATION CONFIRMED (Auto-Banned)</b>" : "⚠️ <b>SUSPICIOUS (Needs Admin Review)</b>");

        const alertText = `🚨 <b>USER REPORT INSPECTED</b>\n\n` +
                          `⚖️ <b>AI Verdict:</b> ${aiBadge}\n` +
                          `📸 <b>Skin Ratio:</b> ${ai.skinPercentage}%\n` +
                          `⚠️ <b>Report Reason:</b> ${escapeHtml(reason)}\n` +
                          `🆔 <b>Target Device:</b> <code>${escapeHtml(partnerHw)}</code>\n` +
                          `🌐 <b>Target IP:</b> <code>${escapeHtml(partnerIp)}</code>\n` +
                          `📊 <b>Reports (24h):</b> ${reportCount}\n\n` +
                          `<i>Decision: ${shouldAutoBan ? "🛑 Banned for 7 Days by AI." : (ai.isSafeUser ? "✅ Inosente. Hindi binan." : "⏳ Pindutin ang button sa ibaba para mag-desisyon.")}</i>`;

        sendTelegramPhotoWithActions(ADMIN_CHAT_ID, snapshot, alertText, partnerHw);

        if (shouldAutoBan) {
          const record = banDeviceSecurity(partnerHw, partnerIp, partnerFp, `AI Auto-Ban: ${reason}`, snapshot);
          partner.emit("ip-banned", { banUntil: record.banUntil, reason: record.reason, snapshot: record.snapshot });
          userInfractions.delete(partnerHw);
        }

        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }
    socket.emit("report-success");
  });

  /* ================= 🛑 UNBAN REQUEST HANDLER ================= */
  socket.on("unban-request", (data) => {
    const phone = String(data.phone || "").trim().replace(/[^0-9]/g, "");
    const ref = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const reqHardware = String(data.hardwareId || hardwareId).trim();
    const now = Date.now();

    const lastSubmitTime = unbanRequestCooldowns.get(reqHardware) || 0;
    if (now - lastSubmitTime < UNBAN_SUBMIT_COOLDOWN) {
      return socket.emit("unban-pending", { message: "⏳ Details already submitted. Checking payment..." });
    }

    if (!phone || phone.length < 10) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid 11-digit GCash Mobile Number." });
    }

    unbanRequestCooldowns.set(reqHardware, now);

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

    sendTelegramWithButtons(
      ADMIN_CHAT_ID, 
      `🚨 <b>UNBAN REQUEST (₱20.00 FEE)</b>\n\n` +
      `📱 <b>Mobile:</b> <code>${escapeHtml(phone)}</code>\n` +
      `💳 <b>Ref:</b> <code>${escapeHtml(ref || "N/A")}</code>\n` +
      `🆔 <b>HW:</b> <code>${escapeHtml(reqHardware)}</code>`, 
      reqHardware
    );

    socket.emit("unban-pending", { message: "⏳ Details submitted! Checking ₱20 payment..." });
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
  console.log(`🤖 Bot 1 (Admin Controls): ONLINE`);
  console.log(`👥 Bot 2 (Customer Support): ONLINE`);
  console.log(`💰 Unban Clearance Fee: ₱20.00 ONLY`);
  console.log(`💾 Persistent Disk Storage: ${DB_FILE}`);
  console.log(`================================================`);
  pollAdminBotUpdates();
  pollSupportBotUpdates();
});
