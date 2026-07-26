import 'dotenv/config';
import { connectDB, Admin } from '../models/db.js';

async function main() {
  const raw = process.argv[2] || '';
  const username = raw.replace(/^@/, '').trim();
  const userId = (process.argv[3] || '').trim();

  await connectDB();

  const byUsername = username
    ? await Admin.findOne({ username: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
    : null;

  const byUserId = userId ? await Admin.findOne({ userId }) : null;

  console.log(
    JSON.stringify(
      {
        input: { username: username || null, userId: userId || null },
        byUsername,
        byUserId
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

