const API_URL = 'http://127.0.0.1:8384/rest';
const API_KEY = 'electron-ui-key';

const headers = {
  'X-API-Key': API_KEY,
  'Content-Type': 'application/json'
};

let transferChart = null;
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

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function initChart() {
  const ctx = document.getElementById('transferChart');
  if (!ctx) return;
  transferChart = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: {
        x: { display: false },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888' } }
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
    document.getElementById('dash-cpu').innerText = (systemStatus.cpuPercent || 0).toFixed(1) + '%';
    document.getElementById('dash-ram').innerText = formatBytes(systemStatus.sys);
    const hours = Math.floor(systemStatus.uptime / 3600);
    const mins = Math.floor((systemStatus.uptime % 3600) / 60);
    document.getElementById('dash-uptime').innerText = `${hours}h ${mins}m`;
  }

  if (connections) {
    document.getElementById('dash-up').innerText = formatBytes(connections.total.outBytesTotal);
    document.getElementById('dash-down').innerText = formatBytes(connections.total.inBytesTotal);
    
    // Update Chart
    if (transferChart) {
      chartData.datasets[0].data.shift();
      chartData.datasets[0].data.push(connections.total.outBytesTotal);
      chartData.datasets[1].data.shift();
      chartData.datasets[1].data.push(connections.total.inBytesTotal);
      transferChart.update();
    }
  }
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

// Legacy Folders Logic (Original)
async function loadFolders() {
  const config = await fetchAPI('/system/config');
  const systemStatus = await fetchAPI('/system/status');
  const connections = await fetchAPI('/system/connections');
  if (!config || !systemStatus) return;

  document.getElementById('metric-folders-count').innerText = config.folders.length;
  document.getElementById('metric-devices-count').innerText = config.devices.length;
  document.getElementById('metric-global-state').innerHTML = `<span class="unit">Online</span>`;
  
  if (connections) {
      document.getElementById('metric-up-rate').innerText = formatBytes(connections.total.outBytesTotal) + '/s';
      document.getElementById('metric-down-rate').innerText = formatBytes(connections.total.inBytesTotal) + '/s';
  }
  document.getElementById('metric-cpu').innerText = (systemStatus.cpuPercent || 0).toFixed(1) + '%';

  let totalData = 0;
  const foldersListEl = document.getElementById('folders-list');
  foldersListEl.innerHTML = '';
  
  for (const folder of config.folders) {
    const dbStatus = await fetchAPI(`/db/status?folder=${folder.id}`);
    if (dbStatus) totalData += dbStatus.globalBytes;

    const itemEl = document.createElement('div');
    itemEl.className = 'invoice-item';
    const isIdle = dbStatus?.state === 'idle';
    const statusClass = isIdle ? 'viewed' : 'unsent-white';
    const statusText = dbStatus?.state ? dbStatus.state.charAt(0).toUpperCase() + dbStatus.state.slice(1) : 'Unknown';

    itemEl.innerHTML = `
      <img src="https://ui-avatars.com/api/?name=${folder.label || folder.id}&background=random" class="item-av">
      <div class="item-id-date">
        <span class="id">${folder.label || folder.id}</span>
        <span class="date" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${folder.path}</span>
      </div>
      <span class="status ${statusClass}">${statusText}</span>
      <span class="amount">${formatBytes(dbStatus?.globalBytes)}</span>
    `;

    itemEl.addEventListener('click', () => {
      document.getElementById('detail-title').innerText = folder.label || folder.id;
      document.getElementById('detail-status').innerText = statusText;
      document.getElementById('detail-id').innerText = folder.id;
      document.getElementById('detail-path').innerText = folder.path;
      document.getElementById('detail-global-size').innerText = formatBytes(dbStatus?.globalBytes);
      document.getElementById('detail-local-size').innerText = formatBytes(dbStatus?.localBytes);
      document.getElementById('detail-files').innerText = dbStatus?.globalFiles || 0;
      document.getElementById('detail-dirs').innerText = dbStatus?.globalDirectories || 0;
      document.getElementById('detail-scanned').innerText = dbStatus?.sequence > 0 ? new Date().toLocaleString() : 'Never';
      
      document.querySelectorAll('.invoice-item').forEach(el => el.classList.remove('active'));
      itemEl.classList.add('active');
    });

    foldersListEl.appendChild(itemEl);
  }
  document.getElementById('metric-total-data').innerText = formatBytes(totalData);
}

// Master Loop
async function tick() {
  await updateDashboardData();
  const activeView = document.querySelector('.view-content.active').id;
  if (activeView === 'view-folders') await loadFolders();
  if (activeView === 'view-devices') await loadDevices();
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  loadSettings();
  loadAdvancedLogs();
  tick(); // Initial fetch
  setInterval(tick, 3000); // Poll every 3 seconds

  // Routing
  const navItems = document.querySelectorAll('.nav-item[data-target]');
  const views = document.querySelectorAll('.view-content');

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
      if (targetId === 'view-devices') loadDevices();
      if (targetId === 'view-advanced') loadAdvancedLogs();
      if (targetId === 'view-settings') loadSettings();
    });
  });
});
