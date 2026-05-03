import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { login } from '../lib/auth.js';
import { useTheme } from '../lib/theme.js';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)
  ? `${import.meta.env.VITE_API_URL as string}/api`
  : '/api';

interface BranchOption {
  branchId: number;
  branchName: string;
  roles: string[];
  isAllBranches: boolean;
}

// ── Step 1: credentials ───────────────────────────────────────────────────────
const credSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});
type CredForm = z.infer<typeof credSchema>;

interface LoginPageProps {
  onSuccess: (opts?: { mustChangePassword?: boolean; permissions?: string[] }) => void;
}

export default function LoginPage({ onSuccess }: LoginPageProps) {
  const { theme, toggleTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Two-step state
  const [step, setStep] = useState<'credentials' | 'branch'>('credentials');
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [savedCreds, setSavedCreds] = useState<{ username: string; password: string } | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<CredForm>({
    resolver: zodResolver(credSchema),
  });

  // ── Step 1: validate credentials, get branches ────────────────────────────
  const onCredSubmit = async (data: CredForm) => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/pre-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: data.username, password: data.password }),
        credentials: 'include',
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? 'Invalid credentials');
        return;
      }

      const availableBranches: BranchOption[] = body.branches ?? [];
      setSavedCreds({ username: data.username, password: data.password });

      if (availableBranches.length === 0) {
        setError('No branch access found for this account. Contact your administrator.');
        return;
      }

      // Auto-select if only one branch
      if (body.autoSelectBranchId) {
        await doLogin(data.username, data.password, body.autoSelectBranchId);
        return;
      }

      setBranches(availableBranches);
      setSelectedBranchId(availableBranches[0].branchId);
      setStep('branch');
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: complete login with selected branch ───────────────────────────
  const doLogin = async (username: string, password: string, branchId: number) => {
    setLoading(true);
    setError(null);
    try {
      const result = await login(username, password, branchId);
      onSuccess({ mustChangePassword: result.mustChangePassword, permissions: result.permissions });
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      if (e.code === 'BRANCH_ACCESS_DENIED') setError('You do not have access to the selected branch');
      else setError(e.message ?? 'Login failed');
      setStep('credentials');
    } finally {
      setLoading(false);
    }
  };

  const onBranchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!savedCreds || !selectedBranchId) return;
    await doLogin(savedCreds.username, savedCreds.password, selectedBranchId);
  };

  // ── Shared UI wrapper ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 dark:from-gray-950 dark:via-gray-900 dark:to-indigo-950 flex items-center justify-center relative overflow-hidden transition-colors duration-500">

      {/* Background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-blue-200 dark:bg-blue-900 rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-3xl opacity-40 animate-pulse-slow" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-indigo-200 dark:bg-indigo-900 rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-3xl opacity-40 animate-pulse-slow" style={{ animationDelay: '1.5s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-purple-100 dark:bg-purple-900 rounded-full mix-blend-multiply dark:mix-blend-screen filter blur-3xl opacity-30 animate-pulse-slow" style={{ animationDelay: '3s' }} />
      </div>

      {/* Theme toggle */}
      <button onClick={toggleTheme}
        className="absolute top-4 right-4 p-2.5 rounded-xl bg-white/70 dark:bg-gray-800/70 backdrop-blur-sm text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 shadow-sm transition-all duration-200"
        title="Toggle theme">
        {theme === 'dark' ? (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        )}
      </button>

      <div className="relative w-full max-w-md mx-4 animate-slide-down">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30 mb-4">
            <span className="text-white text-2xl font-bold">B</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Bookstore Management</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {step === 'credentials' ? 'Sign in to your workspace' : 'Select your working branch'}
          </p>
        </div>

        <div className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl rounded-2xl shadow-xl shadow-black/5 dark:shadow-black/30 border border-white/50 dark:border-gray-700/50 p-8">

          {/* ── Step 1: Credentials ── */}
          {step === 'credentials' && (
            <form onSubmit={handleSubmit(onCredSubmit)} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Username</label>
                <input {...register('username')} type="text" autoComplete="username" placeholder="Enter your username" autoFocus
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                {errors.username && <p className="text-red-500 dark:text-red-400 text-xs mt-1.5">{errors.username.message}</p>}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Password</label>
                <input {...register('password')} type="password" autoComplete="current-password" placeholder="Enter your password"
                  className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                {errors.password && <p className="text-red-500 dark:text-red-400 text-xs mt-1.5">{errors.password.message}</p>}
              </div>

              {error && (
                <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-sm text-red-700 dark:text-red-400">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading}
                className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl py-2.5 text-sm font-semibold shadow-md shadow-blue-500/20 hover:shadow-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200">
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Verifying...
                  </span>
                ) : 'Continue'}
              </button>
            </form>
          )}

          {/* ── Step 2: Branch selection ── */}
          {step === 'branch' && (
            <form onSubmit={onBranchSubmit} className="space-y-5">
              <div className="space-y-2">
                {branches.map(b => {
                  const isSelected = selectedBranchId === b.branchId;
                  return (
                    <button
                      key={b.branchId}
                      type="button"
                      onClick={() => setSelectedBranchId(b.branchId)}
                      className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all duration-150 ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
                          : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 hover:border-blue-300 dark:hover:border-blue-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                            {b.isAllBranches && <span className="text-amber-500">🌐</span>}
                            {b.branchName}
                          </p>
                          {b.roles.length > 0 && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {b.roles.join(' · ')}
                            </p>
                          )}
                        </div>
                        {isSelected && (
                          <span className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {error && (
                <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-sm text-red-700 dark:text-red-400">
                  {error}
                </div>
              )}

              <div className="flex gap-3">
                <button type="button" onClick={() => { setStep('credentials'); setError(null); }}
                  className="flex-1 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl py-2.5 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  ← Back
                </button>
                <button type="submit" disabled={loading || !selectedBranchId}
                  className="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-xl py-2.5 text-sm font-semibold shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200">
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Signing in...
                    </span>
                  ) : 'Sign In'}
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 dark:text-gray-600 mt-6">
          Bookstore ERP · Phase 0
        </p>
      </div>
    </div>
  );
}
