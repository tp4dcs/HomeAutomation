// server.js

// 1. Load environment variables from .env file in local development.
//    This line should be at the very top of your file.
//    In production environments like Render, these variables are injected directly,
//    so 'dotenv' won't be needed there, but it's essential for local testing.
require('dotenv').config();

// 2. Import necessary modules
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mqtt = require("mqtt");
const path = require("path");
const cors = require("cors");
const cron = require("node-cron");

const app = express();
const server = http.createServer(app);
// Initialize Socket.IO with the HTTP server
const io = socketIo(server);

// 3. Configure Express middleware
//    Enable CORS: This is crucial if your frontend (e.g., on GitHub Pages)
//    is hosted on a different domain than your backend (on Render).
//    For production, you should restrict 'origin' to your specific frontend domain
//    for better security (e.g., cors({ origin: 'https://your-frontend-domain.com' }));
app.use(cors());
//    Serve static files from the 'public' directory. Make sure your index.html
//    and other frontend assets are placed inside a folder named 'public'
//    in the root of your project.
app.use(express.static(path.join(__dirname, "public")));
//    Parse JSON request bodies: Allows you to receive JSON data from your frontend
app.use(express.json());
//    Parse URL-encoded bodies (if you use traditional form submissions)
app.use(express.urlencoded({ extended: true }));

// --- MQTT Connection Configuration ---
// 4. Retrieve MQTT parameters from environment variables.
//    These variables MUST be set in your Render dashboard under the "Environment" tab.
//    For local development, set them in a .env file (which should be in .gitignore).
const MQTT_HOST = process.env.MQTT_HOST;
const MQTT_PORT = process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT) : null;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_PROTOCOL = process.env.MQTT_PROTOCOL || 'wss'; // Default to 'wss' if not specified

// 5. Basic validation for essential MQTT environment variables
if (!MQTT_HOST || !MQTT_PORT || !MQTT_USERNAME || !MQTT_PASSWORD) {
    console.error('CRITICAL ERROR: One or more MQTT environment variables are missing!');
    console.error('Please ensure MQTT_HOST, MQTT_PORT, MQTT_USERNAME, MQTT_PASSWORD are set.');
    console.error('For local development, create a .env file with these variables.');
    console.error('For Render deployment, add them in the "Environment" tab of your service.');
    // Exit the process if critical environment variables are not set.
    // This prevents the server from starting with incomplete configuration.
    process.exit(1);
}

// 6. Construct the MQTT connection URL and options
const connectUrl = `${MQTT_PROTOCOL}://${MQTT_HOST}:${MQTT_PORT}/mqtt`; // Added /mqtt path as per your original code
const mqttOptions = {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    clientId: `mqtt_dashboard_${Math.random().toString(16).slice(2, 10)}`, // Keep dynamic client ID
    // Add other MQTT.js options here if needed, e.g., clean, reconnectPeriod
    // clean: true, // Set to true to receive messages from the moment the connection is established
    // reconnectPeriod: 1000 // Reconnect after 1 second if disconnected
};

// 7. Initialize and connect the MQTT client
console.log(`Attempting to connect to MQTT broker at: ${connectUrl}`);
console.log(`Using username: ${MQTT_USERNAME}`); // Be cautious about logging sensitive info in production

const mqttClient = mqtt.connect(connectUrl, mqttOptions);

// Initial states
let espStatus = "UNKNOWN";
let mqttConnected = false;

let relayStates = {
    1: "OFF", 2: "OFF", 3: "OFF", 4: "OFF",
    5: "OFF", 6: "OFF", 7: "OFF", 8: "OFF",
};

// Store schedules (only the configuration)
// IMPORTANT: Schedules are currently NOT persistent across server restarts/deployments.
// For persistence, you would need to store them in a database (e.g., Firestore).
let schedules = {};
const cronJobs = {};
const relayModes = { // Store manual/auto mode for each relay (default to manual)
    1: "manual", 2: "manual", 3: "manual", 4: "manual",
    5: "manual", 6: "manual", 7: "manual", 8: "manual",
};

const AUTO_CONTROL_TOPIC = "home/devices/auto_control"; // Topic ESP8266 publishes to

