#!/usr/bin/env node
'use strict';

const fs = require('fs');
const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSubNode = require('./pubsubNode.js');
const OptractMedia = require('./dapps/OptractMedia/OptractMedia.js');
//const IPFS = require('./FileService.js');
const ipfsClient = require('ipfs-http-client');
const mr = require('@postlight/mercury-parser');
const bs58 = require('bs58');
const diff = require('json-diff').diff;
const ethUtils = require('ethereumjs-utils');

//configuration
const config = JSON.parse(fs.readFileSync(path.join('./dapps', 'config.json')).toString()); // can become part of cfgObj

// ASCII Art!!!
const ASCII_Art = (word) => {
        const _aa = (resolve, reject) => {
                figlet(word, {font: 'Big'}, (err, data) => {
                        if (err) return reject(err);
                        resolve(data);
                })
        }

        return new Promise(_aa);
}

// Handling promises in REPL (for node < 10.x)
const replEvalPromise = (cmd,ctx,filename,cb) => {
  let result=eval(cmd);
  if (result instanceof Promise) {
    return result.then(response=>cb(null,response))
                 .catch((err) => { console.trace(err); cb(null,undefined) });
  }
  return cb(null, result);
}

// Master password handling
const askMasterPass = (resolve, reject) =>
{
        let pslen = 0;
        const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                terminal: true
        });
        try {
                rl.question('Master Password:', (answer) => {
                        rl.close();
                        resolve(answer);
                });
                rl._writeToOutput = (stringToWrite) => {
                        //console.log(stringToWrite.charCodeAt(0));
                        if (stringToWrite.charCodeAt(0) === 13) {
                                rl.output.write("\n");
                        } else if (stringToWrite.charCodeAt(0) === 77 || stringToWrite.charCodeAt(0) === '') {
                                if (pslen > 0) {
                                        pslen--;
                                        rl.output.write("Master Password:" + '*'.repeat(pslen));
                                } else {
                                        rl.output.write("Master Password:");
                                }
                        } else {
                                pslen++;
                                rl.output.write("*");
                        }
                };
        } catch(err) {
                reject(err);
        }
}

const missing = (a, b) => 
{
	let out  = diff(a,b);
	let _tmp = out.filter((i) => { return i[0] === '+'});
	return _tmp.map((i) => { return i[1] });
}

// Common Tx
const mfields =
[
        {name: 'nonce', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'account', length: 20, allowZero: true, default: Buffer.from([]) },
        {name: 'content', length: 32, allowLess: true, default: Buffer.from([]) }, // ipfs hash
        {name: 'since', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'comment', length: 32, allowLess: true, default: Buffer.from([]) }, // ipfs hash, premium member only
        {name: 'v', allowZero: true, default: Buffer.from([0x1c]) },
        {name: 'r', allowZero: true, length: 32, default: Buffer.from([]) },
        {name: 's', allowZero: true, length: 32, default: Buffer.from([]) }
];

const pfields =
[
        {name: 'nonce', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'pending', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'validator', length: 20, allowZero: true, default: Buffer.from([]) },
        {name: 'cache', length: 32, allowLess: true, default: Buffer.from([]) }, // ipfs hash, containing JSON with IPFS hash that points to previous cache
        {name: 'since', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'v', allowZero: true, default: Buffer.from([0x1c]) },
        {name: 'r', allowZero: true, length: 32, default: Buffer.from([]) },
        {name: 's', allowZero: true, length: 32, default: Buffer.from([]) }
];

