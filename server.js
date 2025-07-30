require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const sharedsession = require('express-socket.io-session');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const authRoutes = require('./auth');
const {
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
} = require('./db');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionStore = new MySQLStore({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chat_app',
    clearExpired: true,
    checkExpirationInterval: 900000,
    expiration: 86400000,
});

const sessionMiddleware = session({
    key: 'chat.sid',
    secret: process.env.SESSION_SECRET || 'your_very_secret_key',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax'
    },
});

app.use(sessionMiddleware);
io.use(sharedsession(sessionMiddleware, { autoSave: true }));

const transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(authRoutes);

app.get('/forgot-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.post('/forgot-password', async (req, res) => {
    const { identifier } = req.body;
    try {
        const user = await findUserByIdentifier(identifier);
        if (!user) {
            console.log(`Password reset requested for non-existent identifier: ${identifier}`);
            return res.json({ success: true, message: 'If an account with that identifier exists, a password reset link has been sent.' });
        }
        if (!user.email) {
            console.warn(`User ${user.id} (${user.username}) requested password reset but has no email.`);
            return res.json({ success: true, message: 'If an account with that identifier exists, a password reset link has been sent.' });
        }
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000);
        const query = `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (${user.id}, '${mysql.escape(token)}', '${expiresAt.toISOString()}')`;
        console.log('forgot-password: Executing query:', query);
        await pool.query(query);
        const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: 'Password Reset Request for Bychat',
            html: `<p>You requested a password reset for your Bychat account.</p>
                   <p>Please click this link to reset your password: <a href="${resetLink}">${resetLink}</a></p>
                   <p>This link will expire in 1 hour.</p>
                   <p>If you did not request this, please ignore this email.</p>
                   <p>Regards,<br>Bychat Team</p>`
        });
        res.json({ success: true, message: 'If an account with that identifier exists, a password reset link has been sent.' });
    } catch (error) {
        console.error('Error during forgot password request:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred. Please try again later.' });
    }
});

app.get('/reset-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    try {
        const query = `SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = '${mysql.escape(token)}'`;
        console.log('reset-password: Executing query:', query);
        const [tokens] = await pool.query(query);
        const resetToken = tokens[0];
        if (!resetToken || resetToken.used || new Date() > new Date(resetToken.expires_at)) {
            console.warn('Attempted password reset with invalid/expired/used token:', token);
            return res.status(400).json({ success: false, message: 'Invalid or expired password reset link.' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const updateQuery = `UPDATE users SET password = '${mysql.escape(hashedPassword)}' WHERE id = ${resetToken.user_id}`;
        const markUsedQuery = `UPDATE password_reset_tokens SET used = TRUE WHERE token = '${mysql.escape(token)}'`;
        console.log('reset-password: Executing update query:', updateQuery);
        console.log('reset-password: Executing mark used query:', markUsedQuery);
        await pool.query(updateQuery);
        await pool.query(markUsedQuery);
        res.json({ success: true, message: 'Your password has been reset successfully. You can now log in.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

app.get('/', (req, res) => {
    if (req.session.user) {
        res.redirect('/chat.html');
    } else {
        res.redirect('/login.html');
    }
});

app.get('/login.html', (req, res) => {
    if (req.session.user) {
        res.redirect('/chat.html');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
});

app.get('/signup.html', (req, res) => {
    if (req.session.user) {
        res.redirect('/chat.html');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'signup.html'));
    }
});

app.get('/chat.html', (req, res) => {
    if (!req.session.user) {
        res.redirect('/login.html');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'chat.html'));
    }
});

app.get('/session', (req, res) => {
    if (req.session.user) {
        res.json({
            loggedIn: true,
            username: req.session.user.username,
            userId: req.session.user.id,
            email: req.session.user.email,
            theme_preference: req.session.user.theme_preference,
            chat_background_image_url: req.session.user.chat_background_image_url
        });
    } else {
        res.json({ loggedIn: false });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ success: false, message: 'Could not log out' });
        }
        res.clearCookie('chat.sid');
        res.json({ success: true, message: 'Logged out successfully!' });
    }
});

const connectedSockets = new Map();
const onlineUsers = new Map();

function broadcastOnlineUsers() {
    const usersList = Array.from(onlineUsers.values());
    io.emit('online-users-list', usersList);
}

