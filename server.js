/**
 * MeetLoop - Official Production Server Backend
 * 100% Filipino Made Random Video Chat 🇵🇭
 * High-Speed Telegram Auto-Pairing Bot + WebRTC Matchmaking
 * (Instant Phone-Number Auto Matcher + Anti-Spam Lock + 1-Click Telegram Inline Buttons)
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
const BAN_DURATION_7DAYS = 7 * 24 * 60 * 60 * 1000; // 7 Days in MS

// =========================================================================
// 🤖 TELEGRAM BOT CONFIGURATION (@MeetLoop_bot | Admin ID: 5779976596)
// =========================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8648356765:AAGgnEY9W8T_rWUEk1DgxHS48oNLOhg0d2s";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "5779976596";

// Anti-Cache Headers
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Middleware para saluhin ang lahat ng data format mula sa SMS Forwarder
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.text({ type: "*/*", limit: "15mb" }));

/* ================= DATABASES & CACHE ================= */
const bannedDevices = new Map();
const pendingRequests = new Map(); // Tickets na naghihintay ng matching phone number
const receivedGCashMessages = [];  // Naka-save na mga numero at notification galing sa phone
const rateLimitMap = new Map();    // Anti-Spam protection

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

// Function para i-unban ang user kapag nag-match ang number
function executeUnbanUser(hardwareId, phone, name, auto = false) {
  bannedDevices.delete(hardwareId);

  // Send instant unlock signal sa client browser
  io.emit("real-admin-unban-signal", { hardwareId: hardwareId });

  if (auto) {
    const successMsg = `⚡ <b>AUTO-UNBAN SUCCESSFUL!</b> 🎉\n\n` +
                       `👤 <b>User:</b> ${escapeHtml(name)}\n` +
                       `📱 <b>Matched Mobile No:</b> <code>${escapeHtml(phone)}</code>\n` +
                       `💰 <b>Amount:</b> ₱10.00 / ₱20.00 Support Payment\n\n` +
                       `<i>Kusang binuksan ng system ang ban dahil nagtugma ang GCash Number sa phone notif at website!</i>`;
    sendTelegramMessage(ADMIN_CHAT_ID, successMsg);
  }
}

// Function para i-check kung nagtutugma ang numero (Direct, Last 4 digits, o Masked Number)
function isPhoneMatch(gcashPayloadText, userPhone) {
  if (!gcashPayloadText || !userPhone) return false;
  
  const cleanUserPhone = userPhone.replace(/[^0-9]/g, "");
  const last4 = cleanUserPhone.slice(-4);
  const first4 = cleanUserPhone.slice(0, 4);

  // 1. Direct Full Match (e.g. 09983813724)
  if (gcashPayloadText.includes(cleanUserPhone)) return true;

  // 2. 10-Digit match (e.g. 9983813724 nang walang 0 sa unahan)
  if (cleanUserPhone.length >= 10 && gcashPayloadText.includes(cleanUserPhone.slice(-10))) return true;

  // 3. Masked match (e.g. 0998***3724)
  if (cleanUserPhone.length >= 10 && gcashPayloadText.includes(last4) && gcashPayloadText.includes(first4)) return true;

  // 4. Last 4 digits match kung may kasamang GCash context
  if (last4 && last4.length === 4 && gcashPayloadText.includes(last4)) return true;

  return false;
}

