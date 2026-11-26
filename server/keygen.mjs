import {randomBytes,createHash} from 'node:crypto';
const key=randomBytes(32).toString('base64url');console.log('CLIENT KEY (save privately, do not commit): '+key);console.log('WORKSPACE_KEYS secret (SHA-256): '+createHash('sha256').update(key).digest('hex'));
