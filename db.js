import mysql from 'mysql2/promise';

// Create database connection pool
const pool = mysql.createPool({
  host: 'monorail.proxy.rlwy.net',
  user: 'root',
  password: 'fD0HTuXULtFqk0H2yQn5',
  database: 'railway',
  port: 25312,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// User authentication
export async function authenticateUser(username, password) {
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE username = ? AND password = ?',
    [username, password]
  );
  return rows[0];
}

// Create user
export async function createUser(username, password) {
  const [result] = await pool.execute(
    'INSERT INTO users (username, password) VALUES (?, ?)',
    [username, password]
  );
  return result.insertId;
}

// Save global chat message
export async function saveMessage(username, message) {
  const [result] = await pool.execute(
    'INSERT INTO global_messages (username, message_content) VALUES (?, ?)',
    [username, message]
  );
  return result.insertId;
}

// Get latest global chat messages
export async function getLatestMessages(limit = 50) {
  const parsedLimit = parseInt(limit, 10);
  const [rows] = await pool.execute(
    'SELECT username, message_content, timestamp FROM global_messages ORDER BY timestamp DESC LIMIT ?',
    [parsedLimit]
  );
  return rows;
}

// Save private message
export async function savePrivateMessage(senderId, receiverId, message, isRead = false) {
  const [result] = await pool.execute(
    'INSERT INTO private_messages (sender_id, receiver_id, message_content, is_read) VALUES (?, ?, ?, ?)',
    [senderId, receiverId, message, isRead]
  );
  return result.insertId;
}

// Get private chat history between two users
export async function getPrivateMessageHistory(user1Id, user2Id, limit = 50) {
  const parsedLimit = parseInt(limit, 10);
  const [rows] = await pool.execute(
    `SELECT
        pm.message_content,
        pm.timestamp,
        u_sender.username AS sender_username,
        pm.sender_id,
        pm.receiver_id,
        pm.is_read
     FROM private_messages pm
     JOIN users u_sender ON pm.sender_id = u_sender.id
     WHERE
       (pm.sender_id = ? AND pm.receiver_id = ?) OR
       (pm.sender_id = ? AND pm.receiver_id = ?)
     ORDER BY pm.timestamp ASC
     LIMIT ?`,
    [user1Id, user2Id, user2Id, user1Id, parsedLimit]
  );
  return rows;
}

// Mark private messages as read
export async function markMessagesAsRead(senderId, receiverId) {
  const [result] = await pool.execute(
    'UPDATE private_messages SET is_read = true WHERE sender_id = ? AND receiver_id = ? AND is_read = false',
    [senderId, receiverId]
  );
  return result.affectedRows;
}

// Get all users except one
export async function getAllUsersExcept(userId) {
  const [rows] = await pool.execute(
    'SELECT id, username FROM users WHERE id != ?',
    [userId]
  );
  return rows;
}
