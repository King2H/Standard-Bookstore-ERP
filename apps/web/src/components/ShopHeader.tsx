import { useShopIdentity } from '../features/settings/queries.js';

/**
 * What heads every receipt and printed slip (#228, owner decision 2a): the
 * shop's name, the branch with its address and phone, and the TIN when set.
 * What is not set is left out; nothing shows until it has loaded.
 */
export function ShopHeader({ className = '' }: { className?: string }) {
  const { data } = useShopIdentity();
  if (!data) return null;
  const contact = [data.branch.address, data.branch.phone].filter(Boolean).join(' · ');
  return (
    <header data-testid="shop-header" className={`text-center leading-tight ${className}`}>
      {data.name && <p className="text-base font-bold">{data.name}</p>}
      <p className="text-sm">{data.branch.name}</p>
      {contact && <p className="text-xs opacity-80">{contact}</p>}
      {data.tin && <p className="text-xs opacity-80">TIN {data.tin}</p>}
    </header>
  );
}
