const config = {
  apps: [
    {
      id: "webtty",
      name: "Terminal",
      url: "http://localhost:8082/wetty",
      desc: "Web Terminal",
      color: "#2563eb",
      badge: "TTY",
    },
    {
      id: "opencode",
      name: "IDE",
      url: "http://localhost:4096",
      desc: "Code Editor",
      color: "#0891b2",
      badge: "OC",
    },
    {
      id: "files",
      name: "Files",
      url: "/file-manager/",
      desc: "File Browser",
      color: "#059669",
      badge: "FM",
    },
    {
      id: "proxy",
      name: "Proxy",
      url: "http://localhost:8080",
      desc: "Network Control",
      color: "#d97706",
      badge: "MH",
    },
    {
      id: "market",
      name: "Store",
      type: "system",
      desc: "App Market",
      color: "#8b5cf6",
      badge: "AS",
    },
  ],
  marketApps: [
    {
      id: "browser",
      name: "Browser",
      desc: "Web Browser",
      url: "https://www.google.com",
      color: "#ea4335",
      badge: "WB",
    },
  ],
};

class NotificationManager {
  constructor() {
    this.center = document.getElementById("notification-center");
    this.sidebarContent = document.getElementById("sidebar-content");
    this.notifications = [];
  }

  show(title, body, duration = 4000) {
    // 实时弹窗
    const el = document.createElement("div");
    el.className = "notification";
    el.innerHTML = `
      <div class="notification-title">${title}</div>
      <div class="notification-body">${body}</div>
    `;
    this.center.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 500);
    }, duration);

    // 添加到侧边栏历史
    this.addToSidebar(title, body);
  }

  addToSidebar(title, body) {
    if (this.notifications.length === 0) {
      this.sidebarContent.innerHTML = ""; // 清除 "No New Notifications"
    }

    const notif = { title, body, time: new Date() };
    this.notifications.unshift(notif);

    const item = document.createElement("div");
    item.className = "sidebar-notif";
    item.innerHTML = `
      <div class="sidebar-notif-title">${title}</div>
      <div class="sidebar-notif-body">${body}</div>
    `;
    this.sidebarContent.insertBefore(item, this.sidebarContent.firstChild);
  }
}

class WindowManager {
  constructor() {
    this.windows = new Map();
    this.activeWindowId = null;
    this.windowSerial = 0;
    this.cascade = 0;
    this.taskbarApps = document.getElementById("taskbar-apps");
    this.notifications = new NotificationManager();
  }

  createWindow(app) {
    if (app.id === "market") {
      this.createMarketWindow();
      return;
    }

    const winId = `win-${++this.windowSerial}`;
    const instance =
      [...this.windows.values()].filter((w) => w.app.id === app.id).length + 1;

    const width = Math.min(1000, window.innerWidth - 100);
    const height = Math.min(700, window.innerHeight - 150);
    const x = 50 + this.cascade;
    const y = 40 + this.cascade;

    const box = new WinBox(`${app.name} #${instance}`, {
      url: app.url,
      width,
      height,
      x,
      y,
      background: "var(--bg-elevated)",
      onfocus: () => this.setActive(winId),
      onminimize: () => this.updateTaskbar(),
      onrestore: () => this.setActive(winId),
      onclose: () => this.removeWindow(winId),
    });

    const ctrl = box.dom.querySelector(".wb-control");
    if (ctrl) {
      const ext = document.createElement("span");
      ext.className = "wb-external";
      ext.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>';
      ext.onclick = (e) => {
        e.stopPropagation();
        if (app.url) window.open(app.url, "_blank");
      };
      ctrl.insertBefore(ext, ctrl.firstChild);
    }

    this.windows.set(winId, { box, app, instance });
    this.addTaskbarButton(winId, app, instance);
    this.setActive(winId);

    this.cascade = (this.cascade + 20) % 200;
  }

  createMarketWindow() {
    const box = new WinBox("App Store", {
      width: 600,
      height: 400,
      x: "center",
      y: "center",
      background: "var(--bg-elevated)",
      html: `<div class="market-grid"></div>`,
    });

    const grid = box.dom.querySelector(".market-grid");
    config.marketApps.forEach((app) => {
      const exists = config.apps.some((a) => a.id === app.id);
      const item = document.createElement("div");
      item.className = "market-item";
      item.innerHTML = `
        <div class="market-icon" style="background: ${app.color}">${app.badge}</div>
        <div style="font-weight: 600; font-size: 14px;">${app.name}</div>
        <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">${app.desc}</div>
        <button class="install-btn" ${exists ? "disabled" : ""}>${exists ? "Installed" : "Install"}</button>
      `;

      const btn = item.querySelector(".install-btn");
      btn.onclick = () => {
        if (!exists) {
          btn.disabled = true;
          btn.textContent = "Installing...";
          setTimeout(() => {
            config.apps.push(app);
            renderApps();
            btn.textContent = "Installed";
            this.notifications.show(
              "Success",
              `${app.name} has been installed.`,
            );
          }, 1500);
        }
      };
      grid.appendChild(item);
    });
  }

