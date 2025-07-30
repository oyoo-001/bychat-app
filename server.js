// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const sharedsession = require('express-socket.io-session');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const { registerUser, loginUser } = require('./auth');
const {
    saveMessage,
    getLatestMessages,
    savePrivateMessage,
    getPrivateMessageHistory,
    getUnreadCountsForUser,
    getTotalUnreadCountForUser, // NEW: Import new db function
    markMessagesAsRead
} = require('./db');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware to parse JSON and form data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
const sessionStore = new MySQLStore({
    host: process.env.DB_HOST || 'localhost',
    port: 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'chat_app',
    clearExpired: true,
    checkExpirationInterval: 900000,
    expiration: 86400000,
});

const sessionMiddleware = session({
    key: 'chat.sid',
    secret: process.env.SESSION_SECRET || 'yourSecret',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
    },
});

// Apply session middleware to Express
app.use(sessionMiddleware);

// Apply session middleware to Socket.IO
io.use(sharedsession(sessionMiddleware, {
    autoSave: true,
}));

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Routes
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

// Handle signup
app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await registerUser(username, password);
        req.session.user = { id: user.id, username: user.username };
        res.json({ success: true, message: 'User registered and logged in successfully' });
    } catch (err) {
        console.error('Signup error:', err.message);
        res.status(400).json({ success: false, message: err.message });
    }
});

// Handle login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await loginUser(username, password);
        req.session.user = { id: user.id, username: user.username };
        res.json({ success: true, message: 'Login successful' });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(401).json({ success: false, message: err.message });
    }
});

// Session endpoint for frontend to check login status and get user info
app.get('/session', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, username: req.session.user.username, userId: req.session.user.id });
    } else {
        res.json({ loggedIn: false });
    }
});

// Logout endpoint
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ success: false, message: 'Could not log out' });
        }
        res.clearCookie('chat.sid');
        res.json({ success: true, message: 'Logged out successfully' });
    });
});


// Socket.IO connection
const connectedSockets = new Map(); // Stores { socketId: { userId, username } }
const onlineUsers = new Map();      // Stores { userId: { id, username } }

function broadcastOnlineUsers() {
    const usersList = Array.from(onlineUsers.values());
    io.emit('online-users-list', usersList);
}

// Helper to send unread counts to a specific user's all connected sockets
async function sendUnreadCountsToUser(userId) {
    try {
        const unreadCounts = await getUnreadCountsForUser(userId);
        Array.from(connectedSockets.entries())
            .filter(([, user]) => user.userId === userId)
            .forEach(([sockId]) => {
                io.to(sockId).emit('initial-unread-counts', unreadCounts);
            });
    } catch (error) {
        console.error(`Error sending unread counts for user ${userId}:`, error);
    }
}

// NEW: Helper to send total unread counts to a specific user's all connected sockets
async function sendTotalUnreadCountToUser(userId) {
    try {
        const totalUnread = await getTotalUnreadCountForUser(userId);
        Array.from(connectedSockets.entries())
            .filter(([, user]) => user.userId === userId)
            .forEach(([sockId]) => {
                io.to(sockId).emit('total-unread-count', totalUnread);
            });
    } catch (error) {
        console.error(`Error sending total unread count for user ${userId}:`, error);
    }
}


io.on('connection', async (socket) => {
    const session = socket.handshake.session;

    if (!session.user) {
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
        io.emit('user-joined', username); // Notify others only on first connection
    } else {
        console.log(`User ${username} (ID: ${userId}) connected an additional device/tab.`);
    }

    broadcastOnlineUsers();
    await sendUnreadCountsToUser(userId);
    await sendTotalUnreadCountToUser(userId); // NEW: Send total unread count on connection


    socket.on('request-global-history', async () => {
        try {
            const chatHistory = await getLatestMessages(50);
            // Ensure timestamp is ISO string if not already
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
        if (username && userId) {
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
        }
    });

    socket.on('private-message', async ({ recipientId, message }) => {
        if (!userId || !username || !recipientId || !message.trim()) {
            console.warn('Invalid private message attempt:', { userId, username, recipientId, message });
            socket.emit('system-message', 'Failed to send private message: Invalid data.');
            return;
        }

        if (String(recipientId) === String(userId)) { // Ensure string comparison
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

            // Emit to all sender's devices
            Array.from(connectedSockets.entries())
                .filter(([sockId, user]) => user.userId === userId)
                .forEach(([sockId]) => {
                    io.to(sockId).emit('private-message-received', { ...messageData, is_my_message: true });
                });

            // Emit to all recipient's devices
            Array.from(connectedSockets.entries())
                .filter(([sockId, user]) => user.userId === recipientId)
                .forEach(([sockId]) => {
                    io.to(sockId).emit('private-message-received', { ...messageData, is_my_message: false });
                });

            // Update unread counts for recipient (both individual and total)
            await sendUnreadCountsToUser(recipientId);
            await sendTotalUnreadCountToUser(recipientId); // NEW: Update total for recipient

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
            console.log(`SERVER: Fetched private history (count: ${history.length}) for ${username} and ${otherUserId}:`, history);

            // Mark these messages as read when history is requested (user opens chat)
            await markMessagesAsRead(userId, otherUserId);

            // After marking messages as read, send updated unread counts to the current user (both individual and total)
            await sendUnreadCountsToUser(userId);
            await sendTotalUnreadCountToUser(userId); // NEW: Update total for current user

            const formattedHistory = history.map(msg => ({
                username: msg.sender_username,
                message_content: msg.message_content,
                timestamp: new Date(msg.timestamp).toISOString(),
                is_my_message: msg.sender_id === userId
            }));
            socket.emit('private-history-loaded', formattedHistory);
        } catch (error) {
            console.error('Error fetching private chat history:', error);
            socket.emit('system-message', 'Failed to load private chat history.');
        }
    });

    // Handle explicit client request to mark messages as read
    socket.on('mark-private-messages-read', async (senderToMarkId) => {
        if (!userId || !senderToMarkId) {
            console.warn('Invalid mark-as-read attempt:', { userId, senderToMarkId });
            return;
        }
        try {
            console.log(`User ${username} (${userId}) marking messages from ${senderToMarkId} as read.`);
            await markMessagesAsRead(userId, senderToMarkId);
            // After marking, send updated counts to the user (both individual and total)
            await sendUnreadCountsToUser(userId);
            await sendTotalUnreadCountToUser(userId); // NEW: Update total for current user
        } catch (error) {
            console.error(`Error marking messages as read for user ${userId} from ${senderToMarkId}:`, error);
        }
    });


    socket.on('disconnect', () => {
        if (connectedSockets.has(socket.id)) {
            const disconnectedUser = connectedSockets.get(socket.id);
            connectedSockets.delete(socket.id);

            const userStillOnline = Array.from(connectedSockets.values()).some(user => user.userId === disconnectedUser.userId);

            if (!userStillOnline) {
                onlineUsers.delete(disconnectedUser.userId);
                console.log(`❌ ${disconnectedUser.username} (ID: ${disconnectedUser.userId}) disconnected`);
                io.emit('user-left', disconnectedUser.username);
            } else {
                console.log(`User ${disconnectedUser.username} disconnected one of their tabs/devices.`);
            }
            broadcastOnlineUsers();
            // No need to send unread counts on disconnect, as the user is gone.
            // If they reconnect, sendTotalUnreadCountToUser will be called.
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});