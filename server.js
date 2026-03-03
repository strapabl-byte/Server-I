require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'somatic-secure-key-2026-v1';

// Security Middleware
app.use(helmet({
    contentSecurityPolicy: false // Allow inline styles for dashboard
}));
app.use(cors());
app.use(express.json());
app.use(express.text());
app.use(express.static('public'));

// Debugging: Log all incoming requests
app.use((req, res, next) => {
    if (req.path !== '/status') { // Don't spam status polls
        console.log(`[DEBUG] ${req.method} ${req.path} - Headers: ${JSON.stringify(req.headers['x-api-key'] ? 'API-KEY-PRESENT' : 'NO-API-KEY')}`);
    }
    next();
});

// Configure Multer for file uploads
const multer = require('multer');
const fs = require('fs');
const uploadDir = 'public/logs';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Use machineId from body if available, otherwise generic name
        // Multer handles file before body is fully parsed in some configs, 
        // but we can trust the client to send a unique name in the 'logfile' field or headers
        // actually, let's just use the original name which we set in C#
        cb(null, file.originalname);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Rate Limiter
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: 'Too many requests, please try again later.'
});

// Auth Middleware
const authenticate = (req, res, next) => {
    const apiKey = req.get('x-api-key');
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
};

// POST /upload-logs - Handle log file upload
app.post('/upload-logs', apiLimiter, authenticate, upload.single('logfile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read the file to extract last 3 lines
    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
        const lastLines = lines.slice(-3);

        lastLines.forEach(line => {
            // Check if this specific log message already exists in eventLogs to avoid duplicates
            const isDuplicate = eventLogs.some(log => log.message.includes(line));

            if (!isDuplicate) {
                const logEntry = {
                    timestamp: new Date().toISOString(),
                    message: `📄 [FILE] ${line}`,
                    time: new Date().toLocaleTimeString(),
                    type: 'file-log'
                };
                eventLogs.unshift(logEntry);
            }
        });

        if (eventLogs.length > MAX_LOGS) {
            eventLogs = eventLogs.slice(0, MAX_LOGS);
        }
    } catch (err) {
        console.error('[ERROR] Failed to read uploaded log file:', err);
    }

    console.log(`[UPLOAD] Log file received: ${req.file.filename}`);
    res.json({ success: true, filename: req.file.filename });
});

// In-memory storage
let currentStatus = {
    online: false,
    lastUpdate: 0,
    data: {}
};

let eventLogs = [];
let pendingCommands = {}; // { machineId: 'START' | 'STOP' }
let schedules = {}; // { machineId: { startAt: 'HH:mm', stopAt: 'HH:mm', enabled: false } }
let autoRestarts = {}; // { machineId: { interval: number, enabled: boolean, lastRestartTime: ISO string } }
const MAX_LOGS = 100;
const serverStartTime = Date.now();

// Generate random ID if none exists
const generateRandomId = () => {
    return 'node-' + Math.random().toString(36).substring(2, 9).toUpperCase();
};

let sessionMachineId = null;

