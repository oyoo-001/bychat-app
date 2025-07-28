// auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt'); // For password hashing and comparison
const { registerUser, findUserByUsername } = require('./db'); // Import DB functions

// Helper function for sending JSON responses
function sendJsonResponse(res, success, message, data = null) {
    res.json({ success, message, data });
}

// --- Registration Route ---
router.post('/signup', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return sendJsonResponse(res, false, 'Username and password are required.');
    }

    try {
        // Hash the password before storing it
        const hashedPassword = await bcrypt.hash(password, 10); // 10 salt rounds

        const newUser = await registerUser(username, hashedPassword);

        // Auto-login after successful registration
        req.session.user = {
            id: newUser.id,
            username: newUser.username
        };

        sendJsonResponse(res, true, 'Registration successful!', { username: newUser.username, userId: newUser.id });
    } catch (error) {
        console.error('Registration error:', error);
        if (error.message === 'Username already exists') {
            return sendJsonResponse(res, false, 'Username already taken. Please choose a different one.');
        }
        sendJsonResponse(res, false, 'Registration failed. Please try again.');
    }
});

// --- Login Route ---
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return sendJsonResponse(res, false, 'Username and password are required.');
    }

    try {
        const user = await findUserByUsername(username);

        if (!user) {
            return sendJsonResponse(res, false, 'Invalid username or password.');
        }

        // IMPORTANT: Compare the provided password with the HASHED password from the DB
        // The user.password here refers to the 'password' column value from the DB
        const isMatch = await bcrypt.compare(password, user.password); // CHANGED: user.password_hash -> user.password

        if (isMatch) {
            // Store user info in session
            req.session.user = {
                id: user.id,
                username: user.username
            };
            sendJsonResponse(res, true, 'Login successful!', { username: user.username, userId: user.id });
        } else {
            sendJsonResponse(res, false, 'Invalid username or password.');
        }

    } catch (error) {
        console.error('Login error:', error);
        sendJsonResponse(res, false, 'An error occurred during login. Please try again.');
    }
});

module.exports = router;