const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
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

// Temporary memory store for OTP verification codes
let otpStorage = {};

// ==========================================
// INITIALIZE DATABASE TABLES (Withdrawals & Users)
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
        console.log("Database tables verified/created successfully.");
    } catch (err) {
        console.error("Error initializing database tables:", err);
    }
}
initDB();

// ==========================================
// 1. SECURE PAYSTACK WEBHOOK ROUTE (Must be before express.json)
// ==========================================
app.post('/paystack-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const paystackSignature = req.headers['x-paystack-signature'];

    // Verify the cryptographic signature using the raw body buffer
    const hash = crypto
        .createHmac('sha512', PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest('hex');

    if (hash === paystackSignature) {
        // Safe to parse into JSON after successful signature match
        const event = JSON.parse(req.body.toString());

        if (event.event === 'charge.success') {
            const paymentData = event.data;
            const userEmail = paymentData.customer.email;
            const amountPaid = paymentData.amount / 100; // Convert kobo to Naira
            const reference = paymentData.reference;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // IDEMPOTENCY CHECK via Database
                const existingTx = await client.query('SELECT id FROM transactions WHERE reference = $1', [reference]);
                if (existingTx.rows.length > 0) {
                    await client.query('ROLLBACK');
                    console.log(`Duplicate webhook ignored for reference: ${reference}`);
                    return res.status(200).send('Webhook already processed');
                }

                // 1. Credit the user's balance permanently in the database
                await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE email = $2',
                    [amountPaid, userEmail]
                );

                // 2. Log the transaction in PostgreSQL
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

// Serve static files / money.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'money.html'));
});

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

// In-Memory Game State Variables (Rooms & Match queues remain in-memory for active socket gameplay speed)
let waitingPlayers = [];
let activeRooms = {};
let houseRevenue = 0;
let incomeLogs = [];
let withdrawalLogs = [];
let supportTickets = [];

// Socket.io Game Logic & Management
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Allow frontend to check user wallet balance directly from PostgreSQL database via email or username fallback
    socket.on('get_balance', async (data, callback) => {
        const { email, username } = data;
        try {
            let result;
            if (email) {
                result = await pool.query('SELECT balance FROM users WHERE email = $1', [email]);
            }
            if ((!result || result.rows.length === 0) && username) {
                result = await pool.query('SELECT balance FROM users WHERE username = $1', [username]);
            }
            const balance = result && result.rows.length > 0 ? parseFloat(result.rows[0].balance) : 0;
            callback({ success: true, balance });
        } catch (err) {
            console.error("Error fetching balance from DB:", err);
            callback({ success: false, balance: 0 });
        }
    });

    // Handle sending Email Verification OTP via Resend with Console Fallback
    socket.on('send_email_otp', async (data, callback) => {
        const { email } = data;
        if (!email) {
            return callback({ success: false, message: 'Email address is required.' });
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        otpStorage[email] = verificationCode;

        try {
            const emailResult = await resend.emails.send({
                from: 'Emoji Treasure Hunt <onboarding@resend.dev>',
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
                console.log(`========================================`);
                console.log(`[TEST MODE OTP] Code for ${email}: ${verificationCode}`);
                console.log(`========================================`);
            }

            console.log(`Verification code processed for ${email}`);
            callback({ success: true, message: 'Verification code generated successfully!' });
        } catch (err) {
            console.warn('Resend exception, using console fallback:', err);
            console.log(`========================================`);
            console.log(`[TEST MODE OTP] Code for ${email}: ${verificationCode}`);
            console.log(`========================================`);
            callback({ success: true, message: 'Verification code generated successfully!' });
        }
    });

    // Handle verifying OTP code entered by the user
    socket.on('verify_email_otp', (data, callback) => {
        const { email, enteredOtp } = data;
        if (otpStorage[email] && otpStorage[email] === enteredOtp) {
            delete otpStorage[email]; // clear code after successful use
            callback({ success: true });
        } else {
            callback({ success: false, message: 'Invalid or expired verification code.' });
        }
    });

    // 1. Database-backed User Registration Handler with Bulletproof Email Mapping
    socket.on('register_user', async (data, callback) => {
        const username = data ? data.username : null;
        const email = data ? (data.email || data.contact) : null;
        const password = data ? data.password : null;

        if (!username || !email || !password) {
            return callback({ success: false, message: 'Missing required registration fields.' });
        }

        try {
            const existing = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
            if (existing.rows.length > 0) {
                return callback({ success: false, message: 'Username or email already exists.' });
            }

            await pool.query(
                `INSERT INTO users (username, email, password, balance) VALUES ($1, $2, $3, 0.00)`,
                [username, email, password]
            );

            callback({ success: true, message: 'Registration successful!' });
        } catch (err) {
            console.error('Registration error details:', err);
            callback({ success: false, message: 'Server error during registration.' });
        }
    });

    // 2. Database-backed User Login Handler
    socket.on('login_user', async (data, callback) => {
        const { username, password } = data;
        try {
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            if (result.rows.length === 0) {
                return callback({ success: false, message: 'Invalid username or password.' });
            }

            const user = result.rows[0];
            if (user.password !== password) {
                return callback({ success: false, message: 'Invalid username or password.' });
            }

            callback({ 
                success: true, 
                user: { 
                    username: user.username, 
                    email: user.email, 
                    balance: parseFloat(user.balance) 
                } 
            });
        } catch (err) {
            console.error('Login error:', err);
            callback({ success: false, message: 'Server error during login.' });
        }
    });

    // 3. Database-backed Change Password Handler
    socket.on('change_password', async (data, callback) => {
        const { username, oldPassword, newPassword } = data;
        try {
            const result = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
            if (result.rows.length === 0 || result.rows[0].password !== oldPassword) {
                return callback({ success: false, message: 'Current password is incorrect.' });
            }

            await pool.query('UPDATE users SET password = $1 WHERE username = $2', [newPassword, username]);
            callback({ success: true, message: 'Password updated successfully!' });
        } catch (err) {
            console.error('Password change error:', err);
            callback({ success: false, message: 'Server error updating password.' });
        }
    });

    // Manual Withdrawal Request Handler with Flexible User Lookup Fallback
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
            callback({ success: true, message: 'Withdrawal request submitted successfully! Pending admin fulfillment.' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Manual withdrawal error:', err);
            callback({ success: false, message: 'Server error processing withdrawal.' });
        } finally {
            client.release();
        }
    });

    // Fetch pending manual withdrawals for admin review
    socket.on('get_pending_withdrawals', async (callback) => {
        try {
            const result = await pool.query("SELECT * FROM withdrawals WHERE status = 'Pending' ORDER BY created_at ASC");
            callback({ success: true, withdrawals: result.rows });
        } catch (err) {
            console.error('Error fetching pending withdrawals:', err);
            callback({ success: false, message: 'Error fetching withdrawal requests.' });
        }
    });

    // Mark manual withdrawal as fulfilled/paid by admin
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

    // Reject manual withdrawal and refund funds back to the user's wallet
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

            // Join both sockets to the room channel so broadcast room messages work seamlessly
            const socket1 = io.sockets.sockets.get(player1.socketId);
            const socket2 = io.sockets.sockets.get(player2.socketId);
            if (socket1) socket1.join(roomId);
            if (socket2) socket2.join(roomId);

            io.to(roomId).emit('match_found', { roomId, players: [player1.username, player2.username], targetEmoji, winningIndex });
        }
    });

    socket.on('play_turn', (data) => {
        const { roomId, index, decoyEmoji } = data;
        const room = activeRooms[roomId];
        if (room) {
            socket.to(roomId).emit('opponent_played', { index, decoyEmoji });
        }
    });

    // Updated player_won event with ₦15 fee deduction and database credit
    socket.on('player_won', async (data) => {
        const { roomId, winner } = data;
        const room = activeRooms[roomId];
        if (room) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const stake = room.stake;
                const totalPool = stake * 2;
                const houseCut = 15;
                const netWinnings = totalPool - houseCut;

                // 1. Credit the winner's balance in database
                await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE username = $2',
                    [netWinnings, winner]
                );

                // 2. Log the WIN transaction for the winner
                await client.query(
                    'INSERT INTO transactions (email, type, amount, description) SELECT email, $1, $2, $3 FROM users WHERE username = $4',
                    ['WIN', netWinnings, `Won ${stake * 2} pool match (₦15 fee applied)`, winner]
                );

                // 3. Accumulate house fee
                houseRevenue += houseCut;
                incomeLogs.unshift({
                    type: 'COMMISSION',
                    description: `₦15 flat fee from ₦${totalPool} pool match`,
                    amount: houseCut,
                    date: new Date().toLocaleString()
                });

                await client.query('COMMIT');

                // Broadcast game over to everyone in the room
                io.to(roomId).emit('game_over', { winner, reason: 'treasure_found', netWinnings });
            } catch (err) {
                await client.query('ROLLBACK');
                console.error('Error processing winner payout:', err);
            } finally {
                client.release();
            }

            delete activeRooms[roomId];
        }
    });

    // New match_timeout handler for 60s draw/stake refund
    socket.on('match_timeout', async (data) => {
        const { roomId } = data;
        const room = activeRooms[roomId];
        if (room) {
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
            }

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
    console.log(`Server running live with PostgreSQL connected on port ${PORT}`);
});