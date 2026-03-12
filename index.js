// index.js
// Telegram Online Status Monitor (gram.js userbot)
// Sends notifications to the specified group: -1003720691412
// Designed for Render.com FREE tier + external pinger recommended

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const express = require("express");
const path = require("path");
const fs = require("fs");

// ────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// Required env variables (set them in Render dashboard!)
const apiId          = Number(process.env.API_ID);
const apiHash        = process.env.API_HASH;
const sessionString  = process.env.STRING_SESSION;
const targetUsername = process.env.TARGET_USERNAME;   // e.g. "@Humanityabove" or "123456789"

// Where ALL notifications & reports go
const NOTIFY_CHAT_ID = "-1003720691412";   // ← your group/supergroup ID

const DATA_FILE      = path.join(__dirname, "onlineData.json");
const POLL_INTERVAL  = 15000; // 15 seconds

// Safety checks
if (!apiId || isNaN(apiId)) {
  console.error("Missing or invalid API_ID environment variable");
  process.exit(1);
}
if (!apiHash) {
  console.error("Missing API_HASH environment variable");
  process.exit(1);
}
if (!sessionString) {
  console.error("Missing STRING_SESSION environment variable");
  process.exit(1);
}
if (!targetUsername) {
  console.error("Missing TARGET_USERNAME environment variable");
  process.exit(1);
}

console.log(`Monitoring target: ${targetUsername}`);
console.log(`Notifications sent to chat ID: ${NOTIFY_CHAT_ID}`);

// ────────────────────────────────────────────────
// Data persistence
// ────────────────────────────────────────────────

let onlineData = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    onlineData = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    console.error("Failed to load onlineData.json → starting fresh", err.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(onlineData, null, 2));
  } catch (err) {
    console.error("Save failed:", err.message);
  }
}

// ────────────────────────────────────────────────
// Express health endpoints (Render requirement)
// ────────────────────────────────────────────────

const app = express();

app.get(["/", "/health", "/ping"], (req, res) => {
  res.type("text/plain").send(
    `Monitor alive | ${new Date().toISOString()} | Target: ${targetUsername}`
  );
});

app.get("/status", (req, res) => {
  res.json({
    online: isOnline ?? false,
    lastPoll: lastPollTime?.toISOString() ?? null,
    totalDaysTracked: Object.keys(onlineData).length,
  });
});

app.get("/report/:day?", (req, res) => {
  const day = req.params.day || getDayKey();
  const data = onlineData[day] || { totalHours: 0, sessions: [] };
  res.json(data);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// ────────────────────────────────────────────────
// Telegram userbot logic
// ────────────────────────────────────────────────

const client = new TelegramClient(
  new StringSession(sessionString),
  apiId,
  apiHash,
  {
    connectionRetries: 5,
    requestRetries: 3,
    autoReconnect: true,
  }
);

let isOnline = false;
let onlineStartTime = null;
let currentDay = null;
let targetId = null;
let lastPollTime = null;

function getDayKey(date = new Date()) {
  return date.toISOString().split("T")[0];
}

function ensureDayData(day) {
  if (!onlineData[day]) {
    onlineData[day] = { totalHours: 0, sessions: [] };
  }
}

async function pollUserStatus() {
  lastPollTime = new Date();

  try {
    const now = new Date();
    const today = getDayKey(now);

    const inputEntity = await client.getInputEntity(targetUsername);
    const fullUser = await client.invoke(
      new Api.users.GetFullUser({ id: inputEntity })
    );
    const user = fullUser.users[0];
    targetId = user.id;

    ensureDayData(today);

    // Handle day rollover
    if (currentDay && currentDay !== today && onlineStartTime) {
      const durationMs = Date.now() - onlineStartTime;
      const hours = (durationMs / 3600000).toFixed(2);
      onlineData[currentDay].sessions.push({
        onlineAt: new Date(onlineStartTime).toLocaleString(),
        offlineAt: "Day rollover",
        durationHours: Number(hours),
      });
      onlineData[currentDay].totalHours += Number(hours);
      saveData();
      onlineStartTime = null;
    }
    currentDay = today;

    const status = user.status;
    const nowOnline = status?.className === "UserStatusOnline";

    if (nowOnline && !isOnline) {
      // → ONLINE
      isOnline = true;
      onlineStartTime = Date.now();

      await client.sendMessage(NOTIFY_CHAT_ID, {
        message: `🟢 ${targetUsername} is NOW ONLINE!\n${now.toLocaleString()}`,
      });

      console.log(`🟢 ${targetUsername} ONLINE`);
    } else if (!nowOnline && isOnline) {
      // → OFFLINE
      isOnline = false;
      const durationMs = Date.now() - onlineStartTime;
      const hours = (durationMs / 3600000).toFixed(2);
      const offlineTime =
        status?.className === "UserStatusOffline"
          ? new Date(status.wasOnline * 1000)
          : now;

      onlineData[today].sessions.push({
        onlineAt: new Date(onlineStartTime).toLocaleString(),
        offlineAt: offlineTime.toLocaleString(),
        durationHours: Number(hours),
      });
      onlineData[today].totalHours += Number(hours);
      saveData();

      await client.sendMessage(NOTIFY_CHAT_ID, {
        message: `🔴 ${targetUsername} went OFFLINE\nOnline for: ${hours} h\nEnded: ${offlineTime.toLocaleString()}`,
      });

      console.log(`🔴 ${targetUsername} OFFLINE after ${hours}h`);
      onlineStartTime = null;
    }
  } catch (err) {
    console.error("Poll failed:", err.message || err.stack?.split("\n")[0]);
  }
}

// ────────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────────

(async () => {
  console.log("Starting Telegram Online Monitor...");

  await client.connect();

  if (!(await client.checkAuthorization())) {
    console.error("Invalid or expired STRING_SESSION — generate a new one");
    process.exit(1);
  }

  console.log("Telegram connected successfully");

  await pollUserStatus();           // initial check
  setInterval(pollUserStatus, POLL_INTERVAL);

  // Daily report ~midnight (crude check)
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 5) {
      const yesterday = getDayKey(new Date(Date.now() - 86400000));
      const data = onlineData[yesterday] || { totalHours: 0 };
      await client.sendMessage(NOTIFY_CHAT_ID, {
        message: `📊 Yesterday (${yesterday}) report:\n${data.totalHours.toFixed(2)} hours online`,
      });
    }
  }, 300000); // every 5 min

  console.log(`Monitoring active → target: ${targetUsername}`);
})();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM → saving & disconnecting");
  saveData();
  client.disconnect();
  process.exit(0);
});
