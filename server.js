const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let waitingUser = null;

function broadcastOnlineCount() {
    io.emit("online-count", io.engine.clientsCount);
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    broadcastOnlineCount();

    socket.on("skip", () => {
        if (socket.partnerId) {
            const oldPartner = io.sockets.sockets.get(socket.partnerId);

            if (oldPartner) {
                oldPartner.partnerId = null;
                oldPartner.emit("partner-disconnected");
            }

            socket.partnerId = null;
        }

        if (waitingUser === socket) return;

        if (!waitingUser) {
            waitingUser = socket;
            socket.emit("waiting");
            console.log("Waiting:", socket.id);
            return;
        }

        const partner = waitingUser;
        waitingUser = null;

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

        if (partner) {
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
        }

        broadcastOnlineCount();
    });
});

const PORT = 3000;

server.listen(PORT, () => {
    console.log(`MeetLoop is running at http://localhost:${PORT}`);
});