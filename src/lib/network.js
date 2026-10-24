'use strict';

const os = require('os');

function isPrivateIPv4(address) {
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  const match = address.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function getLocalAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      addresses.push({
        name,
        address: entry.address,
        private: isPrivateIPv4(entry.address),
      });
    }
  }
  addresses.sort((a, b) => {
    if (a.private !== b.private) return a.private ? -1 : 1;
    return a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
  const seen = new Set();
  return addresses.filter((item) => {
    if (seen.has(item.address)) return false;
    seen.add(item.address);
    return true;
  });
}

function getNetworkInfo(port) {
  const addresses = getLocalAddresses();
  return {
    hostname: os.hostname(),
    port,
    addresses,
    lanUrls: addresses.map((item) => `http://${item.address}:${port}`),
    localhost: `http://localhost:${port}`,
  };
}

module.exports = { getLocalAddresses, getNetworkInfo };