  addTaskbarButton(winId, app, instance) {
    const btn = document.createElement("div");
    btn.className = "taskbar-app";
    btn.id = `task-${winId}`;
    btn.innerHTML = `
      <div class="taskbar-dot" style="background: ${app.color}"></div>
      <span class="taskbar-label">${app.name}</span>
    `;
    btn.onclick = () => this.toggleWindow(winId);
    this.taskbarApps.appendChild(btn);
  }

  toggleWindow(winId) {
    const win = this.windows.get(winId);
    if (!win) return;

    if (win.box.min) {
      win.box.restore();
      win.box.focus();
    } else if (this.activeWindowId === winId) {
      win.box.minimize();
    } else {
      win.box.focus();
    }
  }

  setActive(winId) {
    this.activeWindowId = winId;
    this.updateTaskbar();
  }

  removeWindow(winId) {
    this.windows.delete(winId);
    const btn = document.getElementById(`task-${winId}`);
    if (btn) btn.remove();
    if (this.activeWindowId === winId) this.activeWindowId = null;
    this.updateTaskbar();
  }

  updateTaskbar() {
    this.windows.forEach((win, id) => {
      const btn = document.getElementById(`task-${id}`);
      if (!btn) return;
      btn.classList.remove("active", "minimized");
      if (win.box.min) {
        btn.classList.add("minimized");
      } else if (id === this.activeWindowId) {
        btn.classList.add("active");
      }
    });
  }
}

// 初始化
const wm = new WindowManager();
const appDrawer = document.getElementById("app-drawer");
const launcher = document.getElementById("launcher");
const userToggle = document.getElementById("user-toggle");
const userPanel = document.getElementById("user-panel");
const notifToggle = document.getElementById("notif-toggle");
const notifSidebar = document.getElementById("notification-sidebar");

function renderApps() {
  const appList = document.getElementById("app-list");
  const desktopShortcuts = document.getElementById("desktop-shortcuts");
  appList.innerHTML = "";
  desktopShortcuts.innerHTML = "";

  config.apps.forEach((app) => {
    // 渲染应用抽屉卡片
    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      <div class="thumb" style="background: ${app.color}">${app.badge}</div>
      <div class="app-meta">
        <h4>${app.name}</h4>
        <p>${app.desc}</p>
      </div>
    `;
    card.onclick = () => {
      wm.createWindow(app);
      appDrawer.classList.remove("open");
    };
    appList.appendChild(card);

    // 渲染桌面图标
    const icon = document.createElement("div");
    icon.className = "desktop-icon";
    icon.innerHTML = `
      <div class="icon-thumb" style="background: ${app.color}">${app.badge}</div>
      <div class="icon-label">${app.name}</div>
    `;
    icon.onclick = () => wm.createWindow(app);
    desktopShortcuts.appendChild(icon);
  });
}

function init() {
  renderApps();

  launcher.onclick = (e) => {
    e.stopPropagation();
    appDrawer.classList.toggle("open");
    userPanel.classList.remove("open");
    notifSidebar.classList.remove("open");
  };

  userToggle.onclick = (e) => {
    e.stopPropagation();
    userPanel.classList.toggle("open");
    appDrawer.classList.remove("open");
    notifSidebar.classList.remove("open");
  };

  notifToggle.onclick = (e) => {
    e.stopPropagation();
    notifSidebar.classList.toggle("open");
    appDrawer.classList.remove("open");
    userPanel.classList.remove("open");
  };

  document.addEventListener("click", () => {
    appDrawer.classList.remove("open");
    userPanel.classList.remove("open");
    notifSidebar.classList.remove("open");
  });

  updateClock();
  setInterval(updateClock, 30000);

  setTimeout(() => {
    wm.notifications.show(
      "System",
      "Welcome to Portal Desktop. All systems active.",
    );
  }, 1000);
}

function updateClock() {
  const clock = document.getElementById("clock");
  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

window.onload = init;
