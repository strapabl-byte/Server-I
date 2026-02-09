# Somatic Launcher Server 🚀

Production-ready monitoring server for the Somatic Launcher that tracks game statistics, uptime, crashes, and restarts.

**Last Updated**: 2026-02-01

## Features

- ✅ **Real-time monitoring** - Track launcher and game status in real-time
- ✅ **Event logging** - Record all significant events (launches, crashes, restarts)  
- ✅ **Professional dashboard** - Beautiful, responsive web interface
- ✅ **Security** - API key authentication, rate limiting, helmet protection
- ✅ **Production-ready** - Optimized for deployment on Render.com
- ✅ **Auto-recovery** - Automatically detects when launcher goes offline
- ✅ **Emoji Event Logs** - Beautiful emoji indicators for all events

## API Endpoints

###POST `/update`
Receives launcher status updates.

**Headers:**
```
x-api-key: somatic-secure-key-2026-v1
```

**Payload:**
```json
{
  "event": {
    "type": "heartbeat",
    "reason": "user"
  },
  "game": {
    "exeName": "SomaticGame.exe",
    "pid": 12345,
    "state": "LIVE",
    "uptimeSeconds": 3600
  },
  "crashes_120s": 2,
  "total_restarts": 5,
  "uptime_seconds": 3600,
  "timestampUtc": "2026-01-31T23:40:00Z",
  "app": "SomaticLauncher",
  "machineId": "DESKTOP-XYZ"
}
```

### POST `/log`
Receives detailed log messages.

**Headers:**
```
x-api-key: somatic-secure-key-2026-v1
```

**Payload:**
```json
{
  "message": "[ERROR] Game crashed"
}
```

### GET `/status`
Public endpoint that returns current launcher status (no auth required).

### GET `/logs`
Public endpoint that returns recent event logs (no auth required).

### GET `/`
Serves the monitoring dashboard.

### GET `/health`
Health check endpoint for Render.

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Edit `.env`:**
   ```
   PORT=3000
   API_KEY=somatic-secure-key-2026-v1
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

5. **For development with auto-reload:**
   ```bash
   npm run dev
   ```

6. **Open dashboard:**
   ```
   http://localhost:3000
   ```

## Deploying to Render

### Option 1: Using render.yaml (Recommended)

1. **Push to GitHub:**
   ```bash
   cd Server
   git init
   git add .
   git commit -m "Initial server setup"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Connect to Render:**
   - Go to [render.com](https://render.com)
   - Click "New +" → "Blueprint"
   - Connect your GitHub repository
   - Select the `Server` folder
   - Render will auto-detect `render.yaml`

3. **Set environment variables:**
   - In Render dashboard, go to your service
   - Navigate to "Environment"
   - Add: `API_KEY` = `somatic-secure-key-2026-v1`

### Option 2: Manual Deployment

1. **Create new Web Service on Render**
2. **Connect your repository**
3. **Configure:**
   - **Name:** somatic-launcher-server
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment Variables:**
     - `API_KEY` = `somatic-secure-key-2026-v1`

4. **Deploy!**

## Updating Launcher to Use Your Server

Once deployed, update the `StatusService.cs` in your launcher:

```csharp
private const string ENDPOINT = "https://your-app.onrender.com/update";
private const string LOG_ENDPOINT = "https://your-app.onrender.com/log";
```

## Dashboard Features

The dashboard displays:
- **Online/Offline Status** - Real-time launcher connectivity
- **Health Badge** - Crash-based health indicator
- **Game Uptime** - Current game session duration
- **Process ID** - Active game process
- **Crashes (2m)** - Crashes in the last 2 minutes
- **Total Restarts** - Cumulative restart count
- **Server Uptime** - How long the server has been running
- **Event Logs** - Last 50 significant events with emoji indicators

## Security

- ✅ API key authentication on all write endpoints
- ✅ Rate limiting (100 requests/minute)
- ✅ Helmet.js security headers
- ✅ CORS enabled
- ✅ Input validation and sanitization

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Security:** Helmet, CORS, Rate Limiting
- **Styling:** Pure CSS with gradient effects
- **Hosting:** Render.com (recommended)

## Troubleshooting

### Launcher not connecting?
1. Check that the API key matches in both launcher and server
2. Verify the endpoint URLs are correct
3. Check Render logs for connection attempts

### Dashboard shows offline?
1. Launcher must send heartbeats every 30 seconds
2. Check network connectivity
3. Verify API key is correct

### Logs not appearing?
1. Only non-heartbeat events are logged
2. Log limit is 50 entries
3. Check `/logs` endpoint directly

## License

MIT License - See LICENSE file for details

---

**Made with ❤️ for Somatic Landscapes**
