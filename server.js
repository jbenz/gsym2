const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const os = require('os');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static('public'));

// ========================================
// CONFIGURATION
// ========================================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'production';

const DASHBOARD_TITLE = process.env.DASHBOARD_TITLE || 'GSYM Dashboard';
const DASHBOARD_HEADER_TEXT = process.env.DASHBOARD_HEADER_TEXT || 'Real-time Ethereum Node Monitoring';
const DASHBOARD_FOOTER_TEXT = process.env.DASHBOARD_FOOTER_TEXT || 'Powered by GSYM';
const HOSTNAME = process.env.HOSTNAME || os.hostname();
const COLOR_THEME = (process.env.DASHBOARD_COLOR_THEME || 'slate').toLowerCase();
const ENABLE_EXTERNAL_IP = process.env.ENABLE_EXTERNAL_IP === 'true';

const PRYSM_SERVICE = process.env.PRYSM_SERVICE || 'prysm';
const GETH_SERVICE = process.env.GETH_SERVICE || 'geth';
const GETH_CONN_REPORTING = (process.env.GETH_CONN_REPORTING || 'lsof').toLowerCase();
const PEER_CACHE_TTL = parseInt(process.env.PEER_CACHE_TTL || '3');

// Validate color theme
const VALID_THEMES = ['slate', 'blue', 'red', 'orange'];
const THEME = VALID_THEMES.includes(COLOR_THEME) ? COLOR_THEME : 'slate';

// Theme color mappings
const THEME_COLORS = {
  slate: {
    primary: '#667eea',
    primaryHover: '#5568d3',
    primaryActive: '#4952bc',
    gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    accent: '#667eea'
  },
  blue: {
    primary: '#3b82f6',
    primaryHover: '#2563eb',
    primaryActive: '#1d4ed8',
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #1e40af 100%)',
    accent: '#0ea5e9'
  },
  red: {
    primary: '#ef4444',
    primaryHover: '#dc2626',
    primaryActive: '#b91c1c',
    gradient: 'linear-gradient(135deg, #ef4444 0%, #991b1b 100%)',
    accent: '#f87171'
  },
  orange: {
    primary: '#f97316',
    primaryHover: '#ea580c',
    primaryActive: '#c2410c',
    gradient: 'linear-gradient(135deg, #f97316 0%, #b45309 100%)',
    accent: '#fb923c'
  }
};

const CURRENT_THEME = THEME_COLORS[THEME];

// In-memory cache for peer count and iostat
const cache = {};
const getCached = (key) => {
  const entry = cache[key];
  if (entry && Date.now() - entry.time < PEER_CACHE_TTL * 1000) {
    return entry.value;
  }
  return null;
};
const setCache = (key, value) => {
  cache[key] = { value, time: Date.now() };
};

// ========================================
// UTILITY FUNCTIONS
// ========================================

const parseNum = (val, def = 0) => {
  const n = parseFloat(val);
  return isNaN(n) ? def : n;
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
};

const parseETAToHours = (etaStr) => {
  if (!etaStr) return 'computing...';
  let hours = 0, minutes = 0;
  const hMatch = etaStr.match(/(\d+)h/);
  if (hMatch) hours = parseInt(hMatch[1]);
  const mMatch = etaStr.match(/(\d+)m/);
  if (mMatch) minutes = parseInt(mMatch[1]);
  return `${hours}h ${minutes}m`;
};

const extractKVPairs = (logLine) => {
  const pairs = {};
  const regex = /(\w+)=([^\s]+)/g;
  let match;
  while ((match = regex.exec(logLine)) !== null) {
    let value = match[2].replace(/[,;]$/, '');
    pairs[match[1]] = value;
  }
  return pairs;
};

const execCmd = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    console.error(`Command failed: ${cmd}`, err.message);
    return '';
  }
};

// Get internal IP address
const getInternalIP = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
};

// Get external IP address
const getExternalIP = async () => {
  if (!ENABLE_EXTERNAL_IP) return null;
  try {
    const services = [
      'https://api.ipify.org?format=json',
      'https://api.my-ip.io/ip'
    ];
    for (const service of services) {
      try {
        const response = await fetch(service, { timeout: 2000 });
        if (response.ok) {
          const data = await response.json();
          return data.ip || null;
        }
      } catch (e) {
        // Try next service
      }
    }
  } catch (err) {
    console.error('External IP detection error:', err.message);
  }
  return null;
};

