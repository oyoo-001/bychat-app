const mysql = require('mysql2/promise');

// Get the full DATABASE_URL from environment variables
const dbConnectionString = process.env.DATABASE_URL;

if (!dbConnectionString) {
    console.error('❌ FATAL: DATABASE_URL environment variable is not set!');
    process.exit(1);
}

const pool = mysql.createPool(dbConnectionString);

// Test the connection
pool.getConnection()
    .then(connection => {
        console.log('✅ Connected to MySQL database!');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Error connecting to MySQL database:', err.message);
        process.exit(1);
    });

const db = pool;

// --- Register a new user ---
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
            return {
                id: result.insertId,
                username,
                email,
                theme_preference: 'dark',
                chat_background_image_url: null
            };
        } else {
            throw new Error('Failed to register user unexpectedly.');
        }
    } catch (error) {
        console.error('Error in registerUser:', error.message);
        throw error;
    }
}

// --- Find user by username ---
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

// --- Find user by username OR email ---
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

// --- Save user preferences ---
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

// --- Save global message ---
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

// --- Get latest global messages ---
async function getLatestMessages(limit = 100) {
    try {
        limit = parseInt(limit, 10);
        if (isNaN(limit)) limit = 100;

        const [rows] = await db.execute(
            'SELECT username, message_content, timestamp FROM global_messages ORDER BY timestamp DESC LIMIT ?',
            [limit]
        );
        console.log('Fetched latest global messages.');
        return rows.reverse();
    } catch (error) {
        console.error('Error getting latest global messages:', error.message);
        throw error;
    }
}

// --- Save private message ---
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

// --- Get private message history ---
async function getPrivateMessageHistory(user1Id, user2Id, limit = 50) {
    try {
        limit = parseInt(limit, 10);
        if (isNaN(limit)) limit = 50;

        const [rows] = await db.execute(
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
    } catch (error) {
        console.error('Error getting private message history:', error.message);
        throw error;
    }
}

// --- Get unread counts from all other users ---
async function getUnreadCountsForUser(userId) {
    try {
        const [rows] = await db.execute(
            `SELECT sender_id, COUNT(*) AS unread_count
             FROM private_messages
             WHERE receiver_id = ? AND is_read = FALSE
             GROUP BY sender_id`,
            [userId]
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

// --- Get total unread count for a user ---
async function getTotalUnreadCountForUser(userId) {
    try {
        const [rows] = await db.execute(
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

// --- Mark messages as read ---
async function markMessagesAsRead(receiverId, senderId) {
    try {
        const [result] = await db.execute(
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
    markMessagesAsRead
};
