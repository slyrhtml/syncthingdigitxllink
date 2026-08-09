const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let mainWindow;
let syncthingProcess;

// We'll assume the binary is in the root directory for development
// In a real build, we'd copy it into the electron app resources folder.
const syncthingBinary = path.join(__dirname, '..', 'syncthing');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('http://127.0.0.1:8384');

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

function checkSyncthingHealth(callback) {
  const req = http.get('http://127.0.0.1:8384', (res) => {
    if (res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 401 || res.statusCode === 403) {
      callback(true);
    } else {
      callback(false);
    }
  });
  
  req.on('error', () => {
    callback(false);
  });
}

function waitForSyncthingAndStart() {
  const interval = setInterval(() => {
    checkSyncthingHealth((isHealthy) => {
      if (isHealthy) {
        clearInterval(interval);
        createWindow();
      }
    });
  }, 1000);
}

app.on('ready', () => {
  // Start Syncthing in the background
  // -no-browser prevents it from opening a default web browser
  // --home=./config isolates the configuration so we don't conflict with existing setups
  console.log(`Starting Syncthing from: ${syncthingBinary}`);
  syncthingProcess = spawn(syncthingBinary, ['--no-browser'], {
    stdio: 'inherit'
  });

  syncthingProcess.on('error', (err) => {
    console.error('Failed to start Syncthing process:', err);
  });

  syncthingProcess.on('exit', (code, signal) => {
    console.log(`Syncthing process exited with code ${code} and signal ${signal}`);
  });

  // Wait for the backend to start up, then show the UI
  waitForSyncthingAndStart();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    waitForSyncthingAndStart();
  }
});

app.on('before-quit', () => {
  // Ensure the background process is terminated when the app closes
  if (syncthingProcess) {
    console.log('Killing Syncthing background process...');
    syncthingProcess.kill('SIGINT');
  }
});
