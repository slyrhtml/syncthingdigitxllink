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
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(dateString) {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    return date.toLocaleString();
}

async function loadDashboard() {
  const config = await fetchAPI('/system/config');
  const systemStatus = await fetchAPI('/system/status');
  
  if (!config || !systemStatus) return;

  // Update Top Metrics
  document.getElementById('global-state').innerText = 'Online';
  document.getElementById('total-folders').innerText = config.folders.length;
  document.getElementById('connected-devices').innerText = config.devices.length;

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
    itemEl.className = 'list-item';
    
    // Determine status (Idle vs Syncing)
    const isIdle = dbStatus?.state === 'idle';
    const statusClass = isIdle ? 'idle' : 'syncing';
    const statusText = dbStatus?.state ? dbStatus.state.charAt(0).toUpperCase() + dbStatus.state.slice(1) : 'Unknown';

    itemEl.innerHTML = `
      <div class="item-icon">📁</div>
      <div class="item-info">
        <h4>${folder.label || folder.id}</h4>
        <p>${folder.path}</p>
      </div>
      <div class="item-size">${formatBytes(dbStatus?.globalBytes)}</div>
      <div class="item-status ${statusClass}">${statusText}</div>
    `;

    // Click handler to load details
    itemEl.addEventListener('click', () => {
      document.getElementById('detail-title').innerText = folder.label || folder.id;
      document.getElementById('detail-status').innerText = statusText;
      document.getElementById('detail-path').innerText = folder.path;
      document.getElementById('detail-size').innerText = formatBytes(dbStatus?.globalBytes);
      document.getElementById('detail-scanned').innerText = formatTime(dbStatus?.sequence > 0 ? new Date() : null); // Mocked time for now
      document.getElementById('detail-local').innerText = formatBytes(dbStatus?.localBytes);
      
      // Remove active state from all items, add to current
      document.querySelectorAll('.list-item').forEach(el => el.style.borderColor = '#f0f0f0');
      itemEl.style.borderColor = 'var(--accent-color)';
    });

    foldersListEl.appendChild(itemEl);
  }

  document.getElementById('total-data').innerText = formatBytes(totalData);
}

// Initial load
document.addEventListener('DOMContentLoaded', loadDashboard);

// Refresh data every 5 seconds
setInterval(loadDashboard, 5000);
