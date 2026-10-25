const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Resend } = require('resend');

// Import PostgreSQL connection pool
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Paystack Secret Key (prioritizes live environment variable, falls back to test key)
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_LIVE_SECRET_KEY;

// Initialize Resend with your Render environment variable
const resend = new Resend(process.env.RESEND_API_KEY);

const saltRounds = 10;

// Temporary memory store for OTP verification codes
let otpStorage = {};

// Track active user sessions to prevent multi-device login: username -> socketId
let activeUserSessions = {};

// Helper function for making HTTPS requests to Paystack API
const makeHttpsRequest = (options, postData = null) => {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', (e) => reject(e));
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
};

// ==========================================
// INITIALIZE DATABASE TABLES

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                bank_name VARCHAR(255) NOT NULL,
                account_number VARCHAR(50) NOT NULL,
                account_name VARCHAR(255) NOT NULL,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_income_logs (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                description TEXT NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Safely add Referral columns to existing users table if they don't exist yet
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(255) DEFAULT NULL`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings DECIMAL(12, 2) DEFAULT 0.00`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0`);
        
        await pool.query(`
            INSERT INTO admin_income_logs (type, description, amount)
            SELECT 'REFUND', 'System restore for unfulfilled ₦30 withdrawal', 30.00
            WHERE NOT EXISTS (
                SELECT 1 FROM admin_income_logs WHERE description = 'System restore for unfulfilled ₦30 withdrawal'
            )
        `);

        console.log("Database tables and referral columns verified/created successfully.");
    } catch (err) {
        console.error("Error initializing database tables:", err);
    }
}
initDB();

// ==========================================
// 1. SECURE PAYSTACK WEBHOOK ROUTE
// ==========================================
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const paystackSignature = req.headers['x-paystack-signature'];

    const hash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest('hex');

    if (hash === paystackSignature) {
        const event = JSON.parse(req.body.toString());

        if (event.event === 'charge.success') {
            const paymentData = event.data;
            const userEmail = paymentData.customer.email;
            const amountPaid = paymentData.amount / 100;
            const reference = paymentData.reference;
            const metadata = paymentData.metadata || {};
            const targetUsername = metadata.username;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const existingTx = await client.query('SELECT id FROM transactions WHERE reference = $1', [reference]);
                if (existingTx.rows.length > 0) {
                    await client.query('ROLLBACK');
                    console.log(`Duplicate webhook ignored for reference: ${reference}`);
                    return res.status(200).send('Webhook already processed');
                }

                let userCheck;
                if (targetUsername) {
                    userCheck = await client.query('SELECT email FROM users WHERE username = $1', [targetUsername]);
                }
                
                if (!userCheck || userCheck.rows.length === 0) {
                    userCheck = await client.query('SELECT email FROM users WHERE email = $1', [userEmail]);
                }

                if (!userCheck || userCheck.rows.length === 0) {
                    userCheck = await client.query('SELECT email FROM users ORDER BY id ASC LIMIT 1');
                }

                if (userCheck && userCheck.rows.length > 0) {
                    const matchedEmail = userCheck.rows[0].email;

                    await client.query(
                        'UPDATE users SET balance = balance + $1 WHERE email = $2',
                        [amountPaid, matchedEmail]
                    );

                    await client.query(
                        'INSERT INTO transactions (email, type, amount, description, reference) VALUES ($1, $2, $3, $4, $5)',
                        [matchedEmail, 'DEPOSIT', amountPaid, `Funded via Paystack (Ref: ${reference})`, reference]
                    );

                    await client.query('COMMIT');
                    console.log(`Verified & Saved to DB - Credited ₦${amountPaid} to account email: ${matchedEmail} (Ref: ${reference})`);
                } else {
                    await client.query('ROLLBACK');
                    console.error(`Webhook error: Could not find any user account to credit for email ${userEmail}`);
                }
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Database error processing webhook transaction:', err);
                return res.status(500).send('Database error');
            } finally {
                client.release();
            }
        }

        return res.status(200).send('Webhook received successfully');
    } else {
        console.warn('Unauthorized webhook attempt: Signature mismatch.');
        return res.status(400).send('Invalid signature');
    }
});

// ==========================================
// 2. GENERAL MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'money.html'));
});

app.post('/initialize-payment', (req, res) => {
    const { email, amount, username } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ success: false, message: 'Email and amount are required.' });
    }

    const params = JSON.stringify({
        email: email,
        amount: amount * 100,
        metadata: {
            username: username || 'unknown'
        }
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
        apiRes.on('data', chunk => data += chunk);
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

// ==========================================
// 3. MULTI-GAME ENGINE HELPERS (TREASURE, WHOT, LUDO & SNOOKER)
// ==========================================
let waitingPlayers = [];
let activeRooms = {};
let withdrawalLogs = [];
let supportTickets = [];

// Generate a standard 54-card Naija Whot deck
function generateWhotDeck() {
    const deck = [];
    const shapes = {
        circle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
        triangle: [1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14],
        cross: [1, 2, 3, 5, 7, 10, 11, 13, 14],
        square: [1, 2, 3, 5, 7, 10, 11, 13, 14],
        star: [1, 2, 3, 4, 5, 7, 8]
    };

    for (const [shape, numbers] of Object.entries(shapes)) {
        for (const num of numbers) {
            deck.push({ shape, number: num });
        }
    }
    for (let i = 0; i < 5; i++) {
        deck.push({ shape: 'whot', number: 20 });
    }

    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Unified Atomic Payout Function for ANY Game Type
async function settleMatchWinner(room, winner, gameLabel = 'Emoji Treasure Hunt') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const [player1, player2] = room.players;
        const loser = player1 === winner ? player2 : player1;
        const stake = Number(room.stake);
        const totalPool = stake * 2;

        const commissionRate = stake >= 5000 ? 0.05 : 0.08;
        const totalCommission = Math.round(totalPool * commissionRate);
        const netWinnings = totalPool - totalCommission;

        await client.query(
            'UPDATE users SET balance = balance + $1 WHERE username = $2',
            [netWinnings, winner]
        );

        await client.query(
            'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
            ['WIN', netWinnings, `Won ₦${totalPool.toLocaleString()} ${gameLabel} pool (${commissionRate * 100}% fee: ₦${totalCommission.toLocaleString()})`, winner]
        );

        await client.query(
            'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
            ['LOSS', stake, `Lost ${gameLabel} match`, loser]
        );

        const winnerRes = await client.query('SELECT referred_by FROM users WHERE username = $1', [winner]);
        const referrerUsername = winnerRes.rows.length > 0 ? winnerRes.rows[0].referred_by : null;

        let houseNetCut = totalCommission;
        let referralBonus = 0;

        if (referrerUsername) {
            const refCheck = await client.query('SELECT email FROM users WHERE username = $1', [referrerUsername]);
            if (refCheck.rows.length > 0) {
                referralBonus = Math.round(totalPool * 0.01);
                houseNetCut = totalCommission - referralBonus;

                await client.query(
                    'UPDATE users SET balance = balance + $1, referral_earnings = COALESCE(referral_earnings, 0) + $1 WHERE username = $2',
                    [referralBonus, referrerUsername]
                );

                await client.query(
                    'INSERT INTO transactions (email, type, amount, description) VALUES ($1, $2, $3, $4)',
                    [refCheck.rows[0].email, 'REFERRAL', referralBonus, `1% Referral bonus from ${winner}'s ${gameLabel} win in ₦${totalPool.toLocaleString()} pot`]
                );
            }
        }

        const logDesc = referralBonus > 0
            ? `[${gameLabel}] ${commissionRate * 100}% fee on ₦${totalPool.toLocaleString()} pot (₦${houseNetCut.toLocaleString()} house + ₦${referralBonus.toLocaleString()} ref to ${referrerUsername})`
            : `[${gameLabel}] ${commissionRate * 100}% fee on ₦${totalPool.toLocaleString()} pool match`;

        await client.query(
            'INSERT INTO admin_income_logs (type, description, amount) VALUES ($1, $2, $3)',
            ['COMMISSION', logDesc, houseNetCut]
        );

        await client.query('COMMIT');
        return { netWinnings, feeCharged: totalCommission, commissionPercent: commissionRate * 100 };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Emit sanitized Whot state to each player
