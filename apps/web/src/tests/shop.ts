import { ShopIdentitySchema, type ShopIdentity } from '@bms/shared';
import { contract } from './contract.js';

/** The answer to GET /config/shop for pages that print (#228): every receipt and slip asks for it. */
export const SHOP_IDENTITY: ShopIdentity = contract(ShopIdentitySchema, {
  name: 'Test Bookshop', motto: '', tin: '', taxName: 'VAT',
  branch: { id: 1, name: 'Main Branch', address: 'Bole, Addis Ababa', phone: '+251911000000' },
});
