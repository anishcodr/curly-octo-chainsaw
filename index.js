// index.js
// Telegram Online Monitor (gram.js userbot) + Express webhook server
// Designed for Render.com FREE tier with external pinger (UptimeRobot / Cron-job.org)

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const express = require('express');
const path = require('path');
const fs = require('fs');

// ────────────────────────────────────────────────
//  ── CONFIG ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
const apiId = Number(process.env.API_ID) || YOUR_API_ID;               // ← use env var on Render
const apiHash = process.env.API_HASH || "b3c22abef89712d91d14c53142aaa8f4";
const targetUsername = process.env.TARGET_USERNAME || "@example";     // ← or numeric ID
const sessionString = process.env.STRING_SESSION || "";               // ← paste full session here

const DATA_FILE = path.join(__dirname, "onlineData.json");
const POLL_INTERVAL = 15000; // 15s

// ────────────────────────────────────────────────
//  Load / save data
// ────────────────────────────────────────────────
let onlineData = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    onlineData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {}
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(onlineData, null, 2));
  } catch (e) {
    console.error("Save failed", e);
  }
}

// ────────────────────────────────────────────────
//  Express server (for Render web service + keep-alive)
// ────────────────────────────────────────────────
const app = express();

app.get(['/', '/health', '/ping'], (req, res) => {
  res.type('text/plain').send(`Monitor alive | ${new Date().toISOString()} | Target: ${targetUsername}`);
});

app.get('/status', (req, res) => {
  res.json({
    online: isOnline,
    lastPoll: lastPollTime?.toISOString(),
    totalDaysTracked: Object.keys(onlineData).length
  });
});

// Optional: expose report as JSON endpoint
app.get('/report/:day?', (req, res) => {
  const day = req.params.day || getDayKey();
  const data = onlineData[day] || { totalHours: 0, sessions: [] };
  res.json(data);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server listening on ${PORT} — Render keep-alive ready`);
});

// ────────────────────────────────────────────────
//  Gram.js userbot logic (same as before, slightly cleaned)
// ────────────────────────────────────────────────
const client = new TelegramClient(
  new StringSession(sessionString),
  apiId,
  apiHash,
  { connectionRetries: 5, requestRetries: 3, autoReconnect: true }
);

let isOnline = false;
let onlineStartTime = null;
let currentDay = null;
let targetId = null;
let lastPollTime = null;

function getDayKey(d = new Date()) {
  return d.toISOString().split('T')[0];
}

function ensureDayData(day) {
  if (!onlineData[day]) onlineData[day] = { totalHours: 0, sessions: [] };
}

async function pollUserStatus() {
  lastPollTime = new Date();
  try {
    const now = new Date();
    const today = getDayKey(now);

    const inputEntity = await client.getInputEntity(targetUsername);
    const full = await client.invoke(new Api.users.GetFullUser({ id: inputEntity }));
    const user = full.users[0];
    targetId = user.id;

    ensureDayData(today);
    if (currentDay && currentDay !== today && onlineStartTime) {
      // day rollover handling (same as before)
      const durMs = Date.now() - onlineStartTime;
      const h = (durMs / 3600000).toFixed(2);
      onlineData[currentDay].sessions.push({
        onlineAt: new Date(onlineStartTime).toLocaleString(),
        offlineAt: "Day rollover",
        durationHours: Number(h)
      });
      onlineData[currentDay].totalHours += Number(h);
      saveData();
      onlineStartTime = null;
    }
    currentDay = today;

    const status = user.status;
    const nowOnline = status?.className === "UserStatusOnline";

    if (nowOnline && !isOnline) {
      isOnline = true;
      onlineStartTime = Date.now();
      await client.sendMessage("me", { message: `🟢 ${targetUsername} ONLINE @ ${now.toLocaleString()}` });
      console.log("🟢 ONLINE");
    } else if (!nowOnline && isOnline) {
      isOnline = false;
      const durMs = Date.now() - onlineStartTime;
      const h = (durMs / 3600000).toFixed(2);
      const offTime = status?.className === "UserStatusOffline" ? new Date(status.wasOnline * 1000) : now;

      onlineData[today].sessions.push({
        onlineAt: new Date(onlineStartTime).toLocaleString(),
        offlineAt: offTime.toLocaleString(),
        durationHours: Number(h)
      });
      onlineData[today].totalHours += Number(h);
      saveData();

      await client.sendMessage("me", {
        message: `🔴 ${targetUsername} OFFLINE after ${h}h\nEnded: ${offTime.toLocaleString()}`
      });
      console.log(`🔴 OFFLINE after ${h}h`);
      onlineStartTime = null;
    }

  } catch (err) {
    console.error("Poll failed:", err.message);
    // gram.js usually auto-reconnects, but you can add client.connect() here if needed
  }
}

// ────────────────────────────────────────────────
//  Main startup
// ────────────────────────────────────────────────
(async () => {
  console.log("Starting Telegram monitor + HTTP server...");

  await client.connect();   // Important: connect explicitly

  if (!await client.checkAuthorization()) {
    console.error("Session invalid. Please provide valid STRING_SESSION in env");
    process.exit(1);
  }

  console.log("Telegram connected");

  // Initial poll
  await pollUserStatus();

  // Poll loop
  setInterval(pollUserStatus, POLL_INTERVAL);

  // Optional: daily auto-report at midnight ( crude way )
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 5) {
      const yesterday = getDayKey(new Date(Date.now() - 86400000));
      const data = onlineData[yesterday] || { totalHours: 0 };
      await client.sendMessage("me", {
        message: `📊 Yesterday (${yesterday}) report: ${data.totalHours.toFixed(2)} hours online`
      });
    }
  }, 300000); // check every 5 min

  console.log(`Monitoring ${targetUsername} | HTTP on port ${PORT}`);
})();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log("SIGTERM → saving & disconnecting");
  saveData();
  client.disconnect();
  process.exit(0);
});
