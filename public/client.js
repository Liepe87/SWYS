const socket = io();

let timerInterval = null;
let roundNumber = 0;

// ── Screens ───────────────────────────────────────────────────────────────────

function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}

// ── Title ─────────────────────────────────────────────────────────────────────

document.getElementById("btn-start").addEventListener("click", async () => {
    const maxBonusRounds = parseInt(document.getElementById("round-count").value) || 5;
    await fetch("/host/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxBonusRounds })
    });
});

document.getElementById("btn-again").addEventListener("click", async () => {
    await fetch("/host/reset", { method: "POST" });
});

socket.on("gameReset", () => {
    roundNumber = 0;
    showScreen("screen-title");
});

socket.on("gamePaused", () => {
    stopTimer();
    showToast("⏸ Game paused");
});

socket.on("gameResumed", () => {
    showToast("▶ Game resumed");
});



socket.on("giftReceived", ({ username, maxBonusRounds, bonusRoundsPlayed }) => {
    const remaining = maxBonusRounds - bonusRoundsPlayed;
    showToast(`🎁 ${username} sent a gift! +1 bonus round (${remaining} remaining)`);
});



socket.on("roundStart", ({ image, time }) => {
    roundNumber++;
    document.getElementById("round-num").innerText = roundNumber;
    document.getElementById("puzzle-img").src = image;
    document.getElementById("correct-count").innerText = "0 / 10 correct";
    document.getElementById("round-answer").innerText = "";
    document.getElementById("guess-feed").innerHTML = "";
    showScreen("screen-game");
    startTimer("game-timer", time);
});

socket.on("correctGuess", ({ username, position }) => {
    document.getElementById("correct-count").innerText = `${position} / 10 correct`;

    const feed = document.getElementById("guess-feed");
    const item = document.createElement("div");
    item.className = "guess-item";
    item.innerText = `#${position} ${username}`;
    feed.prepend(item);

    // Keep only last 4 visible
    while (feed.children.length > 4) feed.removeChild(feed.lastChild);
});

socket.on("roundEnd", ({ answer, winners }) => {
    stopTimer();
    document.getElementById("round-answer").innerText = `Answer: ${answer}`;
});

// ── Bonus ─────────────────────────────────────────────────────────────────────

socket.on("bonusTurn", ({ player, image, revealed, bonusPoints, guessTime }) => {
    document.getElementById("bonus-player").innerText = player;
    document.getElementById("bonus-img").src = image;
    document.getElementById("bonus-pts").innerText = `+${bonusPoints} pts available`;
    document.getElementById("bonus-feedback").innerText = "";
    renderTiles(revealed);
    showScreen("screen-bonus");
    startTimer("bonus-timer", guessTime);
});

socket.on("bonusGuessExpired", () => {
    stopTimer();
    document.getElementById("bonus-feedback").innerText = "Time's up! Next round winner gets a turn…";
    document.getElementById("bonus-pts").innerText = "";
});

socket.on("bonusWrongGuess", ({ username }) => {
    document.getElementById("bonus-feedback").innerText = `✗ ${username} — not quite!`;
});

socket.on("bonusEnd", ({ answer, winner, bonusPoints }) => {
    stopTimer();
    renderTiles([0,1,2,3,4,5,6,7,8]);
    if (winner) {
        document.getElementById("bonus-feedback").innerText = `🎉 ${winner} got it! +${bonusPoints} pts`;
        document.getElementById("bonus-pts").innerText = "";
    } else {
        document.getElementById("bonus-feedback").innerText = `Nobody got it! Answer: ${answer}`;
        document.getElementById("bonus-pts").innerText = "";
    }
});

function renderTiles(revealed) {
    for (let i = 0; i < 9; i++) {
        document.getElementById(`tile-${i}`).classList.toggle("removed", revealed.includes(i));
    }
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

socket.on("leaderboard", ({ board, bonusRoundsPlayed, maxBonusRounds }) => {
    stopTimer();
    buildList("lb-list", board);
    document.getElementById("lb-progress").innerText =
        `Catchphrase round ${bonusRoundsPlayed} of ${maxBonusRounds}`;

    let secs = 8;
    document.getElementById("lb-countdown").innerText = secs;
    const cd = setInterval(() => {
        secs--;
        document.getElementById("lb-countdown").innerText = secs;
        if (secs <= 0) clearInterval(cd);
    }, 1000);

    showScreen("screen-leaderboard");
});

// ── Game over ─────────────────────────────────────────────────────────────────

socket.on("gameOver", board => {
    stopTimer();
    buildList("gameover-list", board);
    showScreen("screen-gameover");
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}

function buildList(listId, board) {
    const medals = ["🥇","🥈","🥉"];
    const ul = document.getElementById(listId);
    ul.innerHTML = "";
    board.forEach((p, i) => {
        const li = document.createElement("li");
        if (i === 0) li.classList.add("winner");
        li.innerHTML = `
            <span class="lb-rank">${medals[i] || i + 1}</span>
            <span class="lb-name">${p.username}</span>
            <span class="lb-score">${p.score}</span>
        `;
        ul.appendChild(li);
    });
}

function startTimer(elId, ms) {
    stopTimer();
    const el = document.getElementById(elId);
    let remaining = ms;
    function tick() {
        const secs = Math.ceil(remaining / 1000);
        el.innerText = secs;
        el.className = "timer" + (secs <= 5 ? " urgent" : "");
        remaining -= 100;
        if (remaining < 0) remaining = 0;
    }
    tick();
    timerInterval = setInterval(tick, 100);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
}
