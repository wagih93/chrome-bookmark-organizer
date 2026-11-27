export const MAX_LOG_ENTRIES = 160;

export function createLogEntry(level, message, timestamp = Date.now()) {
  const normalizedLevel = ["info", "success", "warning", "error"].includes(level)
    ? level
    : "info";
  return {
    timestamp,
    level: normalizedLevel,
    message: String(message).slice(0, 600)
  };
}

export function appendLogEntry(logs, entry) {
  return [...(Array.isArray(logs) ? logs : []), entry].slice(-MAX_LOG_ENTRIES);
}

export function formatLogEntry(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  return `[${time}] ${entry.message}`;
}
