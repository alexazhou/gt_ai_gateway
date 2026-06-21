const { execSync } = require('child_process');
const crypto = require('crypto');

console.log('Running Cloudflare Setup...');

try {
  // 1. Run migrations
  console.log('Applying D1 Migrations...');
  execSync('npx wrangler d1 migrations apply gt_ai_gateway --remote', { stdio: 'inherit' });

  // 2. Setup ROOT_TOKEN if not exists
  console.log('Checking ROOT_TOKEN...');
  try {
    const secrets = execSync('npx wrangler secret list', { encoding: 'utf8' });
    if (!secrets.includes('ROOT_TOKEN')) {
      const newToken = crypto.randomUUID();
      console.log('Generating new ROOT_TOKEN...');
      execSync(`echo "${newToken}" | npx wrangler secret put ROOT_TOKEN`, { stdio: 'inherit' });
      console.log('\n==========================================');
      console.log('    🔥 NEW ROOT_TOKEN GENERATED 🔥');
      console.log('==========================================');
      console.log(`Your new ROOT_TOKEN is: ${newToken}`);
      console.log('Please save this securely. You will need it to log in.');
      console.log('==========================================\n');
    } else {
      console.log('ROOT_TOKEN already exists.');
    }
  } catch (err) {
    console.error('Error checking/setting secrets. Continuing deployment...', err.message);
  }
} catch (error) {
  console.error('Setup failed:', error.message);
  process.exit(1);
}
