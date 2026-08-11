const API_URL = 'http://127.0.0.1:8384/rest';
const API_KEY = 'electron-ui-key';

const headers = {
  'X-API-Key': API_KEY,
  'Content-Type': 'application/json'
};

let transferChart = null;
let lastConnectionSample = null;
let localDeviceId = null;
let dashboardTickInProgress = false;
let lastEventId = 0;
let dashboardDeviceNames = {};
let dashboardFolderNames = {};
let foldersViewData = [];
let selectedFolderId = null;
let activeFolderFilter = 'all';
let folderSearchTerm = '';

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_EVENT_CACHE_KEY = 'syncthing-dashboard-events-v1';
const DASHBOARD_EVENT_TYPES = new Set([
  'ItemFinished',
  'DeviceConnected',
  'DeviceDisconnected',
  'StateChanged',
  'FolderErrors'
]);

function loadDashboardEventCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(DASHBOARD_EVENT_CACHE_KEY) || '[]');
    if (!Array.isArray(cached)) return [];
    const cutoff = Date.now() - DAY_MS;
    return cached.filter(event => new Date(event.time).getTime() >= cutoff);
  } catch (error) {
    console.warn('Could not load dashboard activity cache:', error);
    return [];
  }
}

let dashboardEvents = loadDashboardEventCache();

const chartData = {
  labels: Array(60).fill(''),
  datasets: [
    { label: 'Upload (B/s)', data: Array(60).fill(0), borderColor: '#adff2f', backgroundColor: 'rgba(173,255,47,0.1)', fill: true, tension: 0.4 },
    { label: 'Download (B/s)', data: Array(60).fill(0), borderColor: '#f39c12', backgroundColor: 'rgba(243,156,18,0.1)', fill: true, tension: 0.4 }
  ]
};

async function fetchAPI(endpoint) {
  try {
    const response = await fetch(`${API_URL}${endpoint}`, { headers });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`Error fetching ${endpoint}:`, error);
    return null;
  }
}

async function postAPI(endpoint) {
  try {
    const response = await fetch(`${API_URL}${endpoint}`, { method: 'POST', headers });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return true;
  } catch (error) {
    console.error(`Error posting ${endpoint}:`, error);
    return false;
  }
}

async function postJSON(endpoint, body) {
  try {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const message = (await response.text()).trim();
      throw new Error(message || `HTTP error! status: ${response.status}`);
    }
    return { ok: true };
  } catch (error) {
    console.error(`Error posting ${endpoint}:`, error);
    return { ok: false, error: error.message || 'Could not create the folder.' };
  }
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatRelativeTime(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

function initChart() {
  const ctx = document.getElementById('transferChart');
  if (!ctx || typeof Chart === 'undefined') return;
  transferChart = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#888',
            callback: value => formatBytes(value) + '/s'
          }
        }
      },
      plugins: {
        legend: { labels: { color: '#fff' } }
      }
    }
  });
}

async function updateDashboardData() {
  const systemStatus = await fetchAPI('/system/status');
  const connections = await fetchAPI('/system/connections');
  const discovery = await fetchAPI('/system/discovery');
  
  if (systemStatus) {
    localDeviceId = systemStatus.myID || localDeviceId;
    document.getElementById('dash-cpu').innerText = (systemStatus.cpuPercent || 0).toFixed(1) + '%';
    document.getElementById('dash-ram').innerText = formatBytes(systemStatus.sys);
    const hours = Math.floor(systemStatus.uptime / 3600);
    const mins = Math.floor((systemStatus.uptime % 3600) / 60);
    document.getElementById('dash-uptime').innerText = `${hours}h ${mins}m`;
    document.getElementById('dash-goroutines').innerText = systemStatus.goroutines || 0;
  }
  
  if (discovery) {
      let isOnline = false;
      for (const key in discovery) {
          if (discovery[key].error === null) {
              isOnline = true;
          }
      }
      const discoveryEl = document.getElementById('dash-discovery');
      discoveryEl.innerText = isOnline ? 'Online' : 'Offline';
      discoveryEl.style.color = isOnline ? '#adff2f' : '#f39c12';
  }

  if (connections?.total) {
    const now = Date.now();
    const outBytes = Number(connections.total.outBytesTotal || 0);
    const inBytes = Number(connections.total.inBytesTotal || 0);
    document.getElementById('dash-up-total').innerText = 'Up: ' + formatBytes(outBytes);
    document.getElementById('dash-down-total').innerText = 'Down: ' + formatBytes(inBytes);
    document.getElementById('dash-session-traffic').innerText = formatBytes(outBytes + inBytes);

    let uploadRate = 0;
    let downloadRate = 0;
    if (lastConnectionSample) {
      const elapsedSeconds = Math.max(0.001, (now - lastConnectionSample.at) / 1000);
      uploadRate = Math.max(0, (outBytes - lastConnectionSample.outBytes) / elapsedSeconds);
      downloadRate = Math.max(0, (inBytes - lastConnectionSample.inBytes) / elapsedSeconds);
    }
    lastConnectionSample = { at: now, outBytes, inBytes };
    
    if (transferChart) {
      chartData.datasets[0].data.shift();
      chartData.datasets[0].data.push(uploadRate);
      chartData.datasets[1].data.shift();
      chartData.datasets[1].data.push(downloadRate);
      transferChart.update();
    }
  }
}

