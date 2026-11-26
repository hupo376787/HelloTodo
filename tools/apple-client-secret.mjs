// Generates a Sign in with Apple client-secret JWT locally. Never prints its value.
import {createPrivateKey,sign} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function createAppleClientSecret({teamId,clientId,keyId,privateKey,days=90,now=Math.floor(Date.now()/1000)}){
 if(!/^[A-Z0-9]{10}$/.test(teamId||'')||!/^[A-Z0-9]{10}$/.test(keyId||''))throw Error('Team ID and Key ID must each have 10 uppercase letters/digits.');
 if(typeof clientId!=='string'||!/^[-A-Za-z0-9_.]{3,255}$/.test(clientId))throw Error('A valid Apple Services ID is required.');
 if(!Number.isInteger(days)||days<1||days>180)throw Error('Validity must be 1 to 180 days.');
 const key=createPrivateKey(privateKey);
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error('An Apple P-256 .p8 private key is required.');
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const expires=now+days*86400;
 const unsigned=encode({alg:'ES256',kid:keyId})+'.'+encode({iss:teamId,iat:now,exp:expires,aud:'https://appleid.apple.com',sub:clientId});
 const signature=sign('sha256',Buffer.from(unsigned),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return {token:unsigned+'.'+signature,expires};
}

async function main(){
 const args=process.argv.slice(2),options={};
 if(args.length%2)throw Error('Use --team-id ID --client-id ID --key-id ID --key-file PATH --out PATH [--days 90].');
 for(let i=0;i<args.length;i+=2){if(!['--team-id','--client-id','--key-id','--key-file','--out','--days'].includes(args[i]))throw Error('Unknown option: '+args[i]);options[args[i]]=args[i+1];}
 if(!options['--key-file']||!options['--out'])throw Error('--key-file and --out are required.');
 const result=createAppleClientSecret({teamId:options['--team-id'],clientId:options['--client-id'],keyId:options['--key-id'],privateKey:await readFile(options['--key-file']),days:options['--days']?Number(options['--days']):90});
 const destination=resolve(options['--out']);await mkdir(dirname(destination),{recursive:true});
 await writeFile(destination,result.token,{encoding:'utf8',flag:'wx',mode:0o600});
 console.log('Saved: '+destination+'\nExpires: '+new Date(result.expires*1000).toISOString());
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
