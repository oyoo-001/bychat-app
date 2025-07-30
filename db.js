const mysql = require('mysql2/promise');
require('dotenv').config();

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
        const query = `INSERT INTO users (username, password) VALUES ('${mysql.escape(username)}', '${mysql.escape(hashedPassword)}')`;
        console.log('registerUser: Executing query:', query);
        const [result] = await pool.query(query);
        return { id: result.insertId, username };
    } catch (error) {
        console.error('Error in registerUser:', error.message);
        if (error.code === 'ER_DUP_ENTRY') {
            throw new Error('Username already exists');
        }
        throw error;
    }
}

// Function to find a user by username or email
async function findUserByIdentifier(identifier) {
    try {
        const query = `SELECT id, username, password, email, theme_preference, chat_background_image_url
                       FROM users
                       WHERE username = '${mysql.escape(identifier)}' OR email = '${mysql.escape(identifier)}'`;
        console.log('findUserByIdentifier: Executing query:', query);
        const [rows] = await pool.query(query);
        return rows[0];
    } catch (error) {
        console.error('Error in findUserByIdentifier:', error.message);
        throw error;
    }
}

// Function to find a user by username
async function findUserByUsername(username) {
    try {
        const query = `SELECT id, username, password, theme_preference, chat_background_image_url
                       FROM users
                       WHERE username = '${mysql.escape(username)}'`;
        console.log('findUserByUsername: Executing query:', query);
        const [rows] = await pool.query(query);
        return rows[0];
    } catch (error) {
        console.error('Error in findUserByUsername:', error.message);
        throw error;
    }
}

// Function to save a chat message (global)
async function saveMessage(userId, username, messageContent) {
    try {
        const parsedUserId = parseInt(userId, 10);
        if (isNaN(parsedUserId) || parsedUserId <= 0) {
            throw new Error('Invalid userId: must be a positive integer');
        }
        const query = `INSERT INTO global_messages (user_id, username, message_content)
                       VALUES (${parsedUserId}, '${mysql.escape(username)}', '${mysql.escape(messageContent)}')`;
        console.log('saveMessage: Executing query:', query);
        const [result] = await pool.query(query);
        return result.insertId;
    } catch (error) {
        console.error('Error saving global message:', error.message);
        throw error;
    }
}

// Function to get the latest chat messages (global)
async function getLatestMessages(limit = 100) {
    try {
        const parsedLimit = parseInt(limit, 10);
        if (isNaN(parsedLimit) || parsedLimit <= 0) {
            console.warn('getLatestMessages: Invalid limit value, using default:', 100);
            parsedLimit = 100;
        }
        console.log('getLatestMessages: Input limit =', limit, 'Parsed limit =', parsedLimit);
        const query = `SELECT username, message_content, timestamp
                       FROM global_messages
                       ORDER BY timestamp DESC
                       LIMIT ${parsedLimit}`;
        console.log('getLatestMessages: Executing query:', query);
        const [rows] = await pool.query(query);
        console.log('getLatestMessages: Fetched messages count:', rows.length);
        return rows.reverse();
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
        const parsedSenderId = parseInt(senderId, 10);
        const parsedReceiverId = parseInt(receiverId, 10);
        if (isNaN(parsedSenderId) || isNaN(parsedReceiverId) || parsedSenderId <= 0 || parsedReceiverId <= 0) {
            throw new Error('Invalid senderId or receiverId: must be positive integers');
        }
        const query = `INSERT INTO private_messages (sender_id, receiver_id, message_content, is_read)
                       VALUES (${parsedSenderId}, ${parsedReceiverId}, '${mysql.escape(messageContent)}', FALSE)`;
        console.log('savePrivateMessage: Executing query:', query);
        const [result] = await pool.query(query);
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
        console.log('getPrivateMessageHistory: Input params:', { user1Id, user2Id, limit });
        console.log('getPrivateMessageHistory: Parsed params:', { parsedUser1Id, parsedUser2Id, parsedLimit });
        const query = `SELECT
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
                (pm.sender_id = ${parsedUser1Id} AND pm.receiver_id = ${parsedUser2Id}) OR
                (pm.sender_id = ${parsedUser2Id} AND pm.receiver_id = ${parsedUser1Id})
            ORDER BY
                pm.timestamp ASC
            LIMIT ${parsedLimit}`;
        console.log('getPrivateMessageHistory: Executing query:', query);
        const [rows] = await pool.query(query);
        console.log('getPrivateMessageHistory: Fetched messages count:', rows.length);
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
        const query = `SELECT
                sender_id,
                COUNT(*) AS unread_count
            FROM
                private_messages
            WHERE
                receiver_id = ${parsedUserId} AND is_read = FALSE
            GROUP BY
                sender_id`;
        console.log('getUnreadCountsForUser: Executing query:', query);
        const [rows] = await pool.query(query);
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
        const query = `SELECT COUNT(*) AS total_unread_count
            FROM private_messages
            WHERE receiver_id = ${parsedUserId} AND is_read = FALSE`;
        console.log('getTotalUnreadCountForUser: Executing query:', query);
        const [rows] = await pool.query(query);
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
        const query = `UPDATE private_messages
            SET is_read = TRUE
            WHERE receiver_id = ${parsedReceiverId} AND sender_id = ${parsedSenderId} AND is_read = FALSE`;
        console.log('markMessagesAsRead: Executing query:', query);
        const [result] = await pool.query(query);
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
    findUserByIdentifier,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead
};