// =========================================================================
// 📲 UNIVERSAL GCASH WEBHOOK + AUTO NUMBER MATCHER
// =========================================================================
app.all("/webhook/gcash-sms", (req, res) => {
  let rawData = req.body;
  let parsedContent = "";
  let senderTitle = "GCash App";

  if (typeof rawData === "string") {
    try {
      const parsedJson = JSON.parse(rawData);
      parsedContent = parsedJson.content || parsedJson.not_text || parsedJson.notification_text || parsedJson.message || parsedJson.msg || rawData;
      senderTitle = parsedJson.from || parsedJson.title || senderTitle;
    } catch(e) {
      parsedContent = rawData;
    }
  } else if (typeof rawData === "object" && rawData !== null) {
    parsedContent = rawData.content || rawData.not_text || rawData.notification_text || rawData.message || rawData.msg || rawData.text || rawData.body || JSON.stringify(rawData);
    senderTitle = rawData.from || rawData.sender || rawData.title || senderTitle;
  }

  if (!parsedContent && (req.query.content || req.query.message || req.query.text)) {
    parsedContent = req.query.content || req.query.message || req.query.text;
  }

  // Pagsamahin ang Sender Info at Message Content para sa matching
  const fullPayloadString = `${senderTitle} ${parsedContent}`.trim();

  console.log(`[GCASH FORWARDER RECEIVED]:\n${fullPayloadString}`);

  // I-save sa memory cache ng payments
  receivedGCashMessages.push({ text: fullPayloadString, time: Date.now() });
  if (receivedGCashMessages.length > 50) receivedGCashMessages.shift();

  // 🔍 AUTO-CHECK: Hanapin kung may naghihintay na unban ticket na kapareho ang Mobile Number!
  let autoUnbanned = false;
  for (const [reqId, request] of pendingRequests.entries()) {
    if (isPhoneMatch(fullPayloadString, request.phone)) {
      executeUnbanUser(request.hardwareId, request.phone, request.name, true);
      pendingRequests.delete(reqId);
      autoUnbanned = true;
      break;
    }
  }

  if (!autoUnbanned) {
    const alertText = `💰 <b>GCASH NOTIFICATION RECEIVED!</b>\n\n` +
                      `📲 <b>Sender:</b> ${escapeHtml(senderTitle)}\n` +
                      `📩 <b>Details:</b>\n<code>${escapeHtml(parsedContent || "New Payment Notification")}</code>\n\n` +
                      `⏰ <i>Oras: ${new Date().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })}</i>`;

    sendTelegramMessage(ADMIN_CHAT_ID, alertText);
  }

  res.status(200).json({ success: true, message: "Processed" });
});

