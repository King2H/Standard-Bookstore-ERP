/**
 * WelcomeBanner — top-of-dashboard banner with the shop's name and motto,
 * subtle slide-in animation, and a dismiss button.
 *
 * The name and motto are the shop's own settings (#228, owner decision 3a;
 * was: one shop's name for every shop). With no name set it says "Welcome",
 * and shows Super_Admin, who sets it, where.
 *
 * Behavior:
 * - Dismissed state is stored in sessionStorage so it doesn't re-trigger on
 *   every navigation within the same session, but resets on next login.
 * - Animation is a one-shot slide-in from the left (CSS keyframe via Tailwind
 *   arbitrary value). No aggressive looping.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMyProfile } from '../features/account/queries.js';
import { useShopIdentity } from '../features/settings/queries.js';

const SESSION_KEY = 'bms_banner_dismissed';

export default function WelcomeBanner() {
  const { data: shop } = useShopIdentity();
  const { data: me } = useMyProfile();
  const canSetName = me?.currentRoles.includes('Super_Admin') ?? false;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
  });

  if (dismissed) return null;

  const handleDismiss = () => {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <div
      className="relative overflow-hidden border-b border-blue-100 dark:border-blue-900/50 bg-linear-to-r from-blue-50 via-indigo-50 to-purple-50 dark:from-blue-950/40 dark:via-indigo-950/40 dark:to-purple-950/40 px-5 py-2.5 flex items-center gap-3 shrink-0"
      style={{ animation: 'bms-slide-in 0.5s ease-out both' }}
    >
      {/* Decorative background circles */}
      <div className="absolute -right-8 -top-8 w-32 h-32 rounded-full bg-blue-100/50 dark:bg-blue-900/20 pointer-events-none" />
      <div className="absolute -right-2 -bottom-6 w-20 h-20 rounded-full bg-indigo-100/50 dark:bg-indigo-900/20 pointer-events-none" />

      {/* Book icon with gentle pulse */}
      <div
        className="shrink-0 w-8 h-8 rounded-lg bg-white dark:bg-gray-900 shadow-xs border border-blue-100 dark:border-blue-900/50 flex items-center justify-center text-lg"
        style={{ animation: 'bms-pulse-soft 3s ease-in-out infinite' }}
        aria-hidden="true"
      >
        📚
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <h2 className="text-sm font-bold text-gray-900 dark:text-white leading-tight whitespace-nowrap">
          {shop?.name ? `Welcome to ${shop.name}` : 'Welcome'}
        </h2>
        {shop?.motto && (
          <>
            <span className="text-gray-300 dark:text-gray-600 hidden sm:inline">·</span>
            <p className="text-sm text-blue-700 dark:text-blue-300 font-medium hidden sm:block">{shop.motto}</p>
          </>
        )}
        {shop && !shop.name && canSetName && (
          <Link to="/settings" className="text-xs font-semibold text-blue-700 dark:text-blue-300 hover:underline">
            Set your shop's name in Settings → Shop
          </Link>
        )}
      </div>

      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-white/60 dark:hover:bg-gray-800/60 transition-colors"
        aria-label="Dismiss banner"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Keyframe styles injected inline — avoids needing a CSS file */}
      <style>{`
        @keyframes bms-slide-in {
          from { opacity: 0; transform: translateX(-24px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes bms-pulse-soft {
          0%, 100% { transform: scale(1); }
          50%       { transform: scale(1.06); }
        }
      `}</style>
    </div>
  );
}
