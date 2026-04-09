const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { WebcastPushConnection } = require("tiktok-live-connector");
const Game = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const game = new Game(io);

// ── TikTok Live ───────────────────────────────────────────────────────────────

// Put your TikTok username here (without the @)
const TIKTOK_USERNAME = "your_tiktok_username";

const tiktok = new WebcastPushConnection(TIKTOK_USERNAME);

tiktok.connect()
    .then(() => console.log(`Connected to TikTok Live: @${TIKTOK_USERNAME}`))
    .catch(err => console.warn(`TikTok connection failed: ${err.message}\nGame will still work — use POST /chat to simulate messages.`));

tiktok.on("chat", data => {
    game.handleChatGuess(data.nickname, data.comment);
});

tiktok.on("gift", data => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    game.handleGift(data.nickname);
});

tiktok.on("disconnected", () => {
    console.warn("TikTok disconnected. Attempting to reconnect in 5s…");
    setTimeout(() => tiktok.connect().catch(() => {}), 5000);
});

// ── Express ───────────────────────────────────────────────────────────────────

app.use(express.static("public"));
app.use("/images", express.static(path.join(__dirname, "images")));
app.use(express.json());

// ── Localhost-only middleware ─────────────────────────────────────────────────

function localOnly(req, res, next) {
    const ip = req.socket.remoteAddress;
    const ok = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!ok) return res.status(403).send("Forbidden");
    next();
}

app.post("/host/start", localOnly, (req, res) => {
    game.hostStart(req.body);
    res.json({ ok: true });
});

app.post("/host/reset", localOnly, (req, res) => {
    game.hostReset();
    res.json({ ok: true });
});

app.post("/host/pause", localOnly, (req, res) => {
    game.hostPause();
    res.json({ ok: true });
});

app.post("/host/resume", localOnly, (req, res) => {
    game.hostResume();
    res.json({ ok: true });
});

app.post("/host/config", localOnly, (req, res) => {
    const { roundTime, maxBonusRounds, autoplay } = req.body;
    if (roundTime      != null) game.hostSetRoundTime(roundTime);
    if (maxBonusRounds != null) game.hostSetBonusRounds(maxBonusRounds);
    if (autoplay       != null) game.hostSetAutoplay(autoplay);
    res.json({ ok: true });
});

// Test-only routes — localhost only
app.get("/test", localOnly, (req, res) => {
    res.sendFile(path.join(__dirname, "test.html"));
});

// Host panel
app.get("/host", localOnly, (req, res) => {
    res.sendFile(path.join(__dirname, "host.html"));
});

app.post("/chat", localOnly, (req, res) => {
    const { username, message } = req.body;
    if (username && message) game.handleChatGuess(username, message);
    res.json({ ok: true });
});

app.post("/gift", localOnly, (req, res) => {
    const { username } = req.body;
    if (username) game.handleGift(username);
    res.json({ ok: true });
});



server.listen(3000, () => {
    console.log("SWYS running — open http://localhost:3000");
});