// POST /update - Receive launcher updates
app.post('/update', apiLimiter, authenticate, (req, res) => {
    const payload = req.body;
    console.log(`[DEBUG] Update Payload:`, JSON.stringify(payload));
    console.log(`[UPDATE] Received from ${payload.mId || payload.machineId || 'Unknown'} (Event: ${payload.ev?.t || payload.event?.type || 'Unknown'})`);

    // Validate payload
    if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const eventType = payload.event?.type;
    if (!eventType) {
        return res.status(400).json({ error: 'Missing event type' });
    }

    // Verify or generate machineId
    let machineId = payload.machineId;
    if (!machineId || machineId === 'Unknown' || machineId === '---') {
        if (!sessionMachineId) {
            sessionMachineId = generateRandomId();
        }
        machineId = sessionMachineId;
    }

    // Update current status with flattened data structure
    currentStatus = {
        online: true,
        lastUpdate: Date.now(),
        data: {
            pid: payload.game?.pid || 0,
            uptime_seconds: payload.uptime_seconds || 0,
            crashes_120s: payload.crashes_120s || 0,
            total_restarts: payload.total_restarts || 0,
            state: payload.game?.state || 'OFF',
            total_crashes: payload.total_crashes || 0,
            last_crash_at: payload.last_crash_at || '---',
            exeName: payload.game?.exeName || 'Unknown',
            exePath: payload.game?.exePath || '',
            machineId: machineId,
            app: payload.app || 'SomaticLauncher'
        }
    };

    // Log significant events with descriptive messages
    if (eventType !== 'heartbeat') {
        const gameName = payload.game?.exeName || 'Launcher';
        const reason = payload.event?.reason || 'unknown';
        const pid = payload.game?.pid || 0;
        const restarts = payload.total_restarts || 0;

        let message = '';

        switch (eventType) {
            case 'launched':
                message = `🚀 Game Started: ${gameName} (PID: ${pid})`;

                // Reset auto-start timer when game starts
                if (autoRestarts[machineId] && autoRestarts[machineId].autoStartEnabled) {
                    autoRestarts[machineId].lastStartTime = new Date().toISOString();
                }
                // Reset auto-stop timer when game starts (so it stops after X minutes of running)
                if (autoRestarts[machineId] && autoRestarts[machineId].autoStopEnabled) {
                    autoRestarts[machineId].lastStopTime = new Date().toISOString();
                }
                break;
            case 'stopped':
                message = `⏹️ Game Stopped: ${gameName} (by ${reason})`;

                // Reset auto-start timer when game stops (so it starts after X minutes of being stopped)
                if (autoRestarts[machineId] && autoRestarts[machineId].autoStartEnabled) {
                    autoRestarts[machineId].lastStartTime = new Date().toISOString();
                }
                break;
            case 'crashed':
                message = `💥 Game Crashed: ${gameName} (Exit Code: Unknown)`;
                break;
            case 'relaunched':
                message = `🔄 Game Restarted: ${gameName} (Watchdog - Total Re: ${restarts}, Total Crashes: ${payload.total_crashes || 0})`;

                // Reset both timers when game restarts
                if (autoRestarts[machineId]) {
                    if (autoRestarts[machineId].autoStartEnabled) {
                        autoRestarts[machineId].lastStartTime = new Date().toISOString();
                    }
                    if (autoRestarts[machineId].autoStopEnabled) {
                        autoRestarts[machineId].lastStopTime = new Date().toISOString();
                    }
                }
                break;
            case 'selected':
                message = `📂 Game Selected: ${gameName}`;
                break;
            default:
                message = `[${eventType.toUpperCase()}] ${gameName} - ${reason}`;
        }

        const logEntry = {
            timestamp: new Date().toISOString(),
            message,
            time: new Date().toLocaleTimeString(),
            type: eventType
        };

        eventLogs.unshift(logEntry);
        if (eventLogs.length > MAX_LOGS) {
            eventLogs = eventLogs.slice(0, MAX_LOGS);
        }

        console.log(`[EVENT] ${message}`);
    }

    console.log(`[UPDATE] Handled successfully: ${eventType}`);
    res.json({ success: true, received: eventType });
});

// POST /log - Receive detailed logs
app.post('/log', apiLimiter, authenticate, (req, res) => {
    let message = '';

    if (typeof req.body === 'string') {
        message = req.body;
    } else if (req.body && typeof req.body.message === 'string') {
        message = req.body.message;
    } else {
        return res.status(400).json({ error: 'Invalid log format' });
    }

    // Truncate very long messages
    if (message.length > 1000) {
        message = message.substring(0, 1000) + '...';
    }

    const logEntry = {
        timestamp: new Date().toISOString(),
        message,
        time: new Date().toLocaleTimeString(),
        type: 'log'
    };

    eventLogs.unshift(logEntry);
    if (eventLogs.length > MAX_LOGS) {
        eventLogs = eventLogs.slice(0, MAX_LOGS);
    }

    console.log(`[LOG] ${message}`);
    res.json({ success: true });
});

// GET /download/:filename - Force file download
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    // Sanitize filename to prevent directory traversal
    const safeFilename = path.basename(filename);
    const filePath = path.join(__dirname, 'public', 'logs', safeFilename);

    if (fs.existsSync(filePath)) {
        res.download(filePath, safeFilename); // Sets Content-Disposition: attachment
    } else {
        res.status(404).send('Log file not found');
    }
});

