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
let devicesViewData = [];
let selectedDeviceId = null;
let activeDeviceFilter = 'all';
let deviceSearchTerm = '';
let deviceFoldersSnapshot = [];
let pendingDevicesSnapshot = {};
let settingsSnapshot = null;
let settingsLoading = false;
let settingsDirty = false;
let advancedSnapshot = null;
let advancedLoading = false;
let advancedLogSearch = '';
let advancedLogFilter = 'all';
let advancedDebugSearch = '';
let advancedLevelChanges = {};
let advancedAutoRefreshTimer = null;

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
    return { ok: false, error: error.message || 'The request could not be completed.' };
  }
}

async function requestJSON(endpoint, method, body) {
  try {
    const options = { method, headers };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(`${API_URL}${endpoint}`, options);
    if (!response.ok) {
      const message = (await response.text()).trim();
      throw new Error(message || `HTTP error! status: ${response.status}`);
    }
    return { ok: true };
  } catch (error) {
    console.error(`Error ${method} ${endpoint}:`, error);
    return { ok: false, error: error.message || 'The request could not be completed.' };
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
  
  if (systemStatus) {
    localDeviceId = systemStatus.myID || localDeviceId;
    document.getElementById('dash-cpu').innerText = (systemStatus.cpuPercent || 0).toFixed(1) + '%';
    document.getElementById('dash-ram').innerText = formatBytes(systemStatus.sys);
    const hours = Math.floor(systemStatus.uptime / 3600);
    const mins = Math.floor((systemStatus.uptime % 3600) / 60);
    document.getElementById('dash-uptime').innerText = `${hours}h ${mins}m`;
    document.getElementById('dash-goroutines').innerText = systemStatus.goroutines || 0;

    const discoveryServices = Object.values(systemStatus.discoveryStatus || {});
    const discoveryOnline = systemStatus.discoveryEnabled !== false && (
      discoveryServices.length > 0
        ? discoveryServices.some(service => !service?.error)
        : Number(systemStatus.discoveryMethods || 0) > 0
    );
    const discoveryEl = document.getElementById('dash-discovery');
    discoveryEl.innerText = discoveryOnline ? 'Online' : 'Offline';
    discoveryEl.style.color = discoveryOnline ? '#adff2f' : '#f39c12';
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
  const syncedFileEvents = completedFileEvents.filter(event => event.data?.action !== 'delete');
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
    config.folders.forEach((folder, index) => {
        const db = statuses[index];
        locBytes += Number(db?.localBytes || 0);
        globBytes += Number(db?.globalBytes || 0);
        globalFiles += Number(db?.globalFiles || 0);
        pendingFiles += Number(db?.needFiles || 0);
        const state = folderViewState(folder, db);
        if (state.key === 'healthy') foldOk++;
        else if (state.key === 'syncing') foldSync++;
        else foldErr++;
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
    } else if (config.folders.length === 0) {
      syncHealth.classList.add('is-syncing');
      syncHealthText.innerText = 'No folders configured';
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

function normalizeDeviceID(value) {
  const compact = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (compact.length !== 56) return String(value || '').trim().toUpperCase();
  return compact.match(/.{1,7}/g).join('-');
}

function isValidDeviceID(value) {
  return /^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/.test(normalizeDeviceID(value));
}

function validDeviceDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1970) return null;
  return date;
}

function deviceInitials(name) {
  return String(name || 'Remote device')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'RD';
}

function deviceConnectionState(device, connection) {
  if (device.paused || connection?.paused) return { key: 'paused', label: 'Paused' };
  if (connection?.connected) return { key: 'online', label: 'Online' };
  return { key: 'offline', label: 'Offline' };
}

function formatConnectionType(value) {
  if (!value) return '—';
  const [protocol, direction] = value.split('-');
  const protocolName = protocol === 'quic' ? 'QUIC' : protocol === 'tcp' ? 'TCP' : protocol === 'relay' ? 'Relay' : protocol.toUpperCase();
  return direction ? `${protocolName} ${direction}` : protocolName;
}

function formatCompression(value) {
  const labels = { always: 'All data', metadata: 'Metadata only', never: 'Disabled' };
  return labels[value] || 'Metadata only';
}

function renderPendingDevices() {
  const panel = document.getElementById('pending-devices');
  const list = document.getElementById('pending-device-list');
  if (!panel || !list) return;

  const pending = Object.entries(pendingDevicesSnapshot || {});
  panel.hidden = pending.length === 0;
  list.replaceChildren();
  pending.forEach(([id, details]) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pending-device-row';
    const avatar = document.createElement('span');
    avatar.innerText = deviceInitials(details.name);
    const copy = document.createElement('span');
    const name = document.createElement('b');
    name.innerText = details.name || 'Nearby Syncthing device';
    const code = document.createElement('code');
    code.innerText = id;
    copy.append(name, code);
    const action = document.createElement('small');
    action.innerText = 'Use device';
    row.append(avatar, copy, action);
    row.addEventListener('click', () => {
      document.getElementById('add-device-id').value = id;
      document.getElementById('add-device-name').value = details.name || '';
      document.getElementById('add-device-id').dispatchEvent(new Event('input'));
    });
    list.appendChild(row);
  });
}

function renderDeviceFolderOptions() {
  const options = document.getElementById('add-device-folder-options');
  if (!options) return;
  options.replaceChildren();
  if (deviceFoldersSnapshot.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'device-folder-options-empty';
    empty.innerText = 'No folders are configured yet.';
    options.appendChild(empty);
    return;
  }

  deviceFoldersSnapshot.forEach(folder => {
    const label = document.createElement('label');
    label.className = 'device-folder-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = folder.id;
    checkbox.name = 'device-folder';
    const copy = document.createElement('span');
    const name = document.createElement('b');
    name.innerText = folder.label || folder.id;
    const id = document.createElement('small');
    id.innerText = folder.id;
    copy.append(name, id);
    label.append(checkbox, copy);
    options.appendChild(label);
  });
}

function renderDeviceList() {
  const list = document.getElementById('devices-list');
  if (!list) return;
  const normalizedSearch = deviceSearchTerm.trim().toLowerCase();
  const visibleDevices = devicesViewData.filter(item => {
    const matchesFilter = activeDeviceFilter === 'all' || item.state.key === activeDeviceFilter;
    const searchText = `${item.name} ${item.device.deviceID} ${item.connection?.address || ''}`.toLowerCase();
    return matchesFilter && (!normalizedSearch || searchText.includes(normalizedSearch));
  });

  document.getElementById('devices-visible-count').innerText = visibleDevices.length === devicesViewData.length
    ? `${formatCount(visibleDevices.length)} ${visibleDevices.length === 1 ? 'device' : 'devices'}`
    : `Showing ${formatCount(visibleDevices.length)} of ${formatCount(devicesViewData.length)}`;

  list.replaceChildren();
  if (visibleDevices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'device-list-empty';
    empty.innerText = devicesViewData.length === 0
      ? 'No remote devices configured. Add one to begin pairing.'
      : 'No devices match this filter.';
    list.appendChild(empty);
    selectedDeviceId = null;
    return;
  }

  if (!visibleDevices.some(item => item.device.deviceID === selectedDeviceId)) {
    selectedDeviceId = visibleDevices[0].device.deviceID;
  }

  visibleDevices.forEach(item => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `device-row ${item.state.key}${item.device.deviceID === selectedDeviceId ? ' active' : ''}`;
    row.dataset.deviceId = item.device.deviceID;

    const main = document.createElement('div');
    main.className = 'device-row-main';
    const avatar = document.createElement('span');
    avatar.className = 'device-row-avatar';
    avatar.innerText = deviceInitials(item.name);
    const copy = document.createElement('span');
    copy.className = 'device-row-copy';
    const name = document.createElement('span');
    name.className = 'device-row-name';
    name.innerText = item.name;
    const id = document.createElement('span');
    id.className = 'device-row-id';
    id.innerText = item.device.deviceID;
    copy.append(name, id);
    const status = document.createElement('span');
    status.className = `device-state-badge ${item.state.key}`;
    const dot = document.createElement('i');
    const statusText = document.createElement('span');
    statusText.innerText = item.state.label;
    status.append(dot, statusText);
    main.append(avatar, copy, status);

    const meta = document.createElement('div');
    meta.className = 'device-row-meta';
    const folders = document.createElement('span');
    folders.innerText = `${formatCount(item.sharedFolders.length)} shared ${item.sharedFolders.length === 1 ? 'folder' : 'folders'}`;
    const traffic = document.createElement('span');
    traffic.innerText = `${formatBytes(Number(item.connection?.inBytesTotal || 0) + Number(item.connection?.outBytesTotal || 0))} transferred`;
    const seen = document.createElement('span');
    seen.innerText = item.state.key === 'online' ? 'Connected now' : item.lastSeen ? formatRelativeTime(item.lastSeen) : 'Never seen';
    meta.append(folders, traffic, seen);

    row.append(main, meta);
    row.addEventListener('click', () => {
      selectedDeviceId = item.device.deviceID;
      renderDeviceList();
      renderDeviceDetail();
    });
    list.appendChild(row);
  });
}

function renderDeviceDetail() {
  const selected = devicesViewData.find(item => item.device.deviceID === selectedDeviceId);
  const empty = document.getElementById('device-detail-empty');
  const content = document.getElementById('device-detail-content');
  if (!selected) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }

  empty.hidden = true;
  content.hidden = false;
  const { device, connection, state, name, sharedFolders, lastSeen } = selected;
  const startedAt = validDeviceDate(connection?.startedAt);
  const connectionAt = validDeviceDate(connection?.at);
  const route = connection?.isLocal ? 'Local network' : connection?.connected ? 'Remote network' : 'No active route';

  document.getElementById('device-detail-avatar').innerText = deviceInitials(name);
  document.getElementById('device-detail-name').innerText = name;
  document.getElementById('device-detail-id').innerText = device.deviceID;
  const status = document.getElementById('device-detail-status');
  status.className = `device-state-badge ${state.key}`;
  status.innerHTML = '<i></i>';
  status.appendChild(document.createTextNode(state.label));

  const banner = document.getElementById('device-connection-banner');
  banner.className = `device-connection-banner ${state.key}`;
  if (state.key === 'online') {
    document.getElementById('device-connection-title').innerText = `Connected via ${formatConnectionType(connection.type)}`;
    document.getElementById('device-connection-copy').innerText = startedAt
      ? `Connection active since ${startedAt.toLocaleString()}. Syncthing is ready to exchange data.`
      : 'Syncthing is ready to exchange data with this device.';
  } else if (state.key === 'paused') {
    document.getElementById('device-connection-title').innerText = 'Connection paused';
    document.getElementById('device-connection-copy').innerText = 'Resume this device to allow discovery and synchronization.';
  } else {
    document.getElementById('device-connection-title').innerText = 'Waiting for connection';
    document.getElementById('device-connection-copy').innerText = 'Syncthing will connect automatically when both devices approve each other.';
  }
  document.getElementById('device-last-seen').innerText = state.key === 'online'
    ? 'Online now'
    : lastSeen ? `Last seen ${formatRelativeTime(lastSeen)}` : connectionAt ? `Last attempt ${formatRelativeTime(connectionAt)}` : 'Never seen';

  document.getElementById('device-bytes-received').innerText = formatBytes(connection?.inBytesTotal || 0);
  document.getElementById('device-bytes-sent').innerText = formatBytes(connection?.outBytesTotal || 0);
  document.getElementById('device-shared-count').innerText = formatCount(sharedFolders.length);
  document.getElementById('device-shared-copy').innerText = sharedFolders.length === 0
    ? 'No folders shared'
    : `${formatBytes(sharedFolders.reduce((total, folder) => total + Number(folder.globalBytes || 0), 0))} indexed`;
  document.getElementById('device-connection-type').innerText = formatConnectionType(connection?.type);
  document.getElementById('device-connection-location').innerText = route;
  document.getElementById('device-address').innerText = connection?.address || device.addresses?.join(', ') || 'Dynamic';
  document.getElementById('device-client-version').innerText = connection?.clientVersion || 'Unknown';
  document.getElementById('device-compression').innerText = formatCompression(device.compression);
  document.getElementById('device-introducer').innerText = device.introducer ? 'Enabled' : 'No';
  document.getElementById('device-auto-accept').innerText = device.autoAcceptFolders ? 'Enabled' : 'Off';
  document.getElementById('device-folder-count').innerText = `${formatCount(sharedFolders.length)} ${sharedFolders.length === 1 ? 'folder' : 'folders'}`;

  const pauseButton = document.getElementById('device-pause-btn');
  pauseButton.innerText = device.paused ? 'Resume device' : 'Pause device';

  const folderList = document.getElementById('device-folder-list');
  folderList.replaceChildren();
  if (sharedFolders.length === 0) {
    const noFolders = document.createElement('div');
    noFolders.className = 'device-no-folders';
    noFolders.innerText = 'No folders are shared with this device.';
    folderList.appendChild(noFolders);
  } else {
    sharedFolders.forEach(folder => {
      const row = document.createElement('div');
      row.className = 'device-folder-row';
      const icon = document.createElement('span');
      icon.className = 'device-folder-icon';
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5h6l2 2H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5"></path></svg>';
      const copy = document.createElement('span');
      copy.className = 'device-folder-copy';
      const folderName = document.createElement('span');
      folderName.innerText = folder.label || folder.id;
      const folderMeta = document.createElement('small');
      folderMeta.innerText = `${formatBytes(folder.globalBytes || 0)} · ${formatCount(folder.globalFiles || 0)} files`;
      copy.append(folderName, folderMeta);
      const id = document.createElement('code');
      id.innerText = folder.id;
      row.append(icon, copy, id);
      folderList.appendChild(row);
    });
  }
}

