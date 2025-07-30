const mysql = require('mysql2/promise');
require('dotenv').config(); // Load environment variables

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chat_app',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test database connection on startup
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Connected to MySQL database!');
        connection.release();
    } catch (err) {
        console.error('❌ Error connecting to MySQL database:', err.message);
        process.exit(1);
    }
}
testConnection();

// Function to register a new user
async function registerUser(username, hashedPassword) {
    try {
        const [result] = await pool.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );
        return { id: result.insertId, username };
    } catch (error) {
        console.error('Error in registerUser:', error.message);
        if (error.code === 'ER_DUP_ENTRY') {
            throw new Error('Username already exists');
        }
        throw error;
    }
}

// Function to find a user by username
async function findUserByUsername(username) {
    try {
        const [rows] = await pool.execute(
            'SELECT id, username, password, theme_preference, chat_background_image_url FROM users WHERE username = ?',
            [username]
        );
        return rows[0];
    } catch (error) {
        console.error('Error in findUserByUsername:', error.message);
        throw error;
    }
}

// Function to save a chat message (global)
async function saveMessage(userId, username, messageContent) {
    try {
        const [result] = await pool.execute(
            'INSERT INTO global_messages (user_id, username, message_content) VALUES (?, ?, ?)',
            [userId, username, messageContent]
        );
        return result.insertId;
    } catch (error) {
        console.error('Error saving global message:', error.message);
        throw error;
    }
}

// Function to get the latest chat messages (global)
async function getLatestMessages(limit = 100) {
    try {
        const parsedLimit = parseInt(limit, 10); // Ensure limit is an integer
        if (isNaN(parsedLimit) || parsedLimit <= 0) {
            console.warn('Invalid limit value, using default:', 100);
            parsedLimit = 100; // Fallback to default
        }
        console.log('getLatestMessages: Executing with limit =', parsedLimit); // Debug log
        const [rows] = await pool.execute(
            'SELECT username, message_content, timestamp FROM global_messages ORDER BY timestamp DESC LIMIT ?',
            [parsedLimit]
        );
        console.log('Fetched messages count:', rows.length); // Additional debug log
        return rows.reverse(); // Return in ascending order
    } catch (error) {
        console.error('Error getting latest global messages:', {
            message: error.message,
            sqlMessage: error.sqlMessage,
            sqlState: error.sqlState,
            code: error.code
        });
        throw error;
    }
}

// Function to save a private message
async function savePrivateMessage(senderId, receiverId, messageContent) {
    try {
        const [result] = await pool.execute(
            'INSERT INTO private_messages (sender_id, receiver_id, message_content, is_read) VALUES (?, ?, ?, FALSE)',
            [senderId, receiverId, messageContent]
        );
        return result.insertId;
    } catch (error) {
        console.error('Error saving private message:', error.message);
        throw error;
    }
}

// Function to get private message history between two users
async function getPrivateMessageHistory(user1Id, user2Id, limit = 50) {
    try {
        const parsedUser1Id = parseInt(user1Id, 10);
        const parsedUser2Id = parseInt(user2Id, 10);
        const parsedLimit = parseInt(limit, 10);
        if (isNaN(parsedUser1Id) || isNaN(parsedUser2Id) || isNaN(parsedLimit) || parsedLimit <= 0) {
            throw new Error('Invalid parameters: user1Id, user2Id, and limit must be positive integers');
        }
        console.log('getPrivateMessageHistory: Executing with user1Id =', parsedUser1Id, 'user2Id =', parsedUser2Id, 'limit =', parsedLimit);
        const [rows] = await pool.execute(
            `SELECT
                pm.message_content,
                pm.timestamp,
                u_sender.username AS sender_username,
                pm.sender_id,
                pm.receiver_id,
                pm.is_read
            FROM
                private_messages pm
            JOIN
                users u_sender ON pm.sender_id = u_sender.id
            WHERE
                (pm.sender_id = ? AND pm.receiver_id = ?) OR
                (pm.sender_id = ? AND pm.receiver_id = ?)
            ORDER BY
                pm.timestamp ASC
            LIMIT ?`,
            [parsedUser1Id, parsedUser2Id, parsedUser2Id, parsedUser1Id, parsedLimit]
        );
        console.log('Fetched private messages count:', rows.length);
        return rows;
    } catch (error) {
        console.error('Error getting private message history:', {
            message: error.message,
            sqlMessage: error.sqlMessage,
            sqlState: error.sqlState,
            code: error.code
        });
        throw error;
    }
}

// Function to get unread counts for a specific user from all other users
async function getUnreadCountsForUser(userId) {
    try {
        const parsedUserId = parseInt(userId, 10);
        if (isNaN(parsedUserId) || parsedUserId <= 0) {
            throw new Error('Invalid userId: must be a positive integer');
        }
        const [rows] = await pool.execute(
            `SELECT
                sender_id,
                COUNT(*) AS unread_count
            FROM
                private_messages
            WHERE
                receiver_id = ? AND is_read = FALSE
            GROUP BY
                sender_id`,
            [parsedUserId]
        );
        const unreadCounts = {};
        rows.forEach(row => {
            unreadCounts[row.sender_id] = parseInt(row.unread_count, 10);
        });
        return unreadCounts;
    } catch (error) {
        console.error('Error getting unread counts for user:', error.message);
        throw error;
    }
}

// Function to get the total number of unread messages for a user
async function getTotalUnreadCountForUser(userId) {
    try {
        const parsedUserId = parseInt(userId, 10);
        if (isNaN(parsedUserId) || parsedUserId <= 0) {
            throw new Error('Invalid userId: must be a positive integer');
        }
        const [rows] = await pool.execute(
            `SELECT COUNT(*) AS total_unread_count
            FROM private_messages
            WHERE receiver_id = ? AND is_read = FALSE`,
            [parsedUserId]
        );
        return rows[0] ? parseInt(rows[0].total_unread_count, 10) : 0;
    } catch (error) {
        console.error('Error getting total unread count for user:', error.message);
        throw error;
    }
}

// Function to mark messages as read for a specific recipient from a specific sender
async function markMessagesAsRead(receiverId, senderId) {
    try {
        const parsedReceiverId = parseInt(receiverId, 10);
        const parsedSenderId = parseInt(senderId, 10);
        if (isNaN(parsedReceiverId) || isNaN(parsedSenderId)) {
            throw new Error('Invalid receiverId or senderId: must be positive integers');
        }
        const [result] = await pool.execute(
            `UPDATE private_messages
            SET is_read = TRUE
            WHERE receiver_id = ? AND sender_id = ? AND is_read = FALSE`,
            [parsedReceiverId, parsedSenderId]
        );
        return result.affectedRows;
    } catch (error) {
        console.error('Error marking messages as read:', error.message);
        throw error;
    }
}

module.exports = {
    pool,
    registerUser,
    findUserByUsername,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead
};