// Geth peer count methods
const getGethPeerCountLsof = () => {
  try {
    const cached = getCached('gethPeers');
    if (cached !== null) return cached;
    const gethPid = execCmd('pgrep -f "geth" | head -1').trim();
    if (!gethPid) return 0;
    const lsofOutput = execCmd(
      `timeout 2 lsof -p ${gethPid} 2>/dev/null | grep ESTABLISHED | wc -l`
    );
    const peerCount = parseInt(lsofOutput.trim()) || 0;
    setCache('gethPeers', peerCount);
    return peerCount;
  } catch (err) {
    console.error('lsof peer count error:', err.message);
    return 0;
  }
};

const getGethPeerCountNetstat = () => {
  try {
    const cached = getCached('gethPeers');
    if (cached !== null) return cached;
    const gethPid = execCmd('pgrep -f "geth" | head -1').trim();
    if (!gethPid) return 0;
    const output = execCmd(
      `timeout 1 ss -tpn 2>/dev/null | grep geth | grep ESTAB | wc -l`
    );
    const peerCount = parseInt(output.trim()) || 0;
    setCache('gethPeers', peerCount);
    return peerCount;
  } catch (err) {
    console.error('netstat peer count error:', err.message);
    return 0;
  }
};

const getGethPeerCountFromLogs = (gethLogs) => {
  const peerMatches = gethLogs.match(/peers[=:\s]*(\d+)/gi);
  if (peerMatches && peerMatches.length > 0) {
    const latestMatch = peerMatches[peerMatches.length - 1];
    const peerNum = latestMatch.match(/(\d+)/);
    if (peerNum) return parseInt(peerNum[1]);
  }
  return 0;
};

// ========================================
// API ENDPOINTS
// ========================================

app.get('/api/config', (req, res) => {
  res.json({
    title: DASHBOARD_TITLE,
    headerText: DASHBOARD_HEADER_TEXT,
    footerText: DASHBOARD_FOOTER_TEXT,
    hostname: HOSTNAME,
    theme: THEME,
    themeColors: CURRENT_THEME,
    internalIP: getInternalIP(),
    environment: NODE_ENV
  });
});