//Main
class OptractNode extends PubSubNode {
	constructor(cfgObj) {
		super(cfgObj);

		this.appCfgs = { ...config }; // can become part of cfgObj
		this.appName = 'OptractMedia';

		//const FileServ = new IPFS(this.appCfgs.ipfs);
		const Ethereum = new OptractMedia(this.appCfgs);
		const mixins = 
		[
		   'call', 
                   'sendTk',
		   'ethNetStatus',
		   'linkAccount',
		   'password',
                   'validPass',
		   'allAccounts',
                   'connected',
		   'makeMerkleTreeAndUploadRoot',
                   'configured',
                   'memberStatus',
		   'unlockAndSign',
		   'verifySignature'
		];		

		mixins.map((f) => { if (typeof(this[f]) === 'undefined' && typeof(Ethereum[f]) === 'function') this[f] = Ethereum[f] });

		this.networkID = Ethereum.networkID;
		this.abi = Ethereum.abi;
		this.userWallet = Ethereum.userWallet;

		// IPFS related
		//this.ipfs = FileServ.ipfs;
		this.ipfs = new ipfsClient('ipfs.infura.io', '5001', {protocol: 'https'})

		this.get = (ipfsPath) => { return this.ipfs.cat(ipfsPath) }; // returns promise that resolves into Buffer
		this.put = (buffer)   => { return this.ipfs.add(buffer) }; // returns promise that resolves into JSON
		
		// IPFS string need to convert to bytes32 in order to put in smart contract
                this.IPFSstringtoBytes32 = (ipfsHash) =>
                {
                         return '0x'+bs58.decode(ipfsHash).toString('hex').slice(4);  // return string
                        //return bs58.decode(ipfsHash).slice(2);  // return Buffer; slice 2 bytes = 4 hex  (the 'Qm' in front of hash)
                }

                this.Bytes32toIPFSstring = (hash) =>  // hash is a bytes32 Buffer
                {
                        return bs58.encode(Buffer.concat([Buffer.from([0x12, 0x20]), hash]))
                }

		// Event related		
		this.currentTick = 0; //Just an epoch.
		this.pending = {}; // format ??????
		this.newblock = {};
		this.myNonce = 0;
		this.myEpoch = 0;
		this.lock = false;

		const observer = (sec = 3001) =>
		{
			this.lock = true;
        		return setInterval(() => {
				this.currentTick = Math.floor(Date.now() / 1000);
				this.myEpoch = (this.currentTick - (this.currentTick % 300000)) / 300000;
				this.emit('epoch', { tick: this.currentTick, epoch: this.myEpoch }) 
			}, sec);
		}

		// pubsub handler
		this.connectP2P();
		this.join('Optract');

		//const compare = (a,b) => { if (a.nonce > b.nonce) { return 1 } else { return -1 }; return 0 };

		this.setIncommingHandler((msg) => 
		{

			let data = msg.data;
			let account = ethUtils.bufferToHex(data.account);

			this.memberStatus(account).then((rc) => { return rc[0] === 'active'; })
			    .then((rc) => {
				if (!rc) return; // check is member or not ... not yet checking different tiers of memberships.
				try {
					if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
					        return;
					} else if ( typeof(this.pending[account]) === 'undefined' ) {
					        this.pending[account] = { txhash: [], txdata: {} };
					} else if (this.pending[account]['txhash'].length >= 120) {
					        return;
					}
				} catch(err) {
					console.trace(err);
					return;
				}
	
				let nonce = ethUtils.bufferToInt(data.nonce);
				let since = ethUtils.bufferToInt(data.since);
				let content = ethUtils.bufferToHex(data.content);
				let comment = ethUtils.bufferToHex(data.comment); 

				if (comment === '0x') comment = '0x0000000000000000000000000000000000000000000000000000000000000000';

				let _payload = this.abi.encodeParameters(
					['uint', 'address', 'bytes32', 'uint', 'bytes32'],
					[nonce, account, content, since, comment]
				);

				let payload = ethUtils.hashPersonalMessage(Buffer.from(_payload));
	                        let sigout = {
					originAddress: account,
	                                v: ethUtils.bufferToInt(data.v),
	                                r: data.r, s: data.s,
					payload,
	                                netID: this.networkID
	                        };

			        if (this.verifySignature(sigout)){
					let pack = msg.data.serialize();
					let txhash = ethUtils.bufferToHex(ethUtils.sha256(pack));
	                                this.pending[account]['txhash'].push(txhash);
					this.pending[account]['txhash'] = Array.from(new Set(this.pending[account]['txhash'])).sort();
	                                this.pending[account]['txdata'][txhash] = {payload, msg: pack};

					console.log(`DEBUG:`); console.dir(msg);
	                        }
			    })
		})

