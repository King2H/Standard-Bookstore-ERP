import { useState } from 'react';
import type { Customer } from '@bms/shared';
import { CustomerList } from '../components/CustomerList.js';
import { CustomerProfile } from '../components/CustomerProfile.js';

/** Customers: the list, and one customer's profile. */
export default function CustomersPage() {
  const [open, setOpen] = useState<Customer | null>(null);
  return open
    ? <CustomerProfile key={open.id} customer={open} onBack={() => setOpen(null)} />
    : <CustomerList onOpen={setOpen} />;
}