function dashboardEventSignature(event) {
  const data = event.data || {};
  return [
    event.time,
    event.type,
    data.folder || '',
    data.item || '',
    data.id || data.device || '',
    data.action || '',
    data.to || ''
  ].join('|');
}

function mergeDashboardEvents(events) {
  const cutoff = Date.now() - DAY_MS;
  const merged = new Map();
  [...dashboardEvents, ...events]
    .filter(event => DASHBOARD_EVENT_TYPES.has(event.type))
    .filter(event => new Date(event.time).getTime() >= cutoff)
    .forEach(event => merged.set(dashboardEventSignature(event), event));

  dashboardEvents = [...merged.values()]
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-5000);

  try {
    localStorage.setItem(DASHBOARD_EVENT_CACHE_KEY, JSON.stringify(dashboardEvents));
  } catch (error) {
    console.warn('Could not save dashboard activity cache:', error);
  }
}

function folderName(folderId) {
  return dashboardFolderNames[folderId] || folderId || 'Shared folder';
}

function deviceName(deviceId, fallback) {
  return fallback || dashboardDeviceNames[deviceId] || 'Remote device';
}

function itemName(path) {
  if (!path) return 'Item';
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function describeDashboardEvent(event) {
  const data = event.data || {};

  if (event.type === 'ItemFinished') {
    const name = itemName(data.item);
    const location = folderName(data.folder);
    if (data.error) {
      return { title: `Could not sync ${name}`, detail: location, tone: 'error' };
    }
    if (data.action === 'delete') {
      return { title: `${name} removed`, detail: `Synced in ${location}`, tone: 'success' };
    }
    if (data.type === 'dir') {
      return { title: `${name} folder updated`, detail: location, tone: 'success' };
    }
    return { title: `${name} synced`, detail: `Completed in ${location}`, tone: 'success' };
  }

  if (event.type === 'DeviceConnected') {
    return {
      title: `${deviceName(data.id, data.deviceName)} connected`,
      detail: data.addr || 'Ready to sync',
      tone: 'success'
    };
  }

  if (event.type === 'DeviceDisconnected') {
    return {
      title: `${deviceName(data.id)} disconnected`,
      detail: 'Device is offline',
      tone: 'warning'
    };
  }

  if (event.type === 'FolderErrors') {
    const errorCount = Array.isArray(data.errors) ? data.errors.length : 1;
    return {
      title: `${folderName(data.folder)} needs attention`,
      detail: `${formatCount(errorCount)} sync ${errorCount === 1 ? 'error' : 'errors'}`,
      tone: 'error'
    };
  }

  if (event.type === 'StateChanged') {
    const name = folderName(data.folder);
    if (data.to === 'idle' && data.from === 'syncing') {
      return { title: `${name} is up to date`, detail: 'Sync completed', tone: 'success' };
    }
    if (data.to === 'syncing') {
      return { title: `${name} started syncing`, detail: 'Changes are being applied', tone: 'warning' };
    }
    if (data.to === 'scanning') {
      return { title: `Scanning ${name}`, detail: 'Checking for changes', tone: 'neutral' };
    }
    if (data.to === 'error') {
      return { title: `${name} has a sync error`, detail: 'Open the folder for details', tone: 'error' };
    }
  }

  return null;
}

function renderDashboardActivity() {
  const completedFileEvents = dashboardEvents.filter(event =>
    event.type === 'ItemFinished' &&
    event.data?.type === 'file' &&
    !event.data?.error
  );
  const syncedFileEvents = completedFileEvents.filter(event => event.data?.action === 'update');
  const removedFileEvents = completedFileEvents.filter(event => event.data?.action === 'delete');
  const failedFileEvents = dashboardEvents.filter(event =>
    event.type === 'ItemFinished' &&
    event.data?.type === 'file' &&
    Boolean(event.data?.error)
  );

  document.getElementById('dash-synced-24h').innerText = formatCount(syncedFileEvents.length);
  document.getElementById('dash-files-updated').innerText = formatCount(syncedFileEvents.length);
  document.getElementById('dash-files-removed').innerText = formatCount(removedFileEvents.length);
  document.getElementById('dash-sync-failures').innerText = formatCount(failedFileEvents.length);
  document.getElementById('dash-activity-total').innerText = formatCount(completedFileEvents.length);

  const lastSync = completedFileEvents[completedFileEvents.length - 1];
  document.getElementById('dash-last-sync').innerText = lastSync
    ? `Last completed ${formatRelativeTime(lastSync.time).toLowerCase()}`
    : 'No completed transfers yet';

  const hourlyBuckets = Array(24).fill(0);
  completedFileEvents.forEach(event => {
    const hoursAgo = Math.floor((Date.now() - new Date(event.time).getTime()) / 3600000);
    if (hoursAgo >= 0 && hoursAgo < 24) hourlyBuckets[23 - hoursAgo]++;
  });
  const highestHourlyCount = Math.max(1, ...hourlyBuckets);
  const barsEl = document.getElementById('dash-hourly-bars');
  barsEl.replaceChildren();
  hourlyBuckets.forEach((count, index) => {
    const bar = document.createElement('span');
    bar.className = `sync-hour-bar${count > 0 ? ' has-activity' : ''}`;
    bar.setAttribute('aria-label', `${count} completed ${count === 1 ? 'sync' : 'syncs'}, ${23 - index} hours ago`);
    bar.title = `${count} completed ${count === 1 ? 'sync' : 'syncs'}`;
    const fill = document.createElement('span');
    fill.style.height = count > 0 ? `${Math.max(10, (count / highestHourlyCount) * 100)}%` : '3px';
    bar.appendChild(fill);
    barsEl.appendChild(bar);
  });

  const feedEl = document.getElementById('dash-activity-feed');
  const activity = dashboardEvents
    .map(event => ({ event, description: describeDashboardEvent(event) }))
    .filter(entry => entry.description)
    .reverse()
    .slice(0, 20);

  feedEl.replaceChildren();
  if (activity.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.innerText = 'No sync activity in the last 24 hours';
    feedEl.appendChild(empty);
    return;
  }

  activity.forEach(({ event, description }) => {
    const row = document.createElement('div');
    row.className = `activity-item ${description.tone}`;

    const status = document.createElement('span');
    status.className = 'activity-status';

    const copy = document.createElement('div');
    copy.className = 'activity-copy';
    const title = document.createElement('div');
    title.className = 'activity-title';
    title.innerText = description.title;
    const meta = document.createElement('div');
    meta.className = 'activity-meta';
    meta.innerText = `${description.detail} · ${formatRelativeTime(event.time)}`;

    copy.append(title, meta);
    row.append(status, copy);
    feedEl.appendChild(row);
  });
}

async function updateActivityFeed() {
  const events = await fetchAPI(`/events?since=${lastEventId}&limit=1000&timeout=0`);
  if (events?.length) {
    lastEventId = events[events.length - 1].id;
    mergeDashboardEvents(events);
  } else {
    mergeDashboardEvents([]);
  }
  renderDashboardActivity();
}

async function updateFleetSummary() {
    const config = await fetchAPI('/system/config');
    const connections = await fetchAPI('/system/connections');
    if (!config || !connections) return;

    dashboardDeviceNames = Object.fromEntries(
      config.devices.map(device => [device.deviceID, device.name || 'Remote device'])
    );
    dashboardFolderNames = Object.fromEntries(
      config.folders.map(folder => [folder.id, folder.label || folder.id])
    );
    
    // Devices
    let devOk = 0, devOff = 0;
    config.devices.forEach(d => {
        if (d.deviceID === localDeviceId) return;
        if (connections.connections[d.deviceID]?.connected) devOk++;
        else devOff++;
    });
    document.getElementById('fleet-devices-ok').innerText = devOk;
    document.getElementById('fleet-devices-off').innerText = devOff;
    document.getElementById('dash-device-availability').innerText = `${formatCount(devOk)} / ${formatCount(devOk + devOff)}`;
    
    // Folders & Storage
    let foldOk = 0, foldSync = 0, foldErr = 0;
    let locBytes = 0, globBytes = 0;
    let globalFiles = 0, pendingFiles = 0;
    
    const statuses = await Promise.all(
      config.folders.map(folder => fetchAPI(`/db/status?folder=${encodeURIComponent(folder.id)}`))
    );
    config.folders.forEach((f, index) => {
        const db = statuses[index];
        if (db) {
            locBytes += Number(db.localBytes || 0);
            globBytes += Number(db.globalBytes || 0);
            globalFiles += Number(db.globalFiles || 0);
            pendingFiles += Number(db.needFiles || 0);
            if (f.paused) foldErr++;
            else if (db.state === 'idle') foldOk++;
            else if (['syncing', 'scanning', 'scan-waiting', 'sync-waiting', 'cleaning'].includes(db.state)) foldSync++;
            else foldErr++;
        }
    });
    
    document.getElementById('fleet-folders-ok').innerText = foldOk;
    document.getElementById('fleet-folders-sync').innerText = foldSync;
    document.getElementById('fleet-folders-err').innerText = foldErr;
    
    document.getElementById('dash-storage-local').innerText = 'Local: ' + formatBytes(locBytes);
    document.getElementById('dash-storage-global').innerText = 'Global: ' + formatBytes(globBytes);
    document.getElementById('dash-pending-files').innerText = formatCount(pendingFiles);
    document.getElementById('dash-total-files').innerText = formatCount(globalFiles);
    const completionPct = globalFiles > 0
      ? Math.max(0, Math.min(100, ((globalFiles - pendingFiles) / globalFiles) * 100))
      : null;
    document.getElementById('dash-sync-completion').innerText = completionPct === null
      ? '—'
      : `${completionPct.toFixed(completionPct < 100 && completionPct > 99 ? 1 : 0)}%`;

    const syncHealth = document.getElementById('dash-sync-health');
    const syncHealthText = document.getElementById('dash-sync-health-text');
    syncHealth.classList.remove('is-healthy', 'is-syncing', 'has-errors');
    if (foldErr > 0) {
      syncHealth.classList.add('has-errors');
      syncHealthText.innerText = `${foldErr} ${foldErr === 1 ? 'folder needs' : 'folders need'} attention`;
    } else if (foldSync > 0 || pendingFiles > 0) {
      syncHealth.classList.add('is-syncing');
      syncHealthText.innerText = 'Sync in progress';
    } else if (devOff > 0 && devOk === 0) {
      syncHealth.classList.add('is-syncing');
      syncHealthText.innerText = 'Devices offline';
    } else {
      syncHealth.classList.add('is-healthy');
      syncHealthText.innerText = 'All systems synced';
    }

    const pct = globBytes > 0 ? Math.min(100, Math.max(0, (locBytes / globBytes) * 100)) : 0;
    document.getElementById('dash-storage-bar').style.width = pct + '%';
    document.getElementById('dash-storage-percent').innerText = globBytes > 0
      ? `${Math.round(pct)}% available locally`
      : 'No shared data yet';
}

async function loadDevices() {
  const config = await fetchAPI('/system/config');
  const stats = await fetchAPI('/stats/device');
  const connections = await fetchAPI('/system/connections');
  
  if (!config || !stats || !connections) return;
  
  const grid = document.getElementById('devices-grid');
  grid.innerHTML = '';

  config.devices.forEach(device => {
    const isConnected = connections.connections[device.deviceID]?.connected;
    const deviceStats = stats[device.deviceID];
    const lastSeen = deviceStats?.lastSeen ? new Date(deviceStats.lastSeen).toLocaleString() : 'Never';
    
    grid.innerHTML += `
      <div class="device-card">
        <div class="device-card-header">
          <h3>${device.name || 'Unknown Device'}</h3>
          <span class="badge ${isConnected ? 'outline' : 'dark'}">${isConnected ? 'Connected' : 'Offline'}</span>
        </div>
        <p style="color: #888; font-size: 12px; margin-bottom: 16px; word-break: break-all;">${device.deviceID}</p>
        <div style="display: flex; justify-content: space-between; font-size: 13px; color: #ccc;">
          <span>Last Seen:</span> <span>${lastSeen}</span>
        </div>
      </div>
    `;
  });
}

async function loadSettings() {
  const config = await fetchAPI('/system/config');
  if (!config) return;
  
  // Try mapping some standard fields if they exist
  document.getElementById('setting-device-name').value = config.options?.urAccepted ? "Accepted" : "No Name (Demo)";
  document.getElementById('setting-listen').value = config.options?.listenAddresses?.join(', ') || 'default';
  document.getElementById('setting-gui').value = config.gui?.address || '127.0.0.1:8384';
  document.getElementById('setting-api').value = config.gui?.apiKey || API_KEY;
}

async function loadAdvancedLogs() {
  const errors = await fetchAPI('/system/error');
  const logsEl = document.getElementById('advanced-logs');
  if (errors && errors.errors && errors.errors.length > 0) {
    logsEl.innerText = errors.errors.map(e => `[${e.when}] ${e.message}`).join('\\n');
  } else {
    logsEl.innerText = 'No system errors found. All good!';
  }
}

function folderPendingItems(dbStatus) {
  if (!dbStatus) return 0;
  if (Number.isFinite(Number(dbStatus.needTotalItems))) return Number(dbStatus.needTotalItems);
  return Number(dbStatus.needFiles || 0) +
    Number(dbStatus.needDirectories || 0) +
    Number(dbStatus.needSymlinks || 0) +
    Number(dbStatus.needDeletes || 0);
}

function folderProgress(dbStatus) {
  if (!dbStatus) return 0;
  const globalBytes = Number(dbStatus.globalBytes || 0);
  const needBytes = Number(dbStatus.needBytes || 0);
  const pendingItems = folderPendingItems(dbStatus);
  if (globalBytes === 0) return pendingItems > 0 ? 95 : 100;
  const completion = Math.max(0, Math.min(100, (1 - (needBytes / globalBytes)) * 100));
  return completion === 100 && pendingItems > 0 ? 99 : completion;
}

function folderViewState(folder, dbStatus) {
  if (folder.paused) return { key: 'attention', label: 'Paused' };
  if (!dbStatus) return { key: 'attention', label: 'Unavailable' };
  if (dbStatus.invalid || dbStatus.state === 'error') return { key: 'attention', label: 'Error' };

  const pendingItems = folderPendingItems(dbStatus);
  if (['syncing', 'scanning', 'scan-waiting', 'sync-waiting', 'cleaning'].includes(dbStatus.state)) {
    return {
      key: 'syncing',
      label: dbStatus.state === 'scanning' ? 'Scanning' : 'Syncing'
    };
  }
  if (pendingItems > 0) return { key: 'attention', label: 'Out of sync' };
  if (dbStatus.state === 'idle') return { key: 'healthy', label: 'Up to date' };
  return { key: 'attention', label: dbStatus.state || 'Unknown' };
}

function formatFolderType(type) {
  const names = {
    sendreceive: 'Send & Receive',
    sendonly: 'Send Only',
    receiveonly: 'Receive Only',
    receiveencrypted: 'Receive Encrypted'
  };
  return names[type] || type || 'Send & Receive';
}

function formatScanInterval(seconds) {
  const value = Number(seconds || 0);
  if (value === 0) return 'Manual only';
  if (value < 60) return `${value} seconds`;
  if (value < 3600) return `${Math.round(value / 60)} minutes`;
  if (value < 86400) return `${Math.round(value / 3600)} hours`;
  return `${Math.round(value / 86400)} days`;
}

function validFolderDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1970) return null;
  return date;
}

