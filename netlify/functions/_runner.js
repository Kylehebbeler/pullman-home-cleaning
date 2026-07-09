/**
 * _runner.js -- thin GitHub Actions adapter for Netlify-style handler functions.
 *
 * Usage: node netlify/functions/_runner.js <function-name>
 * Example: node netlify/functions/_runner.js send-reminders
 */

'use strict';

const name = process.argv[2];
if (!name) {
  console.error('Usage: node _runner.js <function-name>');
  process.exit(1);
}

const { handler } = require(`./${name}`);

handler()
  .then(result => {
    console.log(`[${name}] status ${result.statusCode}`);
    console.log(result.body);
    process.exit(result.statusCode === 200 ? 0 : 1);
  })
  .catch(err => {
    console.error(`[${name}] fatal error:`, err.message);
    process.exit(1);
  });
