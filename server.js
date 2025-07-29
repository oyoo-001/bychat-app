// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session); // Use MySQL session store
const sharedsession = require('express-socket.io-session'); // To share Express session with Socket.IO
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

// NEW: For password reset functionality
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt'); // Make sure bcrypt is available here for password hashing

// Import the authentication router from auth.js
const authRoutes = require('./auth');

// Import all necessary database interaction functions from db.js
const {
    pool,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead,
    saveUserPreferences,
    db, // Assuming 'db' (the promise-based connection) is also exported from db.js
    findUserByIdentifier // <--- ADDED: Import the new user lookup function
} = require('./db'); // Ensure db.js exports these correctly

const app = express();

// --- ADDED: Trust proxy for Render deployment ---
// Render acts as a reverse proxy. This setting ensures Express correctly
// interprets secure headers and client IP, crucial for session cookies.
app.set('trust proxy', 1); // Trust the first proxy (Render)

const server = http.createServer(app);
const io = socketIo(server);

// --- Express Middleware Setup ---

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Session Configuration ---

// Configure MySQL session store
const sessionStore = new MySQLStore({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', // Use DB_PASSWORD from .env
    database: process.env.DB_NAME || 'chat_app',
    clearExpired: true,
    checkExpirationInterval: 900000,
    expiration: 86400000,
});

// Configure express-session middleware
const sessionMiddleware = session({
    key: 'chat.sid',
    secret: process.env.SESSION_SECRET || 'your_very_secret_key', // IMPORTANT: Change this!
    resave: false, // Only save session if modified
    saveUninitialized: false, // Do not save new sessions that have not been modified
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        httpOnly: true,
        // Ensure secure is true in production for HTTPS
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax' // Reverted back to 'Lax' as 'trust proxy' should handle this
    },
});

app.use(sessionMiddleware);

io.use(sharedsession(sessionMiddleware, {
    autoSave: true, // This is crucial for session changes to be saved automatically
}));

// --- Nodemailer Transporter Configuration ---
// IMPORTANT: Set EMAIL_USER and EMAIL_PASS in your .env file
// For Gmail, if you have 2-Factor Authentication, you MUST generate an App Password:
// Go to Google Account -> Security -> 2-Step Verification -> App passwords
const transporter = nodemailer.createTransport({
    service: 'Gmail', // Or 'Outlook', 'SendGrid', etc. based on your provider
    auth: {
        user: process.env.EMAIL_USER, // Your email address that will send the reset link
        pass: process.env.EMAIL_PASS // Your email password or generated App Password
    },
    // Optional: for development, you might disable strict SSL if having issues (not recommended for production)
    // tls: {
    //     rejectUnauthorized: false
    // }
});
// --- End Nodemailer Transporter Configuration ---

// --- Static File Serving ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Express Routes ---
// Authentication routes from auth.js (handles /login, /signup)
app.use(authRoutes);