function createFolderGlyph(className) {
  const icon = document.createElement('span');
  icon.className = className;
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5h6l2 2H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5"></path></svg>';
  return icon;
}

function renderFolderList() {
  const listEl = document.getElementById('folders-list');
  const normalizedSearch = folderSearchTerm.trim().toLowerCase();
  const visibleFolders = foldersViewData.filter(item => {
    const matchesFilter = activeFolderFilter === 'all' || item.state.key === activeFolderFilter;
    const searchText = `${item.name} ${item.folder.id} ${item.folder.path}`.toLowerCase();
    return matchesFilter && (!normalizedSearch || searchText.includes(normalizedSearch));
  });

  document.getElementById('folders-visible-count').innerText = visibleFolders.length === foldersViewData.length
    ? `${formatCount(visibleFolders.length)} ${visibleFolders.length === 1 ? 'folder' : 'folders'}`
    : `Showing ${formatCount(visibleFolders.length)} of ${formatCount(foldersViewData.length)}`;

  listEl.replaceChildren();
  if (visibleFolders.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'folder-list-empty';
    empty.innerText = foldersViewData.length === 0
      ? 'No folders have been configured yet.'
      : 'No folders match this filter.';
    listEl.appendChild(empty);
    return;
  }

  if (!visibleFolders.some(item => item.folder.id === selectedFolderId)) {
    selectedFolderId = visibleFolders[0].folder.id;
  }

  visibleFolders.forEach(item => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `folder-row ${item.state.key}${item.folder.id === selectedFolderId ? ' active' : ''}`;
    row.dataset.folderId = item.folder.id;

    const main = document.createElement('div');
    main.className = 'folder-row-main';
    main.appendChild(createFolderGlyph('folder-row-icon'));

    const copy = document.createElement('span');
    copy.className = 'folder-row-copy';
    const name = document.createElement('span');
    name.className = 'folder-row-name';
    name.innerText = item.name;
    const path = document.createElement('span');
    path.className = 'folder-row-path';
    path.innerText = item.folder.path;
    copy.append(name, path);

    const badge = document.createElement('span');
    badge.className = `folder-state-badge ${item.state.key}`;
    badge.innerText = item.state.label;
    main.append(copy, badge);

    const progress = document.createElement('div');
    progress.className = 'folder-row-progress';
    const progressFill = document.createElement('span');
    progressFill.style.width = `${item.progress}%`;
    progress.appendChild(progressFill);

    const meta = document.createElement('div');
    meta.className = 'folder-row-meta';
    const size = document.createElement('span');
    size.innerText = formatBytes(item.dbStatus?.globalBytes || 0);
    const files = document.createElement('span');
    files.innerText = `${formatCount(item.dbStatus?.globalFiles || 0)} files`;
    const devices = document.createElement('span');
    devices.innerText = `${formatCount(item.devices.length)} ${item.devices.length === 1 ? 'device' : 'devices'}`;
    meta.append(size, files, devices);

    row.append(main, progress, meta);
    row.addEventListener('click', () => {
      selectedFolderId = item.folder.id;
      renderFolderList();
      renderFolderDetail();
    });
    listEl.appendChild(row);
  });
}

