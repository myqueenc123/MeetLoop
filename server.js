const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// Inayos: Nilagyan ng CORS para gumana kahit i-test sa ibang device o IP
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

let waitingUser = null;

// Inayos: Mas accurate ang sockets.size kaysa sa engine.clientsCount
function broadcastOnlineCount() {
    io.emit("online-count", io.sockets.sockets.size);
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    broadcastOnlineCount();

    socket.on("skip", () => {
        // 1. Putulin muna ang koneksyon sa lumang partner kung meron man
        if (socket.partnerId) {
            const oldPartner = io.sockets.sockets.get(socket.partnerId);

            if (oldPartner) {
                oldPartner.partnerId = null;
                oldPartner.emit("partner-disconnected");
            }
            socket.partnerId = null;
        }

        // Kung siya na mismo ang kasalukuyang naghihintay, huwag nang ulitin
        if (waitingUser === socket) return;

        // INAYOS: Check kung ang naghihintay ay disconnected na pala (Ghost User Fix)
        if (waitingUser && !waitingUser.connected) {
            waitingUser = null;
        }

        // Kung walang naghihintay, siya ang magiging waitingUser
        if (!waitingUser) {
            waitingUser = socket;
            socket.emit("waiting");
            console.log("Waiting in line:", socket.id);
            return;
        }

        // Kung may naghihintay at buhay pa ang connection, ipares sila
        const partner = waitingUser;
        waitingUser = null;

        // Proteksyon para hindi maipares ang sarili sa sarili
        if (partner.id === socket.id) {
            waitingUser = socket;
            socket.emit("waiting");
            return;
        }

        socket.partnerId = partner.id;
        partner.partnerId = socket.id;

        partner.emit("match", { initiator: true });
        socket.emit("match", { initiator: false });

        console.log("Matched:", partner.id, "<->", socket.id);
    });

    socket.on("stop-search", () => {
        if (waitingUser === socket) {
            waitingUser = null;
            console.log("Stopped searching:", socket.id);
        }

        if (socket.partnerId) {
            const oldPartner = io.sockets.sockets.get(socket.partnerId);

            if (oldPartner) {
                oldPartner.partnerId = null;
                oldPartner.emit("partner-disconnected");
            }
            socket.partnerId = null;
        }
    });

    socket.on("signal", (data) => {
        if (!socket.partnerId) return;

        const partner = io.sockets.sockets.get(socket.partnerId);

        // INAYOS: Siguraduhing buhay pa ang socket ng partner bago mag-send ng video signal
        if (partner && partner.connected) {
            partner.emit("signal", data);
        }
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);

        if (waitingUser === socket) {
            waitingUser = null;
        }

        if (socket.partnerId) {
            const partner = io.sockets.sockets.get(socket.partnerId);

            if (partner) {
                partner.partnerId = null;
                partner.emit("partner-disconnected");
            }
            socket.partnerId = null;
        }

        broadcastOnlineCount();
    });
});

// INAYOS: process.env.PORT para ready kapag in-upload online (e.g. Render/Railway)
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`MeetLoop is running at http://localhost:${PORT}`);
});