// Route to serve the forgot password page
app.get('/forgot-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

// POST route to handle forgot password requests (sends email with reset link)
app.post('/forgot-password', async (req, res) => {
    const { identifier } = req.body; // User provides username or email

    try {
        // 1. Find the user by username or email using the dedicated function
        const user = await findUserByIdentifier(identifier); // <--- MODIFIED: Using findUserByIdentifier

        if (!user) {
            // IMPORTANT SECURITY: Always send a generic success message
            // This prevents an attacker from knowing if an email/username exists in your system.
            console.log(`Password reset requested for non-existent identifier: ${identifier}`);
            return res.json({ success: true, message: 'If an account with that identifier exists, a password reset link has been sent.' });
        }

        // Check if user has an email associated
        if (!user.email) {
            console.warn(`User ${user.id} (${user.username}) requested password reset but has no email.`);
            return res.json({ success: true, message: 'If an account with that identifier exists, a password reset link has been sent.' });
        }


        // 2. Generate a unique, secure, time-limited token
        const token = crypto.randomBytes(32).toString('hex'); // Generates a 64-character hexadecimal string
        const expiresAt = new Date(Date.now() + 3600000); // Token valid for 1 hour (3600000 milliseconds)

        // 3. Store the token in the database
        await db.execute(
            'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
            [user.id, token, expiresAt]
        );

        // 4. Send the password reset email
        // Ensure your Render app URL is correct. req.protocol and req.get('host') build it dynamically.
        const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        const senderEmail = process.env.EMAIL_USER;

        await transporter.sendMail({
            from: senderEmail, // Sender email (must match your transporter.auth.user)
            to: user.email, // Recipient email (from the database)
            subject: 'Password Reset Request for Bychat',
            html: `<p>You requested a password reset for your Bychat account.</p>
                   <p>Please click this link to reset your password: <a href="${resetLink}">${resetLink}</a></p>
                   <p>This link will expire in 1 hour.</p>
                   <p>If you did not request this, please ignore this email.</p>
                   <p>Regards,<br>Bychat Team</p>`
        });

        // Generic success message even if email sending fails (to prevent information leakage)
        res.json({ success: true, message: 'If an account with that identifier exists, a password reset link has been sent.' });

    } catch (error) {
        console.error('Error during forgot password request:', error);
        // Log the error but send a generic message to the client
        res.status(500).json({ success: false, message: 'An internal server error occurred. Please try again later.' });
    }
});

// Route to serve the reset password page
app.get('/reset-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

// POST route to handle new password submission
app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    try {
        // 1. Find and validate the token
        const [tokens] = await db.execute(
            'SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = ?',
            [token]
        );
        const resetToken = tokens[0];

        if (!resetToken || resetToken.used || new Date() > new Date(resetToken.expires_at)) {
            console.warn('Attempted password reset with invalid/expired/used token:', token);
            return res.status(400).json({ success: false, message: 'Invalid or expired password reset link.' });
        }

        // 2. Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 10); // Use 10 rounds for salting

        // 3. Update user's password and mark token as used (within a transaction if possible)
        // A simple way to do this without explicit transactions if your DB supports it implicitly for separate statements
        // or if atomicity is not critical *between these two statements* (it usually is)
        // For full atomicity, you'd use db.getConnection() and then connection.beginTransaction(), commit(), rollback()
        await db.execute('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, resetToken.user_id]);
        await db.execute('UPDATE password_reset_tokens SET used = TRUE WHERE token = ?', [token]);

        res.json({ success: true, message: 'Your password has been reset successfully. You can now log in.' });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});

// Existing routes
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
            email: req.session.user.email, // Ensure email is passed to session if retrieved by findUserByUsername/Identifier
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
    });
});

// API endpoint to save user preferences (theme, background, etc.)
app.post('/api/user/preferences', async (req, res) => {
    if (!req.session.user || !req.session.user.id) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }

    const userId = req.session.user.id;
    const { themePreference, chatBackgroundImageUrl } = req.body;

    if (themePreference === undefined && chatBackgroundImageUrl === undefined) {
        return res.status(400).json({ success: false, message: 'No preferences provided to save.' });
    }

    try {
        const success = await saveUserPreferences(userId, themePreference, chatBackgroundImageUrl);
        if (success) {
            if (themePreference !== undefined) {
                req.session.user.theme_preference = themePreference;
            }
            if (chatBackgroundImageUrl !== undefined) {
                req.session.user.chat_background_image_url = chatBackgroundImageUrl;
            }
            res.json({ success: true, message: 'User preferences saved successfully.' });
        } else {
            res.status(500).json({ success: false, message: 'Failed to save user preferences.' });
        }
    } catch (error) {
        console.error('Error saving user preferences:', error);
        res.status(500).json({ success: false, message: 'Server error while saving preferences.' });
    }
});


// --- Socket.IO Logic ---

const connectedSockets = new Map();
const onlineUsers = new Map();

function broadcastOnlineUsers() {
    const usersList = Array.from(onlineUsers.values());
    io.emit('online-users-list', usersList);
}

async function sendUnreadCountsToUser(userId) {
    try {
        const unreadCounts = await getUnreadCountsForUser(userId);
        Array.from(connectedSockets.entries())
            .filter(([, user]) => String(user.userId) === String(userId))
            .forEach(([sockId]) => {
                io.to(sockId).emit('initial-unread-counts', unreadCounts);
            });
    } catch (error) {
        console.error(`Error sending unread counts for user ${userId}:`, error);
    }
}

async function sendTotalUnreadCountToUser(userId) {
    try {
        const totalUnread = await getTotalUnreadCountForUser(userId);
        Array.from(connectedSockets.entries())
            .filter(([, user]) => String(user.userId) === String(userId))
            .forEach(([sockId]) => {
                io.to(sockId).emit('total-unread-count', totalUnread);
            });
    } catch (error) {
        console.error(`Error sending total unread count for user ${userId}:`, error);
    }
}

