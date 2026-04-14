const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const MAX_DICE = 5;

let rooms = {};

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

function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function startNewRoundRoom(roomId) {

    const room = rooms[roomId];
    if (!room) return;

    room.currentBet = null;

    gameMessageToRoom(roomId, "סבב חדש התחיל");

    room.players.forEach(p => {
        p.dice = rollDice(p.dice.length);
        io.to(p.id).emit("yourDice", p.dice);
    });

    io.to(roomId).emit("updateBet", null);

    emitRoomState(roomId);
}

function gameMessageToRoom(roomId, text) {
    io.to(roomId).emit("gameMessage", text);
}

function emitRoomState(roomId) {

    const room = rooms[roomId];
    if (!room) return;

    const totalDice = room.players.reduce((sum, p) => sum + p.dice.length, 0);

    io.to(roomId).emit("gameState", {
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            diceCount: p.dice.length
        })),

        turnPlayerId: room.players.length
            ? room.players[room.turnIndex].id
            : null,

        gameOver: room.gameOver,
        gameStarted: room.gameStarted,
        hostId: room.hostId,

        stats: {
            totalDice,
            expected: totalDice / 3
        }
    });
}

function checkWinnerRoom(roomId) {

    const room = rooms[roomId];
    if (!room) return;

    if (room.players.length === 1) {

        room.gameOver = true;

        io.to(roomId).emit("gameOver", {
            winner: room.players[0].name
        });

        setTimeout(() => {
            delete rooms[roomId];
        }, 10000);
    }
}

function removeDice(player, amount = 1) {

    if (!player) return;

    player.dice.splice(0, amount);
}

