// db.js
const mysql = require('mysql2/promise');

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
        console.error('❌ Error connecting to MySQL database:', err.message);
        process.exit(1); // Exit the process if unable to connect to the database
    });

// Make pool available through the 'db' alias for consistency
const db = pool;

// --- USER FUNCTIONS ---
async function registerUser(username, email, hashedPassword) {
    try {
        const [existingUsername] = await db.execute('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsername.length > 0) {
            throw new Error('Username already exists');
        }

        const [existingEmail] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            throw new Error('Email already exists');
        }

        const [result] = await db.execute(
            'INSERT INTO users (username, email, password, theme_preference, chat_background_image_url) VALUES (?, ?, ?, ?, ?)',
            [username, email, hashedPassword, 'dark', null]
        );

        if (result.affectedRows === 1) {
            return { id: result.insertId, username, email, theme_preference: 'dark', chat_background_image_url: null };
        } else {
            throw new Error('Failed to register user unexpectedly.');
        }
    } catch (error) {
        console.error('Error in registerUser:', error.message);
        throw error;
    }
}

async function findUserByUsername(username) {
    try {
        const [rows] = await db.execute(
            'SELECT id, username, email, password, theme_preference, chat_background_image_url FROM users WHERE username = ?',
            [username]
        );
        return rows[0] || null;
    } catch (error) {
        console.error('Error in findUserByUsername:', error.message);
        throw error;
    }
}

async function findUserByIdentifier(identifier) {
    try {
        const [rows] = await db.execute(
            'SELECT id, username, email, password, theme_preference, chat_background_image_url FROM users WHERE username = ? OR email = ?',
            [identifier, identifier]
        );
        return rows[0] || null;
    } catch (error) {
        console.error('Error in findUserByIdentifier:', error.message);
        throw error;
    }
}

async function saveUserPreferences(userId, themePreference, chatBackgroundImageUrl) {
    try {
        let updateQuery = `UPDATE users SET theme_preference = ?`;
        const params = [themePreference];

        if (chatBackgroundImageUrl !== undefined) {
            updateQuery += `, chat_background_image_url = ?`;
            params.push(chatBackgroundImageUrl);
        }

        updateQuery += ` WHERE id = ?`;
        params.push(userId);

        const [result] = await db.execute(updateQuery, params);
        return result.affectedRows > 0;
    } catch (error) {
        console.error('Error in saveUserPreferences:', error.message);
        throw error;
    }
}

// ... (keep the initial connection code the same) ...

// --- MESSAGE FUNCTIONS ---
async function saveMessage(userId, username, messageContent) {
    try {
        const [result] = await db.execute(
            'INSERT INTO global_messages (user_id, username, message_content) VALUES (?, ?, ?)',
            [userId, username, messageContent]
        );
        return result.insertId;
    } catch (error) {
        console.error('Error saving global message:', error.message);
        throw error;
    }
}

async function getLatestMessages(limit = 100) {
    try {
        // More robust limit handling
        const queryLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000); // Clamp between 1-1000

        const [rows] = await db.execute(
            'SELECT username, message_content, timestamp FROM global_messages ORDER BY timestamp DESC LIMIT ?',
            [queryLimit]
        );
        return rows.reverse();
    } catch (error) {
        console.error('Error getting latest global messages:', error.message);
        throw new Error('Failed to fetch messages');
    }
}

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

async function getPrivateMessageHistory(user1Id, user2Id, limit = 50) {
    try {
        // More robust parameter validation
        if (!user1Id || !user2Id) throw new Error('Missing user IDs');

        const queryLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500); // Clamp between 1-500

        const [rows] = await db.execute(
            `SELECT pm.message_content, pm.timestamp, u_sender.username AS sender_username,
                    pm.sender_id, pm.receiver_id, pm.is_read
             FROM private_messages pm
             JOIN users u_sender ON pm.sender_id = u_sender.id
             WHERE (pm.sender_id = ? AND pm.receiver_id = ?)
                OR (pm.sender_id = ? AND pm.receiver_id = ?)
             ORDER BY pm.timestamp ASC
             LIMIT ?`,
            [user1Id, user2Id, user2Id, user1Id, queryLimit]
        );
        return rows;
    } catch (error) {
        console.error('Error getting private message history:', error.message);
        throw new Error('Failed to fetch private messages');
    }
}

// ... (keep the rest of the file the same) ...

module.exports = {
    db,
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
    markMessagesAsRead,
};