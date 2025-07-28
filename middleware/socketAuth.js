// middleware/socketAuth.js

// This function will return the actual middleware
const createSocketAuthenticator = (sessionMiddleware) => {
    return (socket, next) => {
        // Wrap the session middleware to process the socket request
        sessionMiddleware(socket.request, socket.request.res || {}, (err) => {
            if (err) {
                console.error('Session middleware error for socket:', err);
                return next(new Error('Authentication error: Session processing failed.'));
            }

            if (socket.request.session && socket.request.session.userId) {
                // Attach user info to the socket for easy access later
                socket.userId = socket.request.session.userId;
                socket.username = socket.request.session.username;
                next(); // Allow connection
            } else {
                console.log('Socket.IO authentication failed: No session or userId found.');
                next(new Error('Authentication error: Not logged in.')); // Deny connection
            }
        });
    };
};

module.exports = { createSocketAuthenticator };