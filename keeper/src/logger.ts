export function logInfo(message: string, details?: Record<string, unknown>) {
  const payload = {
    level: "info",
    ts: new Date().toISOString(),
    message,
    ...(details ?? {}),
  };
  console.log(JSON.stringify(payload));
}

export function logWarn(message: string, details?: Record<string, unknown>) {
  const payload = {
    level: "warn",
    ts: new Date().toISOString(),
    message,
    ...(details ?? {}),
  };
  console.warn(JSON.stringify(payload));
}

export function logError(message: string, details?: Record<string, unknown>) {
  const payload = {
    level: "error",
    ts: new Date().toISOString(),
    message,
    ...(details ?? {}),
  };
  console.error(JSON.stringify(payload));
}