// =========================================================================
// ⚡ TELEGRAM POLLING LISTENER (With 1-Click Button Handler)
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

            // 1. HANDLER KAPAG PININDOT ANG INLINE BUTTONS (APPROVE / REJECT)
            if (update.callback_query) {
              const cb = update.callback_query;
              const cbData = cb.data || "";
              const messageId = cb.message?.message_id;
              const chatId = cb.message?.chat?.id;

              if (cbData.startsWith("approve_")) {
                const reqId = cbData.replace("approve_", "");
                const request = pendingRequests.get(reqId);

                if (request) {
                  executeUnbanUser(request.hardwareId, request.phone, request.name, false);
                  pendingRequests.delete(reqId);

                  sendTelegramRaw("editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: `✅ <b>APPROVED BY ADMIN!</b>\n\n👤 <b>User:</b> ${escapeHtml(request.name)}\n📱 <b>Mobile No:</b> <code>${escapeHtml(request.phone)}</code>\n💰 <b>Status:</b> Clearance Fee Verified\n\n🎉 <i>Matagumpay na na-unban ang user sa MeetLoop!</i>`,
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
                    text: "⚠️ Ticket already processed or expired.",
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
                  text: `❌ <b>REJECTED BY ADMIN</b>\n\n👤 <b>User:</b> ${escapeHtml(request ? request.name : "Unknown")}\n📱 <b>Mobile:</b> <code>${escapeHtml(request ? request.phone : "")}</code>\n\n🚫 <i>Hindi na-unban (Walang pumasok na bayad).</i>`,
                  parse_mode: "HTML"
                });

                sendTelegramRaw("answerCallbackQuery", {
                  callback_query_id: cb.id,
                  text: "❌ Request Rejected!",
                  show_alert: false
                });
              }
            }

            // 2. HANDLER PARA SA /start CHAT
            if (update.message && update.message.chat) {
              const incomingChatId = update.message.chat.id;
              const text = (update.message.text || "").trim();

              if (text.startsWith("/start")) {
                const welcomeReply = `👋 <b>Kamusta Jm!</b>\n\n` +
                                     `✅ <b>MeetLoop Auto Mobile-Matcher Bot is Active!</b>\n\n` +
                                     `Dito papasok ang:\n` +
                                     `1. 📲 <b>GCash SMS/Notif mula sa SMS Forwarder</b>\n` +
                                     `2. ⚡ <b>Automatic Unban kapag nag-match ang Mobile Number</b>\n` +
                                     `3. 🛡️ <b>Anti-Spam 60s cooldown limit</b>\n` +
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

/* ================= SOCKET.IO EVENTS ================= */
io.on("connection", (socket) => {
  const hardwareId = String(socket.handshake.query.hardwareId || socket.handshake.query.deviceId || "").trim();

  io.emit("online-count", io.engine.clientsCount);

  // Strict Server Ban Check
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

  // REPORT USER
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

  // SUBMIT GCASH UNBAN TICKET WITH NUMBER MATCHING & RATE LIMITER
  socket.on("unban-request", (data) => {
    const phone = String(data.phone || "").trim().replace(/[^0-9]/g, "");
    const name = String(data.name || "Anonymous User").trim();
    const reqHardware = String(data.hardwareId || hardwareId).trim();

    if (!phone || phone.length < 10) {
      return socket.emit("unban-response", { success: false, message: "❌ Please enter a valid 11-digit Mobile Number." });
    }

    // 🛡️ ANTI-SPAM: 1 submit every 60 seconds per device
    const lastSubmitTime = rateLimitMap.get(reqHardware) || 0;
    if (Date.now() - lastSubmitTime < 60000) {
      return socket.emit("unban-response", { success: false, message: "⚠️ Please wait before submitting another request." });
    }
    rateLimitMap.set(reqHardware, Date.now());

    // 🔥 INSTANT MATCH: Kung pumasok na kanina ang GCash alert na may ganitong numero!
    for (const item of receivedGCashMessages) {
      if (isPhoneMatch(item.text, phone)) {
        executeUnbanUser(reqHardware, phone, name, true);
        return;
      }
    }

    const reqId = "req" + Math.floor(Math.random() * 900000 + 100000);
    pendingRequests.set(reqId, { hardwareId: reqHardware, phone, name, socketId: socket.id });

    // I-send sa Telegram mo na may [ 🟢 1-CLICK APPROVE ]
    const msgText = `🚨 <b>MEETLOOP UNBAN REQUEST</b>\n\n` +
                    `👤 <b>Sender:</b> ${escapeHtml(name)}\n` +
                    `📱 <b>Mobile No:</b> <code>${escapeHtml(phone)}</code>\n` +
                    `💰 <b>Amount:</b> Clearance Fee\n\n` +
                    `<i>Kapag pumasok ang GCash alert na may ganitong number, automatic itong ma-u-unban. O pwede mong pindutin ang 🟢 1-CLICK APPROVE:</i>`;

    sendTelegramWithButtons(ADMIN_CHAT_ID, msgText, reqId);

    return socket.emit("unban-pending", {
      message: "⏳ Payment submitted! Waiting for number match or Admin approval..."
    });
  });

  socket.on("stop-search", () => {
    cleanupUserSession(socket.id);
  });

  socket.on("disconnect", () => {
    cleanupUserSession(socket.id);
    io.emit("online-count", io.engine.clientsCount);
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= BIND TO 0.0.0.0 FOR RENDER ================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`================================================`);
  console.log(`🚀 MeetLoop Server LIVE on port ${PORT}`);
  console.log(`📱 Instant Mobile Number Auto-Matcher: ACTIVE`);
  console.log(`🛡️ Anti-Spam Rate Limiting: ACTIVE`);
  console.log(`🤖 1-Click Inline Buttons: READY`);
  console.log(`📲 GCash Universal Receiver Webhook: READY`);
  console.log(`================================================`);
  pollTelegramUpdates();
});