async function loadDevices() {
  const [config, systemStatus, stats, connections, pending] = await Promise.all([
    fetchAPI('/system/config'),
    fetchAPI('/system/status'),
    fetchAPI('/stats/device'),
    fetchAPI('/system/connections'),
    fetchAPI('/cluster/pending/devices')
  ]);
  if (!config || !systemStatus) return;

  localDeviceId = systemStatus.myID || localDeviceId;
  const devices = Array.isArray(config.devices) ? config.devices : [];
  const folders = Array.isArray(config.folders) ? config.folders : [];
  const remoteDevices = devices.filter(device => device.deviceID !== localDeviceId);
  const localDevice = devices.find(device => device.deviceID === localDeviceId);
  const statuses = await Promise.all(folders.map(folder => fetchAPI(`/db/status?folder=${encodeURIComponent(folder.id)}`)));
  deviceFoldersSnapshot = folders;
  pendingDevicesSnapshot = pending || {};

  devicesViewData = remoteDevices.map(device => {
    const connection = connections?.connections?.[device.deviceID] || null;
    const deviceStats = stats?.[device.deviceID] || null;
    const sharedFolders = folders
      .map((folder, index) => ({
        ...folder,
        globalBytes: statuses[index]?.globalBytes || 0,
        globalFiles: statuses[index]?.globalFiles || 0
      }))
      .filter(folder => (folder.devices || []).some(reference => reference.deviceID === device.deviceID));
    return {
      device,
      connection,
      stats: deviceStats,
      name: device.name || 'Remote device',
      state: deviceConnectionState(device, connection),
      lastSeen: validDeviceDate(deviceStats?.lastSeen),
      sharedFolders
    };
  });

  const onlineCount = devicesViewData.filter(item => item.state.key === 'online').length;
  const pausedCount = devicesViewData.filter(item => item.state.key === 'paused').length;
  const offlineCount = devicesViewData.filter(item => item.state.key === 'offline').length;
  const sharedFolderCount = folders.filter(folder => (folder.devices || []).some(reference => reference.deviceID !== localDeviceId)).length;
  const sessionTraffic = devicesViewData.reduce((total, item) => total + Number(item.connection?.inBytesTotal || 0) + Number(item.connection?.outBytesTotal || 0), 0);

  document.getElementById('local-device-title').innerText = localDevice?.name || 'Local Syncthing';
  document.getElementById('local-device-id').innerText = localDeviceId || 'Device ID unavailable';
  document.getElementById('devices-summary-total').innerText = formatCount(remoteDevices.length);
  document.getElementById('devices-summary-connection-copy').innerText = remoteDevices.length === 0
    ? 'No devices configured'
    : `${formatCount(onlineCount)} online · ${formatCount(offlineCount + pausedCount)} unavailable`;
  document.getElementById('devices-summary-online').innerText = formatCount(onlineCount);
  document.getElementById('devices-summary-folders').innerText = formatCount(sharedFolderCount);
  document.getElementById('devices-summary-traffic').innerText = formatBytes(sessionTraffic);
  document.getElementById('device-filter-all-count').innerText = formatCount(remoteDevices.length);
  document.getElementById('device-filter-online-count').innerText = formatCount(onlineCount);
  document.getElementById('device-filter-offline-count').innerText = formatCount(offlineCount);
  document.getElementById('device-filter-paused-count').innerText = formatCount(pausedCount);

  if (!devicesViewData.some(item => item.device.deviceID === selectedDeviceId)) {
    selectedDeviceId = devicesViewData[0]?.device.deviceID || null;
  }
  if (document.getElementById('add-device-modal')?.hidden !== false) {
    renderPendingDevices();
    renderDeviceFolderOptions();
  }
  renderDeviceList();
  renderDeviceDetail();
}

