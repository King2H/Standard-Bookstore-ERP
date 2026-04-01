import 'dotenv/config';

// Ensure test DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://bms:bms@localhost:5432/bms';
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test_jwt_secret_not_for_production';
}
