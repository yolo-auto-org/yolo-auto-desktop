const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 2_000_000;

function createLogger(userDataDir) {
  const logPath = path.join(userDataDir, 'app.log');

  return function log(level, event, details = {}) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      rotateLogIfNeeded(logPath);
      const entry = {
        ts: new Date().toISOString(),
        level,
        event,
        details
      };
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      console.error('Failed to write app log:', error.message || error);
    }
  };
}

function rotateLogIfNeeded(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_BYTES) return;

    const archivePath = `${logPath}.1`;
    fs.rmSync(archivePath, { force: true });
    fs.renameSync(logPath, archivePath);
  } catch {
    // Missing log files or rotation errors should not break the app.
  }
}

module.exports = {
  createLogger
};
