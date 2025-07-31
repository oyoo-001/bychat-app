// db.js
// This file sets up the database connection pool and exports functions
// for interacting with the database. It uses environment variables
// to securely manage credentials, which is best practice for production.

require('dotenv').config();
const mysql = require('mysql2/promise');

// Create the database connection pool using environment variables
// Fallback values are provided for local development.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chat_app',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Test the database connection on startup
pool.getConnection()
    .then(connection => {
        console.log('✅ Connected to MySQL database!');
        connection.release(); // Release the connection back to the pool
    })
    .catch(err => {
        console.error('❌ Error connecting to database:', err.message);
        // It's crucial to exit the application if the database connection fails on startup
        // This prevents the server from running without a database connection.
        process.exit(1);
    });


// --- Database Interaction Functions ---

/**
 * Registers a new user in the database.
 * @param {string} username - The user's chosen username.
 * @param {string} hashedPassword - The bcrypt-hashed password.
 * @param {string} email - The user's email address (optional).
 * @returns {Promise<object>} - The newly registered user's ID and username.
 */
async function registerUser(username, hashedPassword, email = null) {
    try {
        const [result] = await pool.query(
            'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
            [username, hashedPassword, email]
        );
        return { id: result.insertId, username };
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            throw new Error('Username or email already exists.');
        }
        console.error('Error registering user:', error);
        throw new Error('Could not register user due to a database error.');
    }
}

/**
 * Finds a user by their username.
 * @param {string} username - The username to search for.
 * @returns {Promise<object|null>} - The user object if found, otherwise null.
 */
async function findUserByUsername(username) {
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        return rows[0] || null;
    } catch (error) {
        console.error('Error finding user by username:', error);
        throw new Error('Database error while finding user.');
    }
}

/**
 * Finds a user by their username or email (for password reset).
 * @param {string} identifier - The username or email to search for.
 * @returns {Promise<object|null>} - The user object if found, otherwise null.
 */
async function findUserByIdentifier(identifier) {
    try {
        const [rows] = await pool.query('SELECT id, username, email FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
        return rows[0] || null;
    } catch (error) {
        console.error('Error finding user by identifier:', error);
        throw new Error('Database error while finding user by identifier.');
    }
}

/**
 * Saves a global chat message.
 * @param {number} userId - The ID of the sender.
 * @param {string} username - The username of the sender.
 * @param {string} messageContent - The content of the message.
 */
async function saveMessage(userId, username, messageContent) {
    try {
        await pool.query(
            'INSERT INTO global_messages (sender_id, sender_username, message_content) VALUES (?, ?, ?)',
            [userId, username, messageContent]
        );
    } catch (error) {
        console.error('Error saving global message:', error);
        throw new Error('Failed to save message.');
    }
}

/**
 * Retrieves the latest global chat messages.
 * @param {number} limit - The maximum number of messages to retrieve.
 * @returns {Promise<Array<object>>} - An array of message objects.
 */
async function getLatestMessages(limit = 50) {
    try {
        const [rows] = await pool.query(
            `SELECT sender_username AS username, message_content AS message, timestamp
             FROM global_messages
             ORDER BY timestamp DESC
             LIMIT ?`,
            [limit]
        );
        return rows.reverse(); // Return in chronological order
    } catch (error) {
        console.error('Error fetching latest messages:', error);
        throw new Error('Failed to retrieve chat history.');
    }
}


/*
 * Saves a private message.
 * @param {number} senderId - The ID of the sender.
 * @param {number} receiverId - The ID of the receiver.
 * @param {string} messageContent - The content of the message.
 */
async function savePrivateMessage(senderId, receiverId, messageContent) {
    try {
        await pool.query(
            `INSERT INTO private_messages (sender_id, receiver_id, message_content)
             VALUES (?, ?, ?)`,
            [senderId, receiverId, messageContent]
        );
    } catch (error) {
        console.error('Error saving private message:', error);
        throw new Error('Failed to save private message.');
    }
}

/**
 * Retrieves the private message history between two users.
 * @param {number} userId1 - The ID of the first user.
 * @param {number} userId2 - The ID of the second user.
 * @param {number} limit - The maximum number of messages to retrieve.
 * @returns {Promise<Array<object>>} - An array of private message objects.
 */
async function getPrivateMessageHistory(userId1, userId2, limit = 50) {
    try {
        const [rows] = await pool.query(
            `SELECT pm.sender_id, u.username AS sender_username, pm.message_content, pm.timestamp, pm.is_read
             FROM private_messages pm
             JOIN users u ON pm.sender_id = u.id
             WHERE (pm.sender_id = ? AND pm.receiver_id = ?)
                OR (pm.sender_id = ? AND pm.receiver_id = ?)
             ORDER BY pm.timestamp DESC
             LIMIT ?`,
            [userId1, userId2, userId2, userId1, limit]
        );
        return rows.reverse(); // Return in chronological order
    } catch (error) {
        console.error('Error fetching private message history:', error);
        throw new Error('Failed to retrieve private chat history.');
    }
}

/**
 * Gets unread message counts for a user from each sender.
 * @param {number} userId - The ID of the user.
 * @returns {Promise<object>} - An object where keys are sender IDs and values are unread counts.
 */
async function getUnreadCountsForUser(userId) {
    try {
        const [rows] = await pool.query(
            `SELECT sender_id, COUNT(*) AS unread_count
             FROM private_messages
             WHERE receiver_id = ? AND is_read = FALSE
             GROUP BY sender_id`,
            [userId]
        );
        const unreadCounts = {};
        rows.forEach(row => {
            unreadCounts[row.sender_id] = row.unread_count;
        });
        return unreadCounts;
    } catch (error) {
        console.error('Error getting unread counts for user:', error);
        throw new Error('Failed to retrieve unread counts.');
    }
}

/**
 * Gets the total unread message count for a user.
 * @param {number} userId - The ID of the user.
 * @returns {Promise<number>} - The total number of unread messages.
 */
async function getTotalUnreadCountForUser(userId) {
    try {
        const [rows] = await pool.query(
            `SELECT COUNT(*) AS total_unread
             FROM private_messages
             WHERE receiver_id = ? AND is_read = FALSE`,
            [userId]
        );
        return rows[0] ? rows[0].total_unread : 0;
    } catch (error) {
        console.error('Error getting total unread count for user:', error);
        throw new Error('Failed to retrieve total unread count.');
    }
}

/**
 * Marks messages from a specific sender to a specific receiver as read.
 * @param {number} receiverId - The ID of the user who received the messages.
 * @param {number} senderId - The ID of the user who sent the messages.
 */
async function markMessagesAsRead(receiverId, senderId) {
    try {
        await pool.query(
            `UPDATE private_messages
             SET is_read = TRUE
             WHERE receiver_id = ? AND sender_id = ? AND is_read = FALSE`,
            [receiverId, senderId]
        );
    } catch (error) {
        console.error('Error marking messages as read:', error);
        throw new Error('Failed to mark messages as read.');
    }
}

// Export the database connection pool and all interaction functions
module.exports = {
    pool,
    registerUser,
    findUserByUsername,
    findUserByIdentifier,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead
};
