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
  const addDeviceModal = document.getElementById('add-device-modal');
  const addDeviceForm = document.getElementById('add-device-form');
  const addDeviceId = document.getElementById('add-device-id');
  const addDeviceName = document.getElementById('add-device-name');
  const addDeviceError = document.getElementById('add-device-error');
  const addDeviceSubmit = document.getElementById('add-device-submit');
  let folderIdEdited = false;

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
    const sharingResults = await Promise.all(selectedFolderIds.map(folderId => {
      const folder = deviceFoldersSnapshot.find(item => item.id === folderId);
      const folderDevices = Array.isArray(folder?.devices) ? folder.devices : [];
      if (!folder || folderDevices.some(reference => reference.deviceID === deviceID)) return Promise.resolve({ ok: true });
      return requestJSON(`/config/folders/${encodeURIComponent(folderId)}`, 'PATCH', {
        devices: [...folderDevices, { deviceID }]
      });
    }));

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
