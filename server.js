/**
 * MeetLoop - Official Production Server Backend
 * 100% Filipino Made Random Video Chat 🇵🇭
 * High-Speed Telegram Auto-Pairing Bot + WebRTC Matchmaking
 * (Persistent Device Tickets + Refresh Auto-Unban Recovery)
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
const PAYMENT_VALIDITY_WINDOW = 30 * 60 * 1000; // 30 mins validity

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

// Middleware for parsing JSON and raw bodies
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.text({ type: "*/*", limit: "15mb" }));

/* ================= DATABASES & PERSISTENT TICKETS ================= */
const bannedDevices = new Map();
const persistentDeviceTickets = new Map(); // HardwareID -> { phone, ref, time }
let availablePayments = [];                // Fresh, unconsumed payments only
const burnedReceipts = new Set();          // Permanent list of consumed payments
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

// ⚡ STRICT SINGLE-USE UNBAN EXECUTOR
function executeUnbanUser(hardwareId, phone, auto = false) {
  console.log(`🔓 [UNBAN SUCCESS]: HardwareID=${hardwareId}, Phone=${phone}, Auto=${auto}`);
  
  bannedDevices.delete(hardwareId);
  persistentDeviceTickets.delete(hardwareId);
  attemptTracker.delete(hardwareId);

  io.emit("real-admin-unban-signal", { hardwareId: hardwareId });

  if (auto) {
    const successMsg = `⚡ <b>AUTO-UNBAN SUCCESSFUL!</b> 🎉\n\n` +
                       `📱 <b>Matched Mobile No:</b> <code>${escapeHtml(phone)}</code>\n` +
                       `💰 <b>Status:</b> GCash Payment Verified & BURNED\n\n` +
                       `<i>Kusang binuksan ng system ang ban kahit nag-refresh ang user! Fresh ID reset na ang device.</i>`;
    sendTelegramMessage(ADMIN_CHAT_ID, successMsg);
  }
}

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

// =========================================================================
// 📲 1. PRIMARY WEBHOOK ENDPOINT (MATCHES PERSISTENT TICKETS)
// =========================================================================
app.all("/webhook/gcash-sms", (req, res) => {
  let rawData = req.body;
  let parsedContent = "";
  let senderTitle = "GCash App";

  if (typeof rawData === "string") {
    try {
      const parsedJson = JSON.parse(rawData);
      parsedContent = parsedJson.content || parsedJson.not_text || parsedJson.notification_text || parsedJson.message || parsedJson.msg || parsedJson.System || rawData;
      senderTitle = parsedJson.from || parsedJson.title || senderTitle;
    } catch(e) {
      parsedContent = rawData;
    }
  } else if (typeof rawData === "object" && rawData !== null) {
    parsedContent = rawData.content || rawData.not_text || rawData.notification_text || rawData.message || rawData.msg || rawData.text || rawData.body || rawData.System || JSON.stringify(rawData);
    senderTitle = rawData.from || rawData.sender || rawData.title || senderTitle;
  }

  if (!parsedContent && (req.query.content || req.query.message || req.query.text)) {
    parsedContent = req.query.content || req.query.message || req.query.text;
  }

  const fullPayloadString = `${senderTitle} ${parsedContent}`.trim();
  console.log(`[GCASH WEBHOOK RECEIVED]:\n${fullPayloadString}`);

  const paymentId = "tx_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const now = Date.now();
  
  availablePayments = availablePayments.filter(p => (now - p.time < PAYMENT_VALIDITY_WINDOW));
  const newPaymentObj = { id: paymentId, text: fullPayloadString, time: now };
  availablePayments.push(newPaymentObj);

  // 🔍 AUTO-CHECK: Hanapin sa PERSISTENT TICKETS kung may naghihintay na device (Kahit nag-refresh ang user)!
  let autoUnbanned = false;
  for (const [hwId, ticket] of persistentDeviceTickets.entries()) {
    if (isPhoneMatch(fullPayloadString, ticket.phone) || (ticket.ref && fullPayloadString.includes(ticket.ref))) {
      console.log(`🎯 [MATCH ON PERSISTENT TICKET]: Unbanning HW=${hwId}, Phone=${ticket.phone}`);
      
      availablePayments = availablePayments.filter(p => p.id !== paymentId);
      burnedReceipts.add(paymentId);
      
      executeUnbanUser(hwId, ticket.phone, true);
      autoUnbanned = true;
      break;
    }
  }

  if (!autoUnbanned) {
    const alertText = `💰 <b>GCASH NOTIFICATION RECEIVED!</b>\n\n` +
                      `📲 <b>Sender:</b> ${escapeHtml(senderTitle)}\n` +
                      `📩 <b>Details:</b>\n<code>${escapeHtml(parsedContent || "Payment Alert")}</code>\n\n` +
                      `⏰ <i>Oras: ${new Date().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })}</i>`;

    sendTelegramMessage(ADMIN_CHAT_ID, alertText);
  }

  res.status(200).json({ success: true, message: "Processed and Secured" });
});

// Static files
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