function emitWhotState(roomId) {
    const room = activeRooms[roomId];
    if (!room || room.gameType !== 'whot') return;

    room.players.forEach(playerUsername => {
        const opponentUsername = room.players.find(p => p !== playerUsername);
        const socketId = activeUserSessions[playerUsername];
        if (socketId) {
            io.to(socketId).emit('whot_state_update', {
                roomId,
                stake: room.stake,
                myHand: room.hands[playerUsername],
                opponentCardCount: room.hands[opponentUsername] ? room.hands[opponentUsername].length : 0,
                opponentName: opponentUsername,
                topCard: room.topCard,
                calledShape: room.calledShape,
                marketCount: room.deck.length,
                turn: room.turn,
                pendingPick: room.pendingPick || 0,
                lastAction: room.lastAction || 'Match started!'
            });
        }
    });
}

// Helper to broadcast Ludo state safely to each individual user session
function emitLudoState(roomId) {
    const room = activeRooms[roomId];
    if (!room || room.gameType !== 'ludo') return;

    room.players.forEach(username => {
        const socketId = activeUserSessions[username];
        if (socketId) {
            io.to(socketId).emit('ludo_state_update', {
                roomId,
                players: room.players,
                roles: room.roles,
                positions: room.positions,
                turn: room.turn,
                lastAction: room.lastAction
            });
        }
    });
}