		this.newArticle = (url, _comment = null) => 
		{
			let account = this.userWallet[this.appName];
			return mr.parse(url).then((result) => {
				if (_comment === null) {
					return this.put(Buffer.from(JSON.stringify(result))).then((out) => {
						let content = this.IPFSstringtoBytes32(out[0].hash);
						let comment = '0x0000000000000000000000000000000000000000000000000000000000000000';
						let since = Math.floor(Date.now() / 1000);
						let payload = this.abi.encodeParameters(
							['uint', 'address', 'bytes32', 'uint', 'bytes32'],
							[this.myNonce + 1, account, content, since, comment]
						);
	
						return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
							let params = {
								nonce: this.myNonce + 1,
								account, content, comment, since,
								v: Number(sig.v), r: sig.r, s: sig.s
							};
							let rlp = this.handleRLPx(mfields)(params);
							this.publish('Optract', rlp.serialize());
							this.myNonce = this.myNonce + 1;
							return rlp;
						}).catch((err) => { console.trace(err); })
					})
				} else {
					let p = Promise.all(this.put(Buffer.from(JSON.stringify(result))), this.put(Buffer.from(String(_comment))));
					return p.then((out) => {
						let content = this.IPFSstringtoBytes32(out[0][0].hash);
						let comment = this.IPFSstringtoBytes32(out[1][0].hash);
						let since = Math.floor(Date.now() / 1000);
						let payload = this.abi.encodeParameters(
							['uint', 'address', 'bytes32', 'uint', 'bytes32'],
							[this.myNonce + 1, account, content, since, comment]
						);
	
						return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
							let params = {
								nonce: this.myNonce + 1,
								account, content, comment, since,
								v: Number(sig.v), r: sig.r, s: sig.s
							};
							let rlp = this.handleRLPx(mfields)(params);
							this.publish('Optract', rlp.serialize());
							this.myNonce = this.myNonce + 1;
							return rlp;
						}).catch((err) => { console.trace(err); })
					})
				}
			}).catch((err) => { console.trace(err); });
		}

		this.setOnpendingHandler((msg) => 
		{
			// merge with own pending pool
			let data = msg.data;
			if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
			        return;
			}

			let account = ethUtils.bufferToHex(data.validator);
			let cache = ethUtils.bufferToHex(data.cache);
			let nonce = ethUtils.bufferToInt(data.nonce);
			let since = ethUtils.bufferToInt(data.since);
			let pending = ethUtils.bufferToInt(data.pending);
			// TODO: validate signature against a list of validator address from smart contract
			let _payload = this.abi.encodeParameters(
				['uint', 'uint', 'address', 'bytes32', 'uint'],
				[nonce, pending, account, cache, since] //PoC code fixing pending block No to "1"
			);
			let payload = ethUtils.hashPersonalMessage(Buffer.from(_payload));
	                let sigout = {
				originAddress: account,
	                        v: ethUtils.bufferToInt(data.v),
	                        r: data.r, s: data.s,
				payload,
	                        netID: this.networkID
	                };

			if (this.verifySignature(sigout)){
				let ipfsHash = this.Bytes32toIPFSstring(data.cache); console.log(`IPFS: ${ipfsHash}`);
				this.get('/ipfs/' + ipfsHash).then((buf) => { return JSON.parse(Buffer.from(buf).toString()); })
				.then((pending) => {
					console.log(pending);
					return this.mergeSnapShot(pending);
				}).catch((err) => { console.log(`OnpendingHandler: `); console.trace(err); })
			}
		})

		this.mergeSnapShot = (remote) =>
		{
			// debug
			console.log(`Remote snapshot received ...`);
			console.dir(remote);
		}
	
		this.otimer = observer(150000);

		this.on('epoch', (tikObj) => {
			let account = this.userWallet[this.appName]; console.log(`onepoch: ${account}`);
			 // Broadcast pending or trigger create merkle root.
			this.put(Buffer.from(JSON.stringify(this.pending))).then((out) => {
				let cache   = this.IPFSstringtoBytes32(out[0].hash);
				let payload = this.abi.encodeParameters(
					['uint', 'uint', 'address', 'bytes32', 'uint'],
					[tikObj.epoch, 1, account, cache, tikObj.tick] //PoC code fixing pending block No to "1"
				);

				return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
					let params = {
						nonce: tikObj.epoch,
						pending: 1,
						validator: account,
						cache, 
						since: tikObj.tick,
						v: Number(sig.v), r: sig.r, s: sig.s
					};
					let rlp = this.handleRLPx(pfields)(params);
					this.publish('Optract', rlp.serialize());
					//console.dir(rlp);
					this.lock = false;
				}).catch((err) => { console.trace(err); })
			})
		});
	}
}

const appCfg = { ...config.node, port: 45001 + Math.floor(Math.random()*20) };

console.dir(appCfg);

var app;
var r;
var title = 'Optract: Ops Console';

let stage = new Promise(askMasterPass)
         .catch((err) => { process.exit(1); })
         .then((answer) => { app = new OptractNode(appCfg); app.password(answer); return app.validPass() })
         .then((rc) => {
		if (rc && typeof(app.appCfgs.dapps[app.appName].account) !== 'undefined') {
			return app.linkAccount(app.appName)(app.appCfgs.dapps[app.appName].account).then(console.log);
		} else {
			//console.log(`WARNING: Read-Only Mode as Master Password is NOT unlocked!!!`);
			title = 'Optract: Ops Console  [ RO ]';
		}
	 })
	 .then(() => {
	    return ASCII_Art(title).then((art) => {
	        console.log(art);
		r = repl.start({ prompt: `[-= ${app.appName} =-]$ `, eval: replEvalPromise });
	        r.context = {app};
	        r.on('exit', () => {
	                console.log("\n\t" + 'Stopping CLI...');
			app.leave();
			app.swarm.close();
			process.exit(0);
	        });
	    })
	 })
	 .catch((err) => { console.trace(err); })
