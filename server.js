Const express = require('express');
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
// ==========================================
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
        
        // Auto-restore the failed 30 NGN Admin withdrawal so the balance matches reality
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

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const existingTx = await client.query('SELECT id FROM transactions WHERE reference = $1', [reference]);
                if (existingTx.rows.length > 0) {
                    await client.query('ROLLBACK');
                    console.log(`Duplicate webhook ignored for reference: ${reference}`);
                    return res.status(200).send('Webhook already processed');
                }

                await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE email = $2',
                    [amountPaid, userEmail]
                );

                await client.query(
                    'INSERT INTO transactions (email, type, amount, description, reference) VALUES ($1, $2, $3, $4, $5)',
                    [userEmail, 'DEPOSIT', amountPaid, `Funded via Paystack (Ref: ${reference})`, reference]
                );

                await client.query('COMMIT');
                console.log(`Verified & Saved to DB - Credited ₦${amountPaid} to ${userEmail} (Ref: ${reference})`);
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
    const { email, amount } = req.body;

    if (!email || !amount) {
        return res.status(400).json({ success: false, message: 'Email and amount are required.' });
    }

    const params = JSON.stringify({
        email: email,
        amount: amount * 100
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
// 3. MULTI-GAME ENGINE HELPERS (TREASURE, WHOT & LUDO)
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

        waitingPlayers.forEach(p => {
            if (p.gameType === 'whot') {
                whotWaitingCounts[p.stake] = (whotWaitingCounts[p.stake] || 0) + 1;
            } else if (p.gameType === 'ludo') {
                ludoWaitingCounts[p.stake] = (ludoWaitingCounts[p.stake] || 0) + 1;
            } else {
                waitingCounts[p.stake] = (waitingCounts[p.stake] || 0) + 1;
            }
        });

        Object.values(activeRooms).forEach(room => {
            if (room.gameType === 'whot') {
                whotActiveCounts[room.stake] = (whotActiveCounts[room.stake] || 0) + room.players.length;
            } else if (room.gameType === 'ludo') {
                ludoActiveCounts[room.stake] = (ludoActiveCounts[room.stake] || 0) + room.players.length;
            } else {
                activeCounts[room.stake] = (activeCounts[room.stake] || 0) + room.players.length;
            }
        });

        io.emit('lounge_stats_update', { waitingCounts, activeCounts, whotWaitingCounts, whotActiveCounts, ludoWaitingCounts, ludoActiveCounts });
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
        const { email } = data;
        if (!email) {
            return callback({ success: false, message: 'Email address is required.' });
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        otpStorage[email] = verificationCode;

        try {
            const emailResult = await resend.emails.send({
                from: 'Emoji Treasure Hunt <support@emojitreasurehunt.com>',
                to: [email],
                subject: 'Verify Your Email Address',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px;">
                        <h2>Welcome to Emoji Treasure Hunt!</h2>
                        <p>Your verification code is:</p>
                        <h1 style="color: #4F46E5; letter-spacing: 2px;">${verificationCode}</h1>
                        <p>Please enter this code in the app to complete your verification.</p>
                    </div>
                `
            });

            if (emailResult.error) {
                console.warn('Resend API restricted delivery, falling back to console log:', emailResult.error);
                console.log(`[TEST MODE OTP] Code for ${email}: ${verificationCode}`);
            }

            callback({ success: true, message: 'Verification code generated successfully!' });
        } catch (err) {
            console.warn('Resend exception, using console fallback:', err);
            console.log(`[TEST MODE OTP] Code for ${email}: ${verificationCode}`);
            callback({ success: true, message: 'Verification code generated successfully!' });
        }
    });

    socket.on('verify_email_otp', (data, callback) => {
        const { email, enteredOtp } = data;
        if (otpStorage[email] && otpStorage[email] === enteredOtp) {
            delete otpStorage[email];
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Invalid or expired verification code.' });
        }
    });

    socket.on('register_user', async (data, callback) => {
        const username = data ? data.username : null;
        const email = data ? (data.email || data.contact) : null;
        const password = data ? data.password : null;
        const referredByRaw = data && data.referredBy ? data.referredBy.trim() : null;

        if (!username || !email || !password) {
            return callback({ success: false, message: 'Missing required registration fields.' });
        }

        try {
            const existing = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
            if (existing.rows.length > 0) {
                return callback({ success: false, message: 'Username or email already exists.' });
            }

            let validReferrer = null;
            if (referredByRaw && referredByRaw.toLowerCase() !== username.toLowerCase()) {
                const refCheck = await pool.query('SELECT username FROM users WHERE LOWER(username) = LOWER($1)', [referredByRaw]);
                if (refCheck.rows.length > 0) {
                    validReferrer = refCheck.rows[0].username;
                }
            }

            const hashedPassword = await bcrypt.hash(password, saltRounds);

            await pool.query(
                `INSERT INTO users (username, email, password, balance, referred_by, referral_earnings, referral_count) VALUES ($1, $2, $3, 0.00, $4, 0.00, 0)`,
                [username, email, hashedPassword, validReferrer]
            );

            if (validReferrer) {
                await pool.query(
                    `UPDATE users SET referral_count = COALESCE(referral_count, 0) + 1 WHERE username = $1`,
                    [validReferrer]
                );
            }

            callback({ success: true, message: 'Registration successful!' });
        } catch (err) {
            console.error('Registration error details:', err);
            callback({ success: false, message: 'Server error during registration.' });
        }
    });

    socket.on('login_user', async (data, callback) => {
        const { username, password } = data;
        try {
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            if (result.rows.length === 0) {
                return callback({ success: false, message: 'Invalid username or password.' });
            }

            const user = result.rows[0];
            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                return callback({ success: false, message: 'Invalid username or password.' });
            }

            callback({ 
                success: true, 
                user: { 
                    username: user.username, 
                    email: user.email, 
                    balance: parseFloat(user.balance),
                    referralEarnings: user.referral_earnings ? parseFloat(user.referral_earnings) : 0,
                    referralCount: user.referral_count ? parseInt(user.referral_count, 10) : 0
                } 
            });
        } catch (err) {
            console.error('Login error:', err);
            callback({ success: false, message: 'Server error during login.' });
        }
    });

    socket.on('change_password', async (data, callback) => {
        const { username, oldPassword, newPassword } = data;
        try {
            const result = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
            if (result.rows.length === 0) {
                return callback({ success: false, message: 'User not found.' });
            }

            const isOldMatch = await bcrypt.compare(oldPassword, result.rows[0].password);
            if (!isOldMatch) {
                return callback({ success: false, message: 'Current password is incorrect.' });
            }

            const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
            await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedNewPassword, username]);
            callback({ success: true, message: 'Password updated successfully!' });
        } catch (err) {
            console.error('Password change error:', err);
            callback({ success: false, message: 'Server error updating password.' });
        }
    });

    socket.on('request_withdrawal', async (data, callback) => {
        const { username, amount, bankName, accountNumber, accountName } = data;

        if (!username || !amount || !bankName || !accountNumber) {
            return callback({ success: false, message: 'Missing withdrawal parameters.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            let userRes = await client.query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return callback({ success: false, message: `User '${username}' not found. Please log out and log back in.` });
            }

            const dbUser = userRes.rows[0];
            const currentBalance = parseFloat(dbUser.balance);

            if (currentBalance < amount) {
                await client.query('ROLLBACK');
                return callback({ success: false, message: 'Insufficient wallet balance.' });
            }

            await client.query('UPDATE users SET balance = balance - $1 WHERE username = $2', [amount, dbUser.username]);

            await client.query(
                'INSERT INTO withdrawals (username, amount, bank_name, account_number, account_name, status) VALUES ($1, $2, $3, $4, $5, $6)',
                [dbUser.username, amount, bankName, accountNumber, accountName, 'Pending']
            );

            await client.query(
                'INSERT INTO transactions (email, type, amount, description) VALUES ($1, $2, $3, $4)',
                [dbUser.email, 'WITHDRAWAL', amount, `Manual withdrawal request to ${bankName} (${accountNumber})`]
            );

            await client.query('COMMIT');
            callback({ success: true, message: 'Withdrawal request submitted successfully! Expect your payout in 15 mins to 30 mins.' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Manual withdrawal error:', err);
            callback({ success: false, message: 'Server error processing withdrawal.' });
        } finally {
            client.release();
        }
    });

    socket.on('get_pending_withdrawals', async (callback) => {
        try {
            const result = await pool.query("SELECT * FROM withdrawals WHERE status = 'Pending' ORDER BY created_at ASC");
            callback({ success: true, withdrawals: result.rows });
        } catch (err) {
            console.error('Error fetching pending withdrawals:', err);
            callback({ success: false, message: 'Error fetching withdrawal requests.' });
        }
    });

    socket.on('complete_withdrawal', async (data, callback) => {
        const { withdrawalId } = data;
        try {
            await pool.query("UPDATE withdrawals SET status = 'Completed' WHERE id = $1", [withdrawalId]);
            callback({ success: true, message: 'Withdrawal marked as completed.' });
        } catch (err) {
            console.error('Error completing withdrawal:', err);
            callback({ success: false, message: 'Error updating withdrawal status.' });
        }
    });

    socket.on('deny_withdrawal', async (data, callback) => {
        const { withdrawalId } = data;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const wRes = await client.query("SELECT * FROM withdrawals WHERE id = $1 AND status = 'Pending'", [withdrawalId]);
            if (wRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return callback({ success: false, message: 'Withdrawal request not found or already processed.' });
            }

            const withdrawal = wRes.rows[0];
            const { username, amount } = withdrawal;

            await client.query("UPDATE withdrawals SET status = 'Denied' WHERE id = $1", [withdrawalId]);
            await client.query('UPDATE users SET balance = balance + $1 WHERE username = $2', [amount, username]);

            await client.query(
                'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
                ['REFUND', amount, `Refunded denied withdrawal #${withdrawalId}`, username]
            );

            await client.query('COMMIT');
            callback({ success: true, message: 'Withdrawal denied and funds refunded to player balance.' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Error denying withdrawal:', err);
            callback({ success: false, message: 'Server error processing denial.' });
        } finally {
            client.release();
        }
    });

    // ==========================================
    // UNIFIED MULTI-GAME QUEUE (TREASURE, WHOT & LUDO)
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
                            [player1.username]: [0, 0],
                            [player2.username]: [0, 0]
                        },
                        turn: player1.username,
                        lastDice: null,
                        lastAction: 'Ludo match started! Roll the dice.'
                    };

                    io.to(roomId).emit('ludo_state_update', {
                        positions: activeRooms[roomId].positions,
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

    socket.on('match_timeout', async (data) => {
        const { roomId } = data;
        const room = activeRooms[roomId];
        if (room) {
            delete activeRooms[roomId];

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                for (const username of room.players) {
                    const stake = room.stake;
                    await client.query('UPDATE users SET balance = balance + $1 WHERE username = $2', [stake, username]);
                    await client.query(
                        'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
                        ['REFUND', stake, `Match timed out (Draw) - Stake refunded`, username]
                    );
                }

                await client.query('COMMIT');
                io.to(roomId).emit('game_over', { winner: null, reason: 'timeout' });
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Error processing match timeout refunds:', err);
            } finally {
                client.release();
                broadcastLoungeStats();
            }
        }
    });

    // ==========================================
    // NAIJA WHOT 1V1 EVENTS & 8s TIMEOUT
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

        if (room.pendingPick > 0) {
            socket.emit('whot_invalid_move', { message: `You must draw ${room.pendingPick} cards from the market!` });
            return;
        }

        let isValid = false;
        if (card.shape === 'whot') {
            isValid = true;
        } else if (room.calledShape) {
            isValid = (card.shape === room.calledShape);
        } else {
            isValid = (card.shape === room.topCard.shape || card.number === room.topCard.number);
        }

        if (!isValid) {
            socket.emit('whot_invalid_move', { message: 'Card does not match shape or number!' });
            return;
        }

        playerHand.splice(cardIndex, 1);
        room.topCard = card;
        room.discardPile.push(card);
        room.calledShape = null;

        if (playerHand.length === 0) {
            delete activeRooms[roomId];
            try {
                const payoutInfo = await settleMatchWinner(room, username, 'Naija Whot');
                io.to(roomId).emit('whot_game_over', {
                    winner: username,
                    reason: 'cards_finished',
                    netWinnings: payoutInfo.netWinnings,
                    feeCharged: payoutInfo.feeCharged,
                    commissionPercent: payoutInfo.commissionPercent
                });
            } catch (err) {
                console.error('Error settling Whot winner:', err);
            } finally {
                broadcastLoungeStats();
            }
            return;
        }

        if (card.shape === 'whot') {
            const validShapes = ['circle', 'triangle', 'cross', 'square', 'star'];
            const shapeToCall = validShapes.includes(chosenShape) ? chosenShape : 'circle';
            room.calledShape = shapeToCall;
            room.turn = opponent;
            room.lastAction = `${username} played WHOT 20 and called ${shapeToCall.toUpperCase()}!`;
        } else if (card.number === 1) {
            room.turn = username;
            room.lastAction = `${username} played HOLD ON (1)! ${username} plays again!`;
        } else if (card.number === 8) {
            room.turn = username;
            room.lastAction = `${username} played SUSPENSION (8)! ${opponent} is skipped!`;
        } else if (card.number === 2) {
            room.pendingPick = 2;
            room.turn = opponent;
            room.lastAction = `${username} played PICK TWO (2)! ${opponent} must draw 2 cards!`;
        } else if (card.number === 14) {
            room.pendingPick = 1;
            room.turn = opponent;
            room.lastAction = `${username} played GENERAL MARKET (14)! ${opponent} must draw 1 card!`;
        } else {
            room.turn = opponent;
            room.lastAction = `${username} played ${card.shape.toUpperCase()} ${card.number}.`;
        }

        emitWhotState(roomId);
    });

    socket.on('whot_draw_card', (data) => {
        const { roomId, username } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'whot') return;
        if (room.turn !== username) return;

        const opponent = room.players.find(p => p !== username);
        const drawCount = room.pendingPick > 0 ? room.pendingPick : 1;

        for (let i = 0; i < drawCount; i++) {
            if (room.deck.length === 0 && room.discardPile.length > 1) {
                const currentTop = room.discardPile.pop();
                room.deck = room.discardPile.splice(0);
                room.discardPile = [currentTop];
                for (let j = room.deck.length - 1; j > 0; j--) {
                    const k = Math.floor(Math.random() * (j + 1));
                    [room.deck[j], room.deck[k]] = [room.deck[k], room.deck[j]];
                }
            }
            if (room.deck.length > 0) {
                room.hands[username].push(room.deck.pop());
            }
        }

        room.pendingPick = 0;
        room.turn = opponent;
        room.lastAction = `${username} drew ${drawCount} card${drawCount > 1 ? 's' : ''} from the market.`;

        emitWhotState(roomId);
    });

    socket.on('whot_turn_timeout', (data) => {
        const { roomId, username } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'whot') return;
        if (room.turn !== username) return;

        const opponent = room.players.find(p => p !== username);
        if (room.deck.length > 0) {
            room.hands[username].push(room.deck.pop());
        }
        room.turn = opponent;
        room.lastAction = `⏱️ ${username} timed out! Auto-drew 1 card. Turn passed to ${opponent}.`;
        emitWhotState(roomId);
    });

    // ==========================================
    // LUDO BLITZ GAME ENGINE
    // ==========================================
    socket.on('ludo_roll_dice', (data) => {
        const { roomId, username } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'ludo') return;
        if (room.turn !== username) return;

        const diceRoll = Math.floor(Math.random() * 6) + 1;
        room.lastDice = diceRoll;

        socket.emit('ludo_dice_rolled', { diceRoll });
        io.to(roomId).emit('ludo_action_log', { message: `${username} rolled a ${diceRoll} 🎲` });
    });

    socket.on('ludo_move_token', async (data) => {
        const { roomId, username, tokenIndex } = data;
        const room = activeRooms[roomId];
        if (!room || room.gameType !== 'ludo') return;
        if (room.turn !== username) return;

        const opponent = room.players.find(p => p !== username);
        const playerTokens = room.positions[username];
        const dice = room.lastDice || 1;

        playerTokens[tokenIndex] += dice;
        if (playerTokens[tokenIndex] > 33) {
            playerTokens[tokenIndex] = 33;
        }

        if (playerTokens.every(pos => pos === 33)) {
            delete activeRooms[roomId];
            try {
                const payoutInfo = await settleMatchWinner(room, username, 'Ludo Blitz');
                io.to(roomId).emit('ludo_game_over', {
                    winner: username,
                    netWinnings: payoutInfo.netWinnings,
                    feeCharged: payoutInfo.feeCharged,
                    commissionPercent: payoutInfo.commissionPercent
                });
            } catch (err) {
                console.error('Error settling Ludo winner:', err);
            } finally {
                broadcastLoungeStats();
            }
            return;
        }

        room.turn = opponent;
        room.lastDice = null;

        io.to(roomId).emit('ludo_state_update', {
            positions: room.positions,
            turn: room.turn,
            lastAction: `${username} moved token #${tokenIndex + 1}. Now ${opponent}'s turn!`
        });
    });

    socket.on('leave_queue', (data) => {
        const { username } = data;
        waitingPlayers = waitingPlayers.filter(p => p.username !== username);
        broadcastLoungeStats();
    });

    // ==========================================
    // ADMIN & SUPPORT HANDLERS
    // ==========================================
    socket.on('get_house_revenue', async (callback) => {
        try {
            const sumRes = await pool.query('SELECT SUM(amount) AS total FROM admin_income_logs');
            let totalRevenue = sumRes.rows[0].total ? parseFloat(sumRes.rows[0].total) : 0;

            const logsRes = await pool.query(`
                SELECT type, description, amount, 
                TO_CHAR(created_at, 'YYYY-MM-DD HH12:MI:SS AM') AS date 
                FROM admin_income_logs ORDER BY id DESC LIMIT 50
            `);
            
            callback({
                revenue: totalRevenue,
                incomeLogs: logsRes.rows,
                withdrawalLogs: withdrawalLogs
            });
        } catch (err) {
            console.error('Error fetching house revenue from DB:', err);
            callback({ revenue: 0, incomeLogs: [], withdrawalLogs: [] });
        }
    });

    socket.on('admin_withdraw', async (data, callback) => {
        const { amount, bankName, accountNumber } = data;
        try {
            const sumRes = await pool.query('SELECT SUM(amount) AS total FROM admin_income_logs');
            let currentRevenue = sumRes.rows[0].total ? parseFloat(sumRes.rows[0].total) : 0;

            if (amount > currentRevenue) {
                callback({ success: false, message: 'Insufficient house revenue balance.' });
                return;
            }

            const bankListStr = await makeHttpsRequest({
                hostname: 'api.paystack.co',
                path: '/bank?country=nigeria',
                method: 'GET',
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
            });
            const bankList = JSON.parse(bankListStr);
            const bankObj = bankList.data.find(b => b.name === bankName);
            
            if (!bankObj) {
                return callback({ success: false, message: 'Invalid bank name recognized by Paystack.' });
            }

            const recipientStr = await makeHttpsRequest({
                hostname: 'api.paystack.co',
                path: '/transferrecipient',
                method: 'POST',
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
            }, JSON.stringify({
                type: 'nuban',
                name: 'Admin Payout',
                account_number: accountNumber,
                bank_code: bankObj.code,
                currency: 'NGN'
            }));
            
            const recipientData = JSON.parse(recipientStr);
            if (!recipientData.status) {
                return callback({ success: false, message: 'Paystack Account Error: ' + recipientData.message });
            }
            const recipientCode = recipientData.data.recipient_code;

            const transferStr = await makeHttpsRequest({
                hostname: 'api.paystack.co',
                path: '/transfer',
                method: 'POST',
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
            }, JSON.stringify({
                source: 'balance',
                amount: amount * 100,
                recipient: recipientCode,
                reason: 'Admin Platform Withdrawal'
            }));
            
            const transferData = JSON.parse(transferStr);

            if (!transferData.status) {
                return callback({ success: false, message: 'Transfer Failed: ' + transferData.message });
            }

            await pool.query(
                'INSERT INTO admin_income_logs (type, description, amount) VALUES ($1, $2, $3)',
                ['WITHDRAWAL', `Withdrawn to ${bankName} (${accountNumber}) via API`, -amount]
            );

            withdrawalLogs.unshift({
                amount,
                bankName,
                accountNumber,
                date: new Date().toLocaleString()
            });

            const updatedSumRes = await pool.query('SELECT SUM(amount) AS total FROM admin_income_logs');
            let newRevenue = updatedSumRes.rows[0].total ? parseFloat(updatedSumRes.rows[0].total) : 0;

            callback({ success: true, message: `Successfully withdrew ₦${amount.toLocaleString()} to ${bankName}. Check your bank app!`, newRevenue });
        } catch (err) {
            console.error('Error processing admin withdrawal:', err);
            callback({ success: false, message: 'Server error processing live Paystack withdrawal.' });
        }
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

    socket.on('send_chat_message', (data) => {
        const { username, message } = data;
        if (!username || !message || message.trim() === '') return;

        const chatPayload = {
            username: username,
            message: message.trim(),
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        io.emit('receive_chat_message', chatPayload);
    });

    socket.on('disconnect', async () => {
        waitingPlayers = waitingPlayers.filter(p => p.socketId !== socket.id);

        if (socket.authUsername) {
            for (const [roomId, room] of Object.entries(activeRooms)) {
                if (room.gameType === 'whot' && room.players.includes(socket.authUsername)) {
                    const winner = room.players.find(p => p !== socket.authUsername);
                    delete activeRooms[roomId];
                    try {
                        const payoutInfo = await settleMatchWinner(room, winner, 'Naija Whot (Opponent Disconnected)');
                        io.to(roomId).emit('whot_game_over', {
                            winner,
                            reason: 'opponent_disconnected',
                            netWinnings: payoutInfo.netWinnings,
                            feeCharged: payoutInfo.feeCharged,
                            commissionPercent: payoutInfo.commissionPercent
                        });
                    } catch (e) {
                        console.error('Error settling disconnect forfeit:', e);
                    }
                }
            }
        }

        if (socket.authUsername && activeUserSessions[socket.authUsername] === socket.id) {
            delete activeUserSessions[socket.authUsername];
        }
        io.emit('update_online_count', { count: io.engine.clientsCount });
        broadcastLoungeStats();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running live with PostgreSQL connected on port ${PORT}`);
});