app.get('/api/eth-node-stats', async (req, res) => {
  try {
    const stats = {
      geth: {},
      prysm: {},
      system: {},
      network: {},
      errors: [],
      meta: {
        gethConnReporting: GETH_CONN_REPORTING,
        hostname: HOSTNAME,
        theme: THEME,
        timestamp: new Date().toISOString()
      }
    };

    stats.network.internalIP = getInternalIP();
    if (ENABLE_EXTERNAL_IP) {
      stats.network.externalIP = await getExternalIP();
    }

    // ===== GETH STATS =====
    try {
      const gethLogs = execCmd(
        `journalctl -u ${GETH_SERVICE} -n 1000 --no-pager 2>/dev/null || journalctl -u ${GETH_SERVICE} -n 1000 2>/dev/null`
      );
      
      const chainSyncLines = gethLogs.match(/Syncing: chain download in progress.*/gi) || [];
      const stateSyncLines = gethLogs.match(/Syncing: state download in progress.*/gi) || [];
      
      let chainSync = 0, chainETA = 'computing...';
      let stateSync = 0, stateETA = 'computing...';
      
      if (chainSyncLines.length > 0) {
        const latestChain = chainSyncLines[chainSyncLines.length - 1];
        const chainPairs = extractKVPairs(latestChain);
        if (chainPairs.synced) chainSync = parseFloat(chainPairs.synced.replace('%', ''));
        if (chainPairs.eta) chainETA = parseETAToHours(chainPairs.eta);
      }
      
      if (stateSyncLines.length > 0) {
        const latestState = stateSyncLines[stateSyncLines.length - 1];
        const statePairs = extractKVPairs(latestState);
        if (statePairs.synced) stateSync = parseFloat(statePairs.synced.replace('%', ''));
        if (statePairs.eta) stateETA = parseETAToHours(statePairs.eta);
      }
      
      stats.geth.chainSync = chainSync;
      stats.geth.stateSync = stateSync;
      stats.geth.overallProgress = Math.min(chainSync, stateSync);
      stats.geth.chainETA = chainETA;
      stats.geth.stateETA = stateETA;
      
      const forkchoiceLines = gethLogs.match(/Forkchoice requested sync to new head.*/gi) || [];
      let blocks = 0;
      if (forkchoiceLines.length > 0) {
        const latestFC = forkchoiceLines[forkchoiceLines.length - 1];
        const fcPairs = extractKVPairs(latestFC);
        if (fcPairs.number) blocks = parseInt(fcPairs.number.replace(/,/g, ''));
      }
      
      let peers = 0;
      if (GETH_CONN_REPORTING === 'netstat') {
        peers = getGethPeerCountNetstat();
      } else if (GETH_CONN_REPORTING === 'lsof') {
        peers = getGethPeerCountLsof();
      } else {
        peers = getGethPeerCountFromLogs(gethLogs);
      }
      
      stats.geth.peers = peers;
      stats.geth.blocks = blocks;
      stats.geth.blocksFormatted = blocks.toLocaleString();
      stats.geth.status = (chainSync < 100 || stateSync < 100) ? 'SYNCING' : 'SYNCED';
      stats.geth.synced = (chainSync >= 100 && stateSync >= 100);
      
      const errorLines = gethLogs.match(/(ERROR|WARN).*$/gim) || [];
      errorLines.slice(0, 5).forEach(err => {
        stats.errors.push({
          service: 'Geth',
          level: err.includes('ERROR') ? 'ERROR' : 'WARN',
          message: err.substring(0, 120)
        });
      });
      
    } catch (err) {
      console.error('Geth parsing error:', err.message);
      stats.geth = {
        chainSync: 0, stateSync: 0, overallProgress: 0,
        chainETA: 'error', stateETA: 'error',
        peers: 0, blocks: 0, blocksFormatted: '0', status: 'ERROR', synced: false
      };
    }

    // ===== PRYSM STATS =====
    try {
      const prysmLogs = execCmd(
        `journalctl -u ${PRYSM_SERVICE} -n 2000 --no-pager 2>/dev/null || journalctl -u ${PRYSM_SERVICE} -n 2000 2>/dev/null`
      );
      
      let slot = 0, epoch = 0, peers = 0;
      let quicIn = 0, quicOut = 0, tcpIn = 0, tcpOut = 0;
      
      const syncedLines = prysmLogs.match(/Synced new block.*/gi) || [];
      if (syncedLines.length > 0) {
        const latestSynced = syncedLines[syncedLines.length - 1];
        const syncPairs = extractKVPairs(latestSynced);
        if (syncPairs.slot) slot = parseInt(syncPairs.slot);
        if (syncPairs.epoch) epoch = parseInt(syncPairs.epoch);
      }
      
      const peerLines = prysmLogs.match(/Connected peers.*/gi) || [];
      if (peerLines.length > 0) {
        const latestPeers = peerLines[peerLines.length - 1];
        const peerPairs = extractKVPairs(latestPeers);
        
        if (peerPairs.total) peers = parseInt(peerPairs.total);
        if (peerPairs.inboundQUIC) quicIn = parseInt(peerPairs.inboundQUIC);
        if (peerPairs.outboundQUIC) quicOut = parseInt(peerPairs.outboundQUIC);
        if (peerPairs.inboundTCP) tcpIn = parseInt(peerPairs.inboundTCP);
        if (peerPairs.outboundTCP) tcpOut = parseInt(peerPairs.outboundTCP);
      }
      
      stats.prysm.slot = slot;
      stats.prysm.slotFormatted = slot.toLocaleString();
      stats.prysm.epoch = epoch;
      stats.prysm.epochFormatted = epoch.toLocaleString();
      stats.prysm.peers = peers;
      stats.prysm.connections = { quicIn, quicOut, tcpIn, tcpOut };
      stats.prysm.status = 'ACTIVE';
      
      const prysmErrorLines = prysmLogs.match(/level=error.*/gi) || [];
      prysmErrorLines.slice(0, 5).forEach(err => {
        stats.errors.push({
          service: 'Prysm',
          level: 'ERROR',
          message: err.substring(0, 120)
        });
      });
      
    } catch (err) {
      console.error('Prysm parsing error:', err.message);
      stats.prysm = {
        slot: 0, slotFormatted: '0', epoch: 0, epochFormatted: '0', peers: 0,
        connections: { quicIn: 0, quicOut: 0, tcpIn: 0, tcpOut: 0 },
        status: 'ERROR'
      };
    }

    // ===== SYSTEM STATS =====
    try {
      const memTotal = os.totalmem();
      const memFree = os.freemem();
      const memUsed = memTotal - memFree;
      const memPercent = Math.round((memUsed / memTotal) * 100);
      
      stats.system.memory = memPercent;
      stats.system.memoryUsed = formatBytes(memUsed);
      stats.system.memoryTotal = formatBytes(memTotal);
      stats.system.memoryUsedBytes = memUsed;
      stats.system.memoryTotalBytes = memTotal;
      
      try {
        const dfOutput = execCmd('df -k / 2>/dev/null || df /');
        const lines = dfOutput.split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          if (parts.length >= 5) {
            const total = parseInt(parts[1]) * 1024;
            const used = parseInt(parts[2]) * 1024;
            const diskPercent = Math.round((used / total) * 100);
            stats.system.disk = diskPercent;
            stats.system.diskUsed = formatBytes(used);
            stats.system.diskTotal = formatBytes(total);
            stats.system.diskUsedBytes = used;
            stats.system.diskTotalBytes = total;
          }
        }
      } catch (e) {
        stats.system.disk = 0;
        stats.system.diskUsed = 'N/A';
        stats.system.diskTotal = 'N/A';
      }
      
      const loadavg = os.loadavg();
      stats.system.loadAvg1 = loadavg[0].toFixed(2);
      stats.system.loadAvg5 = loadavg[1].toFixed(2);
      stats.system.loadAvg15 = loadavg[2].toFixed(2);
      stats.system.cpuCores = os.cpus().length;
      
      const uptime = os.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);
      stats.system.uptime = `${days}d ${hours}h ${minutes}m ${seconds}s`;
      stats.system.uptimeShort = `${days}d ${hours}h`;
      stats.system.uptimeSeconds = uptime;
      
      const iostat = parseIOStat();
      if (iostat) {
        stats.system.iostat = {
          cpu: {
            user: iostat.cpu.user.toFixed(2),
            nice: iostat.cpu.nice.toFixed(2),
            system: iostat.cpu.system.toFixed(2),
            iowait: iostat.cpu.iowait.toFixed(2),
            steal: iostat.cpu.steal.toFixed(2),
            idle: iostat.cpu.idle.toFixed(2)
          },
          devices: iostat.devices.map(d => ({
            name: d.name,
            tps: d.tps.toFixed(2),
            kbReadSec: d.kbReadSec.toFixed(2),
            kbWriteSec: d.kbWriteSec.toFixed(2),
            kbDiscSec: d.kbDiscSec.toFixed(2),
            totalKbRead: d.totalKbRead.toLocaleString(),
            totalKbWrite: d.totalKbWrite.toLocaleString(),
            totalKbDisc: (d.totalKbDisc || 0).toLocaleString()
          }))
        };
      }
      
    } catch (err) {
      console.error('System stats error:', err.message);
    }

    stats.errors = stats.errors.slice(0, 10);

    if (NODE_ENV === 'development') {
      console.log(`[${new Date().toISOString()}] API Response:`, JSON.stringify(stats, null, 2));
    }

    res.json(stats);
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: 'Failed to fetch node stats',
      message: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ========================================
// SERVER STARTUP
// ========================================

app.listen(PORT, HOST, () => {
  console.log(`\n📊 GSYM Ethereum Node Monitor`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌐 Dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`📡 API: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/api/eth-node-stats`);
  console.log(`💾 Config:`);
  console.log(`   • Title: ${DASHBOARD_TITLE}`);
  console.log(`   • Hostname: ${HOSTNAME}`);
  console.log(`   • Theme: ${THEME}`);
  console.log(`   • Geth Reporting: ${GETH_CONN_REPORTING}`);
  console.log(`   • External IP: ${ENABLE_EXTERNAL_IP ? 'enabled' : 'disabled'}`);
  console.log(`   • Environment: ${NODE_ENV}`);
  console.log(`\n`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
