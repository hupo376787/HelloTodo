import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {createAppleClientSecret} from '../tools/apple-client-secret.mjs';

test('Apple client secret is a signed ES256 JWT with JOSE signature and bounded validity',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const pem=privateKey.export({type:'pkcs8',format:'pem'});
 const input={teamId:'TEAM123456',clientId:'com.example.hellotodo.web',keyId:'KEY1234567',privateKey:pem,days:90,now:1800000000};
 const {token,expires}=createAppleClientSecret(input),parts=token.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(parts[0],'base64url')),{alg:'ES256',kid:input.keyId});
 const claims=JSON.parse(Buffer.from(parts[1],'base64url'));
 assert.equal(claims.sub,input.clientId);assert.equal(claims.iss,input.teamId);assert.equal(claims.aud,'https://appleid.apple.com');
 assert.equal(expires-input.now,90*86400);assert.equal(Buffer.from(parts[2],'base64url').length,64);
 assert.ok(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')));
 assert.throws(()=>createAppleClientSecret({...input,days:181}));
 assert.throws(()=>createAppleClientSecret({...input,keyId:'invalid'}));
});