async function sendUnreadCountsToUser(userId) {
    try {
        const parsedUserId = parseInt(userId, 10);
        if (isNaN(parsedUserId) || parsedUserId <= 0) {
            throw new Error('Invalid userId for sendUnreadCountsToUser');
        }
        const unreadCounts = await getUnreadCountsForUser(parsedUserId);
        Array.from(connectedSockets.entries())
            .filter(([, user]) => String(user.userId) === String(parsedUserId))
            .forEach(([sockId]) => {
                io.to(sockId).emit('initial-unread-counts', unreadCounts);
            });
    } catch (error) {
        console.error(`Error sending unread counts for user ${userId}:`, error);
    }
}

async function sendTotalUnreadCountToUser(userId) {
    try {
        const parsedUserId = parseInt(userId, 10);
        if (isNaN(parsedUserId) || parsedUserId <= 0) {
            throw new Error('Invalid userId for sendTotalUnreadCountToUser');
        }
        const totalUnread = await getTotalUnreadCountForUser(parsedUserId);
        Array.from(connectedSockets.entries())
            .filter(([, user]) => String(user.userId) === String(parsedUserId))
            .forEach(([sockId]) => {
                io.to(sockId).emit('total-unread-count', totalUnread);
            });
    } catch (error) {
        console.error(`Error sending total unread count for user ${userId}:`, error);
    }
}

