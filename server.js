const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(cors());

// Serve money.html at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'money.html'));
});

// Serve static assets from the root directory
app.use(express.static(__dirname));

// In-memory data stores for testing
let waitingQueues = {
    'Micro Lounge': [],
    'Bronze Lounge': [],
    'Silver Arena': [],
    'Gold Chamber': []
};
let activeRooms = {};
let houseRevenue = 0;
let incomeLogs = [];
let withdrawalLogs = [];
let supportTickets = [];

// ==========================================
// PAYSTACK PAYMENT INITIALIZATION ROUTE
// ==========================================
app.post('/initialize-payment', async (req, res) => {
    try {
        const { email, amount } = req.body; // amount in Naira

        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100 // Paystack expects amount in kobo
            },
            {
                headers: {
                    // Replace with your actual Test Secret Key from Paystack Dashboard
                    Authorization: `Bearer sk_test_YOUR_ACTUAL_SECRET_KEY`, 
                    'Content-Type': 'application/json'
                }
            }
        );

        return res.status(200).json({
            success: true,
            data: response.data.data
        });
    } catch (error) {
        console.error('Payment initialization error:', error.response?.data || error.message);
        return res.status(500).json({ success: false, message: 'Initialization failed' });
    }
});

// ==========================================
// SOCKET.IO REAL-TIME MULTIPLAYER & ADMIN EVENTS
// ==========================================
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Join Matchmaking Queue
    socket.on('join_queue', (data) => {
        const { username, stake } = data;
        let groupName = 'Micro Lounge';
        if (stake === 500) groupName = 'Bronze Lounge';
        else if (stake === 1000) groupName = 'Silver Arena';
        else if (stake === 5000) groupName = 'Gold Chamber';

        if (!waitingQueues[groupName]) {
            waitingQueues[groupName] = [];
        }

        waitingQueues[groupName].push({ socketId: socket.id, username: username, stake: stake });

        // Matchmaking logic: Check if 2 players are in the queue
        if (waitingQueues[groupName].length >= 2) {
            let player1 = waitingQueues[groupName].shift();
            let player2 = waitingQueues[groupName].shift();

            let roomId = 'room_' + Math.random().toString(36).substring(2, 9);
            
            // Randomly select a winning index out of 40 boxes and a target emoji
            const targetEmojis = ['💎', '👑', '🪙', '💰', '🔑', '⭐', '🎁'];
            let targetEmoji = targetEmojis[Math.floor(Math.random() * targetEmojis.length)];
            let winningIndex = Math.floor(Math.random() * 40);

            activeRooms[roomId] = {
                players: [player1.username, player2.username],
                stake: stake,
                targetEmoji: targetEmoji,
                winningIndex: winningIndex,
                turn: player1.username
            };

            // Join both sockets to the room
            io.sockets.sockets.get(player1.socketId)?.join(roomId);
            io.sockets.sockets.get(player2.socketId)?.join(roomId);

            // Broadcast match found to room
            io.to(roomId).emit('match_found', {
                roomId: roomId,
                players: [player1.username, player2.username],
                targetEmoji: targetEmoji,
                winningIndex: winningIndex
            });
        }
    });

    // Leave Queue Handler
    socket.on('leave_queue', (data) => {
        for (let group in waitingQueues) {
            waitingQueues[group] = waitingQueues[group].filter(p => p.username !== data.username);
        }
    });

    // Gameplay Turn Handling
    socket.on('play_turn', (data) => {
        const { roomId, username, index, decoyEmoji } = data;
        let room = activeRooms[roomId];
        if (room) {
            // Broadcast opponent's move to the other player in the room
            socket.to(roomId).emit('opponent_played', {
                index: index,
                decoyEmoji: decoyEmoji,
                nextTurn: room.players.find(p => p !== username)
            });
        }
    });

    // Player Won Handler
    socket.on('player_won', (data) => {
        const { roomId, winner } = data;
        let room = activeRooms[roomId];
        if (room) {
            let totalPool = room.stake * 2;
            let commission = totalPool * 0.05; // 5% House Revenue
            
            houseRevenue += commission;
            incomeLogs.unshift({
                type: 'COMMISSION',
                description: `5% fee from ${room.stake * 2} pool (${winner} won)`,
                amount: commission,
                date: new Date().toLocaleString()
            });

            io.to(roomId).emit('game_over', { winner: winner });
            delete activeRooms[roomId];
        }
    });

    // Admin Hub Endpoints
    socket.on('get_house_revenue', (callback) => {
        callback({
            revenue: houseRevenue,
            incomeLogs: incomeLogs,
            withdrawalLogs: withdrawalLogs
        });
    });

    socket.on('admin_withdraw', (data, callback) => {
        const { amount, bankName, accountNumber } = data;
        if (amount > houseRevenue) {
            callback({ success: false, message: 'Insufficient house revenue balance.' });
            return;
        }

        houseRevenue -= amount;
        withdrawalLogs.unshift({
            amount: amount,
            bankName: bankName,
            accountNumber: accountNumber,
            date: new Date().toLocaleString()
        });

        callback({
            success: true,
            message: `Successfully withdrawn ₦${amount.toLocaleString()} to ${bankName} (${accountNumber})`,
            newRevenue: houseRevenue
        });
    });

    // Support Ticket Handling
    socket.on('submit_support_ticket', (data, callback) => {
        const ticketId = 'TICK_' + Math.floor(1000 + Math.random() * 9000);
        supportTickets.unshift({
            id: ticketId,
            username: data.username,
            category: data.category,
            message: data.message,
            status: 'Pending',
            date: new Date().toLocaleString()
        });
        callback({ success: true, ticketId: ticketId });
    });

    socket.on('get_support_tickets', (callback) => {
        callback({ tickets: supportTickets });
    });

    socket.on('resolve_ticket', (ticketId, callback) => {
        let ticket = supportTickets.find(t => t.id === ticketId);
        if (ticket) {
            ticket.status = 'Resolved';
            callback({ success: true });
        } else {
            callback({ success: false });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        for (let group in waitingQueues) {
            waitingQueues[group] = waitingQueues[group].filter(p => p.socketId !== socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Emoji Treasure Hunt server running smoothly on port ${PORT}`);
});