require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'somatic-secure-key-2026-v1';
const LOG_FILE = path.join(__dirname, 'dashboard_logs.json');
console.log(`[INIT] Persistence file path: ${LOG_FILE}`);

// --- CONFIGURATION & MIDDLEWARE ---

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.text());
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'public', 'logs');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: 'Too many requests, please try again later.'
});

const authenticate = (req, res, next) => {
    const apiKey = req.get('x-api-key');
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Key' });
    }
    next();
};

// --- IN-MEMORY STATE ---

let currentStatus = {
    online: false,
    lastUpdate: 0,
    data: {}
};

let eventLogs = [];
let pendingCommands = {};
let schedules = {};
let autoRestarts = {};
const MAX_LOGS = 100;
const serverStartTime = Date.now();
let sessionMachineId = null;

// --- PERSISTENCE HELPERS ---

const loadLogs = () => {
    try {
        if (fs.existsSync(LOG_FILE)) {
            const data = fs.readFileSync(LOG_FILE, 'utf8');
            eventLogs = JSON.parse(data);
            console.log(`[INIT] Loaded ${eventLogs.length} logs from disk`);
        }
    } catch (err) {
        console.error('[ERROR] Failed to load persistent logs:', err);
    }
};

const saveLogs = () => {
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(eventLogs, null, 2));
    } catch (err) {
        console.error('[ERROR] Failed to save logs to disk:', err);
    }
};

loadLogs();

const generateRandomId = () => 'node-' + Math.random().toString(36).substring(2, 9).toUpperCase();

// --- ROUTES ---

// POST /upload-logs - Handle log file upload
app.post('/upload-logs', apiLimiter, authenticate, upload.single('logfile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');
        const lastLines = lines.slice(-3);

        lastLines.forEach(line => {
            if (!eventLogs.some(log => log.message.includes(line))) {
                eventLogs.unshift({
                    timestamp: new Date().toISOString(),
                    message: `📄 [FILE] ${line}`,
                    time: new Date().toLocaleTimeString(),
                    type: 'file-log'
                });
            }
        });

        if (eventLogs.length > MAX_LOGS) eventLogs = eventLogs.slice(0, MAX_LOGS);
        saveLogs();
    } catch (err) {
        console.error('[ERROR] Failed to read uploaded log file:', err);
    }

    console.log(`[UPLOAD] Log file received: ${req.file.filename}`);
    res.json({ success: true, filename: req.file.filename });
});

// POST /log - Receive plain text logs from launcher (diagnostics, etc.)
app.post('/log', apiLimiter, authenticate, (req, res) => {
    const logText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!logText) return res.status(400).json({ error: 'Empty log body' });

    // Handle potential multiple lines in one request
    const lines = logText.split('\n').filter(l => l.trim());

    lines.forEach(line => {
        eventLogs.unshift({
            timestamp: new Date().toISOString(),
            message: line.trim(),
            time: new Date().toLocaleTimeString(),
            type: 'diagnostic'
        });
    });

    if (eventLogs.length > MAX_LOGS) eventLogs = eventLogs.slice(0, MAX_LOGS);
    saveLogs();

    res.json({ success: true, count: lines.length });
});

// POST /update - Receive launcher updates
app.post('/update', apiLimiter, authenticate, (req, res) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Invalid payload' });

    const eventType = payload.event?.type || (payload.ev ? payload.ev.t : null);
    if (!eventType) return res.status(400).json({ error: 'Missing event type' });

    let machineId = payload.machineId || payload.mId;
    if (!machineId || machineId === 'Unknown' || machineId === '---') {
        if (!sessionMachineId) sessionMachineId = generateRandomId();
        machineId = sessionMachineId;
    }

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

    if (eventType !== 'heartbeat' && eventType !== 'hb') {
        const gameName = payload.game?.exeName || 'Launcher';
        let message = `[${eventType.toUpperCase()}] ${gameName} - ${payload.event?.reason || 'Status Update'}`;

        switch (eventType) {
            case 'launched': message = `🚀 Game Started: ${gameName}`; break;
            case 'stopped': message = `⏹️ Game Stopped: ${gameName}`; break;
            case 'crashed': message = `💥 Game Crashed: ${gameName}`; break;
            case 'relaunched': message = `🔄 Game Restarted: ${gameName}`; break;
        }

        eventLogs.unshift({
            timestamp: new Date().toISOString(),
            message,
            time: new Date().toLocaleTimeString(),
            type: eventType
        });
        if (eventLogs.length > MAX_LOGS) eventLogs = eventLogs.slice(0, MAX_LOGS);
        saveLogs();
    }

    res.json({ success: true, received: eventType });
});