function setSettingsDirty(dirty, state = dirty ? 'dirty' : 'saved', message = dirty ? 'Unsaved changes' : 'All changes saved') {
  settingsDirty = dirty;
  const saveState = document.getElementById('settings-save-state');
  if (!saveState) return;
  saveState.className = `settings-save-state ${state}`;
  saveState.querySelector('span').innerText = message;
  document.getElementById('save-settings-btn').disabled = !dirty || state === 'saving';
  document.getElementById('discard-settings-btn').disabled = !dirty || state === 'saving';
}

function numberSetting(id, fallback = 0) {
  const value = Number(document.getElementById(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function splitSettingList(value) {
  const items = String(value || '')
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
  return items.length ? [...new Set(items)] : ['default'];
}

function formatBandwidthSummary(sendKiB, receiveKiB) {
  const send = Number(sendKiB || 0);
  const receive = Number(receiveKiB || 0);
  if (send === 0 && receive === 0) return 'Unlimited';
  const formatLimit = value => value === 0 ? 'Unlimited' : `${formatBytes(value * 1024)}/s`;
  return `↑ ${formatLimit(send)} · ↓ ${formatLimit(receive)}`;
}

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  return address.startsWith('127.') || address.startsWith('localhost:') || address.startsWith('[::1]') || address.startsWith('unix');
}

function renderSettingsSummary(config, systemStatus, version, localDevice) {
  const options = config.options || {};
  const gui = config.gui || {};
  const enabledServices = [
    options.globalAnnounceEnabled,
    options.localAnnounceEnabled,
    options.relaysEnabled,
    options.natEnabled
  ].filter(Boolean).length;
  const effectiveGuiAddress = systemStatus.guiAddressUsed || gui.address;

  document.getElementById('settings-summary-device').innerText = localDevice?.name || 'Local Syncthing';
  document.getElementById('settings-summary-id').innerText = localDeviceId ? localDeviceId.slice(0, 15) + '…' : 'Device ID unavailable';
  document.getElementById('settings-summary-connectivity').innerText = `${enabledServices} / 4 enabled`;
  document.getElementById('settings-summary-services').innerText = enabledServices === 4 ? 'Discovery, relays, and NAT ready' : 'Some network services are disabled';
  document.getElementById('settings-summary-bandwidth').innerText = formatBandwidthSummary(options.maxSendKbps, options.maxRecvKbps);

  const authenticated = Boolean(gui.user && gui.password);
  const localOnly = isLoopbackAddress(effectiveGuiAddress);
  document.getElementById('settings-summary-security').innerText = authenticated ? 'Protected' : localOnly ? 'Local only' : 'Needs attention';
  document.getElementById('settings-summary-security-copy').innerText = authenticated
    ? `${gui.useTLS ? 'HTTPS' : 'Password'} authentication enabled`
    : localOnly ? 'Only accessible from this device' : 'Remote interface has no login';
  document.getElementById('settings-service-state').innerText = 'Running';
  const uptimeHours = Math.floor(Number(systemStatus.uptime || 0) / 3600);
  document.getElementById('settings-service-meta').innerText = `${version?.version || 'Syncthing'} · ${uptimeHours}h uptime`;
}

async function loadSettings() {
  if (settingsLoading) return;
  settingsLoading = true;
  const [config, systemStatus, version, restartState] = await Promise.all([
    fetchAPI('/system/config'),
    fetchAPI('/system/status'),
    fetchAPI('/system/version'),
    fetchAPI('/config/restart-required')
  ]);

  if (!config || !systemStatus) {
    settingsLoading = false;
    setSettingsDirty(true, 'error', 'Could not load settings');
    document.getElementById('settings-form-error').innerText = 'The Syncthing service did not return its configuration.';
    return;
  }

  localDeviceId = systemStatus.myID || localDeviceId;
  const options = config.options || {};
  const gui = config.gui || {};
  const devices = Array.isArray(config.devices) ? config.devices : [];
  const localDevice = devices.find(device => device.deviceID === localDeviceId) || null;
  settingsSnapshot = { config, systemStatus, version, localDevice };

  document.getElementById('setting-device-name').value = localDevice?.name || '';
  document.getElementById('setting-reconnect').value = options.reconnectionIntervalS ?? 20;
  document.getElementById('setting-keep-temporaries').value = options.keepTemporariesH ?? 24;
  document.getElementById('setting-low-priority').checked = options.setLowPriority !== false;
  document.getElementById('setting-overwrite-names').checked = Boolean(options.overwriteRemoteDeviceNamesOnConnect);
  document.getElementById('setting-listen').value = (options.listenAddresses || ['default']).join('\n');
  document.getElementById('setting-global-discovery').checked = options.globalAnnounceEnabled !== false;
  document.getElementById('setting-local-discovery').checked = options.localAnnounceEnabled !== false;
  document.getElementById('setting-relays').checked = options.relaysEnabled !== false;
  document.getElementById('setting-nat').checked = options.natEnabled !== false;
  document.getElementById('setting-announce-lan').checked = options.announceLANAddresses !== false;
  document.getElementById('setting-max-send').value = options.maxSendKbps ?? 0;
  document.getElementById('setting-max-recv').value = options.maxRecvKbps ?? 0;
  document.getElementById('setting-folder-concurrency').value = options.maxFolderConcurrency ?? 0;
  document.getElementById('setting-connection-limit').value = options.connectionLimitMax ?? 0;
  document.getElementById('setting-limit-lan').checked = Boolean(options.limitBandwidthInLan);
  document.getElementById('setting-gui').value = systemStatus.guiAddressUsed || gui.address || '127.0.0.1:8384';
  document.getElementById('setting-theme').value = gui.theme || 'default';
  document.getElementById('setting-gui-user').value = gui.user || '';
  document.getElementById('setting-gui-password').value = '';
  document.getElementById('setting-api').value = gui.apiKey || API_KEY;
  document.getElementById('setting-api').type = 'password';
  document.getElementById('settings-toggle-api').innerText = 'Show';
  document.getElementById('setting-gui-tls').checked = systemStatus.guiAddressOverridden ? false : Boolean(gui.useTLS);
  document.getElementById('setting-usage-reporting').checked = Number(options.urAccepted || 0) > 0;
  document.getElementById('setting-crash-reporting').checked = options.crashReportingEnabled !== false;
  document.getElementById('setting-audit').checked = Boolean(options.auditEnabled);
  document.getElementById('settings-form-error').innerText = '';
  document.getElementById('settings-restart-banner').hidden = !restartState?.requiresRestart;

  renderSettingsSummary(config, systemStatus, version, localDevice);
  settingsLoading = false;
  setSettingsDirty(false);
}

function collectSettingsChanges() {
  if (!settingsSnapshot) return { error: 'Settings are not loaded yet.' };
  const deviceName = document.getElementById('setting-device-name').value.trim();
  const guiAddress = document.getElementById('setting-gui').value.trim();
  const guiUser = document.getElementById('setting-gui-user').value.trim();
  const guiPassword = document.getElementById('setting-gui-password').value;
  if (!deviceName) return { error: 'Device name cannot be empty.' };
  if (!guiAddress) return { error: 'GUI listen address cannot be empty.' };
  if (numberSetting('setting-reconnect', 20) < 5) return { error: 'Reconnect interval must be at least five seconds.' };
  if (guiPassword && !guiUser) return { error: 'Enter an administrator username before setting a password.' };
  if (guiUser && !guiPassword && !settingsSnapshot.config.gui?.password) {
    return { error: 'Set an administrator password to enable interface authentication.' };
  }

  const { config, systemStatus } = settingsSnapshot;
  const currentOptions = config.options || {};
  const reportVersion = Number(systemStatus.urVersionMax || currentOptions.urAccepted || 1);
  const usageReporting = document.getElementById('setting-usage-reporting').checked;
  const requestedOptions = {
    reconnectionIntervalS: Math.round(numberSetting('setting-reconnect', 20)),
    keepTemporariesH: Math.max(0, Math.round(numberSetting('setting-keep-temporaries', 24))),
    setLowPriority: document.getElementById('setting-low-priority').checked,
    overwriteRemoteDeviceNamesOnConnect: document.getElementById('setting-overwrite-names').checked,
    listenAddresses: splitSettingList(document.getElementById('setting-listen').value),
    globalAnnounceEnabled: document.getElementById('setting-global-discovery').checked,
    localAnnounceEnabled: document.getElementById('setting-local-discovery').checked,
    relaysEnabled: document.getElementById('setting-relays').checked,
    natEnabled: document.getElementById('setting-nat').checked,
    announceLANAddresses: document.getElementById('setting-announce-lan').checked,
    maxSendKbps: Math.max(0, Math.round(numberSetting('setting-max-send', 0))),
    maxRecvKbps: Math.max(0, Math.round(numberSetting('setting-max-recv', 0))),
    maxFolderConcurrency: Math.max(-1, Math.round(numberSetting('setting-folder-concurrency', 0))),
    connectionLimitMax: Math.max(0, Math.round(numberSetting('setting-connection-limit', 0))),
    limitBandwidthInLan: document.getElementById('setting-limit-lan').checked,
    urAccepted: usageReporting ? reportVersion : -1,
    urSeen: reportVersion,
    crashReportingEnabled: document.getElementById('setting-crash-reporting').checked,
    auditEnabled: document.getElementById('setting-audit').checked
  };
  const options = Object.fromEntries(Object.entries(requestedOptions).filter(([key, value]) =>
    JSON.stringify(currentOptions[key]) !== JSON.stringify(value)
  ));
  const currentGui = config.gui || {};
  const gui = {};
  const requestedTheme = document.getElementById('setting-theme').value;
  if (requestedTheme !== currentGui.theme) gui.theme = requestedTheme;
  if (guiUser !== (currentGui.user || '')) gui.user = guiUser;
  if (guiPassword) gui.password = guiPassword;
  return {
    deviceName,
    deviceNameChanged: deviceName !== (settingsSnapshot.localDevice?.name || ''),
    options,
    gui
  };
}

async function waitForLocalAPI(attempts = 20, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${API_URL}/system/ping`, { headers });
      if (response.ok) return true;
    } catch (error) {
      // GUI-related configuration changes briefly restart the local listener.
    }
    await new Promise(resolve => window.setTimeout(resolve, delayMs));
  }
  return false;
}

async function saveSettings() {
  const changes = collectSettingsChanges();
  const errorEl = document.getElementById('settings-form-error');
  if (changes.error) {
    errorEl.innerText = changes.error;
    setSettingsDirty(true, 'error', 'Check highlighted settings');
    return;
  }

  errorEl.innerText = '';
  setSettingsDirty(true, 'saving', 'Saving configuration…');
  const operations = [];
  if (Object.keys(changes.options).length > 0) {
    operations.push(() => requestJSON('/config/options', 'PATCH', changes.options));
  }
  if (changes.deviceNameChanged && localDeviceId) {
    operations.push(() => requestJSON(`/config/devices/${encodeURIComponent(localDeviceId)}`, 'PATCH', { name: changes.deviceName }));
  }
  // Apply GUI changes last because Syncthing may briefly restart its API listener.
  if (Object.keys(changes.gui).length > 0) {
    operations.push(() => requestJSON('/config/gui', 'PATCH', changes.gui));
  }

  if (operations.length === 0) {
    setSettingsDirty(false, 'saved', 'No changes to save');
    return;
  }

  for (const operation of operations) {
    const result = await operation();
    if (!result.ok) {
      errorEl.innerText = result.error || 'One or more settings could not be saved.';
      setSettingsDirty(true, 'error', 'Save failed');
      return;
    }
  }

  if (!await waitForLocalAPI()) {
    errorEl.innerText = 'Changes were saved, but the local Syncthing API did not come back online.';
    setSettingsDirty(true, 'error', 'Save failed');
    return;
  }

  await loadSettings();
  setSettingsDirty(false, 'saved', 'Changes saved');
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function friendlyPathName(key) {
  const names = {
    config: 'Configuration file',
    database: 'Index database',
    certFile: 'Device certificate',
    keyFile: 'Private key',
    auditLog: 'Audit log',
    defFolder: 'Default folder',
    'baseDir-config': 'Configuration directory',
    'baseDir-data': 'Data directory',
    'baseDir-userHome': 'User home'
  };
  return names[key] || key.replace(/[-_]/g, ' ');
}

function classifyAdvancedLog(message, explicitLevel) {
  const level = String(explicitLevel || '').toLowerCase();
  const normalizedLevels = {
    err: 'error',
    error: 'error',
    wrn: 'warning',
    warn: 'warning',
    warning: 'warning',
    inf: 'info',
    info: 'info',
    dbg: 'debug',
    debug: 'debug',
    trace: 'debug'
  };
  if (normalizedLevels[level]) return normalizedLevels[level];
  const text = String(message || '').toLowerCase();
  if (/\b(error|fatal|failed|failure|panic)\b/.test(text)) return 'error';
  if (/\b(warn|warning|timeout|retry)\b/.test(text)) return 'warning';
  if (/\b(debug|trace)\b/.test(text)) return 'debug';
  return 'info';
}

function renderAdvancedOverview() {
  if (!advancedSnapshot) return;
  const { status, paths, ping } = advancedSnapshot;
  const services = Object.entries(status?.connectionServiceStatus || {});
  const discovery = Object.keys(status?.discoveryStatus || {}).length || Number(status?.discoveryMethods || 0);
  const serviceErrors = services.filter(([, service]) => Boolean(service?.error));

  document.getElementById('advanced-runtime-uptime').innerText = formatDuration(status?.uptime);
  document.getElementById('advanced-runtime-workers').innerText = formatCount(status?.goroutines || 0);
  document.getElementById('advanced-runtime-heap').innerText = formatBytes(status?.alloc || 0);
  document.getElementById('advanced-runtime-discovery').innerText = formatCount(discovery);
  document.getElementById('advanced-service-count').innerText = `${formatCount(services.length)} ${services.length === 1 ? 'service' : 'services'}`;

  const badge = document.getElementById('advanced-overview-badge');
  if (ping?.ping !== 'pong') {
    badge.className = 'advanced-panel-badge error';
    badge.innerHTML = '<i></i>Unavailable';
  } else if (serviceErrors.length > 0) {
    badge.className = 'advanced-panel-badge warning';
    badge.innerHTML = `<i></i>${serviceErrors.length} degraded`;
  } else {
    badge.className = 'advanced-panel-badge healthy';
    badge.innerHTML = '<i></i>Healthy';
  }

  const serviceList = document.getElementById('advanced-service-list');
  serviceList.replaceChildren();
  if (services.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'advanced-empty-state';
    empty.innerText = 'No connection services were reported.';
    serviceList.appendChild(empty);
  } else {
    services.slice(0, 10).forEach(([name, service]) => {
      const row = document.createElement('div');
      row.className = `advanced-service-row${service?.error ? ' error' : ''}`;
      const dot = document.createElement('i');
      const copy = document.createElement('span');
      const title = document.createElement('b');
      title.innerText = name;
      const details = document.createElement('small');
      details.innerText = service?.error || [...(service?.lanAddresses || []), ...(service?.wanAddresses || [])][0] || 'Listening for connections';
      copy.append(title, details);
      const state = document.createElement('em');
      state.innerText = service?.error ? 'Degraded' : 'Healthy';
      row.append(dot, copy, state);
      serviceList.appendChild(row);
    });
  }

  const preferredPathKeys = ['config', 'database', 'baseDir-config', 'baseDir-data', 'certFile', 'keyFile', 'auditLog', 'defFolder'];
  const pathEntries = preferredPathKeys.filter(key => paths?.[key]).map(key => [key, paths[key]]);
  if (pathEntries.length === 0) {
    Object.entries(paths || {}).slice(0, 8).forEach(entry => pathEntries.push(entry));
  }
  const pathList = document.getElementById('advanced-path-list');
  pathList.replaceChildren();
  if (pathEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'advanced-empty-state';
    empty.innerText = 'System paths are unavailable.';
    pathList.appendChild(empty);
  } else {
    pathEntries.forEach(([key, path]) => {
      const row = document.createElement('div');
      row.className = 'advanced-path-row';
      const label = document.createElement('span');
      label.innerText = friendlyPathName(key);
      const code = document.createElement('code');
      code.innerText = path;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.innerText = 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(path);
          copy.innerText = 'Copied';
        } catch (error) {
          console.error('Could not copy system path:', error);
          copy.innerText = 'Failed';
        }
        window.setTimeout(() => { copy.innerText = 'Copy'; }, 1400);
      });
      row.append(label, code, copy);
      pathList.appendChild(row);
    });
  }
}

function visibleAdvancedLogs() {
  const logs = Array.isArray(advancedSnapshot?.logs?.messages) ? advancedSnapshot.logs.messages : [];
  const search = advancedLogSearch.trim().toLowerCase();
  return logs
    .map(entry => ({ ...entry, severity: classifyAdvancedLog(entry.message, entry.level) }))
    .filter(entry => advancedLogFilter === 'all' || entry.severity === advancedLogFilter)
    .filter(entry => !search || String(entry.message || '').toLowerCase().includes(search))
    .reverse();
}

function renderAdvancedLogs() {
  if (!advancedSnapshot) return;
  const logs = Array.isArray(advancedSnapshot.logs?.messages) ? advancedSnapshot.logs.messages : [];
  const visible = visibleAdvancedLogs();
  document.getElementById('advanced-log-count').innerText = formatCount(logs.length);
  const list = document.getElementById('advanced-logs');
  list.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'advanced-empty-state';
    empty.innerText = logs.length === 0 ? 'No system log messages are available.' : 'No log messages match this filter.';
    list.appendChild(empty);
    return;
  }
  visible.slice(0, 300).forEach(entry => {
    const row = document.createElement('div');
    row.className = `advanced-log-row ${entry.severity}`;
    const time = document.createElement('time');
    const date = validDeviceDate(entry.when);
    time.innerText = date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const level = document.createElement('span');
    level.className = 'advanced-log-level';
    level.innerText = entry.severity;
    const message = document.createElement('p');
    message.innerText = entry.message || 'Empty log message';
    row.append(time, level, message);
    list.appendChild(row);
  });
}

function renderAdvancedErrors() {
  if (!advancedSnapshot) return;
  const errors = Array.isArray(advancedSnapshot.errors?.errors) ? advancedSnapshot.errors.errors : [];
  const errorCount = document.getElementById('advanced-error-count');
  errorCount.innerText = formatCount(errors.length);
  errorCount.className = errors.length > 0 ? 'warning' : '';
  document.getElementById('advanced-clear-errors').disabled = errors.length === 0;
  const list = document.getElementById('advanced-error-list');
  list.replaceChildren();
  if (errors.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'advanced-empty-state';
    empty.innerText = 'No recent service errors. Everything looks healthy.';
    list.appendChild(empty);
    return;
  }
  [...errors].reverse().forEach(error => {
    const row = document.createElement('div');
    row.className = 'advanced-error-row';
    const icon = document.createElement('span');
    icon.className = 'advanced-error-icon';
    icon.innerText = '!';
    const copy = document.createElement('span');
    const message = document.createElement('b');
    message.innerText = error.message || 'Unknown system error';
    const relative = document.createElement('small');
    const date = validDeviceDate(error.when);
    relative.innerText = date ? formatRelativeTime(date) : 'Time unavailable';
    copy.append(message, relative);
    const time = document.createElement('time');
    time.innerText = date ? date.toLocaleString() : '—';
    row.append(icon, copy, time);
    list.appendChild(row);
  });
}

function renderAdvancedDebugLevels() {
  const list = document.getElementById('advanced-debug-list');
  if (!list) return;
  const levels = advancedSnapshot?.logLevels?.levels || {};
  const descriptions = advancedSnapshot?.logLevels?.packages || {};
  const search = advancedDebugSearch.trim().toLowerCase();
  const packages = Object.keys(levels).filter(name => `${name} ${descriptions[name] || ''}`.toLowerCase().includes(search));
  list.replaceChildren();
  if (packages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'advanced-empty-state';
    empty.innerText = Object.keys(levels).length === 0
      ? 'Facility-level controls are unavailable in this Syncthing build.'
      : 'No logging facilities match this search.';
    list.appendChild(empty);
    return;
  }

  packages.sort().forEach(name => {
    const row = document.createElement('label');
    row.className = 'advanced-debug-row';
    const copy = document.createElement('span');
    const title = document.createElement('b');
    title.innerText = name;
    const description = document.createElement('small');
    description.innerText = descriptions[name] || 'Syncthing subsystem';
    copy.append(title, description);
    const select = document.createElement('select');
    select.dataset.logFacility = name;
    ['DEBUG', 'INFO', 'WARN', 'ERROR'].forEach(level => {
      const option = document.createElement('option');
      option.value = level;
      option.innerText = level[0] + level.slice(1).toLowerCase();
      select.appendChild(option);
    });
    select.value = advancedLevelChanges[name] || String(levels[name] || 'INFO').toUpperCase();
    select.addEventListener('change', () => {
      if (select.value === String(levels[name] || 'INFO').toUpperCase()) delete advancedLevelChanges[name];
      else advancedLevelChanges[name] = select.value;
      document.getElementById('advanced-apply-levels').disabled = Object.keys(advancedLevelChanges).length === 0;
    });
    row.append(copy, select);
    list.appendChild(row);
  });
}

function renderAdvancedMaintenance() {
  if (!advancedSnapshot) return;
  const upgrade = advancedSnapshot.upgrade;
  const updateCopy = document.getElementById('advanced-update-copy');
  const install = document.getElementById('advanced-install-update');
  if (upgrade === undefined) {
    updateCopy.innerText = 'Run a check to look for a newer Syncthing release.';
    install.hidden = true;
  } else if (!upgrade) {
    updateCopy.innerText = 'Automatic update checks are unavailable in this build.';
    install.hidden = true;
  } else if (upgrade.newer) {
    updateCopy.innerText = `${upgrade.latest} is available; currently running ${upgrade.running}.`;
    install.hidden = false;
    install.innerText = `Install ${upgrade.latest}`;
  } else {
    updateCopy.innerText = `${upgrade.running || advancedSnapshot.version?.version || 'Current version'} is up to date.`;
    install.hidden = true;
  }
  const restartState = document.getElementById('advanced-restart-state');
  restartState.innerText = advancedSnapshot.restart?.requiresRestart ? 'Restart required' : 'No restart pending';
  restartState.classList.toggle('warning', Boolean(advancedSnapshot.restart?.requiresRestart));
}

function renderAdvancedSummary() {
  if (!advancedSnapshot) return;
  const { ping, status, version, errors } = advancedSnapshot;
  const healthy = ping?.ping === 'pong';
  const errorCount = Array.isArray(errors?.errors) ? errors.errors.length : 0;
  const live = document.getElementById('advanced-live-state');
  live.className = `advanced-live-state${healthy ? '' : ' offline'}`;
  live.querySelector('span').innerText = healthy ? 'Service online' : 'Service unavailable';
  document.getElementById('advanced-summary-health').innerText = healthy ? 'Healthy' : 'Unavailable';
  document.getElementById('advanced-summary-uptime').innerText = healthy ? `${formatDuration(status?.uptime)} uptime` : 'Could not reach the local API';
  document.getElementById('advanced-summary-version').innerText = version?.version || '—';
  document.getElementById('advanced-summary-platform').innerText = version ? `${version.os || 'unknown'} · ${version.arch || 'unknown'}` : 'Platform unavailable';
  document.getElementById('advanced-summary-memory').innerText = formatBytes(status?.alloc || 0);
  document.getElementById('advanced-summary-workers').innerText = `${formatCount(status?.goroutines || 0)} active workers`;
  document.getElementById('advanced-summary-errors').innerText = formatCount(errorCount);
  document.getElementById('advanced-summary-error-copy').innerText = errorCount === 0 ? 'No errors reported' : `${errorCount} ${errorCount === 1 ? 'issue needs' : 'issues need'} review`;
}

function renderAdvancedData() {
  renderAdvancedSummary();
  renderAdvancedOverview();
  renderAdvancedLogs();
  renderAdvancedErrors();
  renderAdvancedDebugLevels();
  renderAdvancedMaintenance();
}

async function loadAdvancedData() {
  if (advancedLoading) return;
  advancedLoading = true;
  const refreshButton = document.getElementById('advanced-refresh-btn');
  if (refreshButton) refreshButton.disabled = true;
  const previousUpgrade = advancedSnapshot?.upgrade;
  const [ping, status, version, paths, errors, logs, logLevels, restart] = await Promise.all([
    fetchAPI('/system/ping'),
    fetchAPI('/system/status'),
    fetchAPI('/system/version'),
    fetchAPI('/system/paths'),
    fetchAPI('/system/error'),
    fetchAPI('/system/log'),
    fetchAPI('/system/loglevels'),
    fetchAPI('/config/restart-required')
  ]);
  advancedSnapshot = { ping, status, version, paths, errors, logs, logLevels, upgrade: previousUpgrade, restart };
  advancedLevelChanges = {};
  document.getElementById('advanced-apply-levels').disabled = true;
  renderAdvancedData();
  advancedLoading = false;
  if (refreshButton) refreshButton.disabled = false;
}

async function refreshAdvancedActivity() {
  if (!advancedSnapshot || advancedLoading) return;
  const [logs, errors] = await Promise.all([fetchAPI('/system/log'), fetchAPI('/system/error')]);
  if (logs) advancedSnapshot.logs = logs;
  if (errors) advancedSnapshot.errors = errors;
  renderAdvancedSummary();
  renderAdvancedLogs();
  renderAdvancedErrors();
}

async function downloadSupportBundle() {
  const button = document.getElementById('advanced-support-bundle');
  const feedback = document.getElementById('advanced-action-feedback');
  button.disabled = true;
  button.innerText = 'Preparing…';
  feedback.innerText = 'Collecting diagnostics. This can take a few seconds…';
  try {
    const response = await fetch(`${API_URL}/debug/support`, { headers });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `syncthing-support-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    feedback.innerText = 'Support bundle downloaded.';
  } catch (error) {
    console.error('Could not download support bundle:', error);
    feedback.innerText = error.message || 'Could not create the support bundle.';
  }
  button.disabled = false;
  button.innerText = 'Download bundle';
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
  if (dbStatus.invalid || dbStatus.error || dbStatus.watchError || Number(dbStatus.errors || 0) > 0 || dbStatus.state === 'error') {
    return { key: 'attention', label: 'Error' };
  }

  const pendingItems = folderPendingItems(dbStatus);
  if (['syncing', 'sync-preparing', 'scanning', 'starting', 'scan-waiting', 'sync-waiting', 'cleaning', 'clean-waiting'].includes(dbStatus.state)) {
    return {
      key: 'syncing',
      label: dbStatus.state === 'scanning' ? 'Scanning' : 'Syncing'
    };
  }
  if (pendingItems > 0) return { key: 'attention', label: 'Out of sync' };
  if ((folder.devices || []).length <= 1) return { key: 'attention', label: 'Not shared' };
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
  const addFolderBrowse = document.getElementById('add-folder-browse');
  const addFolderPathState = document.getElementById('add-folder-path-state');
  const addFolderError = document.getElementById('add-folder-error');
  const addFolderSubmit = document.getElementById('add-folder-submit');
  const addDeviceModal = document.getElementById('add-device-modal');
  const addDeviceForm = document.getElementById('add-device-form');
  const addDeviceId = document.getElementById('add-device-id');
  const addDeviceName = document.getElementById('add-device-name');
  const addDeviceError = document.getElementById('add-device-error');
  const addDeviceSubmit = document.getElementById('add-device-submit');
  let folderIdEdited = false;

  const updateGeneratedFolderId = () => {
    if (folderIdEdited) return;
    addFolderId.value = addFolderLabel.value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  const resetFolderPathState = () => {
    addFolderPathState.classList.remove('selected');
    addFolderPathState.innerText = 'Select a folder stored on this device.';
  };

  const closeAddFolderModal = () => {
    addFolderModal.hidden = true;
    addFolderError.innerText = '';
  };

  const closeAddDeviceModal = () => {
    addDeviceModal.hidden = true;
    addDeviceError.innerText = '';
  };

  const openAddDeviceModal = () => {
    addDeviceForm.reset();
    document.getElementById('add-device-address').value = 'dynamic';
    document.getElementById('add-device-compression').value = 'metadata';
    addDeviceError.innerText = '';
    addDeviceSubmit.disabled = false;
    addDeviceSubmit.innerText = 'Add and connect';
    renderPendingDevices();
    renderDeviceFolderOptions();
    addDeviceModal.hidden = false;
    window.setTimeout(() => addDeviceId.focus(), 0);
  };

  document.getElementById('add-folder-btn')?.addEventListener('click', () => {
    addFolderForm.reset();
    folderIdEdited = false;
    resetFolderPathState();
    addFolderError.innerText = '';
    addFolderModal.hidden = false;
    window.setTimeout(() => addFolderLabel.focus(), 0);
  });

  document.getElementById('add-folder-close')?.addEventListener('click', closeAddFolderModal);
  document.getElementById('add-folder-cancel')?.addEventListener('click', closeAddFolderModal);
  addFolderModal?.addEventListener('click', event => {
    if (event.target === addFolderModal) closeAddFolderModal();
  });

  document.getElementById('add-device-btn')?.addEventListener('click', openAddDeviceModal);
  document.getElementById('device-empty-add')?.addEventListener('click', openAddDeviceModal);
  document.getElementById('add-device-close')?.addEventListener('click', closeAddDeviceModal);
  document.getElementById('add-device-cancel')?.addEventListener('click', closeAddDeviceModal);
  addDeviceModal?.addEventListener('click', event => {
    if (event.target === addDeviceModal) closeAddDeviceModal();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !addFolderModal.hidden) closeAddFolderModal();
    if (event.key === 'Escape' && !addDeviceModal.hidden) closeAddDeviceModal();
  });

  addFolderLabel?.addEventListener('input', () => {
    updateGeneratedFolderId();
  });
  addFolderId?.addEventListener('input', () => {
    folderIdEdited = addFolderId.value.length > 0;
  });

  addFolderBrowse?.addEventListener('click', async () => {
    if (!window.syncthingDesktop?.selectFolder) {
      addFolderError.innerText = 'Folder selection is available in the desktop app. You can still enter a path manually.';
      addFolderPath.focus();
      return;
    }

    addFolderBrowse.disabled = true;
    addFolderBrowse.querySelector('span').innerText = 'Choosing…';
    addFolderError.innerText = '';
    try {
      const selection = await window.syncthingDesktop.selectFolder();
      if (!selection?.canceled && selection?.path) {
        addFolderPath.value = selection.path;
        addFolderPathState.classList.add('selected');
        addFolderPathState.innerText = 'Selected from this device';

        if (!addFolderLabel.value.trim()) {
          const pathParts = selection.path.split(/[\\/]/).filter(Boolean);
          addFolderLabel.value = pathParts.at(-1) || 'Shared folder';
          updateGeneratedFolderId();
        }
      }
    } catch (error) {
      addFolderError.innerText = `Could not open the folder picker: ${error.message || error}`;
    } finally {
      addFolderBrowse.disabled = false;
      addFolderBrowse.querySelector('span').innerText = 'Choose folder';
    }
  });

  addFolderPath?.addEventListener('input', () => {
    addFolderPathState.classList.toggle('selected', Boolean(addFolderPath.value.trim()));
    addFolderPathState.innerText = addFolderPath.value.trim()
      ? 'Path ready to add'
      : 'Select a folder stored on this device.';
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

  addDeviceId?.addEventListener('input', () => {
    const normalized = normalizeDeviceID(addDeviceId.value);
    if (isValidDeviceID(normalized)) addDeviceId.value = normalized;
    addDeviceError.innerText = '';
  });
  addDeviceId?.addEventListener('blur', () => {
    addDeviceId.value = normalizeDeviceID(addDeviceId.value);
  });

  addDeviceForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const deviceID = normalizeDeviceID(addDeviceId.value);
    if (!isValidDeviceID(deviceID)) {
      addDeviceError.innerText = 'Enter a valid Syncthing Device ID with eight groups of seven characters.';
      addDeviceId.focus();
      return;
    }
    if (deviceID === localDeviceId) {
      addDeviceError.innerText = 'That is this device’s ID. Enter the ID shown on the other device.';
      return;
    }
    if (devicesViewData.some(item => item.device.deviceID === deviceID)) {
      addDeviceError.innerText = 'This device is already configured.';
      return;
    }

    addDeviceSubmit.disabled = true;
    addDeviceSubmit.innerText = 'Adding device…';
    addDeviceError.innerText = '';
    const defaults = await fetchAPI('/config/defaults/device') || {};
    const addresses = document.getElementById('add-device-address').value
      .split(/[\n,]+/)
      .map(address => address.trim())
      .filter(Boolean);
    const result = await postJSON('/config/devices', {
      ...defaults,
      deviceID,
      name: addDeviceName.value.trim() || 'Remote device',
      addresses: addresses.length ? addresses : ['dynamic'],
      compression: document.getElementById('add-device-compression').value,
      autoAcceptFolders: document.getElementById('add-device-auto-accept').checked,
      introducer: document.getElementById('add-device-introducer').checked,
      paused: false
    });

    if (!result.ok) {
      addDeviceError.innerText = result.error || 'Could not add this device.';
      addDeviceSubmit.disabled = false;
      addDeviceSubmit.innerText = 'Add and connect';
      return;
    }

    const selectedFolderIds = [...document.querySelectorAll('input[name="device-folder"]:checked')]
      .map(input => input.value);
    const sharingResults = [];
    for (const folderId of selectedFolderIds) {
      const folder = deviceFoldersSnapshot.find(item => item.id === folderId);
      const folderDevices = Array.isArray(folder?.devices) ? folder.devices : [];
      if (!folder || folderDevices.some(reference => reference.deviceID === deviceID)) {
        sharingResults.push({ ok: true });
        continue;
      }
      sharingResults.push(await requestJSON(`/config/folders/${encodeURIComponent(folderId)}`, 'PATCH', {
        devices: [...folderDevices, { deviceID }]
      }));
    }

    selectedDeviceId = deviceID;
    closeAddDeviceModal();
    await loadDevices();
    const sharingFailures = sharingResults.filter(item => !item.ok).length;
    if (sharingFailures > 0) {
      window.alert(`Device added, but ${sharingFailures} folder ${sharingFailures === 1 ? 'share' : 'shares'} could not be saved. You can retry from the Folders page.`);
    }
    addDeviceSubmit.disabled = false;
    addDeviceSubmit.innerText = 'Add and connect';
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

  document.querySelectorAll('[data-device-filter]').forEach(button => {
    button.addEventListener('click', () => {
      activeDeviceFilter = button.dataset.deviceFilter;
      document.querySelectorAll('[data-device-filter]').forEach(filterButton => {
        const isActive = filterButton === button;
        filterButton.classList.toggle('active', isActive);
        filterButton.setAttribute('aria-selected', String(isActive));
      });
      renderDeviceList();
      renderDeviceDetail();
    });
  });

  document.getElementById('device-search-input')?.addEventListener('input', event => {
    deviceSearchTerm = event.target.value;
    renderDeviceList();
    renderDeviceDetail();
  });

  document.getElementById('copy-local-device-id')?.addEventListener('click', async event => {
    if (!localDeviceId) return;
    const button = event.currentTarget;
    const originalLabel = button.innerText;
    try {
      await navigator.clipboard.writeText(localDeviceId);
      button.innerText = 'Copied';
    } catch (error) {
      console.error('Could not copy local device ID:', error);
      button.innerText = 'Copy failed';
    }
    window.setTimeout(() => { button.innerText = originalLabel; }, 1500);
  });

  document.getElementById('device-pause-btn')?.addEventListener('click', async event => {
    const selected = devicesViewData.find(item => item.device.deviceID === selectedDeviceId);
    if (!selected) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = selected.device.paused ? 'Resuming…' : 'Pausing…';
    const result = await requestJSON(`/config/devices/${encodeURIComponent(selected.device.deviceID)}`, 'PATCH', {
      paused: !selected.device.paused
    });
    if (!result.ok) window.alert(result.error || 'Could not update this device.');
    await loadDevices();
    button.disabled = false;
  });

  document.getElementById('device-remove-btn')?.addEventListener('click', async event => {
    const selected = devicesViewData.find(item => item.device.deviceID === selectedDeviceId);
    if (!selected) return;
    const confirmed = window.confirm(`Remove “${selected.name}” from Syncthing? It will no longer connect or sync shared folders.`);
    if (!confirmed) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = 'Removing…';
    const result = await requestJSON(`/config/devices/${encodeURIComponent(selected.device.deviceID)}`, 'DELETE');
    if (result.ok) {
      selectedDeviceId = null;
      await loadDevices();
    } else {
      window.alert(result.error || 'Could not remove this device.');
    }
    button.disabled = false;
    button.innerText = 'Remove';
  });

  document.querySelectorAll('[data-settings-panel]').forEach(button => {
    button.addEventListener('click', () => {
      const panelName = button.dataset.settingsPanel;
      document.querySelectorAll('[data-settings-panel]').forEach(navButton => {
        const active = navButton === button;
        navButton.classList.toggle('active', active);
        navButton.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-settings-section]').forEach(panel => {
        const active = panel.dataset.settingsSection === panelName;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
    });
  });

  document.getElementById('settings-form')?.addEventListener('input', () => {
    if (!settingsLoading) {
      document.getElementById('settings-form-error').innerText = '';
      setSettingsDirty(true);
    }
  });
  document.getElementById('settings-form')?.addEventListener('change', () => {
    if (!settingsLoading) {
      document.getElementById('settings-form-error').innerText = '';
      setSettingsDirty(true);
    }
  });
  document.getElementById('settings-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    await saveSettings();
  });
  document.getElementById('discard-settings-btn')?.addEventListener('click', async () => {
    await loadSettings();
  });
  document.getElementById('settings-toggle-api')?.addEventListener('click', event => {
    const apiInput = document.getElementById('setting-api');
    const show = apiInput.type === 'password';
    apiInput.type = show ? 'text' : 'password';
    event.currentTarget.innerText = show ? 'Hide' : 'Show';
  });
  document.getElementById('settings-copy-api')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const label = button.innerText;
    try {
      await navigator.clipboard.writeText(document.getElementById('setting-api').value);
      button.innerText = 'Copied';
    } catch (error) {
      console.error('Could not copy API key:', error);
      button.innerText = 'Copy failed';
    }
    window.setTimeout(() => { button.innerText = label; }, 1500);
  });
  document.getElementById('settings-restart-dismiss')?.addEventListener('click', () => {
    document.getElementById('settings-restart-banner').hidden = true;
  });

  document.querySelectorAll('[data-advanced-panel]').forEach(button => {
    button.addEventListener('click', () => {
      const panelName = button.dataset.advancedPanel;
      document.querySelectorAll('[data-advanced-panel]').forEach(navButton => {
        const active = navButton === button;
        navButton.classList.toggle('active', active);
        navButton.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-advanced-section]').forEach(panel => {
        const active = panel.dataset.advancedSection === panelName;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
    });
  });
  document.getElementById('advanced-refresh-btn')?.addEventListener('click', loadAdvancedData);
  document.getElementById('advanced-log-search')?.addEventListener('input', event => {
    advancedLogSearch = event.target.value;
    renderAdvancedLogs();
  });
  document.getElementById('advanced-log-filter')?.addEventListener('change', event => {
    advancedLogFilter = event.target.value;
    renderAdvancedLogs();
  });
  document.getElementById('advanced-copy-logs')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const original = button.innerText;
    const text = visibleAdvancedLogs()
      .slice(0, 300)
      .map(entry => `${entry.when || ''} [${entry.severity.toUpperCase()}] ${entry.message || ''}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      button.innerText = text ? 'Copied' : 'No logs';
    } catch (error) {
      console.error('Could not copy logs:', error);
      button.innerText = 'Copy failed';
    }
    window.setTimeout(() => { button.innerText = original; }, 1500);
  });
  document.getElementById('advanced-auto-refresh')?.addEventListener('change', event => {
    if (advancedAutoRefreshTimer) {
      window.clearInterval(advancedAutoRefreshTimer);
      advancedAutoRefreshTimer = null;
    }
    if (event.target.checked) {
      advancedAutoRefreshTimer = window.setInterval(refreshAdvancedActivity, 5000);
      refreshAdvancedActivity();
    }
  });
  document.getElementById('advanced-clear-errors')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = 'Clearing…';
    const success = await postAPI('/system/error/clear');
    if (success) await refreshAdvancedActivity();
    button.innerText = success ? 'Errors cleared' : 'Clear failed';
    window.setTimeout(() => {
      button.innerText = 'Clear all errors';
      button.disabled = !(advancedSnapshot?.errors?.errors || []).length;
    }, 1400);
  });
  document.getElementById('advanced-debug-search')?.addEventListener('input', event => {
    advancedDebugSearch = event.target.value;
    renderAdvancedDebugLevels();
  });
  document.getElementById('advanced-apply-levels')?.addEventListener('click', async event => {
    if (Object.keys(advancedLevelChanges).length === 0) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = 'Applying…';
    const result = await requestJSON('/system/loglevels', 'POST', advancedLevelChanges);
    if (result.ok) {
      const logLevels = await fetchAPI('/system/loglevels');
      if (logLevels) advancedSnapshot.logLevels = logLevels;
      advancedLevelChanges = {};
      renderAdvancedDebugLevels();
      button.innerText = 'Levels applied';
    } else {
      button.innerText = 'Apply failed';
      button.disabled = false;
    }
    window.setTimeout(() => {
      button.innerText = 'Apply levels';
      button.disabled = Object.keys(advancedLevelChanges).length === 0;
    }, 1500);
  });
  document.getElementById('advanced-support-bundle')?.addEventListener('click', downloadSupportBundle);
  document.getElementById('advanced-check-update')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = 'Checking…';
    const upgrade = await fetchAPI('/system/upgrade');
    if (advancedSnapshot) advancedSnapshot.upgrade = upgrade;
    renderAdvancedMaintenance();
    button.disabled = false;
    button.innerText = 'Check again';
  });
  document.getElementById('advanced-install-update')?.addEventListener('click', async event => {
    const latest = advancedSnapshot?.upgrade?.latest || 'the latest release';
    if (!window.confirm(`Install ${latest} and restart Syncthing? Active transfers will pause briefly.`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = 'Installing…';
    const success = await postAPI('/system/upgrade');
    document.getElementById('advanced-action-feedback').innerText = success
      ? 'Update requested. Syncthing will restart when installation completes.'
      : 'The update could not be started.';
    if (!success) {
      button.disabled = false;
      button.innerText = `Install ${latest}`;
    }
  });
  document.getElementById('advanced-restart-service')?.addEventListener('click', async event => {
    if (!window.confirm('Restart Syncthing now? Synchronization will pause briefly while the managed service restarts.')) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.innerText = 'Restarting…';
    const success = await postAPI('/system/restart');
    document.getElementById('advanced-action-feedback').innerText = success
      ? 'Restart requested. The service should be available again shortly.'
      : 'The restart request failed.';
    window.setTimeout(() => {
      button.disabled = false;
      button.innerText = 'Restart service';
      loadAdvancedData();
    }, 4500);
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
      if (targetId === 'view-advanced') loadAdvancedData();
      else if (advancedAutoRefreshTimer) {
        window.clearInterval(advancedAutoRefreshTimer);
        advancedAutoRefreshTimer = null;
        document.getElementById('advanced-auto-refresh').checked = false;
      }
      if (targetId === 'view-settings') loadSettings();
    });
  });
});
