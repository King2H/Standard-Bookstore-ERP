import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ReferenceNameRequestSchema, type Category } from '@bms/shared';
import { Drawer } from '../../../shared/components/Drawer.js';
import { SearchPicker } from '../../../shared/components/SearchPicker.js';
import { searchCategories, type ReferenceKind } from '../api.js';
import { isParentChoice } from '../rules.js';

/** The form's fields, checked with the rules of the API's contract. */
const ReferenceFormSchema = z.object({
  name: ReferenceNameRequestSchema.shape.name,
  parent: z.object({ id: z.number().int(), label: z.string() }).nullable(),
});
type ReferenceFormValues = z.infer<typeof ReferenceFormSchema>;

export interface ReferenceFormSave { name: string; parentId: number | null }

const INPUT = 'w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500';
const BUTTON = 'flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';

/** Adds or edits an author, category or publisher; a category also has a parent. */
export function ReferenceForm({ kind, noun, placeholder, editing, saving, error, onSave, onClose }: {
  kind: ReferenceKind;
  /** "Author", "Category" or "Publisher". */
  noun: string;
  placeholder: string;
  editing: { id: number; name: string; parentId?: number | null; parentName?: string | null } | null;
  saving: boolean;
  /** What the API refused, if it did. */
  error: string;
  onSave: (values: ReferenceFormSave) => void;
  onClose: () => void;
}) {
  const { register, control, handleSubmit, formState: { errors } } = useForm<ReferenceFormValues>({
    resolver: zodResolver(ReferenceFormSchema),
    defaultValues: {
      name: editing?.name ?? '',
      parent: editing?.parentId ? { id: editing.parentId, label: editing.parentName ?? '' } : null,
    },
  });
  const submit = handleSubmit((v) => onSave({ name: v.name.trim(), parentId: v.parent?.id ?? null }));
  const shown = errors.name?.message ?? error;
  const editingId = editing?.id ?? null;

  return (
    <Drawer title={editing ? `Edit ${noun}` : `New ${noun}`} onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className={`${BUTTON} border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300`}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={saving} className={`${BUTTON} bg-blue-600 hover:bg-blue-700 text-white`}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        {shown && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{shown}</p>}
        <div>
          <label htmlFor="reference-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{noun} Name *</label>
          <input id="reference-name" {...register('name')} placeholder={placeholder} aria-invalid={!!errors.name || undefined} className={INPUT} />
        </div>
        {kind === 'categories' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Parent Category (optional)</label>
            <Controller
              control={control}
              name="parent"
              render={({ field }) => (
                <SearchPicker
                  aria-label="Parent Category"
                  value={field.value}
                  onChange={field.onChange}
                  // The choices depend on the category being edited.
                  queryKey={`categories:parent-of-${editingId ?? 'new'}`}
                  search={async (q) => (await searchCategories(q)).items
                    .filter((c: Category) => isParentChoice(c, editingId))
                    .map((c) => ({ id: c.id, label: c.name }))}
                  placeholder="Top level — type to search…"
                  className={INPUT}
                />
              )}
            />
          </div>
        )}
      </form>
    </Drawer>
  );
}
