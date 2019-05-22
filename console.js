#!/usr/bin/env node
'use strict';

const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSubNode = require('./pubsubNode.js');
const OptractMedia = require('./dapps/OptractMedia/OptractMedia.js');
const IPFS = require('./FileService.js');
const mr = require('@postlight/mercury-parser');
const bs58 = require('bs58');

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

const asyncExec = (func) => { return setTimeout(func, 0) }

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

		this.appCfgs = require(path.join(cfgObj.dappdir, 'config.json')); // can become part of cfgObj
		this.appName = 'OptractMedia';

		const FileServ = new IPFS(this.appCfgs.ipfs);
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
		   'unlockAndSign'
		];		

		mixins.map((f) => { if (typeof(this[f]) === 'undefined' && typeof(Ethereum[f]) === 'function') this[f] = Ethereum[f] });

		this.networkID = Ethereum.networkID;
		this.abi = Ethereum.abi;
		this.userWallet = Ethereum.userWallet;

		// IPFS related
		this.ipfs = FileServ.ipfs;

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
		this.pending = { past: {} }; // format ??????

		// nonce counter (temporary fix for nodejs)
		this.myNonce = 0;
		this.myEpoch = 0;
		this.expn = {};
		this.lock = false;

		const observer = (sec = 3001) =>
		{
        		return setInterval(() => {
				let _tick = Math.floor(Date.now() / 1000);
			 	// update this.pending.past and create new this.pending.currentTick
				if (this.currentTick !== 0) {
					let _tmp = { ...this.pending[this.currentTick] };
					delete this.pending[this.currentTick];
					this.currentTick = _tick;
					this.pending[this.currentTick] = {};

					this.lock = true;
					Array.from(new Set([...Object.keys(this.pending['past']), ...Object.keys(_tmp)])).map((account) => {
						if (typeof(this.pending['past'][account]) === 'undefined') this.pending['past'][account] = {};
						if (typeof(_tmp[account]) === 'undefined') _tmp[account] = {};
						this.pending['past'][account] = { ...this.pending['past'][account], ..._tmp[account] };
						this.expn[account] = Object.keys(this.pending['past'][account]).length;
					});

					this.myEpoch = (this.currentTick - (this.currentTick % 300000)) / 300000;
					this.emit('epoch', { tick: this.currentTick, epoch: this.myEpoch }) 
				} else {
					this.currentTick = _tick;
					this.pending[this.currentTick] = {};
				}
			}, sec);
		}

		// pubsub handler
		this.connectP2P();
		this.join('Optract');

		const compare = (a,b) => { if (a.nonce > b.nonce) { return 1 } else { return -1 }; return 0 };

		this.setIncommingHandler((msg) => 
		{
			let data = msg.data;
			let account = ethUtils.bufferToHex(data.account);
			this.memberStatus(account).then((rc) => { return rc[0] === 'active'; })
			    .then((rc) => {
				if (!rc) return; // check is member or not ... not yet checking different tiers of memberships.
				try {
					if (typeof(this.expn[account]) === 'undefined') {
						this.expn[account] = 0;
					} else if (this.expn[account] >= 120) { 
						return;
					}

					if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
					        return;
					} else if ( typeof(this.pending[this.currentTick][account]) === 'undefined' ) {
					        this.pending[this.currentTick][account] = {};
					}
				} catch(err) {
					console.trace(err);
					return;
				}
	
				let _payload = this.abi.encodeParameters(
					['uint', 'address', 'bytes32', 'uint', 'bytes32'],
					[data.nonce, data.account, data.content, data.since, data.comment]
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
	                                this.pending[this.currentTick][account][payload] = data;
	                        }
			    })
		})

		this.newArticle = (url, _comment = NULL) => 
		{
			let account = this.userWallet[this.appName];
			return mr.parse(url).then((result) => {
				if (_comment === NULL) {
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
			// When committing new block, additional logic to perform last sync or 
		 	// fallback to another witness also be executed here.
		 	// Note that we don't have to filter self-sent message since it is already handled by pubsub

			// with new data structure, pending pool merging is easier..
			// but now how do we prevent local race condition between new epoch past merge and onpending external past merge???
			// 
			//  Planning to use json-diff to identify tx that need to reverify signatures
			//
			if (this.lock === false) {
				// determine if epoch matches upcoming local one
				// leave only unseen tx
				// store in this.snapshot[epoch]
				// merge in next local merge
			} else {
				// wait for local merge done
				// merge in next local merge
			}
		})
	
		this.otimer = observer(30001);

		this.on('epoch', (tikObj) => {
			let account = this.userWallet[this.appName];
			 // Broadcast pending or trigger create merkle root.
			this.put(Buffer.from(JSON.stringify(this.pending['past']))).then((out) => {
				let cache   = this.IPFSstringtoBytes32(out[0].hash);
				let payload = this.abi.encodeParameters(
					['uint', 'uint', 'address', 'bytes32', 'uint'],
					[tikObj.epoch, 1, this.userWallet[this.appName], cache, tikObj.tick] //PoC code fixing pending block No to "1"
				);

				return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
					let params = {
						nonce: tikObj.epoch,
						pending: 1,
						validator: this.userWallet[this.appName],
						cache, 
						since: tikObj.tick,
						v: Number(sig.v), r: sig.r, s: sig.s
					};
					let rlp = this.handleRLPx(pfields)(params);
					this.publish('Optract', rlp.serialize());
					console.dir(rlp);
					this.lock = false;
				}).catch((err) => { console.trace(err); })
			})
		});
	}
}

const appCfg = 
{
	port: 45001 + Math.floor(Math.random()*20), 
	dns: {
		server: [
			'discovery1.datprotocol.com',
			'discovery2.datprotocol.com',
		]
	},
	dht: { 
		bootstrap: [ 
			'bootstrap1.datprotocol.com:6881', 
			'bootstrap2.datprotocol.com:6881', 
			'bootstrap3.datprotocol.com:6881', 
			'bootstrap4.datprotocol.com:6881' 
		]
	},
	dappdir: "/home/jasonlin/Proj/Playground/OptractP2pCLI/dapps"
	// dappdir: "/home/kai/Work/project/OptractP2pCLI/dapps"
};

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
	 .catch((err) => { console.trace(err); });

stage = stage.then(() => {
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
	});
})
