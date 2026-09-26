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

// Dynamic Bank List Route (Fetches all banks live from Paystack)
app.get('/get-banks', (req, res) => {
    const options = {
        hostname: 'api.paystack.co',
        port: 443,
        path: '/bank?country=nigeria',
        method: 'GET',
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
    };

    const reqPaystack = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try {
                const response = JSON.parse(data);
                if (response.status) {
                    res.json({ success: true, banks: response.data });
                } else {
                    res.status(400).json({ success: false, message: 'Could not fetch bank list.' });
                }
            } catch (e) {
                res.status(500).json({ success: false, message: 'Error parsing bank list.' });
            }
        });
    });

    reqPaystack.on('error', () => res.status(500).json({ success: false, message: 'Network error fetching banks.' }));
    reqPaystack.end();
});

// Verify Bank Account Route using dynamic bank codes
app.post('/verify-bank-account', (req, res) => {
    const { accountNumber, bankCode } = req.body;

    if (!accountNumber || !bankCode) {
        return res.status(400).json({ success: false, message: 'Invalid account number or bank code.' });
    }

    const options = {
        hostname: 'api.paystack.co',
        port: 443,
        path: `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        method: 'GET',
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
    };

    const reqPaystack = https.request(options, apiRes => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try {
                const response = JSON.parse(data);
                if (response.status) {
                    res.json({ success: true, accountName: response.data.account_name });
                } else {
                    res.status(400).json({ success: false, message: 'Could not verify account details.' });
                }
            } catch (e) {
                res.status(500).json({ success: false, message: 'Error parsing bank verification response.' });
            }
        });
    });

    reqPaystack.on('error', () => res.status(500).json({ success: false, message: 'Network error verifying bank.' }));
    reqPaystack.end();
});

// Process Automated Payout Transfer Route
app.post('/process-payout', (req, res) => {
    const { amount, bankCode, accountNumber, accountName } = req.body;

    if (!amount || !bankCode || !accountNumber) {
        return res.status(400).json({ success: false, message: 'Missing payout parameters.' });
    }

    const recipientParams = JSON.stringify({
        type: 'nuban',
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN'
    });

    const recipientOptions = {
        hostname: 'api.paystack.co',
        port: 443,
        path: '/transferrecipient',
        method: 'POST',
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
        }
    };

    const recipientReq = https.request(recipientOptions, recipientRes => {
        let recData = '';
        recipientRes.on('data', chunk => recData += chunk);
        recipientRes.on('end', () => {
            try {
                const recResponse = JSON.parse(recData);
                if (!recResponse.status) {
                    return res.status(400).json({ success: false, message: 'Failed to create transfer recipient.' });
                }

                const recipientCode = recResponse.data.recipient_code;

                const transferParams = JSON.stringify({
                    source: 'balance',
                    amount: amount * 100,
                    recipient: recipientCode,
                    reason: 'Emoji Treasure Hunt Withdrawal'
                });

                const transferOptions = {
                    hostname: 'api.paystack.co',
                    port: 443,
                    path: '/transfer',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    }
                };

                const transferReq = https.request(transferOptions, transferRes => {
                    let transData = '';
                    transferRes.on('data', chunk => transData += chunk);
                    transferRes.on('end', () => {
                        const transResponse = JSON.parse(transData);
                        if (transResponse.status) {
                            res.json({ success: true, message: 'Transfer queued successfully by Paystack.' });
                        } else {
                            res.status(400).json({ success: false, message: transResponse.message || 'Transfer failed.' });
                        }
                    });
                });

                transferReq.write(transferParams);
                transferReq.end();

            } catch (e) {
                res.status(500).json({ success: false, message: 'Error processing transfer request.' });
            }
        });
    });

    recipientReq.write(recipientParams);
    recipientReq.end();
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
        
        waitingPlayers = waitingPlayers.filter(p => p.username !== username);
        waitingPlayers.push({ socketId: socket.id, username, stake });

        if (waitingPlayers.length >= 2) {
            const player1 = waitingPlayers.shift();
            const player2 = waitingPlayers.shift();

            const roomId = 'room_' + Date.now();
            const targetEmojis = ['💎', '🔑', '👑', '🪙', '🏆'];
            const targetEmoji = targetEmojis[Math.floor(Math.random() * targetEmojis.length)];
            const winningIndex = Math.floor(Math.random() * 40);

            activeRooms[roomId] = {
                players: [player1.username, player2.username],
                stake: player1.stake,
                targetEmoji,
                winningIndex,
                turn: player1.username
            };

            io.to(player1.socketId).emit('match_found', { roomId, players: [player1.username, player2.username], targetEmoji, winningIndex });
            io.to(player2.socketId).emit('match_found', { roomId, players: [player1.username, player2.username], targetEmoji, winningIndex });
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
            let houseCut = room.stake * 2 * 0.05;
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
        waitingPlayers = waitingPlayers.filter(p => p.socketId !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running live on port ${PORT}`);
});