function renderFolderDetail() {
  const selected = foldersViewData.find(item => item.folder.id === selectedFolderId);
  const emptyEl = document.getElementById('folder-detail-empty');
  const contentEl = document.getElementById('folder-detail-content');
  if (!selected) {
    emptyEl.hidden = false;
    contentEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  contentEl.hidden = false;
  const { folder, dbStatus, stats, state, progress, devices } = selected;
  const pending = folderPendingItems(dbStatus);
  const lastScan = validFolderDate(stats?.lastScan);
  const lastFileAt = validFolderDate(stats?.lastFile?.at);

  document.getElementById('detail-title').innerText = selected.name;
  document.getElementById('detail-id').innerText = folder.id;
  document.getElementById('detail-path').innerText = folder.path;
  document.getElementById('detail-global-size').innerText = formatBytes(dbStatus?.globalBytes || 0);
  document.getElementById('detail-local-size').innerText = formatBytes(dbStatus?.localBytes || 0);
  document.getElementById('detail-files').innerText = formatCount(dbStatus?.globalFiles || 0);
  document.getElementById('detail-dirs').innerText = formatCount(dbStatus?.globalDirectories || 0);
  document.getElementById('detail-pending').innerText = formatCount(pending);
  document.getElementById('detail-progress-percent').innerText = `${progress.toFixed(progress < 100 && progress > 99 ? 1 : 0)}%`;
  document.getElementById('detail-progress-bar').style.width = `${progress}%`;
  document.getElementById('detail-progress-copy').innerText = pending > 0
    ? `${formatCount(pending)} ${pending === 1 ? 'item' : 'items'} remaining`
    : 'Local copy matches the global index';

  const statusEl = document.getElementById('detail-status');
  statusEl.className = `folder-state-badge ${state.key}`;
  statusEl.innerText = state.label;

  document.getElementById('detail-folder-type').innerText = formatFolderType(folder.type);
  document.getElementById('detail-watch-state').innerText = folder.fsWatcherEnabled ? 'Enabled' : 'Disabled';
  document.getElementById('detail-rescan-interval').innerText = formatScanInterval(folder.rescanIntervalS);
  document.getElementById('detail-scanned').innerText = lastScan ? formatRelativeTime(lastScan) : 'Never';
  document.getElementById('detail-last-file').innerText = stats?.lastFile?.filename
    ? `${stats.lastFile.filename}${lastFileAt ? ` · ${formatRelativeTime(lastFileAt)}` : ''}`
    : 'No completed file syncs';

  document.getElementById('detail-device-count').innerText = `${formatCount(devices.length)} ${devices.length === 1 ? 'device' : 'devices'}`;
  const deviceList = document.getElementById('detail-device-list');
  deviceList.replaceChildren();
  if (devices.length === 0) {
    const noDevices = document.createElement('div');
    noDevices.className = 'folder-no-devices';
    noDevices.innerText = 'Not shared with another device';
    deviceList.appendChild(noDevices);
  } else {
    devices.forEach(device => {
      const row = document.createElement('div');
      row.className = 'folder-device-row';
      const avatar = document.createElement('span');
      avatar.className = 'folder-device-avatar';
      avatar.innerText = device.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
      const copy = document.createElement('span');
      copy.className = 'folder-device-copy';
      const name = document.createElement('span');
      name.innerText = device.name;
      const id = document.createElement('small');
      id.innerText = device.id;
      copy.append(name, id);
      const status = document.createElement('span');
      status.className = `folder-device-status${device.online ? ' online' : ''}`;
      const dot = document.createElement('i');
      const statusText = document.createElement('span');
      statusText.innerText = device.online ? 'Online' : 'Offline';
      status.append(dot, statusText);
      row.append(avatar, copy, status);
      deviceList.appendChild(row);
    });
  }
}

async function loadFolders() {
  const [config, systemStatus, connections, folderStats] = await Promise.all([
    fetchAPI('/system/config'),
    fetchAPI('/system/status'),
    fetchAPI('/system/connections'),
    fetchAPI('/stats/folder')
  ]);
  if (!config || !systemStatus) return;

  localDeviceId = systemStatus.myID || localDeviceId;
  const folders = Array.isArray(config.folders) ? config.folders : [];
  const devices = Array.isArray(config.devices) ? config.devices : [];
  const remoteDevices = devices.filter(device => device.deviceID !== localDeviceId);
  const deviceNames = Object.fromEntries(remoteDevices.map(device => [device.deviceID, device.name || 'Remote device']));
  const statuses = await Promise.all(
    folders.map(folder => fetchAPI(`/db/status?folder=${encodeURIComponent(folder.id)}`))
  );

  foldersViewData = folders.map((folder, index) => {
    const dbStatus = statuses[index];
    const sharedDevices = (folder.devices || [])
      .filter(reference => reference.deviceID !== localDeviceId)
      .map(reference => ({
        id: reference.deviceID,
        name: deviceNames[reference.deviceID] || 'Remote device',
        online: Boolean(connections?.connections?.[reference.deviceID]?.connected)
      }));
    return {
      folder,
      dbStatus,
      stats: folderStats?.[folder.id] || null,
      name: folder.label || folder.id,
      state: folderViewState(folder, dbStatus),
      progress: folderProgress(dbStatus),
      devices: sharedDevices
    };
  });

  const healthyCount = foldersViewData.filter(item => item.state.key === 'healthy').length;
  const syncingCount = foldersViewData.filter(item => item.state.key === 'syncing').length;
  const attentionCount = foldersViewData.filter(item => item.state.key === 'attention').length;
  const totalData = foldersViewData.reduce((total, item) => total + Number(item.dbStatus?.globalBytes || 0), 0);

  document.getElementById('metric-folders-count').innerText = formatCount(folders.length);
  document.getElementById('folders-summary-device-count').innerText = `Across ${formatCount(remoteDevices.length)} remote ${remoteDevices.length === 1 ? 'device' : 'devices'}`;
  document.getElementById('folders-summary-healthy').innerText = formatCount(healthyCount);
  document.getElementById('folders-summary-syncing').innerText = formatCount(syncingCount);
  document.getElementById('folders-summary-attention').innerText = formatCount(attentionCount);
  document.getElementById('metric-total-data').innerText = formatBytes(totalData);
  document.getElementById('folder-filter-all-count').innerText = formatCount(folders.length);
  document.getElementById('folder-filter-healthy-count').innerText = formatCount(healthyCount);
  document.getElementById('folder-filter-syncing-count').innerText = formatCount(syncingCount);
  document.getElementById('folder-filter-attention-count').innerText = formatCount(attentionCount);

  if (!foldersViewData.some(item => item.folder.id === selectedFolderId)) {
    selectedFolderId = foldersViewData[0]?.folder.id || null;
  }
  renderFolderList();
  renderFolderDetail();
}

// Master Loop
async function tick() {
  if (dashboardTickInProgress) return;
  dashboardTickInProgress = true;
  try {
    const activeView = document.querySelector('.view-content.active')?.id;
    if (activeView === 'view-dashboard') {
        await updateDashboardData();
        await updateFleetSummary();
        await updateActivityFeed();
    }
    if (activeView === 'view-folders') await loadFolders();
    if (activeView === 'view-devices') await loadDevices();
  } finally {
    dashboardTickInProgress = false;
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  renderDashboardActivity();
  loadSettings();
  loadAdvancedLogs();
  tick(); // Initial fetch
  setInterval(tick, 3000); // Poll every 3 seconds

  // Routing
  const navItems = document.querySelectorAll('.nav-item[data-target]');
  const views = document.querySelectorAll('.view-content');
  const addFolderModal = document.getElementById('add-folder-modal');
  const addFolderForm = document.getElementById('add-folder-form');
  const addFolderLabel = document.getElementById('add-folder-label');
  const addFolderId = document.getElementById('add-folder-id');
  const addFolderPath = document.getElementById('add-folder-path');
  const addFolderError = document.getElementById('add-folder-error');
  const addFolderSubmit = document.getElementById('add-folder-submit');
  let folderIdEdited = false;

  const closeAddFolderModal = () => {
    addFolderModal.hidden = true;
    addFolderError.innerText = '';
  };

  document.getElementById('add-folder-btn')?.addEventListener('click', () => {
    addFolderForm.reset();
    folderIdEdited = false;
    addFolderError.innerText = '';
    addFolderModal.hidden = false;
    window.setTimeout(() => addFolderLabel.focus(), 0);
  });

  document.getElementById('add-folder-close')?.addEventListener('click', closeAddFolderModal);
  document.getElementById('add-folder-cancel')?.addEventListener('click', closeAddFolderModal);
  addFolderModal?.addEventListener('click', event => {
    if (event.target === addFolderModal) closeAddFolderModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !addFolderModal.hidden) closeAddFolderModal();
  });

  addFolderLabel?.addEventListener('input', () => {
    if (folderIdEdited) return;
    addFolderId.value = addFolderLabel.value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  });
  addFolderId?.addEventListener('input', () => {
    folderIdEdited = addFolderId.value.length > 0;
  });

  addFolderForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const id = addFolderId.value.trim();
    const path = addFolderPath.value.trim();
    if (!id || !path) return;

    addFolderSubmit.disabled = true;
    addFolderSubmit.innerText = 'Creating…';
    addFolderError.innerText = '';
    const result = await postJSON('/config/folders', {
      id,
      label: addFolderLabel.value.trim() || id,
      path,
      type: document.getElementById('add-folder-type').value,
      fsWatcherEnabled: document.getElementById('add-folder-watch').checked,
      rescanIntervalS: 3600
    });

    if (result.ok) {
      closeAddFolderModal();
      selectedFolderId = id;
      activeFolderFilter = 'all';
      folderSearchTerm = '';
      document.getElementById('folder-search-input').value = '';
      document.querySelectorAll('[data-folder-filter]').forEach(filterButton => {
        const isActive = filterButton.dataset.folderFilter === 'all';
        filterButton.classList.toggle('active', isActive);
        filterButton.setAttribute('aria-selected', String(isActive));
      });
      await loadFolders();
    } else {
      addFolderError.innerText = result.error;
    }
    addFolderSubmit.disabled = false;
    addFolderSubmit.innerText = 'Create folder';
  });

  document.querySelectorAll('[data-folder-filter]').forEach(button => {
    button.addEventListener('click', () => {
      activeFolderFilter = button.dataset.folderFilter;
      document.querySelectorAll('[data-folder-filter]').forEach(filterButton => {
        const isActive = filterButton === button;
        filterButton.classList.toggle('active', isActive);
        filterButton.setAttribute('aria-selected', String(isActive));
      });
      renderFolderList();
      renderFolderDetail();
    });
  });

  document.getElementById('folder-search-input')?.addEventListener('input', event => {
    folderSearchTerm = event.target.value;
    renderFolderList();
    renderFolderDetail();
  });

  document.getElementById('folder-rescan-btn')?.addEventListener('click', async event => {
    if (!selectedFolderId) return;
    const button = event.currentTarget;
    const originalContent = button.innerHTML;
    button.disabled = true;
    button.innerText = 'Requesting scan…';
    const success = await postAPI(`/db/scan?folder=${encodeURIComponent(selectedFolderId)}`);
    button.innerText = success ? 'Scan requested' : 'Could not start scan';
    if (success) await loadFolders();
    window.setTimeout(() => {
      button.innerHTML = originalContent;
      button.disabled = false;
    }, 1800);
  });

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(nav => {
        nav.classList.remove('active');
        const dot = nav.querySelector('.dot');
        if (dot) dot.remove();
      });

      item.classList.add('active');
      if (!item.querySelector('.dot')) {
        item.insertAdjacentHTML('afterbegin', '<span class="dot"></span> ');
      }

      const targetId = item.getAttribute('data-target');
      views.forEach(view => {
        if (view.id === targetId) view.classList.add('active');
        else view.classList.remove('active');
      });
      
      // Trigger instant load on tab switch
      if (targetId === 'view-dashboard') tick();
      if (targetId === 'view-folders') loadFolders();
      if (targetId === 'view-devices') loadDevices();
      if (targetId === 'view-advanced') loadAdvancedLogs();
      if (targetId === 'view-settings') loadSettings();
    });
  });
});
