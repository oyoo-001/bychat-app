// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session); // Use MySQL session store
const sharedsession = require('express-socket.io-session'); // To share Express session with Socket.IO
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');

// Import the authentication router from auth.js
const authRoutes = require('./auth');

// Import all necessary database interaction functions from db.js
const {
    // You only need to import 'pool' if you're passing it directly to MySQLStore,
    // otherwise MySQLStore can use its own connection settings.
    // However, keeping it here for clarity with db.js connection test.
    pool,
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser,
    markMessagesAsRead,
    saveUserPreferences // <--- THIS IS THE LINE THAT WAS MISSING IN YOUR PROVIDED CODE!
} = require('./db'); // Ensure db.js exports these correctly

const app = express();
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
    secret: process.env.SESSION_SECRET || 'your_very_secret_key',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
    },
});

app.use(sessionMiddleware);

io.use(sharedsession(sessionMiddleware, {
    autoSave: true,
}));

// --- Static File Serving ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Express Routes ---
app.use(authRoutes);

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
        // Fetch full user data including theme and background on session check
        // This is a good place to update the session with current DB preferences
        // for theme and background, if they can be changed elsewhere or if the
        // initial login only fetches basic info.
        // For now, we'll assume the session already contains it from login or registration.
        res.json({
            loggedIn: true,
            username: req.session.user.username,
            userId: req.session.user.id,
            theme_preference: req.session.user.theme_preference, // Include these
            chat_background_image_url: req.session.user.chat_background_image_url // Include these
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

// NEW: API endpoint to save user preferences (theme, background, etc.)
app.post('/api/user/preferences', async (req, res) => {
    if (!req.session.user || !req.session.user.id) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }

    const userId = req.session.user.id;
    const { themePreference, chatBackgroundImageUrl } = req.body;

    // Basic validation: at least one preference must be provided
    // Using `undefined` check to allow `null` or empty string as valid preference values
    if (themePreference === undefined && chatBackgroundImageUrl === undefined) {
        return res.status(400).json({ success: false, message: 'No preferences provided to save.' });
    }

    try {
        const success = await saveUserPreferences(userId, themePreference, chatBackgroundImageUrl);
        if (success) {
            // IMPORTANT: Update the session with the newly saved preferences
            // This ensures subsequent requests/page refreshes reflect the change without re-fetching from DB
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
            return;
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