io.on('connection', async (socket) => {
    const session = socket.handshake.session;

    // --- ADDED DETAILED LOGGING HERE ---
    console.log('--- Socket.IO Connection Attempt ---');
    console.log('socket.handshake.session:', session);
    console.log('socket.handshake.session.user:', session ? session.user : 'Session object is null/undefined');
    console.log('socket.handshake.headers.cookie:', socket.handshake.headers.cookie);
    // --- END DETAILED LOGGING ---

    if (!session.user || !session.user.id) {
        console.log('Unauthenticated socket attempted connection, disconnecting...');
        socket.disconnect(true);
        return;
    }

    const { id: userId, username } = session.user;

    connectedSockets.set(socket.id, { userId, username });

    const userWasAlreadyOnline = onlineUsers.has(userId);
    onlineUsers.set(userId, { id: userId, username });

    if (!userWasAlreadyOnline) {
        console.log(`✅ ${username} (ID: ${userId}) connected to chat`);
        io.emit('user-joined', username);
    } else {
        console.log(`User ${username} (ID: ${userId}) connected an additional device/tab.`);
    }

    broadcastOnlineUsers();
    await sendUnreadCountsToUser(userId);
    await sendTotalUnreadCountToUser(userId);

    socket.on('request-global-history', async () => {
        try {
            const chatHistory = await getLatestMessages(50);
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
        if (username && userId && msgContent && msgContent.message && msgContent.message.trim()) {
            try {
                await saveMessage(userId, username, msgContent.message);
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
        if (!userId || !username || !recipientId || !message || !message.trim()) {
            console.warn('Invalid private message attempt (missing data):', { userId, username, recipientId, message });
            socket.emit('system-message', 'Failed to send private message: Invalid data.');
        }

        if (String(recipientId) === String(userId)) {
            socket.emit('system-message', 'You cannot send a private message to yourself.');
            return;
        }

        try {
            await savePrivateMessage(userId, recipientId, message);

            const recipientUser = onlineUsers.get(recipientId);
            const recipientUsername = recipientUser ? recipientUser.username : `User ${recipientId}`;

            const serverTimestamp = new Date().toISOString();

            const messageData = {
                senderId: userId,
                senderUsername: username,
                receiverId: recipientId,
                receiverUsername: recipientUsername,
                message_content: message,
                timestamp: serverTimestamp
            };

            Array.from(connectedSockets.entries())
                .filter(([sockId, user]) => String(user.userId) === String(userId))
                .forEach(([sockId]) => {
                    io.to(sockId).emit('private-message-received', { ...messageData, is_my_message: true });
                });

            Array.from(connectedSockets.entries())
                .filter(([sockId, user]) => String(user.userId) === String(recipientId))
                .forEach(([sockId]) => {
                    io.to(sockId).emit('private-message-received', { ...messageData, is_my_message: false });
                });

            await sendUnreadCountsToUser(recipientId);
            await sendTotalUnreadCountToUser(recipientId);

        } catch (error) {
            console.error('Error saving or sending private message:', error);
            socket.emit('system-message', 'Failed to send private message.');
        }
    });

    socket.on('request-private-history', async (otherUserId) => {
        console.log(`SERVER: Received request for private history with otherUserId: ${otherUserId} from userId: ${userId}`);
        if (!userId) {
            socket.emit('system-message', 'Authentication required for private history.');
            return;
        }
        if (String(otherUserId) === String(userId)) {
            socket.emit('system-message', 'Cannot get private history with yourself.');
            return;
        }

        try {
            const history = await getPrivateMessageHistory(userId, otherUserId, 50);
            console.log(`SERVER: Fetched private history (count: ${history.length}) for ${username} and ${otherUserId}`);

            await markMessagesAsRead(userId, otherUserId);

            await sendUnreadCountsToUser(userId);
            await sendTotalUnreadCountToUser(userId);

            const formattedHistory = history.map(msg => ({
                username: msg.sender_username,
                message_content: msg.message_content,
                timestamp: new Date(msg.timestamp).toISOString(),
                is_my_message: String(msg.sender_id) === String(userId)
            }));
            socket.emit('private-history-loaded', formattedHistory);
        } catch (error) {
            console.error('Error fetching private chat history:', error);
            socket.emit('system-message', 'Failed to load private chat history.');
        }
    });

    socket.on('mark-private-messages-read', async (senderToMarkId) => {
        if (!userId || !senderToMarkId) {
            console.warn('Invalid mark-as-read attempt (missing data):', { userId, senderToMarkId });
            return;
        }
        try {
            console.log(`User ${username} (${userId}) marking messages from ${senderToMarkId} as read.`);
            await markMessagesAsRead(userId, senderToMarkId);
            await sendUnreadCountsToUser(userId);
            await sendTotalUnreadCountToUser(userId);
        } catch (error) {
            console.error(`Error marking messages as read for user ${userId} from ${senderToMarkId}:`, error);
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