io.on("connection", (socket) => {

    socket.on("joinRoom", (name, roomId) => {

    const room = rooms[roomId];
    if (!room) return;

    if (room.gameStarted) return;
    if (room.players.find(p => p.id === socket.id)) return;

    room.players.push({
        id: socket.id,
        name,
        dice: rollDice()
    });

    socket.join(roomId);

    gameMessageToRoom(roomId, name + " הצטרף לחדר");

    if (!room.hostId) {
        room.hostId = socket.id;
    }

    emitRoomState(roomId);

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
        socket.emit("yourDice", player.dice);
    }
});

    socket.on("startGame", (roomId) => {

    const room = rooms[roomId];
    if (!room) return;

    if (socket.id !== room.hostId) return;
    if (room.players.length < 2) return;
    if (room.gameStarted) return;

    room.gameStarted = true;
    room.gameOver = false;
    room.currentBet = null;

    gameMessageToRoom(roomId, "המשחק התחיל!");

    room.players.forEach(p => {
        p.dice = rollDice();
        io.to(roomId).emit("yourDice", p.dice);
    });

    room.turnIndex = 0;

    emitRoomState(roomId);
});

   socket.on("placeBet", (bet, roomId) => {

    const room = rooms[roomId];
    if (!room) return;

    if (room.gameOver || !room.gameStarted) return;
    if (!room.players.length) return;

    // בדיקת תור
    if (room.players[room.turnIndex].id !== socket.id) return;

    if (!bet || !bet.count || !bet.number) return;
    if (bet.number < 2 || bet.number > 6) return;
    if (bet.count < 1) return;

    // בדיקת סך קוביות
    const totalDice = room.players.reduce(
        (sum, p) => sum + p.dice.length,
        0
    );

    if (bet.count > totalDice) return;

    // בדיקת חוקיות הימור מול הקודם
    if (room.currentBet) {

        const old = room.currentBet;

        const valid =
            bet.count > old.count ||
            (bet.count === old.count && bet.number > old.number);

        if (!valid) return;
    }

    // שמירת ההימור
    room.currentBet = {
        playerId: socket.id,
        playerName: room.players.find(p => p.id === socket.id).name,
        count: bet.count,
        number: bet.number
    };

    gameMessageToRoom(
        roomId,
        `${room.currentBet.playerName} הימר ${bet.count} פעמים ${bet.number}`
    );

    io.to(roomId).emit("updateBet", room.currentBet);

    // מעבר תור
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    emitRoomState(roomId);
});

   socket.on("halfToJoker", (roomId) => {

    const room = rooms[roomId];
    if (!room) return;
    if (!room || !room.currentBet) return;

    if (room.players[room.turnIndex].id !== socket.id) return;

    const newCount = Math.ceil(room.currentBet.count / 2);

    room.currentBet = {
        playerId: socket.id,
        playerName: room.players.find(p => p.id === socket.id).name,
        count: newCount,
        number: 1
    };

    io.to(roomId).emit("updateBet", room.currentBet);

    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    emitRoomState(roomId);
});

   socket.on("backToNormal", (number, roomId) => {

    const room = rooms[roomId];
    if (!room) return;
    if (!room || !room.currentBet) return;

    if (room.players[room.turnIndex].id !== socket.id) return;

    if (room.currentBet.number !== 1) return;
    if (number < 2 || number > 6) return;

    room.currentBet = {
        playerId: socket.id,
        playerName: room.players.find(p => p.id === socket.id).name,
        count: room.currentBet.count * 2 + 1,
        number
    };

    io.to(roomId).emit("updateBet", room.currentBet);

    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    emitRoomState(roomId);
});

   socket.on("callLiar", (roomId) => {

    const room = rooms[roomId];
    if (!room) return;
    if (!room || !room.currentBet) return;

    const caller = room.players.find(p => p.id === socket.id);
    const bettor = room.players.find(p => p.id === room.currentBet.playerId);

    if (!caller || !bettor) return;

    // חושפים קוביות לכולם
    io.to(roomId).emit("revealDice", room.players.map(p => ({
        name: p.name,
        dice: p.dice
    })));

    const total = countDice(room.players, room.currentBet.number);

    gameMessageToRoom(roomId, `${caller.name} קרא שקר!`);

    let loser = total < room.currentBet.count ? bettor : caller;

    if (loser) {
        gameMessageToRoom(roomId, `${loser.name} הפסיד קובייה`);
        removeDice(loser, 1);
    }

    // מחיקת שחקנים בלי קוביות
    room.players = room.players.filter(p => p.dice.length > 0);

    // תיקון תור
   if (room.players.length > 0) {
    room.turnIndex = room.turnIndex % room.players.length;
} else {
    delete rooms[roomId];
    return;
}

    checkWinnerRoom(roomId);

    if (!room.gameOver && room.players.length > 0) {
        startNewRoundRoom(roomId);
    }

    emitRoomState(roomId);
    io.to(roomId).emit("updateBet", null);
});

  socket.on("callExact", (roomId) => {

    const room = rooms[roomId];
    if (!room || !room.currentBet) return;

    const caller = room.players.find(p => p.id === socket.id);
    if (!caller) return;

    const total = countDice(room.players, room.currentBet.number);

    io.to(roomId).emit("revealDice", room.players.map(p => ({
        name: p.name,
        dice: p.dice
    })));

    gameMessageToRoom(roomId, `${caller.name} אמר בול!`);

    if (total === room.currentBet.count) {

        gameMessageToRoom(roomId, `${caller.name} צדק וקיבל קובייה`);

        if (caller.dice.length < MAX_DICE) {
            caller.dice.push(1);
        }

    } else {

        gameMessageToRoom(roomId, `${caller.name} טעה והפסיד קובייה`);
        removeDice(caller, 1);
    }

    room.players = room.players.filter(p => p.dice.length > 0);

    if (room.turnIndex >= room.players.length) {
        room.turnIndex = 0;
    }

    checkWinnerRoom(roomId);

    if (!room.gameOver && room.players.length > 0) {
        startNewRoundRoom(roomId);
    }

    emitRoomState(roomId);
    io.to(roomId).emit("updateBet", null);
});

   socket.on("createRoom", (name, callback) => {

    const roomId = generateRoomId();

    rooms[roomId] = {
        players: [],
        currentBet: null,
        turnIndex: 0,
        gameOver: false,
        gameStarted: false,
        hostId: socket.id
    };

    rooms[roomId].players.push({
        id: socket.id,
        name,
        dice: rollDice()
    });

    socket.join(roomId);

    callback(roomId);

    gameMessageToRoom(roomId, name + " יצר חדר");

    emitRoomState(roomId);

    const player = rooms[roomId].players.find(p => p.id === socket.id);

    if (player) {
    socket.emit("yourDice", player.dice);}
});

   socket.on("disconnect", () => {

    // לעבור על כל החדרים ולמצוא איפה השחקן נמצא
    for (const roomId in rooms) {

        const room = rooms[roomId];

        const playerIndex = room.players.findIndex(p => p.id === socket.id);

        if (playerIndex !== -1) {

            const wasHost = room.hostId === socket.id;

            // מחיקת השחקן
            room.players.splice(playerIndex, 1);

            gameMessageToRoom(roomId, "שחקן עזב את המשחק");

            // אם אין שחקנים בכלל → מוחקים חדר
            if (room.players.length === 0) {
                delete rooms[roomId];
                return;
            }

            // אם ה-host עזב → ממנים חדש
            if (wasHost) {
                room.hostId = room.players[0].id;
                gameMessageToRoom(roomId, "הוסט חדש מונה");
            }

            // תיקון תור אם צריך
            if (room.turnIndex >= room.players.length) {
                room.turnIndex = 0;
            }

            emitRoomState(roomId);
            break;
        }
    }
	});
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});