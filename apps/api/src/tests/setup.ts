import 'dotenv/config';

// Ensure test DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://bms:bms@localhost:5432/bms';
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test_jwt_secret_not_for_production';
}

// 64-char hex dev key for column encryption in tests
if (!process.env.COLUMN_ENCRYPTION_KEY) {
  process.env.COLUMN_ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
}
