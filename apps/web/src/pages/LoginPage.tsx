import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { login } from '../lib/auth.js';

interface BranchOption { id: number; name: string }

const schema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  branchId: z.coerce.number().int().positive('Please select a branch'),
});

type FormData = z.infer<typeof schema>;

interface LoginPageProps {
  onSuccess: () => void;
}

export default function LoginPage({ onSuccess }: LoginPageProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);

  // Fetch branches without auth — public endpoint
  useEffect(() => {
    fetch('/api/branches/public')
      .then(r => r.json())
      .then(data => {
        setBranches(data.items ?? []);
        setBranchesLoading(false);
      })
      .catch(() => setBranchesLoading(false));
  }, []);

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    setError(null);
    setLoading(true);
    try {
      await login(data.username, data.password, data.branchId);
      onSuccess();
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string };
      if (e.code === 'INVALID_CREDENTIALS') {
        setError('Invalid username or password');
      } else if (e.code === 'ACCOUNT_INACTIVE') {
        setError('This account has been deactivated');
      } else if (e.code === 'BRANCH_ACCESS_DENIED') {
        setError('You do not have access to the selected branch');
      } else {
        setError(e.message ?? 'Login failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-md p-8 w-full max-w-md">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Bookstore Management</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to your account</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              {...register('username')}
              type="text"
              autoComplete="username"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {errors.username && <p className="text-red-500 text-xs mt-1">{errors.username.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              {...register('password')}
              type="password"
              autoComplete="current-password"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {errors.password && <p className="text-red-500 text-xs mt-1">{errors.password.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
            {branchesLoading ? (
              <div className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-400">
                Loading branches...
              </div>
            ) : (
              <select
                {...register('branchId')}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">Select a branch...</option>
                {branches.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}
            {errors.branchId && <p className="text-red-500 text-xs mt-1">{errors.branchId.message}</p>}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || branchesLoading}
            className="w-full bg-blue-600 text-white rounded-md py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
