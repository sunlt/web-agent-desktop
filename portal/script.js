const apps = [
  {
    id: "webtty",
    name: "WebTTY",
    url: "http://localhost:8082/wetty",
    desc: "WebTTY terminal interface",
    color: "linear-gradient(140deg, #f97316, #fb923c)",
    badge: "TTY",
  },
  {
    id: "opencode",
    name: "OpenCode",
    url: "http://localhost:4096",
    desc: "OpenCode service",
    color: "linear-gradient(140deg, #38bdf8, #0ea5e9)",
    badge: "OC",
  },
  {
    id: "file-manager",
    name: "File Manager",
    url: "http://localhost:8081",
    desc: "Filebrowser service",
    color: "linear-gradient(140deg, #22c55e, #16a34a)",
    badge: "FM",
  },
  {
    id: "mihomo",
    name: "Mihomo Dashboard",
    url: "http://localhost:8080",
    desc: "Proxy control center",
    color: "linear-gradient(140deg, #facc15, #eab308)",
    badge: "MH",
  },
];

const taskbarApps = document.getElementById("taskbar-apps");
const appList = document.getElementById("app-list");
const appDrawer = document.getElementById("app-drawer");
const launcher = document.getElementById("launcher");
const clock = document.getElementById("clock");

let cascade = 0;
let windowSerial = 0;
let activeWindowId = null;
const openWindows = new Map();
const windowCounts = {};

function createDrawerCard(app) {
  const card = document.createElement("div");
  card.className = "app-card";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.style.background = app.color;
  thumb.textContent = app.badge;

  const meta = document.createElement("div");
  meta.className = "app-meta";
  const title = document.createElement("h4");
  title.style.display = "flex";
  title.style.alignItems = "center";
  title.textContent = app.name;

  const titleLink = document.createElement("a");
  titleLink.href = app.url;
  titleLink.target = "_blank";
  titleLink.className = "title-link";
  titleLink.title = "Open in new tab";
  titleLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
  titleLink.onclick = (e) => e.stopPropagation();
  title.appendChild(titleLink);

  const desc = document.createElement("p");
  desc.textContent = app.desc;
  meta.appendChild(title);
  meta.appendChild(desc);

  const btn = document.createElement("button");
  btn.className = "open-btn";
  btn.textContent = "Open";
  btn.addEventListener("click", () => {
    openApp(app);
    appDrawer.classList.remove("open");
  });

  card.appendChild(thumb);
  card.appendChild(meta);
  card.appendChild(btn);
  return card;
}

function createTaskbarButton(app, winId, instance) {
  const button = document.createElement("div");
  button.className = "taskbar-app";
  button.dataset.winId = winId;
  button.title = app.name;

  const dot = document.createElement("span");
  dot.className = "taskbar-dot";
  dot.style.background = app.color;

  const label = document.createElement("span");
  label.className = "taskbar-label";
  label.textContent = `${app.name} #${instance}`;

  button.appendChild(dot);
  button.appendChild(label);
  button.addEventListener("click", () => toggleMinimize(winId));
  return button;
}

function openApp(app) {
  const instance = (windowCounts[app.id] || 0) + 1;
  windowCounts[app.id] = instance;
  const winId = `win-${++windowSerial}`;
  const maxWidth = Math.max(280, window.innerWidth - 48);
  const maxHeight = Math.max(220, window.innerHeight - 120);
  const width = maxWidth;
  const height = maxHeight;
  const targetX = 140 + cascade;
  const targetY = 80 + cascade;
  const x = Math.max(16, Math.min(targetX, window.innerWidth - width - 16));
  const y = Math.max(16, Math.min(targetY, window.innerHeight - height - 80));

  const box = new WinBox(`${app.name} #${instance}`, {
    url: app.url,
    width,
    height,
    x,
    y,
    background: app.color,
    class: "portal-winbox",
    onfocus: () => setActiveWindow(winId),
    onblur: () => {
      if (activeWindowId === winId) {
        activeWindowId = null;
        updateTaskbarState();
      }
    },
    onminimize: () => updateTaskbarState(),
    onrestore: () => setActiveWindow(winId),
    onclose: () => {
      removeWindow(winId);
    },
  });

  // Add external link button to header
  try {
    const ctrl = box.dom.querySelector(".wb-control");
    if (ctrl) {
      const externalBtn = document.createElement("span");
      externalBtn.className = "wb-external";
      externalBtn.title = "Open in new tab";
      externalBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
      externalBtn.onclick = (e) => {
        e.stopPropagation();
        window.open(app.url, "_blank");
      };
      ctrl.insertBefore(externalBtn, ctrl.firstChild);
    }
  } catch (e) {
    console.error("Failed to add external button to WinBox header", e);
  }

  openWindows.set(winId, { box, app, instance });
  taskbarApps.appendChild(createTaskbarButton(app, winId, instance));
  setActiveWindow(winId);

  if (cascade < 120) {
    cascade += 26;
  } else {
    cascade = 0;
  }
}

function setActiveWindow(winId) {
  activeWindowId = winId;
  updateTaskbarState();
}

function toggleMinimize(winId) {
  const entry = openWindows.get(winId);
  if (!entry) return;
  const box = entry.box;
  if (box.min) {
    box.restore();
    box.focus();
    setActiveWindow(winId);
    return;
  }
  if (activeWindowId === winId) {
    box.minimize();
  } else {
    box.focus();
    setActiveWindow(winId);
  }
  updateTaskbarState();
}

function updateTaskbarState() {
  taskbarApps.querySelectorAll(".taskbar-app").forEach((btn) => {
    btn.classList.remove("active", "minimized");
    const entry = openWindows.get(btn.dataset.winId);
    if (!entry) {
      return;
    }
    const box = entry.box;
    if (box.min) {
      btn.classList.add("minimized");
    } else if (btn.dataset.winId === activeWindowId) {
      btn.classList.add("active");
    }
  });
}

function removeWindow(winId) {
  openWindows.delete(winId);
  if (activeWindowId === winId) {
    activeWindowId = null;
  }
  const btn = taskbarApps.querySelector(`[data-win-id="${winId}"]`);
  if (btn) btn.remove();
  updateTaskbarState();
}

function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = now.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  clock.textContent = `${date} ${time}`;
}

launcher.addEventListener("click", () => {
  appDrawer.classList.toggle("open");
});

document.addEventListener("click", (event) => {
  if (!appDrawer.contains(event.target) && event.target !== launcher) {
    appDrawer.classList.remove("open");
  }
});

apps.forEach((app) => {
  appList.appendChild(createDrawerCard(app));
});

updateClock();
setInterval(updateClock, 1000 * 30);
