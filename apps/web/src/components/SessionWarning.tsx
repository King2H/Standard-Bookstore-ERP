/**
 * SessionWarning — modal shown 1 minute before inactivity logout.
 * Disappears automatically if the user moves the mouse / types.
 */
import { useEffect, useState } from 'react';
import { resetInactivityTimer } from '../lib/session.js';

interface SessionWarningProps {
  secondsLeft: number;   // 0 = hidden, >0 = show with countdown
  onStayLoggedIn: () => void;
  onLogoutNow: () => void;
}

export default function SessionWarning({ secondsLeft, onStayLoggedIn, onLogoutNow }: SessionWarningProps) {
  const [displayed, setDisplayed] = useState(secondsLeft);

  // Tick the local countdown every second while visible
  useEffect(() => {
    if (secondsLeft <= 0) { setDisplayed(0); return; }
    setDisplayed(secondsLeft);
    const id = setInterval(() => {
      setDisplayed(prev => {
        if (prev <= 1) { clearInterval(id); return 0; }
        return prev - 1;
      });
    }, 1_000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  if (secondsLeft <= 0) return null;

  const mins = Math.floor(displayed / 60);
  const secs = displayed % 60;
  const timeStr = mins > 0
    ? `${mins}:${String(secs).padStart(2, '0')}`
    : `${secs}s`;

  const handleStay = () => {
    resetInactivityTimer();
    onStayLoggedIn();
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-warning-title"
    >
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 w-full max-w-sm mx-4 text-center">
        {/* Icon */}
        <div className="w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>

        <h2 id="session-warning-title" className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
          Session expiring soon
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
          You've been inactive. Your session will end in
        </p>

        {/* Countdown */}
        <div className="text-3xl font-bold text-amber-600 dark:text-amber-400 mb-5 tabular-nums">
          {timeStr}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onLogoutNow}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-colors"
          >
            Log out now
          </button>
          <button
            onClick={handleStay}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm"
            autoFocus
          >
            Stay logged in
          </button>
        </div>
      </div>
    </div>
  );
}
