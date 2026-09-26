const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files / money.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'money.html'));
});

// Paystack Secret Key provided
const PAYSTACK_SECRET_KEY = 'sk_test_a89bb1d0da69c502d735d9df85a247a09c351972';

// Payment Initialization Route for Paystack
app.post('/initialize-payment', (req, res) => {
    const { email, amount } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ success: false, message: 'Email and amount are required.' });
    }

    const params = JSON.stringify({
        email: email,
        amount: amount * 100 // Convert Naira to Kobo
    });

    const options = {
        hostname: 'api.paystack.co',
        port: 443,
        path: '/transaction/initialize',
        method: 'POST',
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
        }
    };

    const reqPaystack = https.request(options, apiRes => {
        let data = '';

        apiRes.on('data', chunk => {
            data += chunk;
        });

        apiRes.on('end', () => {
            try {
                const response = JSON.parse(data);
                if (response.status) {
                    res.json({ success: true, data: response.data });
                } else {
                    res.status(400).json({ success: false, message: response.message || 'Initialization failed' });
                }
            } catch (e) {
                res.status(500).json({ success: false, message: 'Invalid response from Paystack API' });
            }
        });
    });

    reqPaystack.on('error', error => {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server connection error to Paystack' });
    });

    reqPaystack.write(params);
    reqPaystack.end();
});

// In-Memory Database / Game State Variables
let waitingPlayers = [];
let activeRooms = {};
let houseRevenue = 0;
let incomeLogs = [];
let withdrawalLogs = [];
let supportTickets = [];

// Socket.io Game Logic & Management
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join_queue', (data) => {
        const { username, stake } = data;
        
        // Remove player if already in queue
        waitingPlayers = waitingPlayers.filter(p => p.username !== username);

        waitingPlayers.push({ socketId: socket.id, username, stake });
        console.log(`${username} joined queue with stake ₦${stake}`);

        // Check if we have at least 2 players for a match
        if (waitingPlayers.length >= 2) {
            const player1 = waitingPlayers.shift();
            const player2 = waitingPlayers.shift();

            const roomId = 'room_' + Date.now();
            const targetEmojis = ['💎', '🔑', '👑', '🪙', '🏆'];
            const targetEmoji = targetEmojis[Math.floor(Math.random() * targetEmojis.length)];
            const winningIndex = Math.floor(Math.random() * 40); // 40 boxes grid

            activeRooms[roomId] = {
                players: [player1.username, player2.username],
                stake: player1.stake,
                targetEmoji,
                winningIndex,
                turn: player1.username
            };

            io.to(player1.socketId).emit('match_found', { roomId, players: [player1.username, player2.username], targetEmoji, winningIndex });
            io.to(player2.socketId).emit('match_found', { roomId, players: [player1.username, player2.username], targetEmoji, winningIndex });

            console.log(`Match created in room ${roomId} between ${player1.username} and ${player2.username}`);
        }
    });

    socket.on('play_turn', (data) => {
        const { roomId, username, index, decoyEmoji } = data;
        const room = activeRooms[roomId];
        if (room) {
            socket.broadcast.emit('opponent_played', { index, decoyEmoji });
        }
    });

    socket.on('player_won', (data) => {
        const { roomId, winner } = data;
        const room = activeRooms[roomId];
        if (room) {
            let houseCut = room.stake * 2 * 0.05; // 5% house commission
            houseRevenue += houseCut;
            
            incomeLogs.unshift({
                type: 'COMMISSION',
                description: `5% fee from ${room.stake * 2} pool match`,
                amount: houseCut,
                date: new Date().toLocaleString()
            });

            io.emit('game_over', { winner });
            delete activeRooms[roomId];
        }
    });

    socket.on('leave_queue', (data) => {
        const { username } = data;
        waitingPlayers = waitingPlayers.filter(p => p.username !== username);
    });

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
            amount,
            bankName,
            accountNumber,
            date: new Date().toLocaleString()
        });

        callback({ success: true, message: `Successfully withdrew ₦${amount.toLocaleString()} to ${bankName} (${accountNumber})`, newRevenue: houseRevenue });
    });

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
        callback({ success: true, ticketId });
    });

    socket.on('get_support_tickets', (callback) => {
        callback({ tickets: supportTickets });
    });

    socket.on('resolve_ticket', (ticketId, callback) => {
        const ticket = supportTickets.find(t => t.id === ticketId);
        if (ticket) {
            ticket.status = 'Resolved';
            callback({ success: true });
        } else {
            callback({ success: false });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        waitingPlayers = waitingPlayers.filter(p => p.socketId !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running live on port ${PORT}`);
});