io.on('connection', async (socket) => {
    const session = socket.handshake.session;
    if (!session.user || !session.user.id) {
        console.log('Unauthenticated socket attempted connection, disconnecting...');
        socket.disconnect(true);
        return;
    }
    const { id: userId, username } = session.user;
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId) || parsedUserId <= 0) {
        console.error('Invalid userId in session:', userId);
        socket.disconnect(true);
        return;
    }
    connectedSockets.set(socket.id, { userId: parsedUserId, username });
    const userWasAlreadyOnline = onlineUsers.has(parsedUserId);
    onlineUsers.set(parsedUserId, { id: parsedUserId, username });
    if (!userWasAlreadyOnline) {
        console.log(`✅ ${username} (ID: ${parsedUserId}) connected to chat`);
        io.emit('user-joined', username);
    } else {
        console.log(`User ${username} (ID: ${parsedUserId}) connected an additional device/tab.`);
    }
    broadcastOnlineUsers();
    await sendUnreadCountsToUser(parsedUserId);
    await sendTotalUnreadCountToUser(parsedUserId);

    socket.on('request-global-history', async () => {
        try {
            console.log('request-global-history: Calling getLatestMessages with limit = 50');
            const chatHistory = await getLatestMessages(50);
            console.log('request-global-history: Fetched messages count:', chatHistory.length);
            const formattedHistory = chatHistory.map(msg => ({
                ...msg,
                timestamp: new Date(msg.timestamp).toISOString()
            }));
            socket.emit('chat-history', formattedHistory);
        } catch (error) {
            console.error('Error fetching global chat history:', error);
            socket.emit('system-message', 'Failed to load global chat history.');
        }
    });

    socket.on('chat-message', async (msgContent) => {
        if (username && parsedUserId && msgContent && msgContent.message && msgContent.message.trim()) {
            try {
                await saveMessage(parsedUserId, username, msgContent.message);
                const serverTimestamp = new Date().toISOString();
                io.emit('chat-message', {
                    user: username,
                    message: msgContent.message,
                    timestamp: serverTimestamp
                });
            } catch (error) {
                console.error('Error saving global message:', error);
                socket.emit('system-message', 'Failed to send message. Please try again.');
            }
        } else {
            socket.emit('system-message', 'Message cannot be empty.');
        }
    });

    socket.on('private-message', async ({ recipientId, message }) => {
        const parsedRecipientId = parseInt(recipientId, 10);
        if (!parsedUserId || !username || !parsedRecipientId || !message || !message.trim()) {
            console.warn('Invalid private message attempt (missing data):', { userId: parsedUserId, username, recipientId, message });
            socket.emit('system-message', 'Failed to send private message: Invalid data.');
            return;
        }
        if (parsedRecipientId === parsedUserId) {
            socket.emit('system-message', 'You cannot send a private message to yourself.');
            return;
        }
        try {
            await savePrivateMessage(parsedUserId, parsedRecipientId, message);
            const recipientUser = onlineUsers.get(parsedRecipientId);
            const recipientUsername = recipientUser ? recipientUser.username : `User ${parsedRecipientId}`;
            const serverTimestamp = new Date().toISOString();
            const messageData = {
                senderId: parsedUserId,
                senderUsername: username,
                receiverId: parsedRecipientId,
                receiverUsername: recipientUsername,
                message_content: message,
                timestamp: serverTimestamp
            };
            Array.from(connectedSockets.entries())
                .filter(([sockId, user]) => String(user.userId) === String(parsedUserId))
                .forEach(([sockId]) => {
                    io.to(sockId).emit('private-message-received', { ...messageData, is_my_message: true });
                });
            Array.from(connectedSockets.entries())
                .filter(([sockId, user]) => String(user.userId) === String(parsedRecipientId))
                .forEach(([sockId]) => {
                    io.to(sockId).emit('private-message-received', { ...messageData, is_my_message: false });
                });
            await sendUnreadCountsToUser(parsedRecipientId);
            await sendTotalUnreadCountToUser(parsedRecipientId);
        } catch (error) {
            console.error('Error saving or sending private message:', error);
            socket.emit('system-message', 'Failed to send private message.');
        }
    });

    socket.on('request-private-history', async (otherUserId) => {
        const parsedOtherUserId = parseInt(otherUserId, 10);
        console.log(`SERVER: Received request for private history with otherUserId: ${otherUserId} (parsed: ${parsedOtherUserId}) from userId: ${parsedUserId}`);
        console.log('request-private-history: Input params:', { userId, otherUserId, limit: 50 });
        if (!parsedUserId) {
            socket.emit('system-message', 'Authentication required for private history.');
            return;
        }
        if (parsedOtherUserId === parsedUserId) {
            socket.emit('system-message', 'Cannot get private history with yourself.');
            return;
        }
        if (isNaN(parsedOtherUserId) || parsedOtherUserId <= 0) {
            socket.emit('system-message', 'Invalid user ID for private history.');
            return;
        }
        try {
            const history = await getPrivateMessageHistory(parsedUserId, parsedOtherUserId, 50);
            console.log(`SERVER: Fetched private history (count: ${history.length}) for ${username} and ${parsedOtherUserId}`);
            await markMessagesAsRead(parsedUserId, parsedOtherUserId);
            await sendUnreadCountsToUser(parsedUserId);
            await sendTotalUnreadCountToUser(parsedUserId);
            const formattedHistory = history.map(msg => ({
                username: msg.sender_username,
                message_content: msg.message_content,
                timestamp: new Date(msg.timestamp).toISOString(),
                is_my_message: String(msg.sender_id) === String(parsedUserId)
            }));
            socket.emit('private-history-loaded', formattedHistory);
        } catch (error) {
            console.error('Error fetching private chat history:', error);
            socket.emit('system-message', 'Failed to load private chat history.');
        }
    });

    socket.on('mark-private-messages-read', async (senderToMarkId) => {
        const parsedSenderToMarkId = parseInt(senderToMarkId, 10);
        if (!parsedUserId || !parsedSenderToMarkId) {
            console.warn('Invalid mark-as-read attempt (missing data):', { userId: parsedUserId, senderToMarkId });
            return;
        }
        try {
            console.log(`User ${username} (${parsedUserId}) marking messages from ${parsedSenderToMarkId} as read.`);
            await markMessagesAsRead(parsedUserId, parsedSenderToMarkId);
            await sendUnreadCountsToUser(parsedUserId);
            await sendTotalUnreadCountToUser(parsedUserId);
        } catch (error) {
            console.error(`Error marking messages as read for user ${parsedUserId} from ${parsedSenderToMarkId}:`, error);
        }
    });

    socket.on('disconnect', () => {
        if (connectedSockets.has(socket.id)) {
            const disconnectedUser = connectedSockets.get(socket.id);
            connectedSockets.delete(socket.id);
            const userStillOnline = Array.from(connectedSockets.values())
                .some(user => String(user.userId) === String(disconnectedUser.userId));
            if (!userStillOnline) {
                onlineUsers.delete(disconnectedUser.userId);
                console.log(`❌ ${disconnectedUser.username} (ID: ${disconnectedUser.userId}) disconnected`);
                io.emit('user-left', disconnectedUser.username);
            } else {
                console.log(`User ${disconnectedUser.username} disconnected one of their tabs/devices.`);
            }
            broadcastOnlineUsers();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`Serving static files from: ${path.join(__dirname, 'public')}`);
});