// GET /status - Dashboard polling endpoint
app.get('/status', (req, res) => {
    const timeSinceLast = Date.now() - currentStatus.lastUpdate;
    const isOnline = timeSinceLast < 60000 && currentStatus.online;
    const serverUptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

    const crashes = currentStatus.data.crashes_120s || 0;
    let health = isOnline ? (crashes >= 4 ? 'critical' : crashes >= 2 ? 'warning' : crashes >= 1 ? 'good' : 'excellent') : 'offline';

    const machineId = currentStatus.data.machineId;
    let command = machineId ? pendingCommands[machineId] : null;
    let autoRestart = null;

    if (machineId && autoRestarts[machineId]) {
        const config = autoRestarts[machineId];
        const now = new Date();
        const calcNext = (enabled, last, interval) => {
            if (!enabled || !last) return 0;
            const elapsed = Math.floor((now - new Date(last)) / 1000);
            return Math.max(0, (interval * 60) - elapsed);
        };
        autoRestart = {
            autoStopEnabled: config.autoStopEnabled,
            autoStopInterval: config.autoStopInterval,
            nextStopIn: calcNext(config.autoStopEnabled, config.lastStopTime, config.autoStopInterval),
            autoStartEnabled: config.autoStartEnabled,
            autoStartInterval: config.autoStartInterval,
            nextStartIn: calcNext(config.autoStartEnabled, config.lastStartTime, config.autoStartInterval)
        };
    }

    res.json({
        online: isOnline,
        lastUpdate: currentStatus.lastUpdate,
        lastUpdateTimestamp: currentStatus.lastUpdate,
        serverUptimeSeconds,
        health,
        data: currentStatus.data,
        logs: eventLogs.slice(0, 100),
        command,
        autoRestart
    });
});

// GET /download/:filename - Final Download Route Fix
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const safeFilename = path.basename(filename);
    const filePath = path.resolve(__dirname, 'public', 'logs', safeFilename);

    console.log(`[DOWNLOAD] Request for: ${safeFilename}`);
    console.log(`[DOWNLOAD] Resolved path: ${filePath}`);

    if (fs.existsSync(filePath)) {
        console.log(`[DOWNLOAD] File found, sending...`);
        res.download(filePath, safeFilename);
    } else {
        console.error(`[DOWNLOAD] File NOT found at: ${filePath}`);
        // Fallback check: list directory to help debug
        const files = fs.readdirSync(path.join(__dirname, 'public', 'logs'));
        console.log(`[DOWNLOAD] Available files in logs/:`, files);
        res.status(404).send('Log file not found on server');
    }
});

// POST /api/admin/command - Force manual commands
app.post('/api/admin/command', authenticate, (req, res) => {
    const { machineId, command } = req.body;
    if (machineId && ['START', 'STOP'].includes(command)) {
        pendingCommands[machineId] = command;
        eventLogs.unshift({
            timestamp: new Date().toISOString(),
            message: `🎮 REMOTE CMD: ${command} issued for ${machineId}`,
            time: new Date().toLocaleTimeString(),
            type: 'admin-command'
        });
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Invalid request' });
});

// POST /api/admin/auto-restart - Configure timers
app.post('/api/admin/auto-restart', authenticate, (req, res) => {
    const { machineId, autoStopInterval, autoStopEnabled, autoStartInterval, autoStartEnabled } = req.body;
    if (machineId) {
        autoRestarts[machineId] = {
            autoStopInterval: autoStopInterval || 120,
            autoStopEnabled: !!autoStopEnabled,
            lastStopTime: autoStopEnabled ? new Date().toISOString() : null,
            autoStartInterval: autoStartInterval || 120,
            autoStartEnabled: !!autoStartEnabled,
            lastStartTime: autoStartEnabled ? new Date().toISOString() : null
        };
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Invalid machineId' });
});

// GET /api/commands/:machineId - Launcher polling
app.get('/api/commands/:machineId', authenticate, (req, res) => {
    const machineId = req.params.machineId;
    const command = pendingCommands[machineId] || null;
    if (command) delete pendingCommands[machineId];

    res.json({
        command,
        schedule: schedules[machineId] || { enabled: false },
        autoRestart: null // Simplified for now
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

app.listen(PORT, () => {
    console.log(`🚀 Somatic Launcher II Server`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
});
