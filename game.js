const fs = require("fs");
const path = require("path");
const levenshtein = require("fast-levenshtein");

const DEFAULT_ROUND_TIME    = 20000;
const DEFAULT_BONUS_TIME    = 10000;
const DEFAULT_BONUS_ROUNDS  = 5;

function normalize(text) {
    return text
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function answerFromFilename(file) {
    return normalize(path.parse(file).name.replace(/_/g, " "));
}

class Game {
    constructor(io) {
        this.io = io;
        this.players = {};
        this.puzzles = this.loadPuzzles();
        this.usedPuzzleIndices = [];
        this.currentRound = null;
        this.bonus = null;

        // State
        this.started  = false;
        this.paused   = false;
        this.autoplay = false;

        // Config
        this.roundTime      = DEFAULT_ROUND_TIME;
        this.bonusTime      = DEFAULT_BONUS_TIME;
        this.maxBonusRounds = DEFAULT_BONUS_ROUNDS;
        this.bonusRoundsPlayed = 0;

        // Timers
        this.roundTimer      = null;
        this.bonusGuessTimer = null;

        // Pause tracking
        this.roundEndsAt = null;   // absolute timestamp when round timer fires
        this.bonusEndsAt = null;
    }

    loadPuzzles() {
        return fs.readdirSync("./images").map(file => ({
            file,
            answer: answerFromFilename(file)
        }));
    }

    randomPuzzle() {
        if (this.usedPuzzleIndices.length >= this.puzzles.length) {
            this.usedPuzzleIndices = [];
        }
        const available = this.puzzles
            .map((_, i) => i)
            .filter(i => !this.usedPuzzleIndices.includes(i));
        const idx = available[Math.floor(Math.random() * available.length)];
        this.usedPuzzleIndices.push(idx);
        return this.puzzles[idx];
    }

    // ── Host controls ─────────────────────────────────────────────────────────

    hostStart({ maxBonusRounds, roundTime, autoplay } = {}) {
        if (this.started) return;
        this.maxBonusRounds    = Math.max(1, parseInt(maxBonusRounds) || DEFAULT_BONUS_ROUNDS);
        this.roundTime         = Math.max(5000, parseInt(roundTime) || DEFAULT_ROUND_TIME);
        this.autoplay          = !!autoplay;
        this.bonusRoundsPlayed = 0;
        this.paused            = false;
        this.players           = {};
        this.usedPuzzleIndices = [];
        this.started           = true;
        this.emitHostState();
        setTimeout(() => this.startRound(), 500);
    }

    hostReset() {
        clearTimeout(this.roundTimer);
        clearTimeout(this.bonusGuessTimer);
        this.started           = false;
        this.paused            = false;
        this.currentRound      = null;
        this.bonus             = null;
        this.bonusRoundsPlayed = 0;
        this.players           = {};
        this.usedPuzzleIndices = [];
        this.io.emit("gameReset");
        this.emitHostState();
    }

    hostPause() {
        if (!this.started || this.paused) return;
        this.paused = true;

        // Freeze timers — store remaining time
        if (this.roundTimer && this.currentRound?.active) {
            this.roundRemaining = Math.max(0, this.roundEndsAt - Date.now());
            clearTimeout(this.roundTimer);
            this.roundTimer = null;
        }
        if (this.bonusGuessTimer && this.bonus?.guessOpen) {
            this.bonusRemaining = Math.max(0, this.bonusEndsAt - Date.now());
            clearTimeout(this.bonusGuessTimer);
            this.bonusGuessTimer = null;
        }

        this.io.emit("gamePaused");
        this.emitHostState();
    }

    hostResume() {
        if (!this.started || !this.paused) return;
        this.paused = false;

        // Restore timers with remaining time
        if (this.currentRound?.active && this.roundRemaining != null) {
            this.roundEndsAt = Date.now() + this.roundRemaining;
            this.roundTimer  = setTimeout(() => this.endRound(), this.roundRemaining);
            this.roundRemaining = null;
        }
        if (this.bonus?.guessOpen && this.bonusRemaining != null) {
            this.bonusEndsAt     = Date.now() + this.bonusRemaining;
            this.bonusGuessTimer = setTimeout(() => this._bonusExpire(), this.bonusRemaining);
            this.bonusRemaining  = null;
        }

        this.io.emit("gameResumed");
        this.emitHostState();
    }

    hostSetRoundTime(ms) {
        this.roundTime = Math.max(5000, parseInt(ms) || DEFAULT_ROUND_TIME);
        this.emitHostState();
    }

    hostSetBonusRounds(n) {
        this.maxBonusRounds = Math.max(1, parseInt(n) || DEFAULT_BONUS_ROUNDS);
        this.emitHostState();
    }

    hostSetAutoplay(enabled) {
        this.autoplay = !!enabled;
        this.emitHostState();
    }

    // Emit full host state so the panel stays in sync
    emitHostState() {
        this.io.emit("hostState", {
            started:           this.started,
            paused:            this.paused,
            autoplay:          this.autoplay,
            roundTime:         this.roundTime,
            maxBonusRounds:    this.maxBonusRounds,
            bonusRoundsPlayed: this.bonusRoundsPlayed,
            scores:            this.getBoard()
        });
    }

    // ── Gifts ─────────────────────────────────────────────────────────────────

    handleGift(username) {
        if (!this.started) return;
        if (!this.players[username]) this.players[username] = { score: 0 };
        this.maxBonusRounds++;
        this.io.emit("giftReceived", {
            username,
            maxBonusRounds:    this.maxBonusRounds,
            bonusRoundsPlayed: this.bonusRoundsPlayed
        });
        this.emitHostState();
    }

    // ── Chat guess ────────────────────────────────────────────────────────────

    handleChatGuess(username, message) {
        if (!this.started || this.paused) return;
        if (!this.players[username]) this.players[username] = { score: 0 };

        if (this.bonus?.guessOpen && this.bonus.playerId === username) {
            this.handleBonusGuess(username, message);
        } else if (this.currentRound?.active) {
            this.handleGuess(username, message);
        }
    }

    // ── Main rounds ───────────────────────────────────────────────────────────

    startRound() {
        const puzzle = this.randomPuzzle();
        this.currentRound = { puzzle, winners: [], active: true };

        this.io.emit("roundStart", {
            image:        `/images/${puzzle.file}`,
            time:         this.roundTime,
            bonusWaiting: !!this.bonus
        });

        this.roundEndsAt = Date.now() + this.roundTime;
        this.roundTimer  = setTimeout(() => this.endRound(), this.roundTime);
    }

    handleGuess(username, guess) {
        if (!this.currentRound?.active) return;
        if (this.currentRound.winners.includes(username)) return;

        guess = normalize(guess);
        const dist = levenshtein.get(guess, this.currentRound.puzzle.answer);

        if (dist <= 2) {
            this.currentRound.winners.push(username);
            const position = this.currentRound.winners.length;
            this.io.emit("correctGuess", { username, position });
            this.emitHostState();
            if (position >= 10) this.endRound();
        }
    }

    endRound() {
        if (!this.currentRound?.active) return;
        clearTimeout(this.roundTimer);
        this.currentRound.active = false;

        this.awardPoints();

        this.io.emit("roundEnd", {
            answer:  this.currentRound.puzzle.answer,
            winners: this.currentRound.winners
        });

        this.emitHostState();

        if (this.currentRound.winners.length > 0) {
            setTimeout(() => this.startBonusTurn(this.currentRound.winners[0]), 4000);
        } else {
            setTimeout(() => this.showLeaderboard(), 4000);
        }
    }

    awardPoints() {
        this.currentRound.winners.forEach((username, index) => {
            const points = 10 - index;
            if (points > 0 && this.players[username]) {
                this.players[username].score += points;
            }
        });
    }

    // ── Bonus rounds ──────────────────────────────────────────────────────────

    startBonusTurn(username) {
        if (!this.bonus) {
            this.bonus = {
                puzzle:   this.randomPuzzle(),
                tileOrder: [0,1,2,3,4,5,6,7,8].sort(() => Math.random() - 0.5),
                revealed: [],
                playerId: null,
                guessOpen: false
            };
        }

        this.bonus.playerId  = username;
        this.bonus.guessOpen = false;

        const nextTile = this.bonus.tileOrder[this.bonus.revealed.length];
        this.bonus.revealed.push(nextTile);
        this.bonus.guessOpen = true;

        const tilesLeft   = 9 - this.bonus.revealed.length;
        const bonusPoints = (tilesLeft + 1) * 5;

        this.io.emit("bonusTurn", {
            player:      username,
            image:       `/images/${this.bonus.puzzle.file}`,
            revealed:    [...this.bonus.revealed],
            bonusPoints,
            guessTime:   this.bonusTime
        });

        this.bonusEndsAt     = Date.now() + this.bonusTime;
        this.bonusGuessTimer = setTimeout(() => this._bonusExpire(), this.bonusTime);
    }

    _bonusExpire() {
        if (!this.bonus) return;
        this.bonus.guessOpen = false;
        this.io.emit("bonusGuessExpired");

        if (this.bonus.revealed.length >= 9) {
            this.retireBonus(null, 0, this.bonus.puzzle.answer);
        } else {
            setTimeout(() => this.showLeaderboard(), 2000);
        }
    }

    handleBonusGuess(username, guess) {
        if (!this.bonus?.guessOpen) return;
        if (username !== this.bonus.playerId) return;

        guess = normalize(guess);
        const answer = this.bonus.puzzle.answer;
        const dist   = levenshtein.get(guess, answer);

        if (dist <= 2) {
            clearTimeout(this.bonusGuessTimer);
            this.bonus.guessOpen = false;

            const tilesLeft   = 9 - this.bonus.revealed.length;
            const bonusPoints = (tilesLeft + 1) * 5;

            if (this.players[username]) this.players[username].score += bonusPoints;

            this.retireBonus(username, bonusPoints, answer);
        } else {
            this.io.emit("bonusWrongGuess", { username });
        }
    }

    retireBonus(winner, bonusPoints, answer) {
        this.bonus = null;
        this.bonusRoundsPlayed++;

        this.io.emit("bonusEnd", {
            answer,
            winner:            winner || null,
            bonusPoints:       winner ? bonusPoints : 0,
            bonusRoundsPlayed: this.bonusRoundsPlayed,
            maxBonusRounds:    this.maxBonusRounds
        });

        this.emitHostState();

        const delay = winner ? 3000 : 2000;
        if (this.bonusRoundsPlayed >= this.maxBonusRounds) {
            setTimeout(() => this.gameOver(), delay);
        } else {
            setTimeout(() => this.showLeaderboard(), delay);
        }
    }

    // ── Leaderboard / game over ───────────────────────────────────────────────

    showLeaderboard() {
        this.io.emit("leaderboard", {
            board:             this.getBoard(),
            bonusRoundsPlayed: this.bonusRoundsPlayed,
            maxBonusRounds:    this.maxBonusRounds
        });
        setTimeout(() => this.startRound(), 8000);
    }

    gameOver() {
        this.started = false;
        this.io.emit("gameOver", this.getBoard());

        if (this.autoplay) {
            // Restart automatically after a short pause
            setTimeout(() => {
                this.hostStart({
                    maxBonusRounds: this.maxBonusRounds,
                    roundTime:      this.roundTime,
                    autoplay:       true
                });
            }, 10000);
        }

        this.emitHostState();
    }

    getBoard() {
        return Object.entries(this.players)
            .map(([username, data]) => ({ username, score: data.score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
    }
}

module.exports = Game;
