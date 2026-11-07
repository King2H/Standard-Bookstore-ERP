/**
 * Whether the API is shutting down (#32, owner decision 3a): readiness then
 * answers 503 while requests already in progress finish.
 */
let shuttingDown = false;

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
