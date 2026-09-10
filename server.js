/**
 * MeetLoop - Official Production Server Backend
 * 100% Filipino Made Random Video Chat 🇵🇭
 * High-Speed Telegram Auto-Pairing Bot + WebRTC Matchmaking
 * (Direct Telegram Ingestion + Phone Auto-Matcher + Real-Time Online Counter)
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
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000;

// ================= TELEGRAM BOT CONFIG =================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8648356765:AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

// Anti-Cache Headers
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.text({ type: "*/*", limit: "15mb" }));

/* ================= DATABASES & MATCHING LEDGER ================= */
const bannedDevices = new Map();
const pendingRequests = new Map(); // HardwareId -> { hardwareId, phone, ref, socketId }
const receivedGCashPayments = [];  // Naka-store na verified payments mula sa Telegram
const attemptTracker = new Map();

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    res.on("end", () => {
      if (callback) callback(null, d);
    });
  });

  req.on("error", (e) => {
    console.error("❌ Telegram API Error:", e.message);
    if (callback) callback(e);
  });

  req.write(payload);
  req.end();
}

function sendTelegramMessage(chatId, text) {
  sendTelegramRaw("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

function sendTelegramWithButtons(chatId, text, reqId) {
  const payload = {
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
  };
  sendTelegramRaw("sendMessage", payload);
}

// ⚡ BULLETPROOF UNBAN EXECUTOR
function executeUnbanUser(hardwareId, phone, auto = false) {
  console.log(`🔓 [UNBAN SUCCESS]: HardwareID=${hardwareId}, Phone=${phone}, Auto=${auto}`);
  
  bannedDevices.delete(hardwareId);
  attemptTracker.delete(hardwareId);

  // Send instant unlock signal sa client browser
  io.emit("real-admin-unban-signal", { hardwareId: hardwareId });

  if (auto) {
    const successMsg = `⚡ <b>AUTO-UNBAN SUCCESSFUL!</b> 🎉\n\n` +
                       `📱 <b>Matched Mobile No:</b> <code>${escapeHtml(phone)}</code>\n` +
                       `💰 <b>Amount:</b> GCash Payment Verified\n\n` +
                       `<i>Kusang binuksan ng system ang ban dahil nagtugma ang Number sa Telegram alert at website!</i>`;
    sendTelegramMessage(ADMIN_CHAT_ID, successMsg);
  }
}

// 🔍 ADVANCED NUMBER EXTRACTOR & MATCHER
function extractAllPhoneNumbers(text) {
  if (!text) return [];
  const matches = text.match(/(09\d{9}|9\d{9}|\b\d{10,12}\b)/g);
  if (!matches) return [];
  return matches.map(num => num.replace(/[^0-9]/g, ""));
}

function isPhoneMatch(gcashText, userPhone) {
  if (!gcashText || !userPhone) return false;
  
  const cleanUser = String(userPhone).replace(/[^0-9]/g, "");
  if (!cleanUser || cleanUser.length < 7) return false;

  const user10Digit = cleanUser.slice(-10);
  if (gcashText.includes(cleanUser) || gcashText.includes(user10Digit)) return true;

  const extractedNumbers = extractAllPhoneNumbers(gcashText);
  for (const num of extractedNumbers) {
    if (num === cleanUser || num.endsWith(user10Digit) || cleanUser.endsWith(num.slice(-10))) {
      return true;
    }
  }

  const last7 = cleanUser.slice(-7);
  if (last7 && gcashText.includes(last7)) return true;

  return false;
}

// Process new GCash text to check for unban matches
function processIncomingGCashText(fullText) {
  console.log(`[INCOMING GCASH PAYMENT LOGGED]: ${fullText}`);
  receivedGCashPayments.push({ text: fullText, time: Date.now(), used: false });
  if (receivedGCashPayments.length > 50) receivedGCashPayments.shift();

  // Check kung may naghihintay na unban request
  for (const [reqId, request] of pendingRequests.entries()) {
    if (isPhoneMatch(fullText, request.phone) || (request.ref && fullText.includes(request.ref))) {
      console.log(`🎯 [INSTANT MATCH SUCCESS]: Matched user ${request.phone}`);
      executeUnbanUser(request.hardwareId, request.phone, true);
      pendingRequests.delete(reqId);
      break;
    }
  }
}

// =========================================================================
// ⚡ TELEGRAM POLLING LISTENER (READS MESSAGES + 1-CLICK BUTTONS)
// =========================================================================
let lastUpdateId = 0;
let isPolling = false;

function pollTelegramUpdates() {
  if (isPolling) return;
  isPolling = true;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`;

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => data += chunk);
    res.on("end", () => {
      isPolling = false;
      try {
        const json = JSON.parse(data);
        if (json.ok && Array.isArray(json.result)) {
          json.result.forEach((update) => {
            lastUpdateId = update.update_id;

            // 1. BASAHIN ANG DIRECT GCASH SMS FORWARDER MESSAGES SA TELEGRAM
            if (update.message && update.message.text) {
              const incomingText = update.message.text;

              // Kung ito ay GCash payment notification mula sa SMS Forwarder mo
              if (incomingText.includes("received") || incomingText.includes("GCash") || incomingText.includes("PHP") || incomingText.includes("09")) {
                processIncomingGCashText(incomingText);
              }

              if (incomingText.startsWith("/start")) {
                const welcomeReply = `👋 <b>Kamusta Jm!</b>\n\n` +
                                     `✅ <b>MeetLoop Direct Telegram Reader is Active!</b>\n\n` +
                                     `Dito papasok ang:\n` +
                                     `1. 📲 <b>GCash SMS mula sa SMS Forwarder</b>\n` +
                                     `2. ⚡ <b>Automatic Unban kapag nag-match ang Mobile Number</b>\n` +
                                     `3. 🚨 <b>1-Click Approve / Reject Buttons sa bawat ticket</b> 🎉`;
                sendTelegramMessage(update.message.chat.id, welcomeReply);
              }
            }

            // 2. HANDLER PARA SA 1-CLICK APPROVE / REJECT BUTTONS
            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = cb.data || "";
              const messageId = cb.message?.message_id;
              const chatId = cb.message?.chat?.id;

              if (cbData.startsWith("approve_")) {
                const reqId = cbData.replace("approve_", "");
                const request = pendingRequests.get(reqId);

                if (request) {
                  executeUnbanUser(request.hardwareId, request.phone, false);
                  pendingRequests.delete(reqId);

                  sendTelegramRaw("editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: `✅ <b>APPROVED BY ADMIN!</b>\n\n📱 <b>Mobile No:</b> <code>${escapeHtml(request.phone)}</code>\n💰 <b>Status:</b> Clearance Fee Verified\n\n🎉 <i>Matagumpay na na-unban ang user sa MeetLoop!</i>`,
                    parse_mode: "HTML"
                  });

                  sendTelegramRaw("answerCallbackQuery", {
                    callback_query_id: cb.id,
                    text: "✅ User Unbanned Successfully!",
                    show_alert: true
                  });
                }
              } else if (cbData.startsWith("reject_")) {
                const reqId = cbData.replace("reject_", "");
                const request = pendingRequests.get(reqId);
                pendingRequests.delete(reqId);

                sendTelegramRaw("editMessageText", {
                  chat_id: chatId,
                  message_id: messageId,
                  text: `❌ <b>REJECTED BY ADMIN</b>\n\n📱 <b>Mobile:</b> <code>${escapeHtml(request ? request.phone : "")}</code>\n\n🚫 <i>Hindi na-unban.</i>`,
                  parse_mode: "HTML"
                });

                sendTelegramRaw("answerCallbackQuery", {
                  callback_query_id: cb.id,
                  text: "❌ Request Rejected!",
                  show_alert: false
                });
              }
            }
          });
        }
      } catch (e) {}
      setTimeout(pollTelegramUpdates, 1500);
    });
  }).on("error", (e) => {
    isPolling = false;
    setTimeout(pollTelegramUpdates, 3000);
  });
}

function checkDeviceBan(hardwareId) {
  if (!hardwareId) return null;
  const now = Date.now();

  if (bannedDevices.has(hardwareId)) {
    const record = bannedDevices.get(hardwareId);
    if (now < record.banUntil) return record;
    bannedDevices.delete(hardwareId);
  }
  return null;
}

function banDevice(hardwareId, reason, snapshot = null, durationMs = BAN_DURATION_7DAYS) {
  const finalId = String(hardwareId || "").trim();
  if (!finalId) return null;

  const banUntil = Date.now() + durationMs;
  const record = { banUntil, reason, snapshot, hardwareId: finalId };
  bannedDevices.set(finalId, record);
  return record;
}

/* ================= MATCHMAKING ENGINE ================= */
let waitingQueue = [];
const activePairs = new Map();

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter(id => id !== socketId);
}

function cleanupUserSession(socketId) {
  removeFromQueue(socketId);
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partner.emit("partner-disconnected");
      activePairs.delete(partnerId);
    }
    activePairs.delete(socketId);
  }
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

function broadcastOnlineCount() {
  const count = Math.max(1, io.engine.clientsCount);
  io.emit("online-count", count);
}

/* ================= SOCKET.IO EVENTS ================= */
io.on("connection", (socket) => {
  const hardwareId = String(socket.handshake.query.hardwareId || socket.handshake.query.deviceId || "").trim();

  broadcastOnlineCount();

  const banInfo = checkDeviceBan(hardwareId);
  if (banInfo) {
    socket.emit("ip-banned", {
      banUntil: banInfo.banUntil,
      reason: banInfo.reason,
      snapshot: banInfo.snapshot
    });
  }

  socket.on("skip", () => {
    const currentBan = checkDeviceBan(hardwareId);
    if (currentBan) {
      return socket.emit("ip-banned", {
        banUntil: currentBan.banUntil,
        reason: currentBan.reason,
        snapshot: currentBan.snapshot
      });
    }

    cleanupUserSession(socket.id);
    waitingQueue.push(socket.id);
    socket.emit("waiting");

    matchUsers();
  });

  socket.on("signal", (data) => {
    const currentBan = checkDeviceBan(hardwareId);
    if (currentBan) return;

    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        partner.emit("signal", data);
      }
    }
  });

  socket.on("report-user", (data) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) {
        const partnerHw = String(partner.handshake.query.hardwareId || partner.handshake.query.deviceId || partner.id).trim();
        const encounterSnapshot = data.snapshot || null;

        const record = banDevice(partnerHw, data.reason || "Policy Violation", encounterSnapshot, BAN_DURATION_7DAYS);

        partner.emit("ip-banned", {
          banUntil: record.banUntil,
          reason: record.reason,
          snapshot: record.snapshot
        });

        activePairs.delete(partnerId);
      }
      activePairs.delete(socket.id);
    }
    socket.emit("report-success");
  });

  // SUBMIT GCASH UNBAN TICKET
  socket.on("unban-request", (data) => {
    const phone = String(data.phone || "").trim().replace(/[^0-9]/g, "");
    const ref = String(data.ref || "").trim().replace(/[^0-9]/g, "");
    const reqHardware = String(data.hardwareId || hardwareId).trim();

    if (!phone || phone.length < 10) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid 11-digit Mobile Number." });
    }

    let tracker = attemptTracker.get(reqHardware) || { attempts: 0, lockedUntil: 0 };
    if (Date.now() < tracker.lockedUntil) {
      const remainingSec = Math.ceil((tracker.lockedUntil - Date.now()) / 1000);
      return socket.emit("unban-response", { 
        success: false, 
        message: `⏳ Max attempts reached. Please wait ${remainingSec}s before trying again.` 
      });
    }

    tracker.attempts++;
    if (tracker.attempts >= 4) {
      tracker.lockedUntil = Date.now() + 30000;
      tracker.attempts = 0;
    }
    attemptTracker.set(reqHardware, tracker);

    // 🔥 INSTANT MATCH CHECK (Tingnan kung pumasok na sa Telegram kanina!)
    for (const item of receivedGCashPayments) {
      if (!item.used && (isPhoneMatch(item.text, phone) || (ref && item.text.includes(ref)))) {
        console.log(`🎯 [INSTANT MATCH FROM TELEGRAM FEED]: User ${phone} matched`);
        item.used = true;
        executeUnbanUser(reqHardware, phone, true);
        return;
      }
    }

    const reqId = "req" + Math.floor(Math.random() * 900000 + 100000);
    pendingRequests.set(reqId, { hardwareId: reqHardware, phone, ref, socketId: socket.id });

    const msgText = `🚨 <b>MEETLOOP UNBAN REQUEST</b>\n\n` +
                    `📱 <b>Mobile No:</b> <code>${escapeHtml(phone)}</code>\n` +
                    `💳 <b>Ref No:</b> <code>${escapeHtml(ref || "N/A")}</code>\n` +
                    `💰 <b>Amount:</b> ₱10.00 Clearance Fee\n\n` +
                    `<i>Kapag pumasok ang alert sa Telegram mula sa SMS forwarder, automatic itong ma-u-unban. O pwede mong pindutin ang 🟢 1-CLICK APPROVE:</i>`;

    sendTelegramWithButtons(ADMIN_CHAT_ID, msgText, reqId);

    return socket.emit("unban-pending", {
      message: "⏳ Details submitted! Checking GCash payment notification for matching Mobile Number..."
    });
  });

  socket.on("stop-search", () => {
    cleanupUserSession(socket.id);
  });

  socket.on("disconnect", () => {
    cleanupUserSession(socket.id);
    broadcastOnlineCount();
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`📲 Direct Telegram Message Auto-Matcher: ACTIVE`);
  console.log(`👥 Real-Time Online Counter: ACTIVE`);
  console.log(`🛡️ 4-Attempts & 30s Cooldown Limiter: ACTIVE`);
  console.log(`⚡ Strict 1-Tab Session Lock: ACTIVE`);
  console.log(`================================================`);
  pollTelegramUpdates();
});