// =========================================================================
// ⚡ TELEGRAM POLLING LISTENER
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

            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = cb.data || "";
              const messageId = cb.message?.message_id;
              const chatId = cb.message?.chat?.id;

              if (cbData.startsWith("approve_")) {
                const hwId = cbData.replace("approve_", "");
                const ticket = persistentDeviceTickets.get(hwId);

                if (bannedDevices.has(hwId) || ticket) {
                  executeUnbanUser(hwId, ticket ? ticket.phone : "Manual", false);

                  sendTelegramRaw("editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: `✅ <b>APPROVED BY ADMIN!</b>\n\n📱 <b>Mobile No:</b> <code>${escapeHtml(ticket ? ticket.phone : "Verified")}</code>\n💰 <b>Status:</b> Clearance Fee Verified\n\n🎉 <i>Matagumpay na na-unban ang user sa MeetLoop!</i>`,
                    parse_mode: "HTML"
                  });

                  sendTelegramRaw("answerCallbackQuery", {
                    callback_query_id: cb.id,
                    text: "✅ User Unbanned Successfully!",
                    show_alert: true
                  });
                } else {
                  sendTelegramRaw("answerCallbackQuery", {
                    callback_query_id: cb.id,
                    text: "⚠️ Ticket already unbanned or expired.",
                    show_alert: true
                  });
                }
              } else if (cbData.startsWith("reject_")) {
                const hwId = cbData.replace("reject_", "");
                const ticket = persistentDeviceTickets.get(hwId);
                persistentDeviceTickets.delete(hwId);

                sendTelegramRaw("editMessageText", {
                  chat_id: chatId,
                  message_id: messageId,
                  text: `❌ <b>REJECTED BY ADMIN</b>\n\n📱 <b>Mobile:</b> <code>${escapeHtml(ticket ? ticket.phone : "")}</code>\n\n🚫 <i>Hindi na-unban.</i>`,
                  parse_mode: "HTML"
                });

                sendTelegramRaw("answerCallbackQuery", {
                  callback_query_id: cb.id,
                  text: "❌ Request Rejected!",
                  show_alert: false
                });
              }
            }

            if (update.message && update.message.chat) {
              const incomingChatId = update.message.chat.id;
              const text = (update.message.text || "").trim();

              if (text.startsWith("/start")) {
                const welcomeReply = `👋 <b>Kamusta Jm!</b>\n\n` +
                                     `✅ <b>MeetLoop Auto Phone Matcher is Active!</b>\n\n` +
                                     `Dito papasok ang:\n` +
                                     `1. 📲 <b>GCash SMS/Notif mula sa SMS Forwarder</b>\n` +
                                     `2. ⚡ <b>Automatic Unban kahit mag-refresh ang user</b>\n` +
                                     `3. 🛡️ <b>Strict Single-Use Burned Receipts</b>\n` +
                                     `4. 🚨 <b>1-Click Approve / Reject Buttons sa bawat ticket</b> 🎉`;
                sendTelegramMessage(incomingChatId, welcomeReply);
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
    persistentDeviceTickets.delete(hardwareId);
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

  // 🔄 AUTO-CHECK SA RECONNECT / REFRESH
  socket.on("check-ban-status", (data) => {
    const hwId = String(data?.hardwareId || hardwareId).trim();
    if (!bannedDevices.has(hwId)) {
      socket.emit("real-admin-unban-signal", { hardwareId: hwId });
    }
  });

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

  // REPORT USER: CAPTURES STRANGER PICTURE
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

    // 🔥 INSTANT MATCH CHECK: Kung nauna ang bayad bago mag-submit
    const now = Date.now();
    let matchedIndex = -1;

    for (let i = 0; i < availablePayments.length; i++) {
      const item = availablePayments[i];
      if ((now - item.time < PAYMENT_VALIDITY_WINDOW) && (isPhoneMatch(item.text, phone) || (ref && item.text.includes(ref)))) {
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

    // 🔒 PERSISTENT TICKET SAVE: Kahit mag-refresh ang user, mananatili ito sa server!
    persistentDeviceTickets.set(reqHardware, { phone, ref, time: now });

    const msgText = `🚨 <b>MEETLOOP UNBAN REQUEST</b>\n\n` +
                    `📱 <b>Mobile No:</b> <code>${escapeHtml(phone)}</code>\n` +
                    `💳 <b>Ref No:</b> <code>${escapeHtml(ref || "N/A")}</code>\n` +
                    `💰 <b>Amount:</b> ₱10.00 Clearance Fee\n\n` +
                    `<i>Kapag pumasok ang GCash alert kahit mag-refresh ang user, automatic itong ma-u-unban. O pwede mong pindutin ang 🟢 1-CLICK APPROVE:</i>`;

    sendTelegramWithButtons(ADMIN_CHAT_ID, msgText, reqHardware);

    return socket.emit("unban-pending", {
      message: "⏳ Details submitted! Checking for a fresh unconsumed GCash payment..."
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
  console.log(`📡 GCash Webhook Route: READY (/webhook/gcash-sms)`);
  console.log(`💾 Persistent Device Ticket Matching: ACTIVE`);
  console.log(`🔒 Single-Use Burned Receipts: STRICTLY ACTIVE`);
  console.log(`================================================`);
  pollTelegramUpdates();
});
