// db.js
const mysql = require('mysql2/promise');
// Removed: require('dotenv').config(); // Render automatically handles env vars, no need for dotenv

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

// Make pool.execute available as db.execute for consistency
const db = pool;

// Function to register a new user (to include email)
async function registerUser(username, email, hashedPassword) { // Added 'email' parameter
    try {
        // Check if username already exists
        const [existingUsername] = await db.execute('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsername.length > 0) {
            throw new Error('Username already exists');
        }

        // Check if email already exists
        const [existingEmail] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            throw new Error('Email already exists');
        }

        // Insert into users table, including email and default preferences
        const [result] = await db.execute(
            'INSERT INTO users (username, email, password, theme_preference, chat_background_image_url) VALUES (?, ?, ?, ?, ?)',
            [username, email, hashedPassword, 'dark', null] // 'dark' and null are default values
        );

        if (result.affectedRows === 1) {
            return {
                id: result.insertId,
                username: username,
                email: email, // Return email with the new user object
                theme_preference: 'dark',
                chat_background_image_url: null
            };
        } else {
            throw new Error('Failed to register user unexpectedly.');
        }
    } catch (error) {
        console.error('Error in registerUser:', error.message);
        // The specific 'Username already exists' or 'Email already exists' errors are re-thrown
        // For other DB errors, throw the generic error
        throw error;
    }
}

// Function to find a user by username (to include email and preferences)
async function findUserByUsername(username) {
    try {
        const [rows] = await db.execute(
            'SELECT id, username, email, password, theme_preference, chat_background_image_url FROM users WHERE username = ?',
            [username]
        );
        return rows[0] || null; // Returns the first row (user object) or null if not found
    } catch (error) {
        console.error('Error in findUserByUsername:', error.message);
        throw error;
    }
}

// NEW: Function to find a user by username OR email (Crucial for Forgot Password)
async function findUserByIdentifier(identifier) {
    try {
        const [rows] = await db.execute(
            'SELECT id, username, email, password, theme_preference, chat_background_image_url FROM users WHERE username = ? OR email = ?',
            [identifier, identifier] // Tries to match by username or email
        );
        return rows[0] || null; // Returns the first user found or null
    } catch (error) {
        console.error('Error in findUserByIdentifier:', error.message);
        throw error;
    }
}

// Function to update user preferences (if you want to control what's nullable from client)
// This function needs careful handling if chatBackgroundImageUrl can be NULL.
// The current SQL sets it to NULL if passed as NULL.
async function saveUserPreferences(userId, themePreference, chatBackgroundImageUrl) {
    try {
        let updateQuery = `UPDATE users SET theme_preference = ?`;
        const params = [themePreference];

        // Only add chat_background_image_url to query if it's explicitly provided
        // This prevents overwriting with NULL if the client doesn't send it.
        if (chatBackgroundImageUrl !== undefined) { // Check for undefined, not just null
            updateQuery += `, chat_background_image_url = ?`;
            params.push(chatBackgroundImageUrl);
        }

        updateQuery += ` WHERE id = ?`;
        params.push(userId);

        const [result] = await db.execute(updateQuery, params);
        return result.affectedRows > 0; // Return true if rows were affected, false otherwise
    } catch (error) {
        console.error('Error in saveUserPreferences:', error.message);
        throw error;
    }
}

// Existing Message Functions (ensure they use 'db' alias for consistency)
async function saveMessage(userId, username, messageContent) {
    try {
        const [result] = await db.execute( // Using db.execute for consistency
            'INSERT INTO global_messages (user_id, username, message_content) VALUES (?, ?, ?)',
            [userId, username, messageContent]
        );
        return result.insertId;
    } catch (error) {
        console.error('Error saving global message:', error.message);
        throw error;
    }
}

// --- MODIFIED: Function to get the latest chat messages (global) ---
async function getLatestMessages(limit = 100) {
    try {
        console.log(`DEBUG: getLatestMessages received limit: ${limit}, type: ${typeof limit}`);
        const [rows] = await db.execute(
            'SELECT username, message_content, timestamp FROM global_messages ORDER BY timestamp DESC LIMIT ?',
            [limit] // CRITICAL FIX: Wrap 'limit' in an array for db.execute
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
        const [result] = await db.execute(
            'INSERT INTO private_messages (sender_id, receiver_id, message_content, is_read) VALUES (?, ?, ?, FALSE)',
            [senderId, receiverId, messageContent]
        );
        return result.insertId;
    } catch (error) {
        console.error('Error saving private message:', error.message);
        throw error;
    }
}

// --- MODIFIED: Function to get private message history between two users ---
async function getPrivateMessageHistory(user1Id, user2Id, limit = 50) {
    try {
        console.log(`DEBUG: getPrivateMessageHistory received limit: ${limit}, type: ${typeof limit}`);
        const [rows] = await db.execute( // Using db.execute
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
            [user1Id, user2Id, user2Id, user1Id, limit] // CRITICAL FIX: Ensure all parameters are in this array
        );
        return rows;
    } catch (error) {
        console.error('Error getting private message history:', error.message);
        throw error;
    }
}

// Function to get unread counts for a specific user from all other users
async function getUnreadCountsForUser(userId) {
    try {
        const [rows] = await db.execute( // Using db.execute
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
        const [rows] = await db.execute( // Using db.execute
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
        const [result] = await db.execute( // Using db.execute
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
    pool, // Export the pool directly if needed for advanced use
    db, // Export db as an alias for pool.execute for consistency
    registerUser,
    findUserByUsername,
    findUserByIdentifier,
    saveUserPreferences,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead
};