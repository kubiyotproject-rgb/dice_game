const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const MAX_DICE = 5;

let players = [];
let currentBet = null;
let turnIndex = 0;
let gameOver = false;
let gameStarted = false;

function rollDice(count = MAX_DICE) {
    return Array.from({ length: count }, () =>
        Math.floor(Math.random() * 6) + 1
    );
}

function countDice(players, target) {
    let total = 0;

    for (const p of players) {
        for (const d of p.dice) {
            if (d === target || d === 1) total++;
        }
    }

    return total;
}

function isMyTurn(socket) {
    return players.length && players[turnIndex].id === socket.id;
}

function emitGameState() {

    const totalDice = players.reduce((sum, p) => sum + p.dice.length, 0);

    io.emit("gameState", {
        players: players.map(p => ({
            id: p.id,
            name: p.name,
            diceCount: p.dice.length
        })),
        turnPlayerId: players.length ? players[turnIndex].id : null,
        gameOver,
        stats: {
            totalDice,
            expected: totalDice / 3
        }
    });
}

function startNewRound(nextStarter = 0) {
	
	gameMessage("סבב חדש התחיל");
	
    currentBet = null;

    players.forEach(p => {
        p.dice = rollDice(p.dice.length);
        io.to(p.id).emit("yourDice", p.dice);
    });

    turnIndex = nextStarter % players.length;

    io.emit("updateBet", null);

    emitGameState();
}

function gameMessage(text) {
    io.emit("gameMessage", text);
}

function checkWinner() {
    if (players.length === 1) {
        gameOver = true;
        io.emit("gameOver", { winner: players[0].name });
    }
}

function removeDice(player, amount = 1) {

    if (!player) return;

    player.dice.splice(0, amount);

    if (player.dice.length < 0) player.dice = [];
}

io.on("connection", (socket) => {

socket.on("startGame", () => {

    if (gameStarted) return;
    if (players.length < 2) return;

    gameStarted = true;

    gameMessage("המשחק התחיל!");

    startNewRound(0);

    emitGameState();
	});

    socket.on("joinGame", (name) => {

    if (gameStarted) return; //חסימת הצטרפות אחרי התחלה

    if (!name) return;
    if (players.find(p => p.id === socket.id)) return;

    players.push({
        id: socket.id,
        name,
        dice: rollDice()
    });

    gameMessage(name + " הצטרף למשחק");

    emitGameState();

    socket.emit("yourDice",
        players.find(p => p.id === socket.id).dice
    );
	});

    socket.on("placeBet", (bet) => {

    if (gameOver) return;
    if (!isMyTurn(socket)) return;

    if (!bet || !bet.count || !bet.number) return;

    if (bet.number < 2 || bet.number > 6) return;
    if (bet.count < 1) return;

    // סך כל הקוביות במשחק
    const totalDice = players.reduce(
        (sum, p) => sum + p.dice.length,
        0
    );

    if (bet.count > totalDice) return;

    if (currentBet) {

        const oldCount = currentBet.count;
        const oldNumber = currentBet.number;

        const newCount = bet.count;
        const newNumber = bet.number;

        const valid =
            (newCount > oldCount) ||
            (newCount === oldCount && newNumber > oldNumber);

        if (!valid) return;
    }

    currentBet = {
        playerId: socket.id,
        playerName: players.find(p => p.id === socket.id).name,
        count: bet.count,
        number: bet.number
    };
	
	gameMessage(
    	currentBet.playerName +
    	" הימר " +
    	currentBet.count +
    	" פעמים " +
    	currentBet.number
	);
	
    io.emit("updateBet", currentBet);

    turnIndex = (turnIndex + 1) % players.length;

    emitGameState();
	});

    socket.on("halfToJoker", () => {

        if (!currentBet) return;
        if (!isMyTurn(socket)) return;

        const newCount = Math.ceil(currentBet.count / 2);

        currentBet = {
            playerId: socket.id,
            playerName: players.find(p => p.id === socket.id).name,
            count: newCount,
            number: 1
        };

        io.emit("updateBet", currentBet);

        turnIndex = (turnIndex + 1) % players.length;

        emitGameState();
    });

    socket.on("backToNormal", (number) => {

        if (!currentBet) return;
        if (!isMyTurn(socket)) return;

        if (currentBet.number !== 1) return;
        if (number < 2 || number > 6) return;

        currentBet = {
            playerId: socket.id,
            playerName: players.find(p => p.id === socket.id).name,
            count: currentBet.count * 2 + 1,
            number
        };

        io.emit("updateBet", currentBet);

        turnIndex = (turnIndex + 1) % players.length;

        emitGameState();
    });

    socket.on("callLiar", () => {

    if (!currentBet) return;

    const caller = players.find(p => p.id === socket.id);
    const bettor = players.find(p => p.id === currentBet.playerId);

    if (!caller || !bettor) return;

    io.emit("revealDice", players.map(p => ({
        name: p.name,
        dice: p.dice
    })));

    const total = countDice(players, currentBet.number);

    gameMessage(caller.name + " קרא שקר!");

    let loser;

    if (total < currentBet.count) {
        loser = bettor;
    } else {
        loser = caller;
    }

    if (loser) {
        gameMessage(loser.name + " הפסיד קובייה");
        removeDice(loser, 1);
    }

    players = players.filter(p => p.dice.length > 0);

    if (turnIndex >= players.length) turnIndex = 0;

    checkWinner();

    if (!gameOver && players.length > 0) {
        startNewRound(turnIndex);
    }

    emitGameState();
    io.emit("updateBet", null);
	});

    socket.on("callExact", () => {

    if (!currentBet) return;

    const caller = players.find(p => p.id === socket.id);
    if (!caller) return;

    const total = countDice(players, currentBet.number);

    io.emit("revealDice", players.map(p => ({
        name: p.name,
        dice: p.dice
    })));

    gameMessage(caller.name + " אמר בול!");

    let correct = total === currentBet.count;

    if (correct) {

        gameMessage(caller.name + " צדק וקיבל קובייה");

        if (caller.dice.length < MAX_DICE) {
            caller.dice.push(1);
        }

    } else {

        gameMessage(caller.name + " טעה והפסיד קובייה");
        removeDice(caller, 1);
    }

    players = players.filter(p => p.dice.length > 0);

    if (turnIndex >= players.length) turnIndex = 0;

    checkWinner();

    if (!gameOver && players.length > 0) {
        startNewRound(turnIndex);
    }

    emitGameState();
    io.emit("updateBet", null);
	});

    socket.on("disconnect", () => {

        players = players.filter(p => p.id !== socket.id);

        if (turnIndex >= players.length) turnIndex = 0;

        checkWinner();

        emitGameState();
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});