// Function to execute a relay action
function executeRelayAction(relayNum, action) {
    const payload = action.toUpperCase(); // Ensure payload is uppercase "ON" or "OFF"
    mqttClient.publish(`home/devices/relay${relayNum}`, payload, { qos: 0, retain: true }); // Publish directly to the relay topic
    relayStates[relayNum] = action;
    io.emit("relayStatus", { relay: relayNum, status: action });
    console.log(`⚙️ Relay ${relayNum} set to ${action} (Manual/Scheduled) - Published to: home/devices/relay${relayNum} with payload: ${payload}`);
}

// Function to schedule a cron job
function scheduleRelayJob(relayNum, schedule) {
    const [hours, minutes] = schedule.time.split(":");
    const cronExpression = `${minutes} ${hours} * * ${schedule.days.join(",")}`;

    const job = cron.schedule(cronExpression, () => {
        if (relayModes[relayNum] === "manual") {
            console.log(`⏰ SCHEDULED: Cron job triggered for Relay ${relayNum} at ${schedule.time} on ${schedule.days.join(',')}, attempting action: ${schedule.action}`); // More detailed log
            executeRelayAction(relayNum, schedule.action);
        } else {
            console.log(`⏰ Schedule for Relay ${relayNum} ignored (Auto Mode)`);
        }
    });
    return job;
}

// Initialize existing schedules
function initializeSchedules() {
    // IMPORTANT: This clears schedules on every server restart.
    // For persistence, schedules need to be loaded from a database here.
    schedules = {}; // Reset on server start
    // Stop and clear all existing cron jobs
    for (const jobKey in cronJobs) {
        if (cronJobs.hasOwnProperty(jobKey)) {
            cronJobs[jobKey].stop();
            delete cronJobs[jobKey];
        }
    }

    // Re-schedule based on the current `schedules` object (which is empty on restart)
    // If you add database persistence, this loop will re-create jobs from loaded schedules.
    for (const relayNumStr in schedules) {
        const relayNum = parseInt(relayNumStr);
        if (schedules.hasOwnProperty(relayNumStr) && Array.isArray(schedules[relayNumStr])) {
            schedules[relayNumStr].forEach(schedule => {
                const jobKey = `${relayNum}-${schedule.time}-${schedule.days.join('-')}-${schedule.action}`;
                // Only schedule if in manual mode
                if (relayModes[relayNum] === "manual") {
                    cronJobs[jobKey] = scheduleRelayJob(relayNum, schedule);
                    console.log(`Rescheduled job for Relay ${relayNum}: ${jobKey}`);
                }
            });
        }
    }
}

// MQTT event handlers
mqttClient.on("connect", () => {
    console.log("✅ Connected to MQTT broker");
    mqttConnected = true;

    mqttClient.subscribe("home/devices/status", { qos: 0 });
    for (let i = 1; i <= 8; i++) {
        mqttClient.subscribe(`home/devices/relay${i}/status`, { qos: 0 });
    }
    mqttClient.subscribe(AUTO_CONTROL_TOPIC, { qos: 0 }); // Subscribe to auto-control topic

    io.emit("mqttStatus", "CONNECTED");
    initializeSchedules(); // Re-initialize schedules on MQTT connect (and server start)
});

mqttClient.on("close", () => {
    console.log("❌ Disconnected from MQTT broker");
    mqttConnected = false;
    io.emit("mqttStatus", "DISCONNECTED");
    // Stop and clear all cron jobs when MQTT disconnects
    for (const jobKey in cronJobs) {
        if (cronJobs.hasOwnProperty(jobKey)) {
            cronJobs[jobKey].stop();
        }
    }
    // Note: cronJobs object is not reset here, but jobs are stopped.
    // They will be re-initialized on next MQTT connect.
});

mqttClient.on("error", (err) => {
    console.error("MQTT Connection Error:", err);
    // You might want to emit this error to the frontend as well
    io.emit("mqttError", err.message);
});


