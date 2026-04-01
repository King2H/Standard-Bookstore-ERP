import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api } from '../lib/api.js';
import { getAccessToken } from '../lib/api.js';
import { useToast } from '../components/Toast.js';

interface Branch {
  id: number;
  name: string;
  address: string;
  contactInfo: { phone?: string; email?: string };
  isActive: boolean;
  createdAt: string;
}

const createSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  contactInfo: z.object({
    phone: z.string().optional(),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
  }),
  operatingHours: z.object({
    mon: z.string().default('09:00-18:00'),
    tue: z.string().default('09:00-18:00'),
    wed: z.string().default('09:00-18:00'),
    thu: z.string().default('09:00-18:00'),
    fri: z.string().default('09:00-18:00'),
    sat: z.string().default('10:00-16:00'),
    sun: z.string().default('closed'),
  }),
});

type CreateForm = z.infer<typeof createSchema>;

export default function BranchesPage({ userRole }: { userRole?: string }) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const { showToast } = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<{ items: Branch[]; total: number }>('/branches'),
    enabled: !!getAccessToken(), // only fetch when authenticated
    retry: false,
  });

  const createMutation = useMutation({
    mutationFn: (body: CreateForm) => api.post<Branch>('/branches', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      setShowForm(false);
      reset();
      setApiError(null);
      showToast('Branch created successfully');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      setApiError(e.message ?? 'Failed to create branch');
      showToast(e.message ?? 'Failed to create branch', 'error');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => api.post(`/branches/${id}/deactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      showToast('Branch deactivated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to deactivate branch', 'error');
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: number) => api.post(`/branches/${id}/reactivate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      showToast('Branch reactivated');
    },
    onError: (err: unknown) => {
      const e = err as { message?: string };
      showToast(e.message ?? 'Failed to reactivate branch', 'error');
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      address: '',
      contactInfo: { phone: '', email: '' },
      operatingHours: {
        mon: '09:00-18:00',
        tue: '09:00-18:00',
        wed: '09:00-18:00',
        thu: '09:00-18:00',
        fri: '09:00-18:00',
        sat: '10:00-16:00',
        sun: 'closed',
      },
    },
  });

  const onSubmit = (data: CreateForm) => {
    setApiError(null);
    createMutation.mutate(data);
  };

  const canCreateBranch = ['Super_Admin', 'Admin', 'Manager'].includes(userRole ?? '');

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Branches</h1>
        {canCreateBranch && (
          <button
            type="button"
            onClick={() => { setShowForm(!showForm); setApiError(null); }}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
          >
            {showForm ? 'Cancel' : '+ New Branch'}
          </button>
        )}
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="bg-white border border-gray-200 rounded-lg p-4 mb-6 space-y-3"
        >
          <h2 className="font-medium text-gray-800">Create Branch</h2>

          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
              {apiError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Name <span className="text-red-500">*</span>
              </label>
              <input
                {...register('name')}
                placeholder="e.g. Downtown Branch"
                className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {errors.name && (
                <p className="text-red-500 text-xs mt-1">{errors.name.message}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Address <span className="text-red-500">*</span>
              </label>
              <input
                {...register('address')}
                placeholder="e.g. 123 Main St, City"
                className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {errors.address && (
                <p className="text-red-500 text-xs mt-1">{errors.address.message}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input
                {...register('contactInfo.phone')}
                placeholder="e.g. 555-0100"
                className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input
                {...register('contactInfo.email')}
                type="email"
                placeholder="e.g. branch@store.com"
                className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {errors.contactInfo?.email && (
                <p className="text-red-500 text-xs mt-1">{errors.contactInfo.email.message}</p>
              )}
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={createMutation.isPending || isSubmitting}
              className="bg-blue-600 text-white px-4 py-2 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Branch'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); reset(); setApiError(null); }}
              className="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm font-medium hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading branches...</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Address</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.items.map((branch) => (
                <tr key={branch.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{branch.name}</td>
                  <td className="px-4 py-3 text-gray-600">{branch.address}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        branch.isActive
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {branch.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {branch.isActive ? (
                      <button
                        type="button"
                        onClick={() => deactivateMutation.mutate(branch.id)}
                        disabled={deactivateMutation.isPending}
                        className="text-red-600 hover:text-red-800 text-xs disabled:opacity-50"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => reactivateMutation.mutate(branch.id)}
                        disabled={reactivateMutation.isPending}
                        className="text-green-600 hover:text-green-800 text-xs disabled:opacity-50"
                      >
                        Reactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(!data?.items || data.items.length === 0) && (
            <p className="text-center text-gray-500 text-sm py-8">No branches found</p>
          )}
        </div>
      )}
    </div>
  );
}
