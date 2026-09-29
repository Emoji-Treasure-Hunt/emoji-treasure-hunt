const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:your_password@localhost:5432/emoji_treasure_db',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const initializeDatabase = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                fullname VARCHAR(100),
                country VARCHAR(50) DEFAULT 'Nigeria',
                dob DATE,
                gender VARCHAR(20),
                balance NUMERIC(12, 2) DEFAULT 0.00,
                total_wins INT DEFAULT 0,
                total_won NUMERIC(12, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                email VARCHAR(100) NOT NULL,
                type VARCHAR(20) NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                description TEXT,
                reference VARCHAR(100) UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("Database tables verified/created successfully.");
    } catch (err) {
        console.error("Error initializing database tables:", err);
    }
};

initializeDatabase();

module.exports = pool;