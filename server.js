const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());

// Serve static files from your project root folder
app.use(express.static(__dirname));

// Root route to serve your main game page (money.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'money.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configure Nodemailer with your email and passkey
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'emojitreasurehunt@gmail.com',
        pass: 'edlr dfhd suqa zlkf'
    }
});

// Temporary memory store for active OTPs
let pendingOtps = {};

let waitingQueue = [];
let activeRooms = {};
let houseRevenue = 0;
let incomeLogs = []; // Audit logs for admin income commission tracking
let withdrawalLogs = []; // Admin withdrawal history logs
let supportTickets = []; // Customer support inbox records

const emojiPool = ['💎', '🔑', '🪙', '👑', '💰', '🌟', '🏆', '🎁'];

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);

    // Handle generating and sending the email OTP
    socket.on('send_email_otp', async (data, callback) => {
        const { email } = data;
        if (!email) {
            return callback({ success: false, message: 'Email is required.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        pendingOtps[email] = {
            otp,
            expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes expiration
        };

        try {
            await transporter.sendMail({
                from: '"Emoji Treasure Hunt" <emojitreasurehunt@gmail.com>',
                to: email,
                subject: 'Your Account Verification Code',
                text: `Hello! Your verification code is: ${otp}. It expires in 5 minutes.`
            });
            console.log(`OTP sent to ${email}: ${otp}`);
            if (typeof callback === 'function') {
                callback({ success: true, message: 'OTP sent to your email!' });
            }
        } catch (error) {
            console.error('Error sending email:', error);
            if (typeof callback === 'function') {
                callback({ success: false, message: 'Failed to send email. Check server configuration.' });
            }
        }
    });

    // Handle verifying the OTP entered by the user
    socket.on('verify_email_otp', (data, callback) => {
        const { email, enteredOtp } = data;
        const record = pendingOtps[email];

        if (!record) {
            return callback({ success: false, message: 'No active OTP found. Request a new one.' });
        }

        if (Date.now() > record.expiresAt) {
            delete pendingOtps[email];
            return callback({ success: false, message: 'OTP has expired. Request a new code.' });
        }

        if (record.otp === enteredOtp) {
            delete pendingOtps[email]; // Clear code after use
            console.log(`Email ${email} successfully verified!`);
            if (typeof callback === 'function') {
                callback({ success: true, message: 'Verification successful!' });
            }
        } else {
            if (typeof callback === 'function') {
                callback({ success: false, message: 'Invalid OTP code. Please try again.' });
            }
        }
    });

    // Handle joining queue and instant matchmaking
    socket.on('join_queue', (data) => {
        const { username, stake } = data;
        console.log(`User ${username} joined queue for stake ₦${stake}`);

        // Remove any existing entry for this user to prevent ghost duplicates
        waitingQueue = waitingQueue.filter(item => item.username !== username && item.socketId !== socket.id);
        waitingQueue.push({ socketId: socket.id, username, stake });

        // Look for another player in the queue with the exact same stake
        let opponentIndex = waitingQueue.findIndex(item => item.stake === stake && item.socketId !== socket.id);

        if (opponentIndex !== -1) {
            let player1 = waitingQueue.shift();
            let player2 = waitingQueue.splice(waitingQueue.findIndex(item => item.stake === stake), 1)[0];
            
            if (!player2) {
                player2 = waitingQueue.shift();
            }

            const roomId = 'room_' + Math.random().toString(36).substring(2, 9);
            const winningIndex = Math.floor(Math.random() * 40);
            const targetEmoji = emojiPool[Math.floor(Math.random() * emojiPool.length)];

            // Map stake to group name for accurate auditing logs
            let groupName = "Micro Lounge";
            if (stake === 500) groupName = "Bronze Lounge";
            if (stake === 1000) groupName = "Silver Arena";
            if (stake === 5000) groupName = "Gold Chamber";

            activeRooms[roomId] = {
                players: [player1.username, player2.username],
                stake: player1.stake,
                groupName,
                winningIndex,
                targetEmoji
            };

            const sock1 = io.sockets.sockets.get(player1.socketId);
            const sock2 = io.sockets.sockets.get(player2.socketId);

            sock1?.join(roomId);
            sock2?.join(roomId);

            io.to(roomId).emit('match_found', {
                roomId,
                players: [player1.username, player2.username],
                targetEmoji,
                winningIndex
            });

            console.log(`Match created in room ${roomId} between ${player1.username} and ${player2.username}`);

            // 1-Minute (60 seconds) Total Match Timer & Timeout Full Stake Refund Handler
            setTimeout(() => {
                if (activeRooms[roomId]) {
                    let roomData = activeRooms[roomId];

                    // Issue full 100% refund on timeout (no platform fee deducted)
                    io.to(roomId).emit('no_winner_refund', {
                        stake: roomData.stake
                    });
                    delete activeRooms[roomId];
                    console.log(`Room ${roomId} timed out after 60 seconds. Full stake refund issued.`);
                }
            }, 60000);
        }
    });

    // Handle player leaving queue early before match starts
    socket.on('leave_queue', (data) => {
        const { username } = data;
        waitingQueue = waitingQueue.filter(item => item.socketId !== socket.id && item.username !== username);
        console.log(`User ${username} explicitly left the queue.`);
    });

    // Handle turn-based move broadcasting
    socket.on('play_turn', (data) => {
        const { roomId, username, index, decoyEmoji } = data;
        if (activeRooms[roomId]) {
            socket.to(roomId).emit('opponent_played', {
                username,
                index,
                decoyEmoji
            });
        }
    });

    // Handle player winning the match
    socket.on('player_won', (data) => {
        const { roomId, winner } = data;
        if (activeRooms[roomId]) {
            let roomData = activeRooms[roomId];
            let totalPool = roomData.stake * 2;
            let platformFee = totalPool * 0.05; // 5% fee deduction
            houseRevenue += platformFee;

            // Log income calculation into audit ledger
            incomeLogs.unshift({
                date: new Date().toLocaleString(),
                type: 'WIN COMMISSION',
                amount: platformFee,
                description: `5% fee from ${roomData.groupName} won by ${winner}`
            });

            socket.to(roomId).emit('game_over', { winner });
            delete activeRooms[roomId];
            console.log(`Player ${winner} won room ${roomId}. Income logged.`);
        }
    });

    // Customer Support Ticket Submission Handler
    socket.on('submit_support_ticket', (data, callback) => {
        const { username, category, message } = data;
        const ticket = {
            id: 'TICK_' + Math.floor(1000 + Math.random() * 9000),
            date: new Date().toLocaleString(),
            username: username || 'Anonymous',
            category: category || 'General Inquiry',
            message: message,
            status: 'Pending'
        };
        supportTickets.unshift(ticket);
        console.log(`New support ticket received from ${ticket.username}: ${ticket.category}`);
        if (typeof callback === 'function') {
            callback({ success: true, ticketId: ticket.id });
        }
    });

    // Fetch support tickets for Admin Hub
    socket.on('get_support_tickets', (callback) => {
        if (typeof callback === 'function') {
            callback({ tickets: supportTickets });
        }
    });

    // Resolve support ticket
    socket.on('resolve_ticket', (ticketId, callback) => {
        let ticket = supportTickets.find(t => t.id === ticketId);
        if (ticket) {
            ticket.status = 'Resolved';
            if (typeof callback === 'function') callback({ success: true });
        }
    });

    // Admin revenue balance, income audit logs & withdrawal history fetch
    socket.on('get_house_revenue', (callback) => {
        if (typeof callback === 'function') {
            callback({ 
                revenue: houseRevenue, 
                incomeLogs: incomeLogs, 
                withdrawalLogs: withdrawalLogs 
            });
        }
    });

    // Admin secure withdrawal handler
    socket.on('admin_withdraw', (data, callback) => {
        const { amount, bankName, accountNumber } = data;
        if (amount > houseRevenue) {
            if (typeof callback === 'function') {
                callback({ success: false, message: "Insufficient house revenue balance." });
            }
        } else {
            houseRevenue -= amount;

            // Record withdrawal history
            withdrawalLogs.unshift({
                date: new Date().toLocaleString(),
                amount: amount,
                bankName: bankName,
                accountNumber: accountNumber
            });

            if (typeof callback === 'function') {
                callback({ 
                    success: true, 
                    message: `Successfully withdrew ₦${amount.toLocaleString()} to ${bankName} (${accountNumber})`, 
                    newRevenue: houseRevenue 
                });
            }
        }
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(item => item.socketId !== socket.id);
        console.log(`User disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Game server running successfully on http://localhost:${PORT}`);
});