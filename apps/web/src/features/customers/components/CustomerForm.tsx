import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { CreateCustomerRequest, Customer } from '@bms/shared';

/** The form's fields, checked with the rules of the API's customer contract. */
const CustomerFormSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  phone: z.string().trim(),
  email: z.union([z.literal(''), z.email('Enter a valid email address')]),
  gender: z.string(),
  dateOfBirth: z.string(),
  address: z.string().trim(),
  city: z.string().trim(),
});
type CustomerFormValues = z.infer<typeof CustomerFormSchema>;

const blank: CustomerFormValues = { fullName: '', phone: '', email: '', gender: '', dateOfBirth: '', address: '', city: '' };

function valuesOf(c: Customer | null): CustomerFormValues {
  if (!c) return blank;
  return {
    fullName: c.fullName, phone: c.phone ?? '', email: c.email ?? '', gender: c.gender ?? '',
    dateOfBirth: c.dateOfBirth ?? '', address: c.address ?? '', city: c.city ?? '',
  };
}

/** What to send: every field, an empty one as null, so it is cleared. */
const requestOf = (v: CustomerFormValues): CreateCustomerRequest => ({
  fullName: v.fullName, phone: v.phone || null, email: v.email || null, gender: v.gender || null,
  dateOfBirth: v.dateOfBirth || null, address: v.address || null, city: v.city || null,
});

const INPUT = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 disabled:opacity-60';
const LABEL = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

/** A customer's details, for a new customer or an existing one. */
export function CustomerForm({ customer, disabled = false, className, onSubmit, children }: {
  customer: Customer | null;
  disabled?: boolean;
  className: string;
  onSubmit: (body: CreateCustomerRequest) => void;
  /** The buttons. */
  children?: React.ReactNode;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CustomerFormValues>({
    resolver: zodResolver(CustomerFormSchema),
    values: valuesOf(customer),
  });
  const id = (name: string) => `customer-${customer?.id ?? 'new'}-${name}`;
  const problem = errors.fullName?.message ?? errors.email?.message;

  return (
    <form onSubmit={handleSubmit((v) => onSubmit(requestOf(v)))} className={className} noValidate>
      {problem && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{problem}</p>}
      <div><label htmlFor={id('name')} className={LABEL}>Full Name *</label>
        <input id={id('name')} {...register('fullName')} disabled={disabled} aria-invalid={errors.fullName ? true : undefined} className={INPUT} /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label htmlFor={id('phone')} className={LABEL}>Phone</label>
          <input id={id('phone')} {...register('phone')} disabled={disabled} className={INPUT} /></div>
        <div><label htmlFor={id('email')} className={LABEL}>Email</label>
          <input id={id('email')} type="email" {...register('email')} disabled={disabled} aria-invalid={errors.email ? true : undefined} className={INPUT} /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label htmlFor={id('gender')} className={LABEL}>Gender</label>
          <select id={id('gender')} {...register('gender')} disabled={disabled} className={INPUT}>
            <option value="">Select...</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option>
          </select></div>
        <div><label htmlFor={id('dob')} className={LABEL}>Date of Birth</label>
          <input id={id('dob')} type="date" {...register('dateOfBirth')} disabled={disabled} className={INPUT} /></div>
      </div>
      <div><label htmlFor={id('address')} className={LABEL}>Address</label>
        <input id={id('address')} {...register('address')} disabled={disabled} className={INPUT} /></div>
      <div><label htmlFor={id('city')} className={LABEL}>City</label>
        <input id={id('city')} {...register('city')} disabled={disabled} className={INPUT} /></div>
      {children}
    </form>
  );
}
