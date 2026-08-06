/**
 * One-time script: floor negative inventory.quantity values to 0.
 * Run: node scripts/fix-negative-inventory.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../../../.env');

// Parse .env manually
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

try {
  const result = await pool.query(
    'UPDATE inventory SET quantity = 0, updated_at = now() WHERE quantity < 0'
  );
  console.log(`✓ Fixed ${result.rowCount} inventory row(s) with negative quantity.`);
} catch (err) {
  console.error('✗ Error:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
