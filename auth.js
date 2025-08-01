// auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt'); // For password hashing and comparison
// Ensure findUserByUsername also fetches email or create a new function
const { registerUser, findUserByUsername } = require('./db'); // Import DB functions

// Helper function for sending JSON responses
function sendJsonResponse(res, success, message, data = null) {
    res.json({ success, message, data });
}

// --- Registration Route ---
router.post('/signup', async (req, res) => {
    // MODIFIED: Destructure 'email' from req.body
    const { username, email, password } = req.body;

    // MODIFIED: Include email in validation
    if (!username || !email || !password) {
        return sendJsonResponse(res, false, 'Username, email, and password are required.');
    }

    try {
        // Hash the password before storing it
        const hashedPassword = await bcrypt.hash(password, 10); // 10 salt rounds

        // MODIFIED: Pass 'email' to the registerUser function
        const newUser = await registerUser(username, email, hashedPassword); // Pass email here

        // Auto-login after successful registration (also include theme/background if available)
        // Note: For now, we only have id and username.
        // If theme_preference and chat_background_image_url are stored in DB,
        // you'd need registerUser to return them or fetch them here.
        req.session.user = {
            id: newUser.id,
            username: newUser.username,
            // email: newUser.email, // If newUser object returns email (recommended to return full user from registerUser)
            // theme_preference: newUser.theme_preference,
            // chat_background_image_url: newUser.chat_background_image_url
        };

        // For signup, if you auto-login, you might want to save the session explicitly too
        req.session.save((err) => {
            if (err) {
                console.error('Error saving session after signup:', err);
                return sendJsonResponse(res, false, 'Registration failed due to session error.');
            }
            sendJsonResponse(res, true, 'Registration successful! You are now logged in.', { username: newUser.username, userId: newUser.id });
        });

    } catch (error) {
        console.error('Registration error:', error);
        if (error.message === 'Username already exists' || error.message === 'Email already exists') {
            // Provide a more specific message if db.js differentiates
            return sendJsonResponse(res, false, error.message);
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
        // findUserByUsername should now ideally fetch email, theme_preference, chat_background_image_url
        const user = await findUserByUsername(username);

        if (!user) {
            return sendJsonResponse(res, false, 'Invalid username or password.');
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (isMatch) {
            console.log('User authenticated successfully:', user.username); // <-- ADDED LOG

            // Store user info in session
            req.session.user = {
                id: user.id,
                username: user.username,
                email: user.email, // Ensure this is available from findUserByUsername
                theme_preference: user.theme_preference, // Ensure this is available from findUserByUsername
                chat_background_image_url: user.chat_background_image_url // Ensure this is available from findUserByUsername
            };

            console.log('Session user after setting:', req.session.user); // <-- ADDED LOG

            // Explicitly save the session to ensure it's persisted before sending the response
            req.session.save((err) => {
                if (err) {
                    console.error('Error saving session after login:', err); // <-- ADDED ERROR LOG
                    // Even if session save fails, we might still want to allow login for now,
                    // but it's crucial for Socket.IO.
                    return sendJsonResponse(res, false, 'Login failed due to session error.');
                }
                // Only send success response after session is confirmed saved
                sendJsonResponse(res, true, 'Login successful!', { username: user.username, userId: user.id });
            });

        } else {
            sendJsonResponse(res, false, 'Invalid username or password.');
        }

    } catch (error) {
        console.error('Login error:', error);
        sendJsonResponse(res, false, 'An error occurred during login. Please try again.');
    }
});

module.exports = router;