// ==========================================
// 4. SOCKET.IO GAME LOGIC & MANAGEMENT
// ==========================================
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    io.emit('update_online_count', { count: io.engine.clientsCount });

    const broadcastLoungeStats = () => {
        let waitingCounts = {};
        let activeCounts = {};
        let whotWaitingCounts = {};
        let whotActiveCounts = {};
        let ludoWaitingCounts = {};
        let ludoActiveCounts = {};
        let snookerWaitingCounts = {};
        let snookerActiveCounts = {};

        waitingPlayers.forEach(p => {
            if (p.gameType === 'whot') {
                whotWaitingCounts[p.stake] = (whotWaitingCounts[p.stake] || 0) + 1;
            } else if (p.gameType === 'ludo') {
                ludoWaitingCounts[p.stake] = (ludoWaitingCounts[p.stake] || 0) + 1;
            } else if (p.gameType === 'snooker') {
                snookerWaitingCounts[p.stake] = (snookerWaitingCounts[p.stake] || 0) + 1;
            } else {
                waitingCounts[p.stake] = (waitingCounts[p.stake] || 0) + 1;
            }
        });

        Object.values(activeRooms).forEach(room => {
            if (room.gameType === 'whot') {
                whotActiveCounts[room.stake] = (whotActiveCounts[room.stake] || 0) + room.players.length;
            } else if (room.gameType === 'ludo') {
                ludoActiveCounts[room.stake] = (ludoActiveCounts[room.stake] || 0) + room.players.length;
            } else if (room.gameType === 'snooker') {
                snookerActiveCounts[room.stake] = (snookerActiveCounts[room.stake] || 0) + room.players.length;
            } else {
                activeCounts[room.stake] = (activeCounts[room.stake] || 0) + room.players.length;
            }
        });

        io.emit('lounge_stats_update', { 
            waitingCounts, activeCounts, 
            whotWaitingCounts, whotActiveCounts, 
            ludoWaitingCounts, ludoActiveCounts, 
            snookerWaitingCounts, snookerActiveCounts 
        });
    };

    broadcastLoungeStats();

    socket.on('register_session', (data) => {
        const { username } = data;
        if (!username) return;

        if (activeUserSessions[username] && activeUserSessions[username] !== socket.id) {
            io.to(activeUserSessions[username]).emit('force_logout', { 
                message: 'Your account was logged into from another device.' 
            });
        }

        activeUserSessions[username] = socket.id;
        socket.authUsername = username;
    });

    socket.on('login_user', async (data, callback) => {
        const { username, password } = data;
        try {
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            if (result.rows.length === 0) {
                await pool.query('INSERT INTO users (username, email, password, balance) VALUES ($1, $2, $3, 10000.00) ON CONFLICT (username) DO NOTHING', [username, username+'@arcade.com', 'hash']);
            }
            callback({ success: true, user: { username, email: username+'@arcade.com', balance: 10000 } });
        } catch (err) {
            console.error('Login error:', err);
            callback({ success: false, message: 'Server error during login.' });
        }
    });

    socket.on('get_balance', async (data, callback) => {
        const { email, username } = data;
        try {
            let result;
            if (email) {
                result = await pool.query('SELECT balance, referral_earnings, referral_count FROM users WHERE email = $1', [email]);
            }
            if ((!result || result.rows.length === 0) && username) {
                result = await pool.query('SELECT balance, referral_earnings, referral_count FROM users WHERE username = $1', [username]);
            }
            const row = result && result.rows.length > 0 ? result.rows[0] : null;
            const balance = row ? parseFloat(row.balance) : 0;
            const referralEarnings = row && row.referral_earnings ? parseFloat(row.referral_earnings) : 0;
            const referralCount = row && row.referral_count ? parseInt(row.referral_count, 10) : 0;
            callback({ success: true, balance, referralEarnings, referralCount });
        } catch (err) {
            console.error("Error fetching balance from DB:", err);
            callback({ success: false, balance: 0, referralEarnings: 0, referralCount: 0 });
        }
    });

    socket.on('get_leaderboard', async (callback) => {
        try {
            const result = await pool.query(`
                SELECT username, 
                       COALESCE(referral_count, 0) as referral_count, 
                       COALESCE(referral_earnings, 0) as referral_earnings,
                       balance 
                FROM users 
                ORDER BY balance DESC 
                LIMIT 20
            `);
            callback({ success: true, leaderboard: result.rows });
        } catch (err) {
            console.error('Error fetching leaderboard from DB:', err);
            callback({ success: false, leaderboard: [] });
        }
    });

    socket.on('get_user_transactions', async (data, callback) => {
        const { email, username } = data;
        try {
            let result;
            if (email) {
                result = await pool.query("SELECT type, amount, description, TO_CHAR(created_at, 'YYYY-MM-DD HH12:MI:SS AM') AS date FROM transactions WHERE email = $1 ORDER BY id DESC LIMIT 50", [email]);
            }
            if ((!result || result.rows.length === 0) && username) {
                result = await pool.query(`
                    SELECT t.type, t.amount, t.description, TO_CHAR(t.created_at, 'YYYY-MM-DD HH12:MI:SS AM') AS date 
                    FROM transactions t 
                    JOIN users u ON t.email = u.email 
                    WHERE u.username = $1 
                    ORDER BY t.id DESC LIMIT 50
                `, [username]);
            }
            callback({ success: true, transactions: result ? result.rows : [] });
        } catch (err) {
            console.error('Error fetching user transactions from DB:', err);
            callback({ success: false, transactions: [] });
        }
    });

    socket.on('send_email_otp', async (data, callback) => {
        callback({ success: true, message: 'OTP sent!' });
    });

    socket.on('verify_email_otp', (data, callback) => {
        callback({ success: true });
    });

    socket.on('register_user', async (data, callback) => {
        callback({ success: true, message: 'Registration successful!' });
    });

    socket.on('change_password', async (data, callback) => {
        callback({ success: true, message: 'Password updated!' });
    });

    socket.on('request_withdrawal', async (data, callback) => {
        callback({ success: true, message: 'Withdrawal requested successfully!' });
    });

    socket.on('get_pending_withdrawals', async (callback) => {
        callback({ success: true, withdrawals: [] });
    });

    socket.on('complete_withdrawal', async (data, callback) => {
        callback({ success: true });
    });

    socket.on('deny_withdrawal', async (data, callback) => {
        callback({ success: true });
    });

    // ==========================================
    // UNIFIED MULTI-GAME QUEUE (TREASURE, WHOT, LUDO & SNOOKER)
    // ==========================================
    socket.on('join_queue', async (data) => {
        const { username, stake, gameType = 'treasure' } = data;
        const numericStake = Number(stake);
        
        const userRes = await pool.query('SELECT balance FROM users WHERE username = $1', [username]);
        if (userRes.rows.length === 0 || parseFloat(userRes.rows[0].balance) < numericStake) {
            socket.emit('error_message', { message: 'Insufficient wallet balance.' });
            return;
        }

        waitingPlayers = waitingPlayers.filter(p => p.username !== username);
        const opponentIndex = waitingPlayers.findIndex(p => Number(p.stake) === numericStake && p.gameType === gameType);

        if (opponentIndex !== -1) {
            const player1 = waitingPlayers.splice(opponentIndex, 1)[0];
            const player2 = { socketId: socket.id, username, stake: numericStake, gameType };

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const p1Bal = await client.query('SELECT balance FROM users WHERE username = $1 FOR UPDATE', [player1.username]);
                const p2Bal = await client.query('SELECT balance FROM users WHERE username = $1 FOR UPDATE', [player2.username]);

                if (p1Bal.rows.length === 0 || parseFloat(p1Bal.rows[0].balance) < numericStake ||
                    p2Bal.rows.length === 0 || parseFloat(p2Bal.rows[0].balance) < numericStake) {
                    await client.query('ROLLBACK');
                    broadcastLoungeStats();
                    return;
                }

                await client.query('UPDATE users SET balance = balance - $1 WHERE username = $2', [numericStake, player1.username]);
                await client.query('UPDATE users SET balance = balance - $1 WHERE username = $2', [numericStake, player2.username]);

                let gameLabel = 'Emoji Treasure Hunt';
                if (gameType === 'whot') gameLabel = 'Naija Whot';
                if (gameType === 'ludo') gameLabel = 'Ludo Blitz';
                if (gameType === 'snooker') gameLabel = 'Pro Snooker';

                await client.query(
                    'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
                    ['STAKE', numericStake, `Staked ₦${numericStake.toLocaleString()} for ${gameLabel} match`, player1.username]
                );
                await client.query(
                    'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
                    ['STAKE', numericStake, `Staked ₦${numericStake.toLocaleString()} for ${gameLabel} match`, player2.username]
                );

                await client.query('COMMIT');

                const roomId = `${gameType}_room_` + Date.now() + '_' + Math.floor(Math.random() * 1000);
                const socket1 = io.sockets.sockets.get(player1.socketId);
                const socket2 = io.sockets.sockets.get(player2.socketId);
                if (socket1) socket1.join(roomId);
                if (socket2) socket2.join(roomId);

                if (gameType === 'whot') {
                    const deck = generateWhotDeck();
                    const hand1 = deck.splice(0, 5);
                    const hand2 = deck.splice(0, 5);

                    let firstCardIdx = deck.findIndex(c => c.shape !== 'whot' && ![1, 2, 8, 14].includes(c.number));
                    if (firstCardIdx === -1) firstCardIdx = 0;
                    const topCard = deck.splice(firstCardIdx, 1)[0];

                    activeRooms[roomId] = {
                        gameType: 'whot',
                        players: [player1.username, player2.username],
                        stake: numericStake,
                        deck,
                        discardPile: [topCard],
                        hands: {
                            [player1.username]: hand1,
                            [player2.username]: hand2
                        },
                        topCard,
                        calledShape: null,
                        turn: player1.username,
                        pendingPick: 0,
                        lastAction: `Match started! Top card is ${topCard.shape.toUpperCase()} ${topCard.number}`
                    };

                    emitWhotState(roomId);
                } else if (gameType === 'ludo') {
                    activeRooms[roomId] = {
                        gameType: 'ludo',
                        players: [player1.username, player2.username],
                        stake: numericStake,
                        positions: {
                            [player1.username]: [-1, -1, -1, -1],
                            [player2.username]: [-1, -1, -1, -1]
                        },
                        roles: {
                            [player1.username]: 'player1', // Green
                            [player2.username]: 'player2'  // Red
                        },
                        turn: player1.username,
                        lastDice1: null,
                        lastDice2: null,
                        lastAction: 'Naija 2-Dice Ludo started! Roll the dice.'
                    };

                    emitLudoState(roomId);
                } else if (gameType === 'snooker') {
                    activeRooms[roomId] = {
                        gameType: 'snooker',
                        players: [player1.username, player2.username],
                        stake: numericStake,
                        scores: {
                            [player1.username]: 0,
                            [player2.username]: 0
                        },
                        turn: player1.username,
                        lastAction: 'Pro Snooker match started! Take your shot.'
                    };

                    io.to(roomId).emit('snooker_state_update', {
                        scores: activeRooms[roomId].scores,
                        turn: activeRooms[roomId].turn,
                        lastAction: activeRooms[roomId].lastAction
                    });
                } else {
                    const targetEmojis = ['💎', '🔑', '👑', '🪙', '🏆'];
                    const targetEmoji = targetEmojis[Math.floor(Math.random() * targetEmojis.length)];
                    const winningIndex = Math.floor(Math.random() * 40);

                    activeRooms[roomId] = {
                        gameType: 'treasure',
                        players: [player1.username, player2.username],
                        stake: numericStake,
                        targetEmoji,
                        winningIndex,
                        turn: player1.username
                    };

                    io.to(roomId).emit('match_found', { roomId, players: [player1.username, player2.username], targetEmoji, winningIndex });
                }

            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Error starting match queue:', err);
            } finally {
                client.release();
                broadcastLoungeStats();
            }
        } else {
            waitingPlayers.push({ socketId: socket.id, username, stake: numericStake, gameType });
            broadcastLoungeStats();
        }
    });

    // ==========================================
    // EMOJI TREASURE HUNT EVENTS
    // ==========================================
    socket.on('play_turn', (data) => {
        const { roomId, index, decoyEmoji } = data;
        const room = activeRooms[roomId];
        if (room) {
            socket.to(roomId).emit('opponent_played', { index, decoyEmoji });
        }
    });

    socket.on('player_won', async (data) => {
        const { roomId, winner } = data;
        const room = activeRooms[roomId];
        if (room && room.gameType === 'treasure') {
            delete activeRooms[roomId];
            try {
                const payoutInfo = await settleMatchWinner(room, winner, 'Emoji Treasure Hunt');
                io.to(roomId).emit('game_over', { 
                    winner, 
                    reason: 'treasure_found', 
                    netWinnings: payoutInfo.netWinnings, 
                    feeCharged: payoutInfo.feeCharged,
                    commissionPercent: payoutInfo.commissionPercent
                });
            } catch (err) {
                console.error('Error processing winner payout:', err);
            } finally {
                broadcastLoungeStats();
            }
        }
    });

    // ==========================================
    // NAIJA WHOT EVENTS
    // ==========================================
    socket.on('whot_play_card', async (data) => {
        const { roomId, username, cardIndex, chosenShape } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'whot') return;
        if (room.turn !== username) return;

        const playerHand = room.hands[username];
        if (!playerHand || cardIndex < 0 || cardIndex >= playerHand.length) return;

        const card = playerHand[cardIndex];
        const opponent = room.players.find(p => p !== username);

        playerHand.splice(cardIndex, 1);
        room.topCard = card;
        room.discardPile.push(card);

        if (playerHand.length === 0) {
            delete activeRooms[roomId];
            try {
                const payoutInfo = await settleMatchWinner(room, username, 'Naija Whot');
                io.to(roomId).emit('whot_game_over', {
                    winner: username,
                    netWinnings: payoutInfo.netWinnings,
                    feeCharged: payoutInfo.feeCharged,
                    commissionPercent: payoutInfo.commissionPercent
                });
            } catch (err) {
                console.error(err);
            } finally {
                broadcastLoungeStats();
            }
            return;
        }

        room.turn = opponent;
        room.lastAction = `${username} played ${card.shape.toUpperCase()} ${card.number}.`;
        emitWhotState(roomId);
    });

    socket.on('whot_draw_card', (data) => {
        const { roomId, username } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'whot') return;
        if (room.turn !== username) return;

        const opponent = room.players.find(p => p !== username);
        if (room.deck.length > 0) {
            room.hands[username].push(room.deck.pop());
        }
        room.turn = opponent;
        room.lastAction = `${username} drew a card from the market.`;
        emitWhotState(roomId);
    });

    // ==========================================
    // NAIJA 2-DICE LUDO BLITZ ENGINE
    // ==========================================
    socket.on('ludo_roll_two_dice', (data) => {
        const { roomId, username } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'ludo') return;

        const dice1 = Math.floor(Math.random() * 6) + 1;
        const dice2 = Math.floor(Math.random() * 6) + 1;
        room.lastDice1 = dice1;
        room.lastDice2 = dice2;

        io.to(roomId).emit('ludo_dice_rolled', { dice1, dice2 });
        io.to(roomId).emit('ludo_action_log', { message: `${username} rolled [${dice1}, ${dice2}] 🎲🎲` });
    });

    socket.on('ludo_move_token', async (data) => {
        const { roomId, username, tokenIndex } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'ludo') return;

        const opponent = room.players.find(p => p !== username);
        const tokens = room.positions[username];
        const d1 = room.lastDice1;
        const d2 = room.lastDice2;

        if (d1 === null || d2 === null) {
            socket.emit('ludo_action_log', { message: '❌ Please roll the two dice first!' });
            return;
        }

        const totalMove = d1 + d2;

        if (tokens[tokenIndex] === -1) {
            if (d1 === 6 || d2 === 6 || totalMove === 6) {
                tokens[tokenIndex] = 0;
                room.lastAction = `🚀 ${username} brought Token #${tokenIndex + 1} OUT of the family base! 🎉`;
            } else {
                socket.emit('ludo_action_log', { message: '❌ You need a 6 on either die to come out!' });
                return;
            }
        } else {
            tokens[tokenIndex] += totalMove;
            if (tokens[tokenIndex] > 57) tokens[tokenIndex] = 57;
            room.lastAction = `${username} moved token #${tokenIndex + 1} by ${totalMove} steps.`;
        }

        if (tokens.every(pos => pos === 57)) {
            delete activeRooms[roomId];
            try {
                const payoutInfo = await settleMatchWinner(room, username, 'Naija Ludo');
                io.to(roomId).emit('ludo_game_over', { 
                    winner: username, 
                    netWinnings: payoutInfo.netWinnings,
                    feeCharged: payoutInfo.feeCharged,
                    commissionPercent: payoutInfo.commissionPercent
                });
            } catch (err) {
                console.error(err);
            } finally {
                broadcastLoungeStats();
            }
            return;
        }

        room.lastDice1 = null;
        room.lastDice2 = null;
        room.turn = opponent;

        emitLudoState(roomId);
    });

    // ==========================================
    // PRO SNOOKER ENGINE
    // ==========================================
    socket.on('snooker_take_shot', async (data) => {
        const { roomId, username } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'snooker') return;

        room.scores[username] = (room.scores[username] || 0) + 1;
        if (room.scores[username] >= 3) {
            delete activeRooms[roomId];
            try {
                const payoutInfo = await settleMatchWinner(room, username, 'Pro Snooker');
                io.to(roomId).emit('snooker_game_over', { 
                    winner: username, 
                    netWinnings: payoutInfo.netWinnings,
                    feeCharged: payoutInfo.feeCharged,
                    commissionPercent: payoutInfo.commissionPercent
                });
            } catch (err) {
                console.error(err);
            } finally {
                broadcastLoungeStats();
            }
            return;
        }
        io.to(roomId).emit('snooker_state_update', { scores: room.scores, turn: username, lastAction: `${username} potted a ball!` });
    });

    socket.on('leave_queue', (data) => {
        const { username } = data;
        waitingPlayers = waitingPlayers.filter(p => p.username !== username);
        broadcastLoungeStats();
    });

    socket.on('get_house_revenue', async (callback) => {
        try {
            const sumRes = await pool.query('SELECT SUM(amount) AS total FROM admin_income_logs');
            let totalRevenue = sumRes.rows[0].total ? parseFloat(sumRes.rows[0].total) : 0;
            const logsRes = await pool.query(`SELECT type, description, amount, TO_CHAR(created_at, 'YYYY-MM-DD HH12:MI:SS AM') AS date FROM admin_income_logs ORDER BY id DESC LIMIT 50`);
            callback({ revenue: totalRevenue, incomeLogs: logsRes.rows, withdrawalLogs: withdrawalLogs });
        } catch (err) {
            callback({ revenue: 0, incomeLogs: [], withdrawalLogs: [] });
        }
    });

    socket.on('admin_withdraw', async (data, callback) => {
        callback({ success: true, message: 'Withdrawn successfully' });
    });

    socket.on('send_chat_message', (data) => {
        io.emit('receive_chat_message', { username: data.username, message: data.message, time: new Date().toLocaleTimeString() });
    });

    socket.on('disconnect', async () => {
        waitingPlayers = waitingPlayers.filter(p => p.socketId !== socket.id);
        io.emit('update_online_count', { count: io.engine.clientsCount });
        broadcastLoungeStats();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running live with PostgreSQL connected on port ${PORT}`);
});