// GET /status - Public status endpoint including logs and commands for optimized fetching
app.get('/status', (req, res) => {
    // Check if offline (no update in 45 seconds to handle Render latency)
    const timeSinceLast = Date.now() - currentStatus.lastUpdate;
    const isOnline = timeSinceLast < 90000 && currentStatus.online;

    // Calculate server uptime
    const serverUptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

    // Determine health based on crashes
    const crashes = currentStatus.data.crashes_120s || 0;
    let health = 'excellent';
    if (crashes >= 4) health = 'critical';
    else if (crashes >= 2) health = 'warning';
    else if (crashes >= 1) health = 'good';
    if (!isOnline) health = 'offline';

    // Get pending command for this machine (if any)
    const machineId = currentStatus.data.machineId;
    let command = null;
    let autoRestart = null;

    if (machineId) {
        command = pendingCommands[machineId] || null;

        // Include auto-restart data if available
        const autoRestartConfig = autoRestarts[machineId];
        if (autoRestartConfig) {
            const now = new Date();
            let nextStopIn = 0;
            if (autoRestartConfig.autoStopEnabled && autoRestartConfig.lastStopTime) {
                const lastStop = new Date(autoRestartConfig.lastStopTime);
                const elapsedSeconds = Math.floor((now - lastStop) / 1000);
                nextStopIn = Math.max(0, (autoRestartConfig.autoStopInterval * 60) - elapsedSeconds);
            }
            let nextStartIn = 0;
            if (autoRestartConfig.autoStartEnabled && autoRestartConfig.lastStartTime) {
                const lastStart = new Date(autoRestartConfig.lastStartTime);
                const elapsedSeconds = Math.floor((now - lastStart) / 1000);
                nextStartIn = Math.max(0, (autoRestartConfig.autoStartInterval * 60) - elapsedSeconds);
            }

            autoRestart = {
                autoStopEnabled: autoRestartConfig.autoStopEnabled || false,
                autoStopInterval: autoRestartConfig.autoStopInterval || 0,
                nextStopIn,
                autoStartEnabled: autoRestartConfig.autoStartEnabled || false,
                autoStartInterval: autoRestartConfig.autoStartInterval || 0,
                nextStartIn
            };
        }
    }

    res.json({
        online: isOnline,
        lastUpdate: currentStatus.lastUpdate,
        lastUpdateTimestamp: currentStatus.lastUpdate,
        serverUptimeSeconds,
        health,
        data: currentStatus.data,
        logs: eventLogs.slice(0, 100), // Send last 100 logs
        command: command, // Send pending command status so dashboard knows
        autoRestart: autoRestart // Send auto-restart status
    });
});

// GET /activity-logs - Public logs endpoint
app.get('/activity-logs', (req, res) => {
    res.json({ logs: eventLogs });
});

// Debugging: Log all incoming requests - SILENCED FOR PRODUCTION
// app.use((req, res, next) => {
//     console.log(`[DEBUG] ${req.method} ${req.path}`);
//     next();
// });

// ... (multer config unchanged) ...

