/**
 * Session management — inactivity timeout + warning.
 *
 * Rules:
 * - On app load: always attempt session restore via refresh token cookie
 * - After login: start 15-min inactivity timer
 * - Page refresh with valid session: restore session, restart timer from now
 * - 15 min idle: auto-logout
 * - 14 min idle: show "Session expiring soon" warning
 * - Any activity (mouse/key/scroll/API call): reset timer
 * - Explicit logout: stop timer, clear storage
 */
import { setActivityNotifier } from './api.js';

// Wire API calls as activity — done at module load, no circular dep
setActivityNotifier(() => {
  // Only notify if the timer is actually running (user is logged in)
  if (pollTimer !== null) notifyActivity();
});

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutes
const WARNING_BEFORE_MS     =  1 * 60 * 1000;  //  1 minute warning
const POLL_INTERVAL_MS      = 30 * 1000;        // check every 30s
const STORAGE_KEY           = 'bms_last_activity';

type LogoutCallback  = () => void;
type WarningCallback = (secondsLeft: number) => void;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let onLogout:  LogoutCallback  | null = null;
let onWarning: WarningCallback | null = null;
let warningShown = false;

// ── Activity tracking ─────────────────────────────────────────────────────────

export function notifyActivity(): void {
  sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
  if (warningShown && onWarning) {
    warningShown = false;
    onWarning(0); // dismiss warning
  }
}

function getLastActivity(): number {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  // If nothing stored, treat as active right now (safe default)
  return stored ? parseInt(stored, 10) : Date.now();
}

// ── DOM event listeners ───────────────────────────────────────────────────────

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'] as const;

function handleActivity() {
  notifyActivity();
}

function attachListeners() {
  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, handleActivity, { passive: true });
  }
}

function detachListeners() {
  for (const event of ACTIVITY_EVENTS) {
    window.removeEventListener(event, handleActivity);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

function tick() {
  const idle = Date.now() - getLastActivity();

  if (idle >= INACTIVITY_TIMEOUT_MS) {
    stopInactivityTimer();
    onLogout?.();
    return;
  }

  const timeLeft = INACTIVITY_TIMEOUT_MS - idle;
  if (timeLeft <= WARNING_BEFORE_MS && !warningShown) {
    warningShown = true;
    onWarning?.(Math.ceil(timeLeft / 1000));
  } else if (timeLeft > WARNING_BEFORE_MS && warningShown) {
    warningShown = false;
    onWarning?.(0);
  } else if (warningShown) {
    // Update countdown every poll
    onWarning?.(Math.ceil(timeLeft / 1000));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the inactivity timer. Call this after successful login or session restore.
 * Stamps activity NOW so the 15-min clock starts from this moment.
 */
export function startInactivityTimer(
  logoutCb: LogoutCallback,
  warningCb: WarningCallback,
): void {
  // Stop any existing timer first
  stopInactivityTimer();

  onLogout  = logoutCb;
  onWarning = warningCb;
  warningShown = false;

  // Stamp activity NOW — timer starts from login/restore, not from page load
  notifyActivity();

  attachListeners();
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

/**
 * Stop the inactivity timer and clean up. Call on logout.
 */
export function stopInactivityTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  detachListeners();
  onLogout     = null;
  onWarning    = null;
  warningShown = false;
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Manually reset the inactivity timer (e.g. from "Stay logged in" button).
 */
export function resetInactivityTimer(): void {
  notifyActivity();
}
