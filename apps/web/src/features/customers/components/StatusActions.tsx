import type { Customer } from '@bms/shared';
import { useToast } from '../../../components/Toast.js';
import type { CustomerAction } from '../api.js';
import { useCustomerAction } from '../queries.js';

const DONE: Record<CustomerAction, string> = {
  deactivate: 'Customer deactivated', activate: 'Customer activated', archive: 'Customer archived', restore: 'Customer restored',
};
/** Asked before an action runs; the others run straight away. */
const CONFIRM: Partial<Record<CustomerAction, (name: string) => string>> = {
  deactivate: (name) => `Deactivate "${name}"?`,
  archive: (name) => `Archive "${name}"?`,
};

/**
 * The status changes a customer allows, by the shared lifecycle rule: active
 * and inactive switch, either can be archived, an archived one is restored
 * (was: Deactivate only, with no way back).
 */
export function StatusActions({ customer, compact = false }: { customer: Customer; compact?: boolean }) {
  const { showToast } = useToast();
  const actions: Record<CustomerAction, ReturnType<typeof useCustomerAction>> = {
    deactivate: useCustomerAction('deactivate'),
    activate: useCustomerAction('activate'),
    archive: useCustomerAction('archive'),
    restore: useCustomerAction('restore'),
  };
  const offered: CustomerAction[] = customer.status === 'ARCHIVED' ? ['restore']
    : customer.status === 'ACTIVE' ? ['deactivate', 'archive'] : ['activate', 'archive'];

  function run(action: CustomerAction) {
    const question = CONFIRM[action];
    if (question && !confirm(question(customer.fullName))) return;
    actions[action].mutate(customer.id, {
      onSuccess: () => showToast(DONE[action], 'success'),
      onError: (e: Error) => showToast(e.message, 'error'),
    });
  }

  const style: Record<CustomerAction, string> = compact ? {
    deactivate: 'text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950',
    activate: 'text-green-600 hover:bg-green-50 dark:hover:bg-green-950',
    archive: 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800',
    restore: 'text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950',
  } : {
    deactivate: 'text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-950 border-yellow-300 dark:border-yellow-700',
    activate: 'text-green-600 hover:bg-green-50 dark:hover:bg-green-950 border-green-300 dark:border-green-700',
    archive: 'text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 border-gray-300 dark:border-gray-600',
    restore: 'text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 border-blue-300 dark:border-blue-700',
  };
  const label = (a: CustomerAction) => a.charAt(0).toUpperCase() + a.slice(1);

  return (
    <>
      {offered.map((a) => (
        <button key={a} type="button" disabled={actions[a].isPending} onClick={() => run(a)}
          className={compact
            ? `px-2 py-1 rounded-sm transition-colors disabled:opacity-50 ${style[a]}`
            : `text-sm px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${style[a]}`}>
          {label(a)}
        </button>
      ))}
    </>
  );
}
