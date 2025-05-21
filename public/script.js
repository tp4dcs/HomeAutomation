const socket = io();

const mqttIndicator = document.getElementById("mqttIndicator");
const espIndicator = document.getElementById("espIndicator");
const relayGrid = document.getElementById("relayGrid");
const dashboardTitle = document.getElementById("dashboardTitle");

const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const saveBtn = document.getElementById("saveBtn");

const brokerUrl = document.getElementById("brokerUrl");
const brokerPort = document.getElementById("brokerPort");
const brokerUsername = document.getElementById("brokerUsername");
const brokerPassword = document.getElementById("brokerPassword");
const uiTitle = document.getElementById("uiTitle");

const relayStates = {};
const relaySchedules = {}; // Store schedule per relay

function renderRelays() {
  relayGrid.innerHTML = "";
  for (let i = 1; i <= 8; i++) {
    const state = relayStates[i] || "UNKNOWN";
    const div = document.createElement("div");
    div.className = "relay " + (state === "ON" ? "on" : "off");

    div.innerHTML = `
      <h3>Relay ${i}</h3>
      <p>Status: ${state}</p>
      <button onclick="toggleRelay(${i})">${state === "ON" ? "Turn OFF" : "Turn ON"}</button>
      <div style="margin-top:10px;">
        <input type="time" id="time-${i}" />
        <select id="state-${i}">
          <option value="ON">ON</option>
          <option value="OFF">OFF</option>
        </select>
        <button onclick="setSchedule(${i})">Set</button>
        <button onclick="clearSchedule(${i})">Clear</button>
      </div>
    `;
    relayGrid.appendChild(div);
  }
}

function toggleRelay(relayNum) {
  const state = relayStates[relayNum] === "ON" ? "OFF" : "ON";
  socket.emit("toggleRelay", relayNum);
  relayStates[relayNum] = state;
  renderRelays();
}

function setSchedule(relayNum) {
  const time = document.getElementById(`time-${relayNum}`).value;
  const state = document.getElementById(`state-${relayNum}`).value;

  if (time) {
    socket.emit("setSchedule", { relayNum, time, state });
    relaySchedules[relayNum] = { time, state };
    alert(`⏰ Schedule set for Relay ${relayNum} at ${time} to ${state}`);
  } else {
    alert("⛔ Please select a time first!");
  }
}

function clearSchedule(relayNum) {
  socket.emit("clearSchedule", relayNum);
  delete relaySchedules[relayNum];
  alert(`🗑️ Cleared schedule for Relay ${relayNum}`);
}

socket.on("mqttStatus", (status) => {
  mqttIndicator.className = "circle " + (status === "CONNECTED" ? "online" : "offline");
});

socket.on("espStatus", (status) => {
  espIndicator.className = "circle " + (status === "ONLINE" ? "online" : "offline");
});

socket.on("relayStatus", ({ relay, status }) => {
  relayStates[relay] = status;
  renderRelays();
});

renderRelays();

// Load saved config from localStorage
const savedConfig = JSON.parse(localStorage.getItem("mqttConfig") || "{}");
if (savedConfig.uiTitle) dashboardTitle.textContent = savedConfig.uiTitle;

// Show settings modal
settingsBtn.addEventListener("click", () => {
  brokerUrl.value = savedConfig.brokerUrl || "";
  brokerPort.value = savedConfig.brokerPort || "";
  brokerUsername.value = savedConfig.brokerUsername || "";
  brokerPassword.value = savedConfig.brokerPassword || "";
  uiTitle.value = savedConfig.uiTitle || "";
  settingsModal.classList.remove("hidden");
});

// Save settings
saveBtn.addEventListener("click", () => {
  const config = {
    brokerUrl: brokerUrl.value,
    brokerPort: parseInt(brokerPort.value),
    brokerUsername: brokerUsername.value,
    brokerPassword: brokerPassword.value,
    uiTitle: uiTitle.value,
  };

  localStorage.setItem("mqttConfig", JSON.stringify(config));
  settingsModal.classList.add("hidden");
  location.reload();
});
