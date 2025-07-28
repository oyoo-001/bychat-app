// db.js
const mysql = require('mysql2/promise');
// Remove: require('dotenv').config(); // Render automatically handles env vars, no need for dotenv

// Get the full DATABASE_URL from environment variables
const dbConnectionString = process.env.DATABASE_URL;

// Ensure the DATABASE_URL is set before attempting to connect
if (!dbConnectionString) {
    console.error('❌ FATAL: DATABASE_URL environment variable is not set!');
    process.exit(1); // Exit if no DB connection string is found
}

const pool = mysql.createPool(dbConnectionString); // Pass the full URL directly to createPool

// Test the connection
pool.getConnection()
    .then(connection => {
        console.log('✅ Connected to MySQL database!');
        connection.release(); // Release the connection immediately after testing
    })
    .catch(err => {
        console.error('❌ Error connecting to MySQL database:', err.message); // This will now show the specific error
        process.exit(1); // Exit the process if unable to connect to the database
    });

// ... (rest of your functions remain the same) ...

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
        return rows[0]; // Returns the first row (user object) or undefined if not found
    } catch (error) {
        console.error('Error in findUserByUsername:', error.message);
        throw error;
    }
}

// NEW: Function to update user preferences
async function saveUserPreferences(userId, themePreference, chatBackgroundImageUrl) {
    try {
        const [result] = await pool.execute(
            `UPDATE users
             SET theme_preference = ?, chat_background_image_url = ?
             WHERE id = ?`,
            [themePreference, chatBackgroundImageUrl, userId]
        );
        return result.affectedRows > 0; // Return true if rows were affected, false otherwise
    } catch (error) {
        console.error('Error in saveUserPreferences:', error.message);
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
        // CHANGED from pool.execute to pool.query
        const [rows] = await pool.query(
            'SELECT username, message_content, timestamp FROM global_messages ORDER BY timestamp DESC LIMIT ?',
            [limit]
        );
        console.log('Fetched latest global messages.');
        return rows.reverse(); // Return in ascending order (oldest first)
    } catch (error) {
        console.error('Error getting latest global messages:', error.message);
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
        // CHANGED from pool.execute to pool.query
        const [rows] = await pool.query(
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
            [user1Id, user2Id, user2Id, user1Id, limit]
        );
        return rows;
    }
      catch (error) {
        console.error('Error getting private message history:', error.message);
        throw error;
    }
}

// Function to get unread counts for a specific user from all other users
async function getUnreadCountsForUser(userId) {
    try {
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
            [userId]
        );

        const unreadCounts = {};
        rows.forEach(row => {
            unreadCounts[row.sender_id] = parseInt(row.unread_count, 10); // Ensure count is a number
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
        const [rows] = await pool.execute(
            `SELECT COUNT(*) AS total_unread_count
            FROM private_messages
            WHERE receiver_id = ? AND is_read = FALSE`,
            [userId]
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
        const [result] = await pool.execute(
            `UPDATE private_messages
            SET is_read = TRUE
            WHERE receiver_id = ? AND sender_id = ? AND is_read = FALSE`,
            [receiverId, senderId]
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
    saveUserPreferences,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead
};