// GET /status - Public status endpoint including logs and commands for optimized fetching
app.get('/status', (req, res) => {
    // Check if offline (no update in 45 seconds to handle Render latency)
    const timeSinceLast = Date.now() - currentStatus.lastUpdate;
    const isOnline = timeSinceLast < 45000 && currentStatus.online;

    // Calculate server uptime
    const serverUptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

    // Determine health based on crashes
    const crashes = currentStatus.data.crashes_120s || 0;
    let health = 'excellent';
    if (crashes >= 4) health = 'critical';
    else if (crashes >= 2) health = 'warning';
    else if (crashes >= 1) health = 'good';
    if (!isOnline) health = 'offline';

    // Get pending command for this machine (if any)
    const machineId = currentStatus.data.machineId;
    let command = null;
    let autoRestart = null;

    if (machineId) {
        command = pendingCommands[machineId] || null;

        // Include auto-restart data if available
        const autoRestartConfig = autoRestarts[machineId];
        if (autoRestartConfig) {
            const now = new Date();
            let nextStopIn = 0;
            if (autoRestartConfig.autoStopEnabled && autoRestartConfig.lastStopTime) {
                const lastStop = new Date(autoRestartConfig.lastStopTime);
                const elapsedSeconds = Math.floor((now - lastStop) / 1000);
                nextStopIn = Math.max(0, (autoRestartConfig.autoStopInterval * 60) - elapsedSeconds);
            }
            let nextStartIn = 0;
            if (autoRestartConfig.autoStartEnabled && autoRestartConfig.lastStartTime) {
                const lastStart = new Date(autoRestartConfig.lastStartTime);
                const elapsedSeconds = Math.floor((now - lastStart) / 1000);
                nextStartIn = Math.max(0, (autoRestartConfig.autoStartInterval * 60) - elapsedSeconds);
            }

            autoRestart = {
                autoStopEnabled: autoRestartConfig.autoStopEnabled || false,
                autoStopInterval: autoRestartConfig.autoStopInterval || 0,
                nextStopIn,
                autoStartEnabled: autoRestartConfig.autoStartEnabled || false,
                autoStartInterval: autoRestartConfig.autoStartInterval || 0,
                nextStartIn
            };
        }
    }

    res.json({
        online: isOnline,
        lastUpdate: currentStatus.lastUpdate,
        lastUpdateTimestamp: currentStatus.lastUpdate,
        serverUptimeSeconds,
        health,
        data: currentStatus.data,
        logs: eventLogs.slice(0, 100), // Send last 100 logs
        command: command, // Send pending command status so dashboard knows
        autoRestart: autoRestart // Send auto-restart status
    });
});

// GET /api/commands/:machineId - Launcher polls for new commands and schedules
app.get('/api/commands/:machineId', authenticate, (req, res) => {
    const machineId = req.params.machineId;
    const command = pendingCommands[machineId];
    const schedule = schedules[machineId] || { enabled: false };

    // ... (auto-restart logic same as before) ...
    // Get the auto-restart config for the machine (if any)
    const autoRestartConfig = autoRestarts[machineId] || null;
    let autoRestart = null;

    if (autoRestartConfig) {
        const now = new Date();
        // Calculate auto-stop countdown
        let nextStopIn = 0;
        if (autoRestartConfig.autoStopEnabled && autoRestartConfig.lastStopTime) {
            const lastStop = new Date(autoRestartConfig.lastStopTime);
            const elapsedSeconds = Math.floor((now - lastStop) / 1000);
            const intervalSeconds = autoRestartConfig.autoStopInterval * 60;
            nextStopIn = Math.max(0, intervalSeconds - elapsedSeconds);
        }
        // Calculate auto-start countdown
        let nextStartIn = 0;
        if (autoRestartConfig.autoStartEnabled && autoRestartConfig.lastStartTime) {
            const lastStart = new Date(autoRestartConfig.lastStartTime);
            const elapsedSeconds = Math.floor((now - lastStart) / 1000);
            const intervalSeconds = autoRestartConfig.autoStartInterval * 60;
            nextStartIn = Math.max(0, intervalSeconds - elapsedSeconds);
        }

        autoRestart = {
            autoStopEnabled: autoRestartConfig.autoStopEnabled || false,
            autoStopInterval: autoRestartConfig.autoStopInterval || 0,
            nextStopIn,
            autoStartEnabled: autoRestartConfig.autoStartEnabled || false,
            autoStartInterval: autoRestartConfig.autoStartInterval || 0,
            nextStartIn
        };
    }

    // Clear the command after sending it (one-time execution)
    if (command) {
        console.log(`[COMMAND-QUEUE] 🔵 Sending command "${command}" to ${machineId}`);
        console.log(`[COMMAND-QUEUE] 🗑️  Deleting command from queue for ${machineId}`);
        delete pendingCommands[machineId];
        // console.log(`[COMMAND-QUEUE] ✅ Queue status for ${machineId}:`, pendingCommands[machineId] || 'EMPTY');
    } else {
        // console.log(`[COMMAND-QUEUE] ⚪ No pending command for ${machineId}`); // SILENCED
    }

    res.json({
        command: command || null,
        schedule,
        autoRestart
    });
});


