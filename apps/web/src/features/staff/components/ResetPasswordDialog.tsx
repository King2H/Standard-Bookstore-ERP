import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { PasswordSchema } from '@bms/shared';
import { inputCls } from './styles.js';

const ResetSchema = z.object({ temporaryPassword: PasswordSchema });
type ResetValues = z.infer<typeof ResetSchema>;

/**
 * Sets a temporary password, typed hidden and checked with the API's password
 * rules before it is sent (was: the browser's prompt, in plain text, unchecked).
 */
export function ResetPasswordDialog({ username, busy, onSubmit, onCancel }: {
  username: string;
  busy: boolean;
  onSubmit: (temporaryPassword: string) => void;
  onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<ResetValues>({
    resolver: zodResolver(ResetSchema),
    defaultValues: { temporaryPassword: '' },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <form role="dialog" aria-labelledby="reset-password-title" onSubmit={handleSubmit((v) => onSubmit(v.temporaryPassword))}
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 max-w-sm w-full mx-4 shadow-xl">
        <h3 id="reset-password-title" className="text-base font-semibold text-gray-900 dark:text-white mb-2">Reset password for {username}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">They sign in with this temporary password and must change it straight away.</p>
        <label htmlFor="temporary-password" className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Temporary password</label>
        <input id="temporary-password" type="password" autoComplete="new-password" autoFocus {...register('temporaryPassword')} className={inputCls} />
        <p className={`text-xs mt-1 ${errors.temporaryPassword ? 'text-red-500' : 'text-gray-400 dark:text-gray-500'}`}>
          {errors.temporaryPassword?.message ?? 'At least 10 characters, with upper-case, lower-case, a digit and a special character'}
        </p>
        <div className="flex gap-2 justify-end mt-4">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors">Cancel</button>
          <button type="submit" disabled={busy} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors">{busy ? 'Resetting...' : 'Reset Password'}</button>
        </div>
      </form>
    </div>
  );
}