// Handle MQTT messages
mqttClient.on("message", (topic, payload) => {
    const message = payload.toString();

    if (topic === "home/devices/status") {
        espStatus = message;
        io.emit("espStatus", espStatus);
    } else if (topic.endsWith("/status")) {
        const match = topic.match(/relay(\d)\/status/);
        if (match) {
            const relayNum = parseInt(match[1]);
            relayStates[relayNum] = message;
            io.emit("relayStatus", { relay: relayNum, status: message });
        }
    } else if (topic === AUTO_CONTROL_TOPIC) {
        try {
            const data = JSON.parse(message);
            if (data && data.relay && data.state && [1, 2, 3, 4, 5, 6, 7, 8].includes(parseInt(data.relay)) && ["ON", "OFF"].includes(data.state.toUpperCase())) {
                const relayNum = parseInt(data.relay);
                if (relayModes[relayNum] === "auto") {
                    relayStates[relayNum] = data.state.toUpperCase();
                    io.emit("relayStatus", { relay: relayNum, status: relayStates[relayNum] });
                    console.log(`🤖 Relay ${relayNum} set to ${relayStates[relayNum]} (Auto)`);
                }
            }
        } catch (error) {
            console.error("Error parsing auto control message:", error);
        }
    }
});

// WebSocket connection handling
io.on("connection", (socket) => {
    console.log("💻 Client connected");

    // Send initial states to the connected client
    socket.emit("mqttStatus", mqttConnected ? "CONNECTED" : "DISCONNECTED");
    socket.emit("espStatus", espStatus);
    Object.entries(relayStates).forEach(([relay, status]) => {
        socket.emit("relayStatus", { relay: parseInt(relay), status });
    });
    socket.emit("schedulesUpdated", schedules);
    socket.emit("relayModesUpdated", relayModes);

    // Handle relay toggle request from client
    socket.on("toggleRelay", (relayNum) => {
        if (relayModes[relayNum] === "manual") {
            const currentState = relayStates[relayNum];
            const newState = currentState === "ON" ? "OFF" : "ON";
            executeRelayAction(relayNum, newState);
        } else {
            console.log(`Toggle request for Relay ${relayNum} ignored (Auto Mode)`);
        }
    });

    // Handle setting relay mode
    socket.on("setRelayMode", ({ relay, mode }) => {
        const relayNum = parseInt(relay);
        if (["manual", "auto"].includes(mode)) {
            relayModes[relayNum] = mode;
            io.emit("relayModeUpdated", { relay: relayNum, mode: mode }); // Emit only the changed relay and its mode
            console.log(`🕹️ Relay ${relayNum} mode set to ${mode}`);
            // Re-initialize schedules to stop/start cron jobs based on new mode
            initializeSchedules();
        }
    });

    // Handle adding a new schedule
    socket.on("addSchedule", ({ relay, schedule }) => {
        const relayNum = parseInt(relay);
        if (!schedules[relayNum]) {
            schedules[relayNum] = [];
        }
        schedules[relayNum].push(schedule);
        const jobKey = `${relayNum}-${schedule.time}-${schedule.days.join('-')}-${schedule.action}`;
        if (relayModes[relayNum] === "manual") {
            cronJobs[jobKey] = scheduleRelayJob(relayNum, schedule);
        }
        io.emit("schedulesUpdated", schedules);
        console.log(`➕ Added schedule for Relay ${relayNum}: ${JSON.stringify(schedule)}`);
    });

    // Handle deleting a schedule
    socket.on("deleteSchedule", ({ relay, index }) => {
        const relayNum = parseInt(relay);
        if (schedules[relayNum] && schedules[relayNum][index]) {
            const scheduleToDelete = schedules[relayNum][index];
            const jobKeyToDelete = `${relayNum}-${scheduleToDelete.time}-${scheduleToDelete.days.join('-')}-${scheduleToDelete.action}`;
            if (cronJobs[jobKeyToDelete]) {
                cronJobs[jobKeyToDelete].stop();
                delete cronJobs[jobKeyToDelete];
            }
            schedules[relayNum].splice(index, 1);
            if (schedules[relayNum].length === 0) {
                delete schedules[relayNum];
            }
            io.emit("schedulesUpdated", schedules);
            console.log(`🗑️ Deleted schedule for Relay ${relayNum} at index ${index}`);
        }
    });
});

// Start the HTTP server
// Use process.env.PORT for Render, fallback to 3000 for local development
const serverPort = process.env.PORT || 3000;
server.listen(serverPort, () => {
    console.log(`🚀 Server running on http://localhost:${serverPort}`);
    console.log(`Remember to update your frontend to point to your Render URL in production!`);
});

// Initialize schedules on server start (will be empty without persistence)
initializeSchedules();
