import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StaffRole { branchId: number; branchName?: string; role: string }

interface MyProfile {
  id: number;
  username: string;
  fullName: string;
  isActive: boolean;
  createdAt: string;
  roles: StaffRole[];
  currentRole: string;
  currentBranchId: number;
  mustChangePassword?: boolean;
  lastLoginAt?: string | null;
  passwordChangedAt?: string | null;
  isLocked?: boolean;
}

// ── Password change schema ────────────────────────────────────────────────────

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(10, 'Min 10 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[a-z]/, 'Must contain a lowercase letter')
    .regex(/\d/, 'Must contain a digit')
    .regex(/[^A-Za-z\d]/, 'Must contain a special character'),
  confirmPassword: z.string().min(1, 'Please confirm your new password'),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

type PasswordForm = z.infer<typeof passwordSchema>;

// ── Role badge colours (same as Layout) ──────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  Super_Admin:     'bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200',
  Admin:           'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200',
  Manager:         'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200',
  Finance_Officer: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-200',
  Stock_Clerk:     'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200',
  Sales:           'bg-pink-100 dark:bg-pink-900/40 text-pink-800 dark:text-pink-200',
  Purchasor:       'bg-teal-100 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200',
};

const inputCls = 'w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors';

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { showToast } = useToast();
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  // ── Fetch own profile ──────────────────────────────────────────────────────

  const { data: profile, isLoading } = useQuery({
    queryKey: ['my-profile'],
    queryFn: () => api.get<MyProfile>('/staff/me'),
    enabled: !!getAccessToken(),
    staleTime: 60_000,
  });

  // ── Password change mutation ───────────────────────────────────────────────

  const passwordMutation = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.put('/staff/me/password', body),
    onSuccess: () => {
      showToast('Password updated successfully');
      setShowPasswordForm(false);
      reset();
    },
    onError: (err: unknown) => {
      const e = err as { message?: string; code?: string };
      if (e.code === 'INVALID_CURRENT_PASSWORD') {
        showToast('Current password is incorrect', 'error');
      } else {
        showToast(e.message ?? 'Failed to update password', 'error');
      }
    },
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
  });

  const onSubmit = (data: PasswordForm) => {
    passwordMutation.mutate({
      currentPassword: data.currentPassword,
      newPassword: data.newPassword,
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-gray-500 dark:text-gray-400 text-sm">
        <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Loading profile...
      </div>
    );
  }

  if (!profile) return null;

  return (
    <div className="p-6 max-w-2xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">My Profile</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Your account details and security settings</p>
      </div>

      {/* Must-change-password banner */}
      {profile.mustChangePassword && (
        <div className="mb-4 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-700 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-yellow-500 text-lg flex-shrink-0">⚠</span>
          <div>
            <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">Password reset required</p>
            <p className="text-xs text-yellow-700 dark:text-yellow-400 mt-0.5">
              An administrator has reset your password. Please change it now before continuing.
            </p>
          </div>
        </div>
      )}

      {/* Profile card */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden mb-6">

        {/* Avatar + name header */}
        <div className="px-6 py-5 border-b border-gray-100 dark:border-gray-800 flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-md">
            <span className="text-white text-xl font-bold">
              {profile.fullName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">{profile.fullName}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">@{profile.username}</p>
          </div>
          <div className="ml-auto">
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${ROLE_COLORS[profile.currentRole] ?? 'bg-gray-100 text-gray-700'}`}>
              {profile.currentRole}
            </span>
          </div>
        </div>

        {/* Details grid */}
        <div className="px-6 py-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Username</p>
            <p className="text-sm text-gray-900 dark:text-white font-mono">{profile.username}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Account Status</p>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
              profile.isActive
                ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-400'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
            }`}>
              {profile.isActive ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Member Since</p>
            <p className="text-sm text-gray-900 dark:text-white">
              {new Date(profile.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Staff ID</p>
            <p className="text-sm text-gray-900 dark:text-white font-mono">#{profile.id}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Last Login</p>
            <p className="text-sm text-gray-900 dark:text-white">
              {profile.lastLoginAt
                ? new Date(profile.lastLoginAt).toLocaleString()
                : 'Never'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-0.5">Password Last Changed</p>
            <p className="text-sm text-gray-900 dark:text-white">
              {profile.passwordChangedAt
                ? new Date(profile.passwordChangedAt).toLocaleDateString()
                : 'Never changed'}
            </p>
          </div>
        </div>

        {/* Branch & Role assignments */}
        <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Branch & Role Assignments</p>
          {profile.roles.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">No assignments</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {profile.roles.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5">
                  <span className="text-xs text-gray-600 dark:text-gray-400">{r.branchName ?? `Branch ${r.branchId}`}</span>
                  <span className="text-gray-300 dark:text-gray-600">·</span>
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${ROLE_COLORS[r.role] ?? 'bg-gray-100 text-gray-700'}`}>
                    {r.role}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Security section */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Security</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Manage your password</p>
          </div>
          {!showPasswordForm && (
            <button
              onClick={() => setShowPasswordForm(true)}
              className="text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded-lg font-medium transition-colors"
            >
              Change Password
            </button>
          )}
        </div>

        {showPasswordForm ? (
          <form onSubmit={handleSubmit(onSubmit)} className="px-6 py-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                Current Password <span className="text-red-500">*</span>
              </label>
              <input
                {...register('currentPassword')}
                type="password"
                autoComplete="current-password"
                placeholder="Enter your current password"
                className={inputCls}
              />
              {errors.currentPassword && (
                <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.currentPassword.message}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                New Password <span className="text-red-500">*</span>
              </label>
              <input
                {...register('newPassword')}
                type="password"
                autoComplete="new-password"
                placeholder="Min 10 chars, upper, lower, digit, special"
                className={inputCls}
              />
              {errors.newPassword && (
                <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.newPassword.message}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5">
                Confirm New Password <span className="text-red-500">*</span>
              </label>
              <input
                {...register('confirmPassword')}
                type="password"
                autoComplete="new-password"
                placeholder="Re-enter new password"
                className={inputCls}
              />
              {errors.confirmPassword && (
                <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.confirmPassword.message}</p>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={passwordMutation.isPending || isSubmitting}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {passwordMutation.isPending ? 'Updating...' : 'Update Password'}
              </button>
              <button
                type="button"
                onClick={() => { setShowPasswordForm(false); reset(); }}
                className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div>
                <p className="text-sm text-gray-900 dark:text-white font-medium">Password</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Last changed: {profile.passwordChangedAt
                    ? new Date(profile.passwordChangedAt).toLocaleDateString()
                    : 'Never changed'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
