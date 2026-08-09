const API_URL = 'http://127.0.0.1:8384/rest';
const API_KEY = 'electron-ui-key';

const headers = {
  'X-API-Key': API_KEY,
  'Content-Type': 'application/json'
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

async function loadDashboard() {
  const config = await fetchAPI('/system/config');
  const systemStatus = await fetchAPI('/system/status');
  const connections = await fetchAPI('/system/connections');
  
  if (!config || !systemStatus) return;

  // Update Top Metrics
  document.getElementById('metric-folders-count').innerText = config.folders.length;
  document.getElementById('metric-devices-count').innerText = config.devices.length;
  document.getElementById('metric-global-state').innerHTML = `<span class="unit">Online</span>`;
  
  if (connections) {
      document.getElementById('metric-up-rate').innerText = formatBytes(connections.total.outBytesTotal) + '/s';
      document.getElementById('metric-down-rate').innerText = formatBytes(connections.total.inBytesTotal) + '/s';
  }
  document.getElementById('metric-cpu').innerText = (systemStatus.cpuPercent || 0).toFixed(1) + '%';

  // We need to fetch DB status for all folders to get total data
  let totalData = 0;
  const foldersListEl = document.getElementById('folders-list');
  foldersListEl.innerHTML = ''; // Clear loading

  for (const folder of config.folders) {
    const dbStatus = await fetchAPI(`/db/status?folder=${folder.id}`);
    if (dbStatus) {
        totalData += dbStatus.globalBytes;
    }

    // Render Folder List Item
    const itemEl = document.createElement('div');
    itemEl.className = 'invoice-item';
    
    // Determine status (Idle vs Syncing)
    const isIdle = dbStatus?.state === 'idle';
    const statusClass = isIdle ? 'viewed' : 'unsent-white'; // mapped to our CSS classes
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

    // Click handler to load details
    itemEl.addEventListener('click', () => {
      document.getElementById('detail-title').innerText = folder.label || folder.id;
      document.getElementById('detail-status').innerText = statusText;
      document.getElementById('detail-id').innerText = folder.id;
      document.getElementById('detail-path').innerText = folder.path;
      document.getElementById('detail-global-size').innerText = formatBytes(dbStatus?.globalBytes);
      document.getElementById('detail-local-size').innerText = formatBytes(dbStatus?.localBytes);
      document.getElementById('detail-files').innerText = dbStatus?.globalFiles || 0;
      document.getElementById('detail-dirs').innerText = dbStatus?.globalDirectories || 0;
      
      const lastScan = dbStatus?.sequence > 0 ? new Date().toLocaleString() : 'Never';
      document.getElementById('detail-scanned').innerText = lastScan;
      
      // Update active state in UI
      document.querySelectorAll('.invoice-item').forEach(el => el.classList.remove('active'));
      itemEl.classList.add('active');
    });

    foldersListEl.appendChild(itemEl);
  }

  document.getElementById('metric-total-data').innerText = formatBytes(totalData);
}

// Initial load
document.addEventListener('DOMContentLoaded', loadDashboard);

// Refresh data every 5 seconds
setInterval(loadDashboard, 5000);