// POST /api/admin/command - Admin issues a manual command (START/STOP)
app.post('/api/admin/command', authenticate, (req, res) => {
    const { machineId, command } = req.body;

    if (!machineId || !['START', 'STOP'].includes(command)) {
        return res.status(400).json({ error: 'Invalid machineId or command' });
    }

    console.log(`[COMMAND-QUEUE] 📥 Dashboard sent command "${command}" for ${machineId}`);
    console.log(`[COMMAND-QUEUE] 📋 Queue BEFORE adding:`, pendingCommands[machineId] || 'EMPTY');
    pendingCommands[machineId] = command;
    console.log(`[COMMAND-QUEUE] ✅ Command "${command}" queued for ${machineId}`);
    console.log(`[COMMAND-QUEUE] 📋 Queue AFTER adding:`, pendingCommands[machineId]);

    const logEntry = {
        timestamp: new Date().toISOString(),
        message: `🎮 REMOTE CMD: ${command} issued for ${machineId}`,
        time: new Date().toLocaleTimeString(),
        type: 'admin-command'
    };
    eventLogs.unshift(logEntry);

    res.json({ success: true, message: `Command ${command} queued` });
});

// POST /api/admin/schedule - Admin sets a time-based schedule
app.post('/api/admin/schedule', authenticate, (req, res) => {
    const { machineId, startAt, stopAt, enabled } = req.body;

    if (!machineId || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Invalid machineId or enabled status' });
    }

    schedules[machineId] = {
        startAt: startAt || '08:00',
        stopAt: stopAt || '23:00',
        enabled: enabled
    };

    console.log(`[ADMIN] Schedule updated for ${machineId}: ${startAt}-${stopAt} (Enabled: ${enabled})`);

    const logEntry = {
        timestamp: new Date().toISOString(),
        message: `📅 SCHEDULE: ${enabled ? 'Enabled' : 'Disabled'} for ${machineId} (${startAt}-${stopAt})`,
        time: new Date().toLocaleTimeString(),
        type: 'admin-schedule'
    };
    eventLogs.unshift(logEntry);

    res.json({ success: true, message: 'Schedule updated' });
});

// POST /api/admin/auto-restart - Admin sets auto-start/stop intervals
app.post('/api/admin/auto-restart', authenticate, (req, res) => {
    const { machineId, autoStopInterval, autoStopEnabled, autoStartInterval, autoStartEnabled } = req.body;

    if (!machineId) {
        return res.status(400).json({ error: 'Invalid machineId' });
    }

    autoRestarts[machineId] = {
        autoStopInterval: autoStopInterval || 120,
        autoStopEnabled: autoStopEnabled || false,
        lastStopTime: autoStopEnabled ? new Date().toISOString() : null,
        autoStartInterval: autoStartInterval || 120,
        autoStartEnabled: autoStartEnabled || false,
        lastStartTime: autoStartEnabled ? new Date().toISOString() : null
    };

    console.log(`[ADMIN] Auto-start/stop updated for ${machineId}: Stop after ${autoStopInterval} min (${autoStopEnabled ? 'On' : 'Off'}), Start after ${autoStartInterval} min (${autoStartEnabled ? 'On' : 'Off'})`);

    const logEntry = {
        timestamp: new Date().toISOString(),
        message: `🔄 AUTO-START/STOP: Stop ${autoStopEnabled ? 'ON' : 'OFF'} (${autoStopInterval}min), Start ${autoStartEnabled ? 'ON' : 'OFF'} (${autoStartInterval}min) for ${machineId}`,
        time: new Date().toLocaleTimeString(),
        type: 'admin-restart'
    };
    eventLogs.unshift(logEntry);

    res.json({ success: true, message: 'Auto-start/stop updated' });
});


// GET / - Serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check for Render
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Somatic Launcher II Server`);
    console.log(`📡 Running on port ${PORT}`);
    console.log(`🔐 API Key: ${API_KEY.substring(0, 10)}...`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});
