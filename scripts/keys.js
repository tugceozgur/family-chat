// Prints fresh secrets to paste into your host's environment variables.
const crypto = require('crypto');
const { publicKey, privateKey } = require('web-push').generateVAPIDKeys();
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}
VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}`);
