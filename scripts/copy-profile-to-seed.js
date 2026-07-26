
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_DIR = process.env.CHROME_USER_DATA_DIR 
  || path.join(os.homedir(), '.retweet-bot-chrome-profile');
const PROFILE_SEED_DIR = process.env.CHROME_PROFILE_SEED_DIR 
  || path.join(__dirname, '..', 'profile-seed');

// Function to copy a directory recursively
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const SKIP_DIR_NAMES = new Set([
    'Cache',
    'cache',
    'Code Cache',
    'GPUCache',
    'GrShaderCache',
    'ShaderCache',
    'Crashpad',
    'Crash Reports',
    'Media Cache',
    'DawnCache',
    'component_crx_cache'
  ]);

  const SKIP_FILE_PREFIXES = ['Singleton'];
  const SKIP_FILE_NAMES = new Set(['lockfile']);

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;
    if (!entry.isDirectory()) {
      if (SKIP_FILE_NAMES.has(entry.name)) continue;
      if (SKIP_FILE_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue;
    }
    
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Function to clean a directory
function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(entryPath);
      }
    }
  }
}

console.log('========================================');
console.log('📋 Copy Profile to Seed Directory');
console.log('========================================');
console.log('\nSource Profile:', PROFILE_DIR);
console.log('Destination Seed:', PROFILE_SEED_DIR);
console.log('');

if (!fs.existsSync(PROFILE_DIR)) {
  console.error('❌ ERROR: Source profile directory does not exist!');
  console.error('   First run "npm run login:local" to create and populate it.');
  process.exit(1);
}

console.log('⚠️  WARNING: This will DELETE ALL existing files in the seed directory!');
console.log('   Make sure you have logged in successfully first!');
console.log('');

// Ask for confirmation (simple check, since it's local dev)
import readline from 'readline';
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Do you want to proceed? (y/N): ', (answer) => {
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    console.log('❌ Operation cancelled.');
    rl.close();
    process.exit(0);
  }

  try {
    console.log('\n🧹 Cleaning seed directory...');
    cleanDir(PROFILE_SEED_DIR);

    console.log('📂 Copying profile files...');
    copyDir(PROFILE_DIR, PROFILE_SEED_DIR);

    console.log('✅ Profile copied successfully to seed directory!');
    console.log('\nNext Steps:');
    console.log('1. Commit and push the updated profile-seed directory to your repo');
    console.log('2. Deploy to Render');
    console.log('');
  } catch (err) {
    console.error('❌ Error copying profile:', err);
    process.exit(1);
  } finally {
    rl.close();
  }
});

