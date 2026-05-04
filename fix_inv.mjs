import { readFileSync, writeFileSync } from 'fs';

const file = 'apps/api/src/modules/inventory/inventory.service.ts';
let c = readFileSync(file, 'utf8');

// Fix listInventory conditions - bare ${p++} -> $${p++}
c = c.replace(/i\.location_id = \$\{p\+\+\}/g, 'i.location_id = $${p++}');
c = c.replace(/i\.book_id = \$\{p\+\+\}/g, 'i.book_id = $${p++}');
c = c.replace(/lower\(b\.title\) LIKE lower\(\$\{p\}\) OR b\.isbn LIKE \$\{p\}/g,
  'lower(b.title) LIKE lower($${p}) OR b.isbn LIKE $${p}');

// Fix getInventoryHistory conditions - bare ${p++} -> $${p++}
c = c.replace(/ih\.book_id = \$\{p\+\+\}/g, 'ih.book_id = $${p++}');
c = c.replace(/ih\.location_id = \$\{p\+\+\}/g, 'ih.location_id = $${p++}');
c = c.replace(/ih\.movement_type = \$\{p\+\+\}/g, 'ih.movement_type = $${p++}');
c = c.replace(/ih\.reason_code = \$\{p\+\+\}/g, 'ih.reason_code = $${p++}');
c = c.replace(/ih\.created_at >= \$\{p\+\+\}/g, 'ih.created_at >= $${p++}');
c = c.replace(/ih\.created_at <= \$\{p\+\+\}/g, 'ih.created_at <= $${p++}');

// Fix LIMIT/OFFSET - bare ${limitParam} -> $${limitParam}
c = c.replace(/LIMIT \$\{limitParam\} OFFSET \$\{offsetParam\}/g,
  'LIMIT $${limitParam} OFFSET $${offsetParam}');

writeFileSync(file, c, 'utf8');
console.log('inventory.service.ts fixed');
