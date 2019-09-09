'use strict';

const fs = require('fs');
const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
const PubSubNode = require('./pubsubNode.js');
const OptractMedia = require('../dapps/OptractMedia/OptractMedia.js');
const ipfsClient = require('ipfs-http-client');
const mr = require('@postlight/mercury-parser');
const bs58 = require('bs58');
const diff = require('json-diff').diff;
const ethUtils = require('ethereumjs-utils');
const MerkleTree = require('merkle_tree');
const WSServer = require('rpc-websockets').Server;
const mkdirp = require('mkdirp');
const Parser = require('rss-parser');
const Lottery = require('./libSampleTickets.js');
const request = require('request');

//configuration
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '/../dapps', 'config.json')).toString()); // can become part of cfgObj

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
	a.sort(); 
	b.sort();

	let out = diff(a, b);

	if (!out || out.length === 0) return [];
	let _tmp = out.filter((i) => { return i[0] === '+'});
	return _tmp.map((i) => { return i[1] });
}

const keeping = (a, b) => // only a has it. so a should keep it
{
	a.sort(); 
	b.sort();

	let out = diff(a, b);

	if (!out || out.length === 0) return [];
	let _tmp = out.filter((i) => { return i[0] === '-'});
	return _tmp.map((i) => { return i[1] });
}

// Common Tx
const mfields =
[
        {name: 'opround', length: 32,   allowLess: true, default: Buffer.from([]) },  // opround integer
        {name: 'account', length: 20,   allowZero: true, default: Buffer.from([]) },  // user (autherized) address
        {name: 'comment', length: 32,   allowLess: true, default: Buffer.from([]) },  // ipfs hash (comment)
        {name:   'title', length: 1024, allowLess: true, allowZero: true, default: Buffer.from([]) },  // article title
        {name:     'url', length: 1024, allowLess: true, allowZero: true, default: Buffer.from([]) },  // article url
        {name:     'aid', length: 32,   allowZero: true, default: Buffer.from([]) },  // sha256(title+domain), bytes32
        {name:     'oid', length: 32,   allowLess: true, default: Buffer.from([]) },  // participating game round ID, bytes32
        {name: 'v1block', length: 32,   allowLess: true, default: Buffer.from([]) },  // 1st vote block
        {name:  'v1leaf', length: 32,   allowLess: true, default: Buffer.from([]) },  // 1st vote txhash
        {name: 'v2block', length: 32,   allowLess: true, default: Buffer.from([]) },  // 2nd vote (claim) block
        {name:  'v2leaf', length: 32,   allowLess: true, default: Buffer.from([]) },  // 2nd vote (claim) txhash
        {name:   'since', length: 32,   allowLess: true, default: Buffer.from([]) },  // timestamp, uint
        {name: 'v1proof', length: 768,  allowLess: true, allowZero: true, default: Buffer.from([]) },  // 1st vote merkle proof
        {name:  'v1side', length: 3,    allowLess: true, allowZero: true, default: Buffer.from([]) },  // 1st vote merkle proof (side)
        {name: 'v2proof', length: 768,  allowLess: true, allowZero: true, default: Buffer.from([]) },  // 2nd vote merkle proof
        {name:  'v2side', length: 3,    allowLess: true, allowZero: true, default: Buffer.from([]) },  // 2nd vote merkle proof (side)
        {name:       'v', allowZero: true, default: Buffer.from([0x1c]) },
        {name:       'r', allowZero: true, length: 32, default: Buffer.from([]) },
        {name:       's', allowZero: true, length: 32, default: Buffer.from([]) }
];

const pfields =
[
        {name: 'nonce', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'pending', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'validator', length: 20, allowZero: true, default: Buffer.from([]) },
        {name: 'cache', length: 32, allowLess: true, default: Buffer.from([]) }, // ipfs hash of [txhs, txpd, txdt]
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

		const Ethereum = new OptractMedia(this.appCfgs);
		const mixins = 
		[
		   'clearCache',
		   'call', 
                   'sendTk',
		   'ethNetStatus',
		   'linkAccount',
		   'password',
                   'validPass',
		   'newAccount',
		   'importFromJSON',
		   'allAccounts',
                   'connected',
                   'configured',
                   'memberStatus',
                   'buyMembership',
		   'unlockAndSign',
		   'verifySignature',
		   'queueReceipts',
		   'validateMerkleProof',
		   'getBlockNo',
		   'getBlockInfo',
		   'getMaxVoteTime',
		   'getOpround',
		   'getOproundId',
		   'getOproundInfo',
		   'getOproundResults',
		   'getOproundProgress',
		   'getOproundLottery',
		   'getMinSuccessRate',
		   'isValidator'
		];		

		mixins.map((f) => { if (typeof(this[f]) === 'undefined' && typeof(Ethereum[f]) === 'function') this[f] = Ethereum[f] });

		this.networkID = Ethereum.networkID;
		this.abi = Ethereum.abi;
		this.userWallet = Ethereum.userWallet;

		// IPFS related
		this.ipfs = new ipfsClient('127.0.0.1', '5001', {protocol: 'http'}); //FIXME: need to setup onReady event for IPFS
		this.ipfs.id().then((output) => { this.store = '/ipfs/' + output.id; })

		this.get = (ipfsPath) => { return this.ipfs.cat(ipfsPath) }; // returns promise that resolves into Buffer
		this.put = (buffer)   => { return this.ipfs.add(buffer) }; // returns promise that resolves into JSON
		this.ping = (ipfsHash) => { console.log(`DEBUG: pinging peer ${ipfsHash}`); return this.ipfs.ping(ipfsHash).catch((err) => { true } ) };

		this.validIPFSHash = (ipfsHash) =>
		{
			// currently all ipfsHash we have are Qm... so we only check length
			//console.log(bs58.decode(ipfsHash).slice(2).length);
			let d = bs58.decode(ipfsHash);
			if (d.hexSlice(0,1) !== '12') return false;
			let len = parseInt(d.hexSlice(1,2),16);
			return bs58.decode(ipfsHash).slice(2).length === len;
		}

		// IPFS string need to convert to bytes32 in order to put in smart contract
                this.IPFSstringtoBytes32 = (ipfsHash) =>
                {
			if (!this.validIPFSHash(ipfsHash)) console.error(`IPFSstringtoBytes32: ${ipfsHash} use unsupported multihash`);
                        // return '0x'+bs58.decode(ipfsHash).toString('hex').slice(4);  // return string
                        return ethUtils.bufferToHex(bs58.decode(ipfsHash).slice(2));  // slice 2 bytes = 4 hex  (the 'Qm' in front of hash)
                }

                this.Bytes32toIPFSstring = (hash) =>  // hash is a bytes32 Buffer or hex string (w/wo '0x' prefix)
                {
		        let buf = this._getBuffer(hash);
			if (buf.length != 32) console.error(`Bytes32toIPFSstring: length of input hex ${buf.toString('hex')} is not bytes32`);
                        return bs58.encode(Buffer.concat([Buffer.from([0x12, 0x20]), this._getBuffer(hash)]))
                }

                this._getBuffer = (value) => {
                        if (value instanceof Buffer) {
                                return value;
                        } else if (this._isHex(value)) {
                                return Buffer.from(value, 'hex');
                        } else if (this._isHex(value.slice(2)) && value.substr(0,2) === '0x') {
                                return Buffer.from(value.slice(2), 'hex');
                        } else { // the value is neither buffer nor hex string, will not process this, throw error
                                throw new Error("Bad hex value - '" + value + "'");
                        }
                };

                this._isHex = (value) =>  {
                        let hexRegex = /^[0-9A-Fa-f]{2,}$/;
                        return hexRegex.test(value);
                };

		// Event related		
		this.myStamp = Math.floor(Date.now() / 1000);
		this.myTick  = ( this.myStamp - (this.myStamp % 300) ) / 300; // Optract Epoch No.
		this.pending = { txdata: {}, payload: {}, txhash: {}, nonces: {} };
		this.lostChunk = [];
		this.myEpoch = 0; // Optract block No.

		this.aidWatch = {};
		this.clmWatch = {};

		this.game = { drawed: false, opround: -1, oid: '0x', 
			      aid2vc: {}, aid2cc: {}, aidUrl: {}, 
			      curated: {}, voted: {}, votWatch: {},
			      clmWatch: {}, opSync: -1
		}; 

		this.ipfsSwarms = [
			"/ipfs/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM",
			"/ipfs/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
			"/ipfs/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu",
			"/ipfs/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd",
			"/ipfs/QmTKBfNygNbmH4iGL8z5CbKUpxR7j4fDtTgbKCDsRZguZ7",
			"/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
			"/ipfs/QmanMqJfywyBDAFej6GKyb967jBy7drBkeFDT66t3mKhgD",
			"/ipfs/QmXUZGsV4jPUNqTQPZpV6fg8z3ivPgoi6FVBWF3wP6Boyj",
			"/ipfs/QmPrZzP9UffmgJjLd1FQzeUZsGvv7YFpeoL3BEVQzbDwzK",
			"/ipfs/QmZvNGaxC5fHmYUG7e1nPWui7nQrwyNi5LSctKbvT8AyBj",
			"/ipfs/QmPKSjMv3Zp9tdAGFEPMjUtmQjdyHC6HKbEyCgfPNEFDAh",
			"/ipfs/QmWqVP4i86MWg8qmKir52oyyK7vCmFK4sXvwaCapM9C2mg"
		];

		this.ipfsStats = {};

		const __ipfsConnect = () =>
		{
			this.ipfs.id().then((output) => {
				let myid = '/ipfs/' + output.id;
				this.ipfsSwarms.map((s) => {
					if (s === myid) return this.ipfsStats[s] = 'this node';
					this.ipfsStats[s] = 'unknown';
					return setTimeout((peer) => { 
						this.ipfs.swarm.connect(peer)
						    .then((rc) => { this.ipfsStats[peer] = 'success' })
						    .catch((err) => { this.ipfsStats[peer] = 'not connected' }) 
					}, 0, s); 
				});
			});
		}

		const observer = (sec = 300000) =>
		{
			if ( typeof(this.appCfgs.dapps[this.appName].account) === 'undefined'
			  || typeof(this.userWallet[this.appName]) === 'undefined'
			  || !(this.db instanceof Pathwise)
			) {
				console.log(`DEBUG: user account not set, do nothing ...`)
				return setTimeout(observer, 5000, sec);
			}

			this.isValidator(this.userWallet[this.appName]).then((rc) => {
				if(rc) {
					this.setOnpendingHandler(__gen_pending) 
					this.on('epoch', __send_pending);
				} else {
					this.setOnpendingHandler(__vet_pending)
					this.on('epoch', __retry_pending);
				}
			})
		
			this.setIncommingHandler(__incomming); 
			
			const __observe = () => 
			{
				__ipfsConnect();
				this.myStamp = Math.floor(Date.now() / 1000);
				this.myTick  = ( this.myStamp - (this.myStamp % 300) ) / 300;

				let p = [
					this.getBlockNo(),
					this.getOproundInfo().then((rc1) => {
                                               	let op = rc1[0];
                                               	return this.getOproundLottery(op).then((rc2) => {
                                                	return [...rc1, ...rc2];
                                               	})
                                        })
				];

				Promise.all(p).then((rc) => {
					let newEpoch = rc[0];
					let newOpRnd = rc[1][0];
					let oid      = rc[1][1];
					let opStart  = rc[1][2];
					let opDraw   = rc[1][4];

					if (this.game.opround === 0) {
						this.game.opround = newOpRnd;
						this.game.opStart = opStart;
					}

					if (this.myEpoch < newEpoch) {
						this.clearCache(`${this.appName}_BlockRegistry_getBlockNo`);

						let chkClm = false;
						if (newOpRnd > this.game.opround && newOpRnd >= 1) {
							// reset this.game
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRound`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundInfo_0`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundResult_${this.game.opround}`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundProgress`);

							this.game = { 
							      	drawed: opDraw > 0 ? true : false, 
								opround: newOpRnd, oid,
							      	aid2vc: {}, aid2cc: {}, aidUrl: {},
							      	curated: {}, voted: {}, votWatch: {},
							      	clmWatch: {}, opStart, opSync: -1 
							};

							this.db.del(['histxs'], ()=>{})
							this.db.del(['vault'], ()=>{})
							//pull sDB and fIPFS
							this.renewOproundDB(newOpRnd);
							chkClm = true; // remove old claim.
						} else if (newOpRnd === this.game.opround && opDraw !== 0) {
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundInfo_0`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundResult_${this.game.opround}`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundProgress`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundLottery_${this.game.opround}`);

							this.game.drawed = true;
							this.game.lottery = opDraw;
							this.game.winNum = rc[1][5];
							this.game.opStart = opStart;
						}

						this.saveDB();

						// if we have already synced (newEpoch - 1) block, than advance this.myEpoch 
						if (this.lastBlk === this.myEpoch && newEpoch === this.myEpoch + 1) this.myEpoch = newEpoch;
						this.emit('block', { tick: this.myStamp, epoch: this.myTick, block: newEpoch, chkClm })
					} else {
						if (this.myEpoch > newEpoch) this.myEpoch = newEpoch;
						if (newOpRnd === this.game.opround && opDraw !== 0) {
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundInfo_0`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundResult_${this.game.opround}`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundProgress`);
							this.clearCache(`${this.appName}_BlockRegistry_queryOpRoundLottery_${this.game.opround}`);

							this.game.drawed = true;
							this.game.lottery = opDraw;
							this.game.winNum = rc[1][5];
							this.game.opStart = opStart;
						}
						this.emit('epoch', { tick: this.myStamp, epoch: this.myTick, block: this.myEpoch }) 
					}
				})
			}

			__observe();
        		return setInterval(__observe, sec);
		}

		this.dbsync = () => { return (this.myEpoch - this.lastBlk === 1) ? true : false; }

		this.reports = () =>
                {
                        return {
				pubsub:	this.stats(),
				ipfs: this.ipfsStats,
                                lastStamp: this.myStamp, 
                                optract: { 
                                        epoch: this.myEpoch, 
                                        opround: this.game.opround,
                                        oid: this.game.oid,
                                        opStart: this.game.opStart,
                                        missing: this.lostChunk, 
                                        synced: this.lastBlk,
                                        lottery: {drawed: this.game.drawed, lottery: this.game.lottery, winNumber: this.game.winNum},
					lastMsr: this.game.lastMsr,
					lastSDB: this.game.lastSDB,
					lastFL:  this.game.lastFL
                                },
				ethereum: this.ethNetStatus(),
				throttle: this.seen.seen,
				account: this.userWallet,
				dbsync: this.dbsync()
			};
                }

		// pubsub handler
		this.connectP2P();
		this.join('Optract');
		__ipfsConnect();

		const __lock_file = (lpathdir) =>
                {
                        let lpath = path.join(lpathdir, 'Optract.LOCK');
                        fs.closeSync(fs.openSync(lpath, 'w'))
                }

		__lock_file(path.dirname(this.appCfgs.datadir));

		// JSON for now, leveldb soon
		const Pathwise = require('level-pathwise');
		const level = require('level');
		this.db;
		this.lastBlk = 0;

		this.initDB = () =>
		{
			if (this.db instanceof Pathwise) return;

			let dbpath = path.join(this.appCfgs.datadir, 'opdb');
			if (fs.existsSync(dbpath)) {
				// TODO: check db integrity?
				try {
					this.db = new Pathwise(level(dbpath));
					this.db.get(['lost'], (err, rc) => { 
						if (err || (rc.constructor === Object && Object.keys(rc).length === 0)) {
							this.lostChunk = [];
						} else {
							console.log(`DEBUG: lost chunk from db:`); console.dir(rc);
							this.lostChunk = rc;
						}
					});
					this.db.get(['lastBlk'], (err, rc) => { 
						if (err) {
							this.lastBlk = 0;
						} else {
							this.lastBlk = rc; 
							this.myEpoch = rc; // initialization
						}

						this.genOpRoundDB();
						this.genBlockDB(this.lastBlk);
					});
				} catch(err) {
					if (err) { console.trace(err); throw 'leveldb initialization failed'; }
				}
			} else {
				this.db = new Pathwise(level(dbpath));
				this.db.put([], {
					lastBlk: 0, lost: [], block: {}, acc2vc: {}
				}, (err, rc) => {
					if (err) { console.trace(err); throw 'leveldb initialization failed'; }
					this.genOpRoundDB();
					this.genBlockDB(0);
				})
			}
		}

		this.saveDB = () =>
		{
			if (this.lostChunk.length > 0) {
 				console.log(`Please do not turn off node before done ...`);
				this.db.put(['lost'], this.lostChunk, () => { console.log(`DONE Syncing!!`)});
			}
		}

		// internal incomming handler
		const __incomming = (msg) => 
		{
			let data = msg.data;
			let account = ethUtils.bufferToHex(data.account);
			let pack = msg.data.serialize();
			let txhash = ethUtils.bufferToHex(ethUtils.sha256(pack));

			this.memberStatus(account).then((rc) => { return rc[0] === 'active'; }).then((rc) => {
				if (!rc) return; //TODO: checking different tiers of memberships.
                                // let tier = rc[5]; let expireTime = rc[6];  // need these values somewhere?
				try {
					if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
					        return;
					} else if ( typeof(this.pending['txhash'][account]) === 'undefined' 
					         || typeof(this.pending['nonces'][account]) === 'undefined') 
					{
					        this.pending['txhash'][account] = [];
					        this.pending['nonces'][account] = 0;
					} else if (this.pending['txhash'][account].indexOf(txhash) !== -1) {
						return;
					} else if (this.pending.nonces[account] >= 120) {
					        return; // FIXME: still need to implement nonce records properly in committed blocks. ?????????????????????
					}
				} catch(err) {
					console.trace(err);
					return;
				}

				this.getOproundInfo().then((rc) => {	
					let oid = ethUtils.bufferToHex(data.oid);
					oid = '0x' + oid.slice(2).padStart(64, '0');
					let aid = ethUtils.bufferToHex(data.aid);
					let since = ethUtils.bufferToInt(data.since);
					let comment = ethUtils.bufferToHex(data.comment);
					let opround = ethUtils.bufferToInt(data.opround); 
					let v1block = ethUtils.bufferToInt(data.v1block); 
					let v1leaf = ethUtils.bufferToHex(data.v1leaf); 
					let v2block = ethUtils.bufferToInt(data.v2block); 
					let v2leaf = ethUtils.bufferToHex(data.v2leaf); 

					if (oid !== rc[1] || opround !== rc[0]) return;
					if (comment === '0x') {
						if (v1leaf === '0x' || v1block === 0) return;
						if (v2leaf !== '0x' && v2block === 0) return;
					}

                                        comment = '0x' + comment.slice(2).padStart(64, '0');

                                        //payload arrays
                                        let labels = ['uint', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'];
                                        let values = [opround,  account,  comment,        aid,       oid, v1block,   v1leaf, v2block,   v2leaf,  since];

					const __handle_vote = (type) => (data) =>
					{
						let proof;
						let proves;
						let side;
						let sides;
						let leaf;
						let block;

						if (type === 'v1') {
							block = ethUtils.bufferToInt(data.v1block); 
							leaf = ethUtils.bufferToHex(data.v1leaf); 
							leaf = '0x' + leaf.slice(2).padStart(64, '0');
							proof = ethUtils.bufferToHex(data.v1proof);  // proof is 0x + (32bytes)*n, 0<=n<24
							side = ethUtils.bufferToInt(data.v1side);  // side is int between 0 and 2**24-1
						} else if (type === 'v2') {
							block = ethUtils.bufferToInt(data.v2block); 
							leaf = ethUtils.bufferToHex(data.v2leaf); 
							leaf = '0x' + leaf.slice(2).padStart(64, '0');
	                                        	proof = ethUtils.bufferToHex(data.v2proof);
	                                        	side = ethUtils.bufferToInt(data.v2side);
						}
						proves = proof.slice(2).padStart(64 * Math.ceil((proof.length-2)/64), '0').match(/.{1,64}/g).map((i)=>{return '0x'+i})
						sides = side.toString(2).split('').map((v)=>{return v==='1'? true : false});  // convert to bool array
						sides = Array(proves.length-sides.length).fill(false).concat(sides);  // fill 'false' to the left
						if (proves[proves.length-1].length < 64) throw ('wrong proof length');

						return {proof, proves, side, sides, leaf, block};
					}

					const __add_abi = (type) => (labels, values, proves, sides, leaf, block) =>
					{
						let n1 = type === 'v1' ? 10 : 12 ;
						let n2 = n1 + 1;

						return this.call(this.appName)('BlockRegistry')('txExist')(proves, sides, leaf, block).then((rc) => {
                                                        if (!rc) {
                                                            console.log(`Failed to find ${leaf} in ${block}`);
                                                            console.log(proves); console.log(sides);
                                                            console.log(leaf); console.log(block);
                                                            return;
                                                        }
                                        		labels.splice(n1, 0, 'bytes32[]'); 
                                        		labels.splice(n2, 0, 'bool[]');  
                                        		values.splice(n1, 0, proves);
                                        		values.splice(n2, 0, sides);

							return {labels, values};
						})
					}

					const __abi_sign = (txtype, aid, pack, txhash) => (labels, values) => {
						let _payload = this.abi.encodeParameters(labels, values);
						let payload = ethUtils.hashPersonalMessage(Buffer.from(_payload));
		                	       	let sigout = {
							originAddress: account,
				                      	v: ethUtils.bufferToInt(data.v),
		                		        r: data.r, s: data.s,
							payload,
				                       	netID: this.networkID
		                		};
		
					       	if (this.verifySignature(sigout)){
							// These checks can only be done after signature verified.
							if (txtype === 'curate') {
								// verify double curate
								if (typeof(this.aidWatch[aid]) === 'undefined') {
									this.aidWatch[aid] = { curated: [], voted: [], claimed: [] }
								} 

								if (this.aidWatch[aid].curated.indexOf(account) === -1) {
									this.aidWatch[aid].curated.push(account);
								} else if (this.aidWatch[aid].curated.indexOf(account) !== -1 ) {
									console.log(`DEBUG: no double curation in same block`);
									return;
								}
							} else if (txtype === 'vote') {
								// verify double vote
								if (typeof(this.aidWatch[aid]) === 'undefined') {
									this.aidWatch[aid] = { curated: [], voted: [], claimed: [] }
								} 

								if (this.aidWatch[aid].voted.indexOf(account) === -1) {
									this.aidWatch[aid].voted.push(account); 
								} else if (this.aidWatch[aid].voted.indexOf(account) !== -1 ) {
									console.log(`DEBUG: no double votes in same block`);
									return;
								}
							} else if (txtype === 'claim') {
								// verify double claim of a ticket and article
								let v1leaf = values[6];

								if (typeof(this.aidWatch[aid]) === 'undefined') {
									this.aidWatch[aid] = { curated: [], voted: [], claimed: [] }
								} 
							
								if (typeof(this.game.clmWatch[account]) !== 'undefined' && this.game.clmWatch[account].indexOf(v1leaf) !== -1) {
									console.log(`DEBUG: no double v2 votes using same ticket`);
									return;
								}
								
								if (this.aidWatch[aid].claimed.indexOf(account) === -1 && typeof(this.clmWatch[v1leaf]) === 'undefined') {
									this.aidWatch[aid].claimed.push(account);
									this.clmWatch[v1leaf] = aid;
								} else if (this.aidWatch[aid].claimed.indexOf(account) !== -1 || this.clmWatch[v1leaf]) {
									console.log(`DEBUG: no double v2 votes in same block`);
									return;
								}
							} else {
								throw "__abi_sign: unknow txtype";
							}

					                this.pending['txhash'][account].push(txhash);
							this.pending['txhash'][account] = Array.from(new Set(this.pending['txhash'][account])).sort();
							this.pending['nonces'][account] = this.pending['txhash'][account].length;
		                	       		this.pending['txdata'][txhash]  = pack;
				                        this.pending['payload'][txhash] = payload;
	
							console.log(`INFO: Got ${txhash} from ${account}`); 
							// silenced. just to cache content on local ipfs.
							if (comment !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
								console.log(`DEBUG: pinning comment ${comment} from ${txhash}`); 
								let ipfshash = this.Bytes32toIPFSstring(comment);
								if (!this.validIPFSHash(ipfshash)) {
									console.log(`DEBUG: erroneous comment IPFS hash from ${txhash}, dump:`);
									console.log(ipfshash);
									// console.dir(value);
								} else {
									this.ipfs.pin.add(ipfshash);
								}
							}
                                                } else {
                                                        console.log('failed in __abi_sign');
                                                }
					}
	
					if (v1leaf === '0x') { // curate
						values[5] = 0; 									  //v1block
						values[6] = '0x0000000000000000000000000000000000000000000000000000000000000000'; //v1leaf
						values[7] = 0;									  //v2block
						values[8] = '0x0000000000000000000000000000000000000000000000000000000000000000'; //v2leaf
					
						let titleBuf = data.title;
						let domain   = new URL(data.url.toString()).origin;

						//verify aid
						let _aid = ethUtils.bufferToHex(ethUtils.sha256(Buffer.concat([titleBuf, Buffer.from(domain)])));
						if (aid !== _aid) {
							console.log(`aid mismatch:`); 
							console.log(`aid: ${aid}`);
							console.log(`_aid: ${_aid}`);
							return;
						}

						return __abi_sign('curate', aid, pack, txhash)(labels, values);
					}

					if (v1leaf !== '0x') {
						let v1 = __handle_vote('v1')(data);
						values[3] = '0x11be010000000000000000000000000000000000000000000000000000000000';
						
						if (v2leaf === '0x') { // v1 vote
							let p = [
							  __add_abi('v1')(labels, values, v1.proves, v1.sides, v1.leaf, v1.block),
							  this.locateTx(v1.block)(v1.leaf, 'aid')
							];

							return Promise.all(p).then((rc) => 
							{
								let abiObj = rc[0];
								let aid = rc[1];

                                                                if ( typeof(abiObj) === 'undefined' 
								  || aid === null
								  || aid === '0x11be010000000000000000000000000000000000000000000000000000000000'
								  || aid === '0x11be020000000000000000000000000000000000000000000000000000000000'
								) {
									return;
								}

								let values = abiObj.values;
								let labels = abiObj.labels;

								values[7] = 0;									  //v2block
								values[8] = '0x0000000000000000000000000000000000000000000000000000000000000000'; //v2leaf

								__abi_sign('vote', aid, pack, txhash)(labels, values);
							})
				    		} else if (v2leaf !== '0x') {
							values[3] = '0x11be020000000000000000000000000000000000000000000000000000000000';

                                                        return __add_abi('v1')(labels, values, v1.proves, v1.sides, v1.leaf, v1.block).then((abiObj) => {
                                                                if (typeof(abiObj) === 'undefined') return;
                                                                let v2 = __handle_vote('v2')(data);
                                                                let labels = abiObj.labels;
                                                                let values = abiObj.values;

                                                                return __add_abi('v2')(labels, values, v2.proves, v2.sides, v2.leaf, v2.block).then((abiObj) => 
                                                                {
                                                                        if (typeof(abiObj) === 'undefined') return;
                                                                        let labels = abiObj.labels;
                                                                        let values = abiObj.values;

                                                                        let p = [
                                                                          this.call(this.appName)('BlockRegistry')('isWinningTicket')(opround, v1.leaf), 
                                                                          this.call(this.appName)('BlockRegistry')('isWinningTicket')(opround, v2.leaf),
									  this.locateTx(v1.block)(v1.leaf, 'account'),
									  this.locateTx(v2.block)(v2.leaf, 'aid')
                                                                        ];

                                                                        return Promise.all(p).then((rc) => 
                                                                        {
                                                                                if ( !rc[0][0] 
										  || !rc[1][0] 
										  || rc[2] !== account 
										  || rc[3] === null
								  		  || rc[3] === '0x11be010000000000000000000000000000000000000000000000000000000000'
								  		  || rc[3] === '0x11be020000000000000000000000000000000000000000000000000000000000'
										) {
											console.log(`DEBUG: something was wrong with this claim tx`)
											console.dir(rc);
											return; 
										}

										if (this.game.opround > 1 && this.game.lastMsr > 0) {
											if ( typeof(this.game.lastSrates) !== 'undefined' 
											  && typeof(this.game.lastSrates[account]) !== 'undefined'
											) {
												let srate = (this.game.lastSrates[account][0] / this.game.lastSrates[account][1]) * 100;
										          	if (srate >= this.game.lastMsr) {
													let aid = rc[3];
                                                                                			__abi_sign('claim', aid, pack, txhash)(labels, values);
												} else {
													console.log(`DEBUG: srate too low for ${account}`)
													return;
												}
											} else {
												console.log(`DEBUG: new account, no srate yet ${account}`)
												return;
											}
										} else {
											let aid = rc[3];
                                                                                	__abi_sign('claim', aid, pack, txhash)(labels, values);
										}
                                                                        })
                                                                }) 
                                                        }) 
						}
					}
			       })
			})
		}

		const __inner_msgTx = (comment, txData) =>
		{
			let opround = txData.opround;
			let account = txData.account;
			let v1block = txData.v1block;
			let v1leaf  = txData.v1leaf;
			let v2block = txData.v2block;
			let v2leaf  = txData.v2leaf;
			let oid = txData.oid;
			let aid = txData.aid;
			let title = txData.title;
			let url = txData.url;
			let since = Math.floor(Date.now() / 1000);
			let v1proof;
			let v2proof;
			let v1side;
			let v2side;

			let labels = ['uint', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'];
			let values = [opround,  account,   comment,       aid,      oid, v1block,   v1leaf,  v2block,    v2leaf, since];

			if (typeof(txData.v1proof) !== 'undefined' && typeof(txData.v1side) !== 'undefined') {
				v1side  = txData.v1side;
				labels.splice(10, 0, 'bytes32[]');  // v1proof
                                labels.splice(11, 0, 'bool[]');  // v1side
                                values.splice(10, 0, txData.v1proof);
                                values.splice(11, 0, v1side);
                                v1proof = Buffer.concat(txData.v1proof.map((v)=>{return Buffer.from(v.slice(2), 'hex')}));
				// convert bool array to a uint
				v1side = v1side.map((v, k)=>{return v===true ? 2**(v1side.length-1-k) : 0}).reduce((_a, _b)=> _a+_b);
			}

			if (typeof(txData.v2proof) !== 'undefined' && typeof(txData.v2side) !== 'undefined') {
				v2side  = txData.v2side;
				labels.splice(12, 0, 'bytes32[]');  // v2proof
                                labels.splice(13, 0, 'bool[]');  // v2side
                                values.splice(12, 0, txData.v2proof);
                                values.splice(13, 0, v2side);
                                v2proof = Buffer.concat(txData.v2proof.map((v)=>{return Buffer.from(v.slice(2), 'hex')}));
				v2side = v2side.map((v, k)=>{return v===true ? 2**(v2side.length-1-k) : 0}).reduce((_a, _b)=> _a+_b);
			}

			let payload = this.abi.encodeParameters(labels, values);

			return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
				let params = {
					opround, account, comment, aid, oid,
					v1block, v1leaf, v2block, v2leaf,
					since, v: sig.v, r: sig.r, s: sig.s
				};

				if (typeof(title) !== 'undefined' && typeof(url) !== 'undefined') params = { ...params, title, url}
				if (typeof(v1proof) !== 'undefined' && typeof(v1side) !== 'undefined') params = { ...params, v1proof, v1side}
				if (typeof(v2proof) !== 'undefined' && typeof(v2side) !== 'undefined') params = { ...params, v2proof, v2side}

				let rlp = this.handleRLPx(mfields)(params);
				this.publish('Optract', rlp.serialize());

				return __incomming({data: rlp});
			}).catch((err) => { console.trace(err); })
		}

		const __msgTx = (result, txData) =>
		{
			return this.put(Buffer.from(JSON.stringify(result))).then((out) => {
				let comment = this.IPFSstringtoBytes32(out[0].hash);
				return __inner_msgTx(comment, txData);
			})
		}

		this.newArticle = (url, tags, _comment = "Optract by 11BE") =>
		{
			let account = this.userWallet[this.appName];
			let v1leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v2leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v1block = 0;
			let v2block = 0;
			let domain  = new URL(url).origin;

			return this.getOproundInfo().then((rc) => {
				let opround = rc[0];
                        	let oid = rc[1];
				return mr.parse(url).then((result) => {
					if (tags.length === 0) throw "tags are needed";
					let title = result.title;
					let comment = {tags, 'comment': _comment};
					let aid = ethUtils.bufferToHex(ethUtils.sha256(Buffer.concat([Buffer.from(title), Buffer.from(domain)])));
					return __msgTx(comment, {oid, opround, v1leaf, v1block, v2leaf, v2block, account, title, url, aid});
				}).catch((err) => { console.trace(err); })
			})
		}

		this._becomeNumber = (n) => {
			let rc = Number(n);
			if (isNaN(rc)) throw('The input cannot convert to number');
			return rc;
		}

		this.newVote = (v1block, v1leaf, comments = '') =>
		{
			v1block = this._becomeNumber(v1block);
			let account = this.userWallet[this.appName];
			let v2leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v2block = 0;
			let aid     = '0x11be010000000000000000000000000000000000000000000000000000000000';

			let p = [ this.getProofSet(v1block, v1leaf), this.getOproundInfo() ];

                        return Promise.all(p).then((rc) => { // this will fail if v1leaf not in v1block
                                let v1proof = rc[0][0]
				let v1side  = rc[0][1];
				let opround = rc[1][0];
                        	let oid     = rc[1][1];

				if (typeof(v1proof) === 'undefined' || typeof(v1side) === 'undefined' || opround === 0 || oid === '0x') return {call: 'newVote', rc};

                                if (v1side.length > 24) throw ('now cannot support more than 24 proofs, or, 2**24 (~16.7 million) txHash in a block')

				if (comments.length > 0) {
					let result = { comments, from: account };
					return __msgTx(result, {aid, oid, opround, v1leaf, v1block, v1proof, v1side, v2leaf, v2block, account});
				} else {
					let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
					return __inner_msgTx(content, {aid, oid, opround, v1leaf, v1block, v1proof, v1side, v2leaf, v2block, account});
				}
                        })
		} 

		this.newClaim = (v1block, v1leaf, v2block, v2leaf, comments = '') =>
		{
			v1block = this._becomeNumber(v1block);
			v2block = this._becomeNumber(v2block);
			let account = this.userWallet[this.appName];
			let p = [ this.getProofSet(v1block, v1leaf), this.getProofSet(v2block, v2leaf), this.getOproundInfo() ];
			let aid     = '0x11be020000000000000000000000000000000000000000000000000000000000';

			return Promise.all(p).then((rc) => {
				let v1proof = rc[0][0];
				let v1side  = rc[0][1];
				let v2proof = rc[1][0];
				let v2side  = rc[1][1];
                        	let opround = rc[2][0];
                        	let oid     = rc[2][1];

				if (typeof(v1proof) === 'undefined' || typeof(v1side) === 'undefined' 
				 || typeof(v2proof) === 'undefined' || typeof(v2side) === 'undefined' 
			         || opround === 0 || oid === '0x') { return {call: 'newClaim', rc} }

                                if (v1side.length > 24 || v2side.length > 24) throw ('now cannot support more than 24 proofs, or, 2**24 (~16.7 million) txHash in a block');

				console.log(`DEBUG: in newClaim:`)
				console.dir({aid, oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side})

				if (comments.length > 0) {
					let result = { comments, from: account };
					return __msgTx(result, {aid, oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side});
				} else {
					let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
					return __inner_msgTx(content, {aid, oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side});
				}
			})
		}

		this.claimReward = (opround, block, txhash) => {
			// function claimReward(
			//     uint _opRound, bytes32[] calldata proof, bool[] calldata isLeft, bytes32 txHash, uint _sblockNo,
			//     bytes32 _payload, uint8 _v, bytes32 _r, bytes32 _s
			let p = [ this.locateTx(block)(txhash, 'payloadvrs'), this.getProofSet(block, txhash)];
			return Promise.all(p).then((rc)=>{
				let payload = rc[0][0];
				let v = rc[0][1];
				let r = rc[0][2];
				let s = rc[0][3];
				let proof = rc[1][0];
				let isLeft = rc[1][1];
				console.log(opround, proof, isLeft, txhash, block, payload, v, r, s);
				// if check before send
				// this.call(this.appName)('BlockRegistry')('verifySignature')(this.userWallet[this.appName], payload, v, r, s).then(()=>{})
				return this.sendTk(this.appName)('BlockRegistry')('claimReward')(
				    opround, proof, isLeft, txhash, block, payload, v, r, s)();
			})
		}

		this.rssParser = new Parser();
		this.parseFeed = (feedObj) => {
			let fields = feedObj.fields || {};
			fields.title = fields.title || 'title';
			fields.link = fields.link || 'link';
			fields.contentSnippet = fields.contentSnippet || 'contentSnippet';
			fields.isoDate = fields.isoDate || 'isoDate';

			let category = feedObj.category || [];
			return this.rssParser.parseURL(feedObj.url).then((feed)=>{
				return feed.items.map((rc)=>{
					return { title:rc[fields.title],
						 link:rc[fields.link],
						 isoDate:rc[fields.isoDate],
						 contentSnippet:rc[fields.contentSnippet],
						 category:category
					};
				})
			})
		}

		this.allFeeds = [  // manually manage this for now
		    // # How to add feed?
		    // 1. Most rss contain fields 'title', 'url', 'contentSnippet', 'isoDate', if a
		    //    rss use different name for these fields, write the fields name in the 'fields' object
		    // 2. Add a default category for all feed source into the attribute 'category' of the 'fields' object
		    // tech
			{url: 'http://hackernoon.com/feed', category: ['tech'], fields: {contentSnippet:'content:encoded'}},
			{url: 'https://medium.com/feed/one-zero', category: ['tech']},
			{url: 'http://rss.slashdot.org/Slashdot/slashdotMain', category: ['tech']},
			{url: 'http://feeds.dzone.com/cloud', category: ['tech']},
			{url: 'https://threatpost.com/feed/', category: ['tech']},
			{url: 'https://feeds.feedburner.com/thechangelog', category: ['tech']},
			{url: 'https://www.technologyreview.com/stories.rss', category: ['tech']},  // paywall
			{url: 'https://feeds.feedburner.com/RenewableEnergyNewsRssFeed', category: ['tech']},
		    // emereging technology
			{url: 'http://feeds.dzone.com/iot', category: ['emergingTech']},
			{url: 'https://www.theinternetofthings.eu/rss.xml',category: ['emergingTech']},
			{url: 'https://futurism.com/feed/', category: ['emergingTech']},
			{url: 'https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml', category: ['emergingTech']},
		    // science
			{url: 'https://www.sciencedaily.com/rss/all.xml', category: ['science']},
			{url: 'https://api.quantamagazine.org/feed/', category: ['science']},
			{url: 'http://www.sciencemag.org/rss/news_current.xml', category: ['science']},
			{url: 'http://rss.sciam.com/ScientificAmerican-News', category: ['science']},
			{url: 'https://feeds.newscientist.com/', category: ['science']},
		    //blockchain
			{url: 'https://www.trustnodes.com/feed', category: ['blockchain']},
			{url: 'https://www.theblockcrypto.com/rss.xml', category: ['blockchain']},
			{url: 'https://cointelegraph.com/feed', category: ['blockchain']},
			{url: 'https://blockcast.it/feed/', category: ['blockchain']},
			{url: 'https://medium.com/feed/blockchain', category: ['blockchain'], fields: {contentSnippet:'content:encoded'}},  // outdated
			{url: 'https://www.cryptonewsz.com/feed/', category: ['blockchain']},
			// Yahoo finance use dynamic rss feed, here use top 3 in "market cap" or "Volume (24h)" as of Sep 2019 (coinmarketcap.com)
			{url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=btc-usd,eth-usd,xrp-usd,usdt-usd', category: ['blockchain']},
		    //finance
			{url: 'http://bankinnovation.net/feed/', category: ['finance']},
			{url: 'http://feeds.reuters.com/news/wealth', category: ['finance']},
			{url: 'http://feeds.reuters.com/reuters/businessNews', category: ['finance']},
			{url: 'http://feeds2.feedburner.com/businessinsider', category: ['finance']},
			{url: 'https://asia.nikkei.com/rss/feed/nar', category: ['finance']},
			{url: 'https://www.economist.com/finance-and-economics/rss.xml', category: ['finance']},
			{url: 'https://www.economist.com/business/rss.xml', category: ['finance']},
			{url: 'https://www.scmp.com/rss/92/feed', category: ['finance']},
			{url: 'https://feeds.feedburner.com/fastcompany/headlines', category: ['finance']},
			{url: 'http://feeds.hbr.org/harvardbusiness', category: ['finance']},
		    //investment
			{url: 'http://feeds.marketwatch.com/marketwatch/topstories/', category: ['investment']},
			{url: 'https://feeds.feedburner.com/investmentnews-news-opinion', category: ['investment']},
			{url: 'http://rss.cnn.com/rss/money_pf.rss', category: ['investment']},
			{url: 'https://www.kiplinger.com/about/rss/kiplinger.rss', category: ['investment']},
			{url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html', category: ['investment']},
			// {url: 'https://www.google.com/alerts/feeds/16891219944565400122/1209834010678949068', category: ['investment']},
		    // # candidates: 
		    // https://decrypt.co/feed/
		    // https://www.cnbc.com/rss-feeds/ (there are more feeds)
		    // https://money.cnn.com/services/rss/ (there are more feeds)
		    // http://rss.dw.com/rdf/rss-en-bus  (German TV news channel, business news)
		    // https://developer.yahoo.com/finance/  (yahoo use dynamics rss feeds)
		    // http://feeds.nature.com/nature/rss/current (but with lot's of academic-career discussions)
		    // Google alerts: login google, "create alert"->"show options"->"deliver to" -> choose RSS
		    // BBC news rss feed seems un-maintained
		    // # deprecated or don't consider
		    // https://bitcoinmagazine.com/feed (can't parse by mercury-parser)
		    // https://feeds.a.dj.com/rss/RSSMarketsMain.xml  wall street journal, with paywall
		]

		this.getRssArticles = () =>
		{
			const categoryKeywords = {
				// Notes:
				// * use only lower case
				// * avoid using short ones which is a common root of other words
				// * include part of domain names to make sure all url from allFeeds are categorized
				// * this should be a temporary solution, a better way is to use "AI" or users to tag
				'tech': [
				    'technology', '/tech', 'hacker'
				],
				'emergingTech': [
				    'internetofthings', 'futurism', 'robotic', 'artificial_intelligence',
				    'quantum comput', 'artificial intelligence'
				],
				'science': [
				    'astronomy', 'biology', 'physics', 'mathemati', 'science.slashdot'
				],
				'blockchain': [
				    'blockchain', 'ethereum', 'bitcoin', 'dapp', 'cryoto currency', 'libra'
				],
				'finance': [
				    'finance', 'economics', 'economy', 'business', 'trade-war', 'trade war'
				],
				'investment': [
				    'investment'
				]
			}
			const hasKeyword = (keywords, title) => {
				return keywords.some((keyword)=> {return title.toLowerCase().includes(keyword)})
			}

			// time related
			let maxReleasedTime = 86400000 * 7;  // 7 days
			let now = new Date();
			now = now.getTime();  // epoch in ms
			const isOld = (isoDate) => {  // isoDate looks like '2019-08-30T14:48:00.000Z'
				let pubDate = Date.parse(isoDate);  // epoch in ms
				if (isNaN(pubDate)) {
					console.log(`DEBUG: wrong format for date string ${isoDate}`);
					return true;
				}
				if ((now - pubDate) < maxReleasedTime) {
					return false;
				} else {
					return true;
				}
			}

			const shuffleArray = (array) => {
				for (let i = array.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[array[i], array[j]] = [array[j], array[i]];
				}
			}

			const mercuryParsedTitle = (url) => {
				return mr.parse(url).then((result) => {
					return result.title;
				}).catch((err) => { console.log('Error in mercuryParsedTitle'); console.trace(err); })
			}

			let p = this.allFeeds.map((feed)=>{
				return this.parseFeed(feed)
				       .catch((err) => {console.trace(err); return {};})
			});

			return Promise.all(p).then((rc) => {
				let feedInfoList = [];
				rc.map((a) => {
					if (Object.keys(a).length != 0) {
						feedInfoList = [...feedInfoList, ...a.slice(0, 20)]
					}
				});
                                shuffleArray(feedInfoList);
				let feedInfos = feedInfoList.slice(0, 30).map((feedInfo, idx) => {
					// TODO: unshorten url (feedInfo.link)
					return mercuryParsedTitle(feedInfo.link).then((title)=>{
						let url = feedInfo.link;
						let domain  = new URL(url).origin;

						if (typeof(title) === 'undefined' || typeof(domain) === 'undefined') return;
						let aid = ethUtils.bufferToHex(ethUtils.sha256(Buffer.concat([Buffer.from(title), Buffer.from(domain)])));

						// return when aid exist in recent oprounds
						if (this.game.curated.hasOwnProperty(aid)) return;
						// let prevAid = __getOproundAids(this.game.opround-1);  // get a list of aid of prev round
						// if (aid in prevAid) return;

						// TODO: determine tags from contentSnippet or parsed content
						let tags;
						if (typeof(feedInfo.category) === 'undefined') {
							tags = [];
						} else {
							tags = [...feedInfo.category];  // assume feedInfo.category is array
						}
						if (hasKeyword(categoryKeywords['tech'], title) || hasKeyword(categoryKeywords['tech'], url)) tags.push('tech');
						if (hasKeyword(categoryKeywords['emergingTech'], title) || hasKeyword(categoryKeywords['emergingTech'], url)) tags.push('emergingTech');
						if (hasKeyword(categoryKeywords['science'], title) || hasKeyword(categoryKeywords['science'], url)) tags.push('science');
						if (hasKeyword(categoryKeywords['blockchain'], title) || hasKeyword(categoryKeywords['blockchain'], url)) tags.push('blockchain');
						if (hasKeyword(categoryKeywords['finance'], title) || hasKeyword(categoryKeywords['finance'], url)) tags.push('finance');
						if (hasKeyword(categoryKeywords['investment'], title) || hasKeyword(categoryKeywords['investment'], url)) tags.push('investment');
						tags = [...new Set(tags)];
						if (tags.length === 0) console.log('no tag for:' + title + ', ' + url);

						// remove old artucles; feeds without date information (such as hackernoon and nikkei) can pass this filter for now
						let isoDate = feedInfo.isoDate;
						if (typeof(isoDate) !== 'undefined') {
							if (isOld(isoDate)) return
						}

						// if ( typeof(isoDate) === 'undefined' || tags.length == 0) console.log(`[${tags}]-[${isoDate}]:: ${url}`);
						return {url, tags, isoDate};
					})
				})
				return Promise.all(feedInfos).then((rc)=>{
					return rc.filter((ele)=>{return typeof(ele) !== 'undefined' && Object.keys(ele).length != 0});
				})
			})
		}

		this.newBotArticles = (_comment = "send by 11be bot") =>
		{
			// maybe TODO: let p = [this.getRssArticles, this.getXXXarticles]; Promise.all(p).then(()=>{})
			if (this.pending > 12) {  // assuming one can send that many articles in a bot-period
				console.log(`DEBUG: too many pending articles (${this.pending}), skip newBotArticles`)
				return;
			}

			this.getRssArticles().then((articles)=>{  // articles = [{url, tags}, {url, tags}, ...]
				articles.slice(0, 12).map((urltags, i)=>{
					setTimeout(this.newArticle, 40000*(i+1), urltags.url, urltags.tags, _comment);
				})
			})
			.catch((err) => { console.log(`newBotArticles:`); console.trace(err); return;})
		}

		this.listAccBlockTxs = (blkNo, acc) =>
		{
			return new Promise((resolve, reject)=>{
				this.db.get(['block', blkNo], (err, blk) => {
					let txs = {'curated': [], 'voted': [], 'claimed': [], 'aids': {} }
					let tx2acc = blk.tx2acc;
					let tx2aid = blk.tx2aid;
					Object.keys(tx2acc).map((tx)=>{
						if (tx2acc[tx] === acc ) {
							if (tx2aid[tx] === '0x11be010000000000000000000000000000000000000000000000000000000000') {
								txs['voted'].push(tx);
							} else if (tx2aid[tx] === '0x11be020000000000000000000000000000000000000000000000000000000000') {
								txs['claimed'].push(tx);
							} else {
								txs['curated'].push(tx);
								txs['aids'][tx] = tx2aid[tx];
							}
						}
					})
					resolve([blkNo, txs]);
				})
			})
		}

		this.listRangeAccTxs = (blk1, blk2, acc) =>
		{
			if (blk2 < blk1) return;
			let blks = Array.from({length: blk2-blk1+1}, (v, k)=>k+blk1);
			let p_txs = blks.map((v, k)=>this.listAccBlockTxs(v, acc));
			return Promise.all(p_txs).then((rc)=>{
				// rc = [ [ blk1, {'curated':[tx1, ...], 'voted':[tx2, ...], 'claimed':[tx3, ...]}]
				//	  [ blk2, {'curated':[], 'voted': [], 'claimed':[]}], ...
				//      ]
				return rc;
			})
		}

		this.listAccLotteryWins = (op, acc) =>  // return winning votes
		{
			// Too much query if ask root-chain:
			//     this.call(this.appName)('BlockRegistry')('isWinningTicket')(opround, txHash);
			let p = [this.getOproundInfo(op), this.getOproundLottery(op)];
			return Promise.all(p).then((rc)=>{
				let blk1 = rc[0][2];  // init block no.
				let blk2 = rc[1][1];  // lottery block no.
				let lotteryWinNumber = rc[1][2];
				
				let lottery = new Lottery();

				let output = { opround: op, account: acc, curated: {}, voted: {}, aids: {} };
				if (lotteryWinNumber === '0x0000000000000000000000000000000000000000000000000000000000000000') return output;

				return this.listRangeAccTxs(blk1, blk2, acc).then((rc)=>{
					let blktxs = rc;  // [ [blk1, { curated: [], voted: [], claimed: [] }], [ blk2, {...}] ]

					blktxs.map((v)=>{
						let blk = v[0];
						let txs = v[1];

						output.curated = { ...output.curated, [blk]: lottery.sample(txs['curated'], lotteryWinNumber) };
						if (typeof(output.aids[blk]) === 'undefined') output.aids[blk] = [];
						output.curated[blk].map((tx)=>{
							output.aids[blk].push(txs['aids'][tx]);
						})
						output.voted = { ...output.voted, [blk]: lottery.sample(txs['voted'], lotteryWinNumber) };
					})

					return output;
				})
			})
			.catch((err) => { console.log(`listAccLotteryWins: `); console.trace(err); return output; });
		}

		this.listBlockCurationTxs = (blkNo) =>
		{
			return new Promise((resolve, reject)=>{
				this.db.get(['block', blkNo], (err, blk) => {
					let txs = {'curated': [], 'voted': [], 'claimed': [], 'aids': {} }
					let tx2aid = blk.tx2aid;
					Object.keys(tx2aid).map((tx)=>{
						if (tx2aid[tx] !== '0x11be010000000000000000000000000000000000000000000000000000000000' && 
						    tx2aid[tx] !== '0x11be020000000000000000000000000000000000000000000000000000000000'
						) {
							txs['curated'].push(tx);
							txs['aids'][tx] = tx2aid[tx];
						}
					})
					resolve([blkNo, txs]);
				})
			})
		}

		this.listRangeCurationTxs = (blk1, blk2) => 
		{
			if (blk2 < blk1) return;
			let blks = Array.from({length: blk2-blk1+1}, (v, k)=>k+blk1);
			let p_txs = blks.map((v, k)=>this.listBlockCurationTxs(v));
			return Promise.all(p_txs).then((rc)=>{
				return rc;
			})
		}

		this.listCurationLotteryWins = (op) =>  // return tx of winning curation
		{
			let p = [this.getOproundInfo(op), this.getOproundLottery(op)];
			return Promise.all(p).then((rc)=>{
				let blk1 = rc[0][2];  // init block no.
				let blk2 = rc[1][1];  // lottery block no.
				let lotteryWinNumber = rc[1][2];
				
				let lottery = new Lottery();

				let output = { opround: op, curated: {}, voted: {}, aids: {} };
				if (lotteryWinNumber === '0x0000000000000000000000000000000000000000000000000000000000000000') return output;
				return this.listRangeCurationTxs(blk1, blk2).then((rc)=>{
					let blktxs = rc;  // [ [blk1, { curated: [], voted: [], claimed: [] }], [ blk2, {...}] ]

					blktxs.map((v)=>{
						let blk = v[0];
						let txs = v[1];

						output.curated = { ...output.curated, [blk]: lottery.sample(txs['curated'], lotteryWinNumber) };
						if (typeof(output.aids[blk]) === 'undefined') output.aids[blk] = [];
						output.curated[blk].map((tx)=>{
							output.aids[blk].push(txs['aids'][tx]);
						})
						output.voted = { ...output.voted, [blk]: lottery.sample(txs['voted'], lotteryWinNumber) };
					})

					return output;
				})
			})
			.catch((err) => { console.log(`listCurationLotteryWins: `); console.trace(err); return output; });
		}

		const __node_status = () =>
		{
			let reports = this.reports();
			if (typeof(reports.account[this.appName]) === 'undefined') {
				let pending = this.pending;
				let opgame  = this.game;

				let output = {
					EthBlock: reports.ethereum.blockHeight,
					OptractBlock: reports.optract.epoch,
					OproundNo: reports.optract.opround,
					PeerCounts: reports.pubsub.connected,
					Account: null,
					MemberStatus: null,
					pending
				};
					
				this.emit('opStats', output); 
			} else {
				this.memberStatus(this.userWallet[this.appName]).then((rc) => {
					let pending = this.pending;
					let opgame  = this.game;

					let output = {
						EthBlock: reports.ethereum.blockHeight,
						OptractBlock: reports.optract.epoch,
						OproundNo: reports.optract.opround,
						PeerCounts: reports.pubsub.connected,
						Account: reports.account[this.appName],
						MemberStatus: rc[0],
						pending
					};

					this.emit('opStats', output); 
				})
			}
		}

		this.statProbe = () =>
		{
			return __node_status();
		}

		const __retry_pending = () =>
		{
			let account = this.userWallet[this.appName];

			if (typeof(this.pending.txhash[account]) === 'undefined'|| this.pending.txhash[account].length === 0) return __node_status();

			let dhashs = this.pending.txhash[account];
			console.log('Retry snapshot');

			dhashs.slice(0, 6).map((thash, i) => {  // 6x40=240s, slight shorter than observer (300s)
				return setTimeout((hash) => {
					let rlpx = this.pending.txdata[hash];
					this.publish('Optract', rlpx);
					console.log(`DEBUG: resending ${hash} as it has not been seen in pending pool.`)
				}, 40000*(i+1) + Math.random()*100, thash);
			})

			setTimeout(__node_status, 60011);
		}

		// slightly different on pending function for regular clients
		const __vet_pending = (msg) =>
		{
			// merge with own pending pool
			let data = msg.data;
			if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
			        return;
			}

			let account = ethUtils.bufferToHex(data.validator);

			let p = [
				this.getBlockNo(),
				this.isValidator(account)
			]

			Promise.all(p).then((rc) => {
				let cache = ethUtils.bufferToHex(data.cache);
				cache = '0x' + cache.slice(2).padStart(64, '0');
				let nonce = ethUtils.bufferToInt(data.nonce);
				let since = ethUtils.bufferToInt(data.since);
				let pending = ethUtils.bufferToInt(data.pending);

				if (pending !== rc[0] || !rc[1]) return;

				let _payload = this.abi.encodeParameters(
					['uint', 'uint', 'address', 'bytes32', 'uint'],
					[nonce, pending, account, cache, since]
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
					let ipfsHash = this.Bytes32toIPFSstring(cache); console.log(`Snapshot IPFS: ${ipfsHash} for block ${pending}`);
					let p = [
						this.get(ipfsHash).then((buf) => { return JSON.parse(buf.toString()) }),
						this.packSnap()
					];
	
					Promise.all(p).then((results) => {
						let pending = results[0]; 
						let mystats = results[1]; 
						if (pending[0].length === 0) return;
						let remains = keeping([...mystats[0]], [...pending[0]]); // pass in duplicates
						let confirmed = keeping([...mystats[0]], [...remains])
						if (confirmed.length === 0 ) return; 
						this.purgeSnapShot(pending, confirmed); 
					}).catch((err) => { console.log(`OnpendingHandler: `); console.trace(err); })
				}
			})
		}

		this.purgeSnapShot = (remote, dhashs) => 
		{
			//determine which type of each dhash, and then 
			console.log('Purging snapshot');
			dhashs.map((thash) => {
				return setTimeout((hash) => {
					let idx = remote[0].indexOf(hash);
					let data = this.handleRLPx(mfields)(Buffer.from(remote[2][idx]));
					let account = ethUtils.bufferToHex(data.account);
					let aid = ethUtils.bufferToHex(data.aid);
					let oid = ethUtils.bufferToHex(data.oid);
					let sigout = {
						originAddress: account,
						payload: Buffer.from(remote[1][idx]),
						v: ethUtils.bufferToInt(data.v),
						r: data.r, s: data.s,
						netID: this.networkID // FIXME: we need to include networkID in snapshot
					}

					const __clear_hash = () =>
					{
						if ( typeof(this.pending.txhash[account]) === 'undefined'
						  || this.pending.txhash[account].indexOf(hash) === -1) { return true; }

						this.pending.txhash[account].splice(this.pending.txhash[account].indexOf(hash), 1);
						delete this.pending.txdata[hash];
						delete this.pending.payload[hash];
						this.pending.nonces[account] = this.pending.nonces[account] - 1;
						return true;
					}

					if (this.verifySignature(sigout)) {
						if (account === this.userWallet[this.appName]) {
							console.log(`DEBUG: found one of my own tx, handling ...`);
							if (aid === '0x11be020000000000000000000000000000000000000000000000000000000000') {
								let v1leaf = ethUtils.bufferToHex(data.v1leaf);
								let v1blk  = ethUtils.bufferToHex(data.v1block);

								const __add_db = (v1leaf, v1blk) => (resolve, reject) => 
								{
									this.db.put(['histxs', hash], {v1leaf, v1blk, oid}, (err, rc) => {
										if (err) return reject(err);
										resolve();
									})
								}

								return new Promise(__add_db(v1leaf, v1blk)).then(__clear_hash)
									     .catch((err) => { console.log('In purgeSnapShot:'); console.trace(err); })
							} else if (aid === '0x11be010000000000000000000000000000000000000000000000000000000000') {
								let v1leaf = ethUtils.bufferToHex(data.v1leaf);
								let v1blk  = ethUtils.bufferToInt(data.v1block);

								const __add_vt = (account, v1aid, url, since) => (resolve, reject) =>
								{
									this.db.put(['vault', account, v1aid], {url, since}, (e,r) => { 
										if(e) return reject(e); 
										resolve(); 
									})
								}

								return this.locateTx(v1blk)(v1leaf).then((v1data) => {
									let v1aid = ethUtils.bufferToHex(v1data.aid);
									let url   = v1data.url.toString();
									let since = ethUtils.bufferToInt(v1data.since);
									return new Promise(__add_vt(account, v1aid, url, since)).then(__clear_hash)
									             .catch((err) => { console.log('In purgeSnapShot:'); console.trace(err); })
								})
							}
						}
							
						return __clear_hash();
					}
				}, 0, thash);
                        })
		}

		// internal onpending handler
		const __gen_pending = (msg) => 
		{
			// merge with own pending pool
			let data = msg.data;
			if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
			        return;
			}

			let account = ethUtils.bufferToHex(data.validator);

			let p = [
				this.getBlockNo(),
				this.isValidator(account)
			]

			Promise.all(p).then((rc) => {
				let cache = ethUtils.bufferToHex(data.cache);
				cache = '0x' + cache.slice(2).padStart(64, '0');
				let nonce = ethUtils.bufferToInt(data.nonce);
				let since = ethUtils.bufferToInt(data.since);
				let pending = ethUtils.bufferToInt(data.pending);

				if (pending !== rc[0] || !rc[1]) return;

				let _payload = this.abi.encodeParameters(
					['uint', 'uint', 'address', 'bytes32', 'uint'],
					[nonce, pending, account, cache, since]
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
					let ipfsHash = this.Bytes32toIPFSstring(cache); console.log(`Snapshot IPFS: ${ipfsHash} for block ${pending}`);
					let p = [
						this.get(ipfsHash).then((buf) => { return JSON.parse(buf.toString()) }),
						this.packSnap()
					];
	
					Promise.all(p).then((results) => {
						let pending = results[0]; 
						let mystats = results[1]; 
						if (pending[0].length === 0) return;
						let acquire = missing([...mystats[0]], [...pending[0]]); // pass in duplicates
						if (acquire.length === 0 ) return; 
						this.mergeSnapShot(pending, acquire); 
					}).catch((err) => { console.log(`OnpendingHandler: `); console.trace(err); })
				}
			})
		}

		this.parseMsgRLPx = (mRLPx) => { return this.handleRLPx(mfields)(mRLPx); }
		this.showTxContent = (txhash) => { return this.parseMsgRLPx(this.pending.txdata[txhash]); }

		this.mergeSnapShot = (remote, dhashs) =>
		{
			console.log('Merging snapshot');
			dhashs.map((thash) => {
				return setTimeout((hash) => {
					let idx = remote[0].indexOf(hash);
					let data = this.handleRLPx(mfields)(Buffer.from(remote[2][idx]));
					let account = ethUtils.bufferToHex(data.account);
					let aid = ethUtils.bufferToHex(data.aid);
					let oid = ethUtils.bufferToHex(data.oid);
					let sigout = {
						originAddress: account,
						payload: Buffer.from(remote[1][idx]),
						v: ethUtils.bufferToInt(data.v),
						r: data.r, s: data.s,
						netID: this.networkID // FIXME: we need to include networkID in snapshot
					}

					const __update_pending = () => 
					{
						if (typeof(this.pending['txhash'][account]) === 'undefined' || typeof(this.pending['nonces'][account]) === 'undefined') {
							this.pending['txhash'][account] = [];
							this.pending['nonces'][account] = 0;
						}

						let pack = Buffer.from(remote[2][idx]); let payload = Buffer.from(remote[1][idx]);
		                                this.pending['txhash'][account].push(hash);
						this.pending['txhash'][account] = Array.from(new Set(this.pending['txhash'][account])).sort();
						this.pending['nonces'][account] = this.pending['txhash'][account].length;
		                                this.pending['txdata'][hash]  = pack;
		                                this.pending['payload'][hash] = payload;
	
						console.log(`INFO: Got ${hash} by ${account} from snapshot`); 
						// silenced. just to cache content on local ipfs.
                                                if (data.comment.length != 0) {  // vote have no content
							let _comment = '0x' + ethUtils.bufferToHex(data.comment).slice(2).padStart(64, '0');
                                                        let ipfshash = this.Bytes32toIPFSstring(_comment);
							if (!this.validIPFSHash(ipfshash)) {
								console.log(`DEBUG: erroneous comment IPFS hash from ${hash}, dump:`);
								console.log(ipfshash);
                                                                // console.dir(data);
							} else { 
								this.ipfs.pin.add(ipfshash);
							}
                                                }
					}
	
					if (this.verifySignature(sigout)){
						// These checks can only be done after signature verified.
						if (aid === '0x11be010000000000000000000000000000000000000000000000000000000000') {
							let v1block = ethUtils.bufferToInt(data.v1block);
							let v1leaf  = ethUtils.bufferToHex(data.v1leaf);

							return this.locateTx(v1block)(v1leaf, 'aid').then((v1aid) => {
								// verify double vote
								if (typeof(this.aidWatch[v1aid]) === 'undefined') {
									this.aidWatch[v1aid] = { curated: [], voted: [], claimed: [] }
								} 

								if (this.aidWatch[v1aid].voted.indexOf(account) === -1) {
									this.aidWatch[v1aid].voted.push(account);
									return __update_pending();
								} else if (this.aidWatch[v1aid].voted.indexOf(account) !== -1 ) {
									console.log(`DEBUG: no double votes in same block`);
									return;
								}
							})

						} else if (aid === '0x11be020000000000000000000000000000000000000000000000000000000000') {
							if (oid !== this.game.oid) return;
							// verify double claim of a ticket and article
							let v1leaf = ethUtils.bufferToHex(data.v1leaf);
							let v2leaf = ethUtils.bufferToHex(data.v2leaf);
							let v2block = ethUtils.bufferToInt(data.v2block);

							return this.locateTx(v2block)(v2leaf, 'aid').then((v2aid) => {
								if (typeof(this.aidWatch[v2aid]) === 'undefined') {
									this.aidWatch[v2aid] = { curated: [], voted: [], claimed: [] }
								} 
						
								if (typeof(this.game.clmWatch[account]) !== 'undefined' && this.game.clmWatch[account].indexOf(v1leaf) !== -1) {
									console.log(`DEBUG: no double v2 votes using same ticket`);
									return;
								}
							
								if (this.aidWatch[v2aid].claimed.indexOf(account) === -1 && typeof(this.clmWatch[v1leaf]) === 'undefined') {
									this.aidWatch[v2aid].claimed.push(account);
									this.clmWatch[v1leaf] = v2aid;
									return __update_pending();
								} else if (this.aidWatch[v2aid].claimed.indexOf(account) !== -1 || this.clmWatch[v1leaf]) {
									console.log(`DEBUG: no double v2 votes in same block`);
									return;
								}
							})
						} else { // curate
							// verify double curate
							if (typeof(this.aidWatch[aid]) === 'undefined') {
								this.aidWatch[aid] = { curated: [], voted: [], claimed: [] }
							} 

							if (this.aidWatch[aid].curated.indexOf(account) === -1) {
								this.aidWatch[aid].curated.push(account);
								return __update_pending();
							} else if (this.aidWatch[aid].curated.indexOf(account) !== -1 ) {
								console.log(`DEBUG: no double curation in same block`);
								return;
							}
						}
					}
				}, 0, thash);
			})
		}
	
		this.makeMerkleTreeAndUploadRoot = () =>
                {
			const OpRStats = {
				__GENESIS__: 0, // opRound ends
				__NDR__:     1, // opRound ends
				__V1PASS__:  2, 
				__V2PASS__:  3, // opRound ends
				__REGULAR__: 4
			};

                        // Currently, we will group all block data into single JSON and publish it on IPFS
                        let blkObj =  {myEpoch: this.myEpoch, data: {} };
                        let leaves = [];

                        // is this block data structure good enough?
			let snapshot = this.packSnap();
		        if (snapshot[0].length === 0) return;
			if (Number(this.lastBlk) !== this.myEpoch - 1) return; // node not yet fully synced, cannot calculate data for block production

		        leaves = [...snapshot[0]];
		        blkObj.data = snapshot;

                        console.log(`DEBUG: Final Leaves for myEpoch = ${blkObj.myEpoch}:`); console.dir(leaves);

                        let merkleTree = this.makeMerkleTree(leaves);
                        let merkleRoot = ethUtils.bufferToHex(merkleTree.getMerkleRoot());
                        console.log(`Block Merkle Root: ${merkleRoot}`);

			const __genAidBlk = () =>
			{
				// aid tree and aid block data
				// aid-tree: {aid01: {url, tx01:IPFShash, tx02:IPFShash, ...}, aid02:{...}, ...}
				let aidObj = {};

				snapshot[0].map((txhash)=>{
					let txObj = this.showTxContent(txhash);
					let aid = ethUtils.bufferToHex(txObj.aid);
					let _comment = '0x' + ethUtils.bufferToHex(txObj.comment).slice(2).padStart(64, '0');
					let ipfs = this.Bytes32toIPFSstring(_comment);
					let url = txObj.url.toString();
					if (typeof(aidObj[aid]) === 'undefined') aidObj[aid] = {url};
					aidObj[aid][txhash] = ipfs;
				});

				let aidList = Object.keys(aidObj);
				let aidMerkleTree = this.makeMerkleTree(aidList);
				let aidMerkleRoot = ethUtils.bufferToHex(aidMerkleTree.getMerkleRoot());

				return this.put(Buffer.from(JSON.stringify(aidObj))).then((rc)=>{
					console.log('AID IPFS Put Results'); console.dir(rc);
					let ipfscid = this.IPFSstringtoBytes32(rc[0].hash);
					console.log('AID IPFS CID: ' + ipfscid);
					return [ipfscid, aidMerkleRoot];
				})
			};

			// OpRound ending judgement
			// 3 critiria 
			// a) timestamp: (solidity call check) -> promise
			// b) which phase: (solidity call check) -> promise
			// c) check v1 or v2 count according to phase (solidity call check + cache) -> promise [ depends on b) ]
			// closure
			const __endOpRound = () =>
			{
				let p = [this.getOpround(), this.getOproundProgress(), this.getMaxVoteTime()];
				return Promise.all(p).then((rc) => {
					let now = Math.floor(Date.now() / 1000);  // or use this.myStamp?
					let articleCount = rc[1][0];
					let atV1 = rc[1][1];
					let v1EndTime = rc[1][2];
					let v2EndTime = rc[1][3];
					// let roundVote1Count = rc[1][4];
					// let roundVote2Count = rc[1][5];
					let maxVoteTime = rc[2];
					// rc[1] return(articleCount, atV1, v1EndTime, v2EndTime, roundVote1Count, roundVote2Count);
					if (rc[0] === 0) {  // genesis
						if (Object.keys(this.aidWatch).length + articleCount >= 7) {
							// 7 is hard coded in contract for now
							return OpRStats['__GENESIS__'];		
						} else {
							return OpRStats['__REGULAR__'];
						}
					} else if (atV1) {
						if (now > v2EndTime + maxVoteTime) {  // no draw round
							return OpRStats['__NDR__'];
						} else {
							let v1count = Object.values(this.aidWatch).reduce((c, i) => { return c = c + i.voted.length }, 0); 
							return this.call(this.appName)('BlockRegistry')('isEnoughV1')(v1count).then((yn)=>{
								if (yn === true) {
									return OpRStats['__V1PASS__'];
								} else {
									return OpRStats['__REGULAR__'];
								}
							})
						}
					} else {  // !atV1
						if (now > v1EndTime + maxVoteTime) {  // no draw round
							return OpRStats['__NDR__'];
						} else {
							let v2count = Object.keys(this.clmWatch).length;  // clmWatch
							return this.call(this.appName)('BlockRegistry')('isEnoughV2')(v2count).then((yn)=>{
								if (yn === true) {
									return OpRStats['__V2PASS__'];
								} else {
									return OpRStats['__REGULAR__'];
								}
							})
						}
					}
				})

			}

			const __genblk = () =>
			{
				return this.generateBlock(blkObj).then((rc)=>{
					console.log('IPFS Put Results'); console.dir(rc);
					let ipfscid = this.IPFSstringtoBytes32(rc[1][0].hash);
					console.log('IPFS CID: ' + ipfscid);
					return ipfscid;
				})
				
			};

			const __genFinalistIPFS = (baseline) => 
			{
				let finalistURL = [];
				// choose qualified aid
				this.game.aidwon = [];  // aidwon is created here

				Object.keys(this.game.aid2vc).map((aid) => { 
					let v = this.game.aid2vc[aid];
					if(v > baseline) {
						this.game.aidwon[aid] = true;
						let url = this.game.aidUrl[aid];
						finalistURL.push(url);		
					} else {
						this.game.aidwon[aid] = false;
					}
				});

				let fURL = Buffer.from(JSON.stringify(finalistURL));

				return this.put(fURL).then((rc)=>{
					let ipfscid = this.IPFSstringtoBytes32(rc[0].hash);
					console.log('finalist IPFS CID: ' + ipfscid);
					return ipfscid;
				})
			};

			const __genSdb = () => // can be merged into __genFinalistIPFS()
			{
				let ipfscid;
				let minSuccessRate;

				// sDB format: JSON
				// { acc: [nwin, ntotal], ... }

				if (this.game.opround < 1) return Promise.resolve([ '0x0', '0' ]);

                                // update 'ntotal', the total curation (v1 votes) of each user
				//   - sDB of previous opround, if any
	                        //   - this.db.acc2vc
                                // note that lastSrates is the **accumulated** srate until previous opround
				// update 'nwin', the successful curation in this opround
        	                //   - this.game.aidwon                                 aid => bool
                	        //   - this.game.voted                                  acc => [aid ...]
				// ---> nwin = previous nwin + this.game.voted[acc].reduce((c,i) => { c = c + (this.game.aidwon[i] ? 1 : 0) }, 0)
				const __calc_srates = (resolve, reject) => {
					this.db.get(['acc2vc'], (err, acc2vc) => {
                                		Object.keys(acc2vc).map((acc) => {
                                        		if (typeof(this.game.lastSrates[acc]) === 'undefined') this.game.lastSrates[acc] = [0, 0];
	                                        	this.game.lastSrates[acc][1] = acc2vc[acc];
        	                        	})

                                		Object.keys(this.game.voted).map((acc) => {
                                        		this.game.lastSrates[acc][0] += [ ...new Set(this.game.voted[acc]) ].reduce((c,aid) => {return this.game.aidwon[aid] ? c+1 : c }, 0);
						})

						this.put(Buffer.from(JSON.stringify(this.game.lastSrates))).then(resolve);
					})
				}

				return new Promise(__calc_srates).then((rc) => {
					let ipfscid = this.IPFSstringtoBytes32(rc[0].hash);
					let srates  = Object.keys(this.game.lastSrates).map((acc) => {
						return Math.floor(this.game.lastSrates[acc][0] / this.game.lastSrates[acc][1] * 100)
					})

					const __medium = (inArray) =>
					{
						let list = inArray.sort();

						if (inArray.length === 1) return inArray[0];

						if (inArray.length % 2 === 0) {
							let idx  = inArray.length / 2;
							return (list[idx] + list[idx - 1]) / 2;
						} else {
							let idx  = (inArray.length - 1) / 2 + 1;
							return list[idx];
						}
					}

					let minSuccessRate = __medium(srates);

					return [ipfscid, minSuccessRate];
				})
			}


			return __endOpRound().then((rc)=>{
                                let v1count = Object.values(this.aidWatch).reduce((c, i) => { c = c + i.voted.length; return c }, 0); 
				let v2count = Object.keys(this.clmWatch).length;  // clmWatch
				console.log('opround status id: ' + rc);
                                if (rc === 0 || rc === 4) {  // genesis or regular
					let p = [__genblk(), __genAidBlk()];
					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let aidIpfscid = rc[1][0];
						let aidMerkleRoot = rc[1][1];
						let baseline = 0;
						let finalistIPFS = '0x0000000000000000000000000000000000000000000000000000000000000000';
						let successRateDB = '0x0000000000000000000000000000000000000000000000000000000000000000';
						let minSuccessRate = 0;
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
                                            console.log(aidMerkleRoot, aidIpfscid);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, aidMerkleRoot, aidIpfscid, successRateDB, finalistIPFS, [snapshot[0].length, v1count, v2count, minSuccessRate, baseline])();
					})
                                } else if (rc === 1) {  // NDR
					let baseline = 0;
					let p = [__genblk(), __genAidBlk()];

					//if (v1count > 0 || Object.values(this.game.acc2vc).reduce((c, i) => { c = c + i; return c }, 0) > 0) p.push(__genSdb());
					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let aidIpfscid = rc[1][0];
						let aidMerkleRoot = rc[1][1];
						let finalistIPFS = '0x0000000000000000000000000000000000000000000000000000000000000000';
						let successRateDB = this.game.lastSDB;
						let minSuccessRate = Number(this.game.lastMsr);
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, aidMerkleRoot, aidIpfscid, successRateDB, finalistIPFS, [snapshot[0].length, v1count, v2count, minSuccessRate, baseline])();
						})
				} else if (rc === 2) { // v1pass, trigger draw
					let baseline = 0;
					let p = [__genblk(), __genAidBlk()];

					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let aidIpfscid = rc[1][0];
						let aidMerkleRoot = rc[1][1];
						let finalistIPFS = '0x0000000000000000000000000000000000000000000000000000000000000000';
						let successRateDB = '0x0000000000000000000000000000000000000000000000000000000000000000';
						let minSuccessRate = 0;
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, aidMerkleRoot, aidIpfscid, successRateDB, finalistIPFS, [snapshot[0].length, v1count, v2count, minSuccessRate, baseline])();
						})
				} else if (rc === 3) {
					let _aid2cc = {};
					Object.keys(this.aidWatch).map((_aid) => { _aid2cc[_aid] = this.aidWatch[_aid].claimed.length });
					Object.keys(this.game.aid2cc).map((_aid) => { 
						if (typeof(_aid2cc[_aid]) === 'undefined') _aid2cc[_aid] = 0;
						_aid2cc[_aid] = _aid2cc[_aid] + this.game.aid2cc[_aid];
					});
					let baseline = Math.max(...Object.values(_aid2cc));
					let p = [__genblk(), __genFinalistIPFS(baseline), __genSdb(), __genAidBlk()];
					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let finalistIPFS = rc[1];
						let successRateDB = rc[2][0];
						let minSuccessRate = rc[2][1];
						let aidIpfscid = rc[3][0];
						let aidMerkleRoot = rc[3][1];
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, aidMerkleRoot, aidIpfscid, successRateDB, finalistIPFS, [snapshot[0].length, v1count, v2count, minSuccessRate, baseline])();
						})

                                } else {
					throw 'Unknown opRStats';
				}
			})
			.catch((err) => { console.log(`ERROR in makeMerkleTreeAndUploadRoot`); console.trace(err); });
		}

                this.makeMerkleTree = (leaves) => {
                        let merkleTree = new MerkleTree();
                        merkleTree.addLeaves(leaves);
                        merkleTree.makeTree();
                        return merkleTree;
                }

		this.getMerkleProof = (leaves, targetLeaf) => {
			let merkleTree = this.makeMerkleTree(leaves);

			let __leafBuffer = Buffer.from(targetLeaf.slice(2), 'hex');
                        let txIdx = merkleTree.tree.leaves.findIndex( (x) => { return Buffer.compare(x, __leafBuffer) == 0 } );
                        if (txIdx == -1) {
                                console.log('Cannot find leave in tree!');
                                return [];
                        } else {
                                console.log(`Found leave in tree! Index: ${txIdx}`);
                        }

                        let proofArr = merkleTree.getProof(txIdx, true);
                        let proof = proofArr[1].map((x) => {return ethUtils.bufferToHex(x);});
                        let isLeft = proofArr[0];

                        let merkleRoot = ethUtils.bufferToHex(merkleTree.getMerkleRoot());
			return [proof, isLeft, merkleRoot];
		}

                this.generateBlock = (blkObj) =>
                {
                        let database = this.appCfgs.dapps[this.appName].database;
			let bb = Buffer.from(JSON.stringify(blkObj));
			let bn = blkObj.myEpoch;

                        const __genBlockBlob = (blkNo, blkbuf) => (resolve, reject) =>
                        {
                                // manually mkdir `${database}` for now
                                mkdirp(path.join(database, String(blkNo)), (err)=>{
                                        if (err) console.error(err);
                                        fs.writeFile(path.join(database, String(blkNo), 'blockBlob'), blkbuf, (errr) => {
                                                if (errr) return reject(errr);
                                                resolve(path.join(database, String(blkNo), 'blockBlob'));
                                        })
                                });
                        }

                        return Promise.all([ new Promise(__genBlockBlob(bn, bb)), this.put(bb) ])
                                    .catch((err) => { console.log(`ERROR in generateBlock`); console.trace(err); });
                }

                this.getBlockData = (sblockNo) => {
                        return this.getBlockInfo(sblockNo).then( (rc) => {
				return { 
					 blockNo: sblockNo, 
					 ethBlockNo: rc[0], 
					 merkleRoot: rc[1], 
					 blockData:  rc[2], 
					 aidData:    rc[4],
					 ipfsHashes: {
						 blk: this.Bytes32toIPFSstring(Buffer.from(rc[2].slice(2), 'hex')),
						 aid: this.Bytes32toIPFSstring(Buffer.from(rc[4].slice(2), 'hex')) 
					 } 
				}
                        })
                }

                this.getPrevBlockData = () => {
                        return this.getBlockNo().then( (sblockNo) =>{
				// sblockNo is *pending* , not yet commited side block no
                                return this.getBlockData(sblockNo-1);
                        })
                }

		this.validateTx = (targetLeaf, sblockNo) =>
		{
			return this.getBlockData(sblockNo).then( (b) => {
				let ipfsHash = Object.values(b.blockData)[0];
				// perhaps we could cache the block results??
				return this.get(ipfsHash).then((d) => {
					let blockJSON = JSON.parse(d.toString());
					let snapshot  = blockJSON.data;
					let leaves    = [ ...snapshot[0] ];
					let mpsets    = this.getMerkleProof(leaves, targetLeaf);
					
					return this.validateMerkleProof(targetLeaf)(...mpsets);
				})
			})
		}

		this.getProofSet = (sblockNo, targetLeaf) =>
		{
			return this.getBlockData(sblockNo).then((b) => {
				let ipfsHash = b.ipfsHashes.blk;
				// perhaps we could cache the block results??
				return this.get(ipfsHash).then((d) => {
					let blockJSON = JSON.parse(d.toString());
					let snapshot  = blockJSON.data;
					let leaves    = [ ...snapshot[0] ];
					return this.getMerkleProof(leaves, targetLeaf);
				})
			})
		}

		this.otimer = observer(150000);

		this.packSnap = (sortTxs = false) =>
		{
			let _tmp = { ...this.pending };
			let _tdt = { ..._tmp.txdata }; 
			let _tpd = { ..._tmp.payload }; 
			let _ths = { ..._tmp.txhash }; 

			let txhs = []; let txdt = []; let txpd = []; 

			Object.keys(_ths).sort().map((acc) => { 
				let a = sortTxs ? _ths[acc].sort() : _ths[acc];
				txhs = [...txhs, ...a];
				a.map((h) => {
					txpd = [ ...txpd, _tpd[h] ];
					txdt = [ ...txdt, _tdt[h] ];
				})
			});

			return [txhs, txpd, txdt];
		}

		// internal Optract on epoch handler
		const __send_pending = (tikObj) => 
		{
			let account  = this.userWallet[this.appName];
			let snapshot = this.packSnap(); 
			if (snapshot[0].length === 0 || !this.dbsync()) return;

			this.put(Buffer.from(JSON.stringify(snapshot))).then((out) => {
				let cache  = this.IPFSstringtoBytes32(out[0].hash);
				let payload = this.abi.encodeParameters(
					['uint', 'uint', 'address', 'bytes32', 'uint'],
					[tikObj.epoch, tikObj.block, account, cache, tikObj.tick]
				);
	
				return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
					let params = {
						nonce: tikObj.epoch,
						pending: tikObj.block,
						validator: account,
						cache, 
						since: tikObj.tick,
						v: sig.v, r: sig.r, s: sig.s
					};
					let rlp = this.handleRLPx(pfields)(params);
					this.publish('Optract', rlp.serialize());
					console.log(`Local snapshot ${out[0].hash} sent`);
					if (this.lostChunk.length > 0) {
						setTimeout(() => { 
							[ ...new Set(this.lostChunk) ].map((h) => {
								if (!this.validIPFSHash(h)) {
									this.lostChunk.splice(this.lostChunk.indexOf(h), 1) 
								} else {
									this.ipfs.pin.add(h).then(() => { 
										this.lostChunk.splice(this.lostChunk.indexOf(h), 1) 
									})
								}
							})
						}, 0);
					}
				}).catch((err) => { console.trace(err); })
			})
		}

		this.genBlockCache = (blockNo) => (ipfsHashes, blocksnap, aid2tx, _notify = false) =>
		{
			let ipfsHash = ipfsHashes.blk;
			let ipfsHash_AID = ipfsHashes.aid;

			let txhs = blocksnap[0];
			let txdt = blocksnap[2];

			// initalize
			let opblock = { ipfsHash, tx2aid: {}, tx2acc: {}, aid: { 'ipfsHash': ipfsHash_AID, tree: aid2tx } };

			txhs.map((t,i) => {
				let data = this.parseMsgRLPx(Buffer.from(txdt[i]));
				let aid  = ethUtils.bufferToHex(data.aid); 
				let acc  = ethUtils.bufferToHex(data.account); 
				opblock['tx2aid'][t] = aid;
				opblock['tx2acc'][t] = acc;

				if (aid === '0x11be010000000000000000000000000000000000000000000000000000000000') {
					this.db.get(['acc2vc', acc], (err, rc) => {
						let acc2vc;

						if (err || (rc.constructor === Object && Object.keys(rc).length === 0)) {
							//console.trace(err);
							acc2vc = 0;
						} else {
							acc2vc = Number(rc);
						}

						this.db.put(['acc2vc', acc], acc2vc + 1, (err, rc) => { if (err) console.trace(err); });
					})
				}
			});

			this.db.put(['block', blockNo], opblock, (err, rc) => {
				if (err) {
					console.log(`genBlockCache:`);
					console.trace(err);
					throw `leveldb update for block ${blockNo} failed`;
				}

				if (blockNo > this.lastBlk) {
					this.lastBlk = blockNo;
					this.db.put(['lastBlk'], blockNo, ()=>{});
				}

				// for wsrpc 'blockData' event
				if (_notify) this.emit('blockData', {blockNo});
			});
		}

		this.locateTx = (blockNo) => (txhash, field='txdata') =>
		{
			const __locate = (resolve, reject) => {
				this.db.get(['block', blockNo], (err, opblock) => {
					if (field === 'aid' && typeof(opblock) !== 'undefined' && typeof(opblock.tx2aid) !== 'undefined' && this.lastBlk >= blockNo) {
						resolve(opblock.tx2aid[txhash] || null);
					} else if (field === 'account' && typeof(opblock) !== 'undefined' && typeof(opblock.tx2acc) !== 'undefined' && this.lastBlk >= blockNo) {
						resolve(opblock.tx2acc[txhash] || null);
					} else if (field === 'payloadvrs') {
						this.getBlockData(blockNo).then((blkdat) => {
							this.get(blkdat.ipfsHashes.blk).then((bd)=>{
								let bksnap = JSON.parse(bd.toString()).data;
								// this.pinBlockDelta(bksnap, bksnap[0]);
								let i = bksnap[0].indexOf(txhash); // assuming already pass merkle check
                                                                let payload = ethUtils.bufferToHex(bksnap[1][i].data);
								let txdata = this.parseMsgRLPx(Buffer.from(bksnap[2][i]));
							        let v = ethUtils.bufferToInt(txdata.v);
							        let r = ethUtils.bufferToHex(txdata.r);
							        let s = ethUtils.bufferToHex(txdata.s);
								resolve([payload, v, r, s]);
							})
						})
					} else {
						this.getBlockData(blockNo).then((blkdat) => {
							let p = [this.get(blkdat.ipfsHashes.blk), this.get(blkdat.ipfsHashes.aid)];

        	        	                        Promise.all(p).then((bd) => {
                	        	                        let bksnap = JSON.parse(bd[0].toString()).data;
                	        	                        let aid2tx = JSON.parse(bd[1].toString());
	
        	                        	                // sync comments
                	                        	        //this.pinBlockDelta(bksnap, bksnap[0]);

	                        	                        // gen block cache
        	                        	                this.genBlockCache(blockNo)(blkdat.ipfsHashes, bksnap, aid2tx);

								let i = bksnap[0].indexOf(txhash); // assuming already pass merkle check
								let txdata = this.parseMsgRLPx(Buffer.from(bksnap[2][i]));

								if (field === 'txdata') {
									resolve(txdata);
								} else {
									resolve(ethUtils.bufferToHex(txdata[field]));
								}
                                        		})
                                		}).catch((err) => {console.log(`Error in locateTx:`); console.trace(err); resolve(null); })
					}
				});
			}

			return new Promise(__locate);
		}

		this.getOpRoundCache = (blockNo) => (ipfsHash, blocksnap) =>
		{
			let txhs = blocksnap[0];
			let txdt = blocksnap[2];

			// In case if SDB or fIPFS haven't been synced in first renewOproundDB() call
			if (blockNo - 1 >= this.game.opStart) {
			     if ( typeof(this.game.lastSrates) === 'undefined' || typeof(this.game.lastFinalist) === 'undefined') {
				     this.renewOproundDB(this.game.opround); // non-blocking
			     }
			}

			if (this.game.opSync >= blockNo) {
				console.log(`DEBUG: Opround info for sblock ${blockNo} has been done before, skipped ...`);
				return;
			} else {
				this.game.opSync = blockNo; // lock and prevent duplicate run
			}

			txhs.map((t,i) => {
				let data = this.parseMsgRLPx(Buffer.from(txdt[i]));
				let aid  = ethUtils.bufferToHex(data.aid); 
				let oid  = ethUtils.bufferToHex(data.oid); 
				let acc  = ethUtils.bufferToHex(data.account);

				if (aid === '0x11be010000000000000000000000000000000000000000000000000000000000') {
					let v1blk = ethUtils.bufferToInt(data.v1block);
					let v1tx  = ethUtils.bufferToHex(data.v1leaf);
				
					if (typeof(this.game.voted[acc]) === 'undefined') this.game.voted[acc] = [];
					if (typeof(this.game.votWatch[acc]) === 'undefined') this.game.votWatch[acc] = [];
					this.game.votWatch[acc].push(v1tx);

					return this.locateTx(v1blk)(v1tx).then((v1txd) => {
						let v1aid = ethUtils.bufferToHex(v1txd.aid);
						let url   = v1txd.url.toString();
						this.game.voted[acc].push(v1aid);
						if (typeof(this.game.aid2vc[v1aid]) === 'undefined') this.game.aid2vc[v1aid] = 0;
						this.game.aid2vc[v1aid] = this.game.aid2vc[v1aid] + 1;
						this.game.aidUrl[v1aid] = url; 

						if (acc === this.userWallet[this.appName]) {
							this.isValidator(this.userWallet[this.appName]).then((rc) => {
								if (rc) return;
								let since = ethUtils.bufferToInt(data.since);
								this.db.put(['vault', acc, v1aid], {url, since}, () => {})
							})
						}
					})
				} else if (aid === '0x11be020000000000000000000000000000000000000000000000000000000000') {
					let v1blk = ethUtils.bufferToInt(data.v1block);
					let v2blk = ethUtils.bufferToInt(data.v2block);
					let v2tx  = ethUtils.bufferToHex(data.v2leaf);
					let v1tx  = ethUtils.bufferToHex(data.v1leaf);

					if (typeof(this.game.clmWatch[acc]) === 'undefined') this.game.clmWatch[acc] = [];
					this.game.clmWatch[acc].push(v1tx)

					if (acc === this.userWallet[this.appName]) {
						this.isValidator(this.userWallet[this.appName]).then((rc) => {
							if (rc) return;
							this.db.put(['histxs', t], {v1tx, v1blk, oid}, () => {})
						})
					}

					return this.locateTx(v2blk)(v2tx, 'aid').then((v2aid) => {
						if (typeof(this.game.aid2cc[v2aid]) === 'undefined') this.game.aid2cc[v2aid] = 0;
						this.game.aid2cc[v2aid] = this.game.aid2cc[v2aid] + 1;
					})
				}

				if(typeof(this.game.curated[aid]) === 'undefined') this.game.curated[aid] = [];
				this.game.curated[aid].push(acc);
			})	
		}

		// should only be used when node (re)started
		this.genOpRoundDB = () => 
		{
			const __range = (start, end) =>
                        {
                                return (new Array(end - start + 1)).fill(undefined).map((_, i) => i + start);
                        }

			let p = [
				this.getBlockNo(),
				this.getOproundInfo()
			];
			
			Promise.all(p).then((rc) => {
				let sblockNo = rc[0]; // this is the pending blockNo
				this.game.opround  = rc[1][0];
				this.game.oid      = rc[1][1];
				this.game.opStart  = rc[1][2]; // start sblockNo.

				if (sblockNo === 0) return;

				if (this.lastBlk < sblockNo - 1) {
					console.log(`WARNING: block sync not yet finished ... skipped`);
					return setTimeout(this.genOpRoundDB, 60000);
				}

				this.renewOproundDB(this.game.opround);

				if (sblockNo > this.game.opStart) {
					__range(this.game.opStart, sblockNo - 1).map((b) => {
						return this.getBlockData(b).then((blkdat) => { 
							let ipfsHash = blkdat.ipfsHashes.blk;
							return this.get(ipfsHash).then((bd) => {
								let bksnap = JSON.parse(bd.toString()).data;
								return this.getOpRoundCache(b)(ipfsHash, bksnap);
							})
						})
					});
				} else {
					return; // pending states *are* the opround cache at this point.
				}
			})
		}

		// When new opround started, there's actually not much to sync right away, 
		// except for previous opround's sDB and fIPFS ...
		this.renewOproundDB = (newOpRndNo) =>
		{
			if (newOpRndNo >= 2) {
                                return this.getOproundResults(newOpRndNo - 1).then((rc) =>
                                {
                                         this.game.lastMsr = rc[3];  // min success ratee
                                         this.game.lastSDB = rc[4];
                                         this.game.lastFL  = rc[5];
                                }).then(() => 
				{
					this.game.lastSrates = {};
					this.game.lastFinalist = [];

					if ( this.game.drawed  === false
					  && this.game.lastSDB === '0x0000000000000000000000000000000000000000000000000000000000000000' 
					  && this.game.lastFL  === '0x0000000000000000000000000000000000000000000000000000000000000000')
					{
						this.game.lastMsr = 0;
						this.game.lastSDB = '0x0000000000000000000000000000000000000000000000000000000000000000';
						this.game.lastFL = '0x0000000000000000000000000000000000000000000000000000000000000000';

						return;
					}

					let p = [];
					if (this.game.lastSDB !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
						let lastSDB = this.Bytes32toIPFSstring(this.game.lastSDB);
						p.push(this.get(lastSDB).then((rc) => { this.game.lastSrates = JSON.parse(rc.toString()); }));
						p.push(this.ipfs.pin.add(lastSDB));
					}

					if (this.game.lastFL !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
						let lastFL  = this.Bytes32toIPFSstring(this.game.lastFL);
						p.push(this.get(lastFL).then((rc) => { this.game.lastFinalist = JSON.parse(rc.toString()); }))
						p.push(this.ipfs.pin.add(lastFL));
					}

					return Promise.all(p)
					              .catch((err) => { console.log(`DEBUG: in renewOproundDB:`); console.trace(err); })
				})
			} else if (newOpRndNo === 1) {
				// may cause error in next opround if these values are 'underfined'
				this.game.lastMsr = 0;
				this.game.lastSDB = '0x0000000000000000000000000000000000000000000000000000000000000000';
				this.game.lastFL = '0x0000000000000000000000000000000000000000000000000000000000000000';
			}
		}

		this.pinBlockDelta = (remote, dhashs) =>
		{
			console.log('pinning block delta');
                        dhashs.map((thash) => {
                                return setTimeout((hash) => {
					console.log(`DEBUG: checking and pin ${hash} if applicable ...`);
					let idx = remote[0].indexOf(hash);
                                        let data = this.handleRLPx(mfields)(Buffer.from(remote[2][idx]));
					if (data.comment.length != 0) {
						let _comment = '0x' + ethUtils.bufferToHex(data.comment).slice(2).padStart(64, '0');
						let ipfshash = this.Bytes32toIPFSstring(_comment);
						if (!this.validIPFSHash(ipfshash)) return;
						return this.ipfs.pin.add(ipfshash)
						.catch((err) => { this.lostChunk.push(ipfshash) })
					}
				}, 0, thash);
			})
		}

		this.clearSnapShot = (dhashs) =>
		{
			console.log('cleaning pending');
                        dhashs.map((txhash) => {
				let account = ethUtils.bufferToHex(this.parseMsgRLPx(this.pending.txdata[txhash]).account);

				if ( typeof(this.pending.txhash[account]) === 'undefined'
                                  || this.pending.txhash[account].indexOf(txhash) === -1) { return true; }

				this.pending.txhash[account].splice(this.pending.txhash[account].indexOf(txhash), 1);
				delete this.pending.txdata[txhash];
				delete this.pending.payload[txhash];
				this.pending.nonces[account] = this.pending.nonces[account] - 1;
			})
		}

		this.parseBlock = (tikObj) =>
		{
			let newBlockNo = tikObj.block;
			this.getBlockData(newBlockNo - 1).then((blkdat) => { 
				console.log(`DEBUG: parsing block data ${newBlockNo - 1}`);
				let p = [
					this.ipfs.pin.add(blkdat.ipfsHashes.blk), 
					this.get(blkdat.ipfsHashes.blk), 
					this.packSnap(), 
					this.ipfs.pin.add(blkdat.ipfsHashes.aid), 
					this.get(blkdat.ipfsHashes.aid), 
					Promise.resolve(blkdat.ipfsHashes)
				];

				return Promise.all(p);
			}).then((rc) => {
				let bksnap = JSON.parse(rc[1].toString()).data;
				let aid2tx = JSON.parse(rc[4].toString());
				let mysnap = rc[2];

				let tokeep = keeping([...mysnap[0]], [...bksnap[0]]); // pass in duplicates
				let todrop = keeping([...mysnap[0]], tokeep);
				let tosync = missing([...mysnap[0]], [...bksnap[0]]); // pass in duplicates

				this.aidWatch = {};
				this.clmWatch = {};

				if (tikObj.chkClm) {
					console.log(`DEBUG: parseBlock: new opRound started, cleaning old claim tx ...`);
					tokeep.map((tx) => 
					{
						let idx = mysnap[0].indexOf(tx);
						let data = this.handleRLPx(mfields)(Buffer.from(mysnap[2][idx]));
						if (ethUtils.bufferToInt(data.opround) !== this.game.opround) todrop.push(tx);
					})
				}

                                this.clearSnapShot(todrop);
				this.myEpoch = newBlockNo;

                                if (tosync.length > 0) this.pinBlockDelta(bksnap, tosync);
				this.emit('epoch', tikObj); // do this only *after* clearSnapShot

				if (tikObj.chkClm === false) this.getOpRoundCache(newBlockNo - 1)(rc[5].blk, bksnap);
				this.genBlockCache(newBlockNo - 1)(rc[5], bksnap, aid2tx, true);

			})
                        .catch((err) => { console.log(`parseBlock: `); console.trace(err); })
		}

		// first JSON, than leveldb
		this.genBlockDB = (sbn=0) =>
		{
			const __range = (start, end) => 
			{
				return (new Array(end - start + 1)).fill(undefined).map((_, i) => i + start);
			}

			this.getBlockNo().then( (sblockNo) => {
				if (this.myEpoch === 0) this.myEpoch = sblockNo;
				if (sblockNo === 0 || sbn === sblockNo - 1) return;
                                // sblockNo is *pending* , not yet commited side block no
				__range(sbn, sblockNo - 1).map((b) => {
					return this.getBlockData(b).then((blkdat) => { 
						let ipfsHash = blkdat.ipfsHashes.blk;
						let ipfsHash_AID = blkdat.ipfsHashes.aid;

						let p = [
							this.get(blkdat.ipfsHashes.blk),
							this.ipfs.pin.add(blkdat.ipfsHashes.blk),
							this.get(blkdat.ipfsHashes.aid),
							this.ipfs.pin.add(blkdat.ipfsHashes.aid)
						];

						return Promise.all(p).then((rc) => {
							let bd = rc[0];
							let bksnap = JSON.parse(bd.toString()).data;
							let ad = rc[2];
							let aid2tx = JSON.parse(ad.toString());

							// sync comments
							this.pinBlockDelta(bksnap, bksnap[0]);

							// gen block cache
							this.genBlockCache(b)(blkdat.ipfsHashes, bksnap, aid2tx, false);
						})
					})
                        		.catch((err) => { console.log(`genBlockDB: `); console.trace(err); process.exit(1);})
				})

				this.saveDB();
			})
                        .catch((err) => { console.log(`genBlockDB: `); console.trace(err); process.exit(1);})
		}

		this.on('block', this.parseBlock);
	}
}

const appCfg = { daemon: true, ...config.node, port: 45054, wsrpc: true };

var opt;
var r;
var title = 'Optract: Ops Console';

if (!appCfg.daemon && appCfg.wsrpc) {
	const WSClient = require('rpc-websockets').Client;
	const connectRPC = (url) => {
        	opt = new WSClient(url);

        	const __ready = (resolve, reject) =>
        	{
            		opt.on('open',  function(event) { resolve(true) });
            		opt.on('error', function(error) { console.trace(error); reject(false) });
        	}

        	return new Promise(__ready);
	}

	return connectRPC('ws://127.0.0.1:59437')
	 .then((rc) => 
	 {
		if (!rc) throw("failed connection");

		title = 'Optract: WS Console';
		return ASCII_Art(title).then((art) => {
		        console.log(art);
			r = repl.start({ prompt: `[-= ${'OptractWsRPC'} =-]$ `, eval: replEvalPromise });
		        r.context = {opt};
		        r.on('exit', () => {
	        	        console.log("\n\t" + 'Stopping WSRPC CLI...');
				opt.close();
			})
		})
	 })
	 .catch((err) => { console.trace(err); })
} else {
	 opt = new OptractNode(appCfg);
	 let stage = Promise.resolve(opt)
         .catch((err) => { process.exit(1); })
	 .then(() => { if (!appCfg.daemon) return new Promise(askMasterPass) })
         .then((answer) => { 
		 if (!appCfg.daemon) {
			 opt.password(answer); return opt.validPass();
		 } else {
			return false;
		 }
	 })
         .then((rc) => {
		if (rc && typeof(opt.appCfgs.dapps[opt.appName].account) !== 'undefined') {
			return opt.linkAccount(opt.appName)(opt.appCfgs.dapps[opt.appName].account)
			          .then((rc) => {
					  console.log(rc);

					  if (Object.values(rc)[0]) {
					  	return opt.initDB();
					  } else {
				  		title = 'Optract: Ops Console [ NA ]';
					  }
				  })
		} else {
			title = 'Optract: Ops Console  [ RO ]';
		}
	 })
	 .then(() => {
	     if(!appCfg.daemon) {
		    return ASCII_Art(title).then((art) => {
		        console.log(art);
			r = repl.start({ prompt: `[-= ${opt.appName} =-]$ `, eval: replEvalPromise });
		        r.context = {opt};
		        r.on('exit', () => {
	        	        console.log("\n\t" + 'Stopping CLI...');
				opt.saveDB();
				opt.leave('Optract');
				opt.swarm.close();
				process.exit(0);
	        	});
		    })
	     } else {
	     	    title = 'Optract: Ops Server';
		    return ASCII_Art(title).then((art) => {
		    	console.log(art);
			r = new WSServer({ port: 59437, host: '127.0.0.1' });

			const expose = 
			{
				vars: ['networkID', 'userWallet', 'pending', 'game'],
				stat: ['reports', 'getPrevBlockData', 'validPass', 'allAccounts', 'getBlockNo', 'makeMerkleTreeAndUploadRoot', 'buyMembership' ,'statProbe'],
				func: ['getOproundInfo', 'newAccount', 'memberStatus', 'ping', 'queueReceipts', 'getOproundLottery', 'parseMsgRLPx', 'get', 'isValidator'],
				main: ['newArticle', 'newVote', 'newClaim', 'importFromJSON', 'listAccLotteryWins'] // obj.args = [arg0, arg1 ...] (ordered args passed as object)
			}

			expose.vars.map((i) => { r.register(i, () => { return opt[i]; }); })
			expose.stat.map((s) => { r.register(s, () => { return opt[s](); }); })
			expose.func.map((f) => { r.register(f, (args) => { let input = args[0]; return opt[f](input); }); })
			expose.main.map((f) => { r.register(f, (obj) => { let inputs = obj.args; return opt[f](...inputs); }); })

			// extra functions
			r.register('addPeer', (obj) => { return opt.swarm.addPeer(obj); });

			r.register('password', (args) => 
			{
				let pw = args[0];
				let account = args[1] || opt.appCfgs.dapps[opt.appName].account;
				opt.password(pw);
				return opt.validPass().then((rc) => {
					if (rc && account !== 'undefined') {
						return opt.linkAccount(opt.appName)(account).then((rc) => 
						{
							opt.initDB();
							opt.appCfgs.dapps[opt.appName].account = account;

							return rc;
						})
					} else {
						return rc;
					}
				})
				.catch((err) => { console.trace(err); });
			})

			let cbTimer;
			r.register('curateBot', (args) => 
			{
				let period = args[0] || 1200000;
				if (typeof(cbTimer) === 'undefined') {
					cbTimer = setInterval(opt.newBotArticles, period); //TODO: customed comments?
					return `curate bot is now on, period: ${period}`;
				} else {
					clearInterval(cbTimer); cbTimer = undefined;
					return 'curate bot is now off';
				}
			})

			let bbTimer;
			r.register('blockBot', (args) =>
			{
				let period = args[0] || 3600000;
				const __new_block = () => 
				{
					if (opt.packSnap()[0].length > 0) {
						let p = [ opt.ethNetStatus(), opt.getPrevBlockData() ];
						return Promise.all(p).then((rc) => {
							if (opt.myEpoch < rc[1]) return 'local node not yet synced';
							let ethBlk = rc[0].blockHeight;
							let pbeBlk = rc[1].ethBlockNo;

							if (ethBlk - pbeBlk < 120) return 'too soon for new block';
							return opt.makeMerkleTreeAndUploadRoot();
						})
					}
				}

				if (typeof(bbTimer) === 'undefined') {
					bbTimer = setInterval(__new_block, period);
					return `block bot is now on, period: ${period}`;
				} else {
					clearInterval(bbTimer); bbTimer = undefined;
					return `block bot is now off`
				}
			})

			r.register('locateTx', (obj) =>
			{
				let blockNo = obj.args[0];
				let txhash  = obj.args[1];

				return opt.locateTx(blockNo)(txhash).then((r) => {
					return { 
						 txhash, 
						 account: ethUtils.bufferToHex(r.account),
						 aid: ethUtils.bufferToHex(r.aid),
						 oid: ethUtils.bufferToHex(r.oid),
						 opround: ethUtils.bufferToInt(r.opround),
						 url: r.url.toString()
			        	}
				})
			})

			r.register('locatePx', (args) =>
			{
				let txhash = args[0];
				let pxsnap = opt.packSnap();
				let r = opt.parseMsgRLPx(Buffer.from(pxsnap[2][pxsnap[0].indexOf(txhash)]));

				return { 
					 txhash, 
					 account: ethUtils.bufferToHex(r.account),
					 aid: ethUtils.bufferToHex(r.aid),
					 oid: ethUtils.bufferToHex(r.oid),
					 opround: ethUtils.bufferToInt(r.opround),
					 url: r.url.toString()
			        }
			})

			r.register('rawBlock', (args) =>
			{
				let blockNo = args[0];
				const __block_dump = (blkNo) => (resolve, reject) => 
				{
					opt.db.get(['block', blockNo], (err, bd) => {
						if (err) return reject(err);
						resolve(bd);
					})
				}

				return new Promise(__block_dump(blockNo)).catch((err) => { console.trace(err); })
			})

			// UI specific APIs

			// Helper functions
			const __is_curation_aid = (aid) => 
			{
				if ( aid === '0x11be010000000000000000000000000000000000000000000000000000000000'
				  || aid === '0x11be020000000000000000000000000000000000000000000000000000000000'
				) {
					return false;
				} else {
					return true;
				}
			}

			const __aidContent = (blkNo, aid) => (resolve, reject) => 
			{
				 if (!__is_curation_aid(aid)) return resolve({});
				 console.log(`DEBUG: __aidContent is called on ${blkNo} :: ${aid}`)
				 opt.db.get(['block', blkNo, 'aid', 'tree', aid], (err,val) => {
					 if (err) return reject(err);
					 let { url, ...txs } = val;
					 resolve({[aid]: { url, txs: Object.keys(txs), blk: [blkNo], cmt: txs }});
				 })
			}

			const __merge_aid_content = (aclist) => 
			{
				if (aclist.length === 0) return {};

				console.log(`DEBUG: __merge_aid_content called on a list of ${aclist.length} item(s)`)
				return aclist.reduce((c,o) => {
					 if (o.constructor === Object && Object.keys(o).length === 0) return {...c, ...o};

					 let aid = Object.keys(o)[0];
					 if (typeof(c[aid]) !== 'undefined') {
						 c[aid].txs = [...c[aid].txs, ...o[aid].txs]; // merge txs
						 c[aid].blk = [...c[aid].blk, ...o[aid].blk]; // merge blk

						 return c;
					 } else {
					 	 return {...c, ...o};
					 }
				});
			}

			const __btxContent = (blkNo, txhash) => (resolve, reject) =>
			{
				 console.log(`DEBUG: __btxContent called on block ${blkNo}`)
				 opt.locateTx(blkNo)(txhash, 'aid').then((aid) => {
					if (!__is_curation_aid(aid)) return resolve({});

					return new Promise(__aidContent(blkNo, aid))
					 .then((result) => { resolve(result); })
				 })
				 .catch((err) => { reject(err); })
			}

			const __bv1Content = (blkNo) => (resolve, reject) =>
			{
				 console.log(`DEBUG: __bv1Content called on block ${blkNo}`)
				 opt.db.get(['block', blkNo, 'aid', 'tree', '0x11be010000000000000000000000000000000000000000000000000000000000'], (err,val) => {
					 if (err || (val.constructor === Object && Object.keys(val).length === 0)) {
						 console.log(`Error?`);
						 console.trace(err); console.dir(val);
						 resolve([]);
					 }

					 let { url, ...txs } = val; // url should be empty here.
					 let queue = Object.keys(txs).map((txhash) => {
						   return opt.locateTx(blkNo)(txhash).then((txdata) => {
							let v1txh = ethUtils.bufferToHex(txdata.v1leaf);
							let v1blk = ethUtils.bufferToInt(txdata.v1block);
							return new Promise(__btxContent(v1blk, v1txh)).catch((err) => { return {}; }) 
						   }) 
					 })

					 Promise.all(queue).then(resolve);
				 })
			}

			const __blkContentList = (blkNo) => (resolve, reject) => {
				 opt.db.get(['block', blkNo, 'aid', 'tree'], (err,val) => {
					 if (err) return reject(err);

					 let results = [];
					 Object.keys(val).map((aid) => {
						if (__is_curation_aid(aid)) {
							let { url, ...txs } = val[aid];
							results.push({[aid]: { url, txs: Object.keys(txs), blk: [blkNo], cmt: txs }})
						}
					 })

					 new Promise(__bv1Content(blkNo)).then((v1aclist) => {
						console.log(`DEBUG: __blkContentList called on block ${blkNo}`)
						resolve([...results, ...v1aclist]);
					 })
					 .catch((err) => { reject(err); });
				 })
			}

			const __blkContent = (blkNo) => (resolve, reject) =>
			{
				console.log(`DEBUG: __blkContent called on block ${blkNo}`)
				new Promise(__blkContentList(blkNo)).then((aclist) => {
					resolve(__merge_aid_content(aclist));
				})
				.catch((err) => { reject(err); })
			}

			// winning ticket specific function calls
			const __blkWinnerContentList = (blkNo, lotteryWinNumber) => (resolve, reject) => 
			{
				 opt.db.get(['block', blkNo, 'aid', 'tree'], (err,val) => {
					 if (err) return reject(err);

					 let lottery = new Lottery();
					 let results = [];
					 Object.keys(val).map((aid) => {
						if (__is_curation_aid(aid)) {
							let { url, ...txs } = val[aid];
							let txswin = lottery.sample(Object.keys(txs), lotteryWinNumber);
							if (txswin.length === 0) return;
							results.push({[aid]: { url, txs: txswin, blk: [blkNo], cmt: txs }})
						}
					 })

					 new Promise(__bv1WinnerContent(blkNo, lotteryWinNumber)).then((v1aclist) => {
						console.log(`DEBUG: __blkWinnerContentList called on block ${blkNo}`)
						resolve([...results, ...v1aclist]);
					 })
					 .catch((err) => { reject(err); });
				 })
			}

			const __bv1WinnerContent = (blkNo, lotteryWinNumber) => (resolve, reject) =>
			{
				 console.log(`DEBUG: __bv1WinnerContent called on block ${blkNo}`)
				 opt.db.get(['block', blkNo, 'aid', 'tree', '0x11be010000000000000000000000000000000000000000000000000000000000'], (err,val) => {
					 if (err || (val.constructor === Object && Object.keys(val).length === 0)) {
						 console.log(`Error?`);
						 console.trace(err); console.dir(val);
						 resolve([]);
					 }

					 let lottery = new Lottery();
					 let { url, ...txs } = val; // url should be empty here.
					 let queue = Object.keys(txs).map((txhash) => {
						   return opt.locateTx(blkNo)(txhash).then((txdata) => {
							let v1txh = ethUtils.bufferToHex(txdata.v1leaf);
							if (lottery.sample([v1txh], lotteryWinNumber).length === 0) return Promise.resolve({});
							let v1blk = ethUtils.bufferToInt(txdata.v1block);
							return new Promise(__btxContent(v1blk, v1txh)).catch((err) => { return {}; }) 
						   }) 
					 })

					 Promise.all(queue).then(resolve);
				 })
			}

			const __blkWinnerContent = (blkNo, lotteryWinNumber) => (resolve, reject) =>
			{
				console.log(`DEBUG: __blkWinnerContent called on block ${blkNo}`)
				new Promise(__blkWinnerContentList(blkNo, lotteryWinNumber)).then((aclist) => {
					resolve(__merge_aid_content(aclist));
				})
				.catch((err) => { reject(err); })
			}

			const __range_winner_queries = (startBlk, endBlk, lotteryWinNumber, parse = false) => 
			{
				let queue = []; 
				for (let i = startBlk; i <= endBlk; i++) {
					queue.push(new Promise(__blkWinnerContentList(i, lotteryWinNumber)).catch((err) => { return []; }))
				}

				return Promise.all(queue).then((aclist) => {
					let biglist = aclist.reduce((c,i) => { return [...c, ...i] });
					return __merge_aid_content(biglist);
				})
				.then((results) => {
					if (!parse) return results;

					let mrq = Object.keys(results).map((aid) => {
						let p = [
						   mr.parse(results[aid].url).catch((err) => { results[aid]['page'] = {err} }),
						   opt.get(Object.values(results[aid].cmt)[0]).catch((err) => { return Buffer.from('{"tags": ["misc"], "comment":"data not synced"}'); })
						];
						return Promise.all(p).then((rc) => {
							let page = rc[0];
							let comments = JSON.parse(rc[1].toString());
							results[aid]['page'] = page;
							results[aid]['tags'] = comments;
						})
						.catch((err) => { console.trace(err); }); //FIXME: better handling?
					});

					return Promise.all(mrq).then(() => { return results; })
				})
			}
			// End of winning ticket specific calls

			const __random_avoid = (n,i) => {
				if(n === 1) return i;
				let t = Math.floor(Math.random()*(n));
				if(t === i) {
					return __random_avoid(n,i) 
				} else { 
					return t;
				}
			}    

			const __random_index = (m,n) =>
                        {
                                return (new Array(m)).fill(undefined).map((_, i) => { return __random_avoid(n,i) });
                        }

			const __random_picks = (m, array) => // random select m elements out of an array
			{
				let n = array.length - 1;
				if (n+1 <= m) return array;
				return __random_index(m,n).reduce((c, i) => { c.push(array[i]); return c; }, []);
			}

			const __range_queries = (startBlk, endBlk, arCap = 15, parse = false) => 
			{
				let queue = []; 
				for (let i = startBlk; i <= endBlk; i++) {
					queue.push(new Promise(__blkContentList(i)).catch((err) => { return []; }))
				}

				return Promise.all(queue).then((aclist) => {
					let biglist = aclist.reduce((c,i) => { return [...c, ...i] });

					// article limit test
					let pick = Math.ceil(biglist.length * 0.4); // 40% of total list
					if (pick > arCap) pick = arCap; 	    // cap max articles per query;
					let random = __random_picks(pick, biglist);

					return __merge_aid_content(random);
				})
				.then((results) => {
					if (!parse) return results;

					let mrq = Object.keys(results).map((aid) => {
						let p = [
						   mr.parse(results[aid].url).catch((err) => { results[aid]['page'] = {err} }),
						   opt.get(Object.values(results[aid].cmt)[0]).catch((err) => { return Buffer.from('{"tags": ["misc"], "comment":"data not synced"}'); })
						];
						return Promise.all(p).then((rc) => {
							let page = rc[0];
							let comments = JSON.parse(rc[1].toString());
							results[aid]['page'] = page;
							results[aid]['tags'] = comments;
						})
						.catch((err) => { console.trace(err); }); //FIXME: better handling?
					});

					return Promise.all(mrq).then(() => { return results; })
				})
			}

			r.register('getBlockArticles', (args) => 
			{
				let blkNo = args[0];
				let arCap = args[1] || 5;
				let parse = args[2] || false;

				//original code
				//return new Promise(__blkContent(blkNo)); 

				// utilizing range function 
				return __range_queries(blkNo, blkNo, arCap, parse);
			})

			r.register('getBkRangeArticles', (args) => 
			{
				let startBlk = args[0];
				let endBlk   = args[1];
				let arCap    = args[2] || 15;
				let parse    = args[3] || false; // item per page

				//TODO: sanity checks
				return __range_queries(startBlk, endBlk, arCap, parse);

			})

			r.register('getClaimArticles', (args) =>
			{
				if (!opt.dbsync()) return {};

				let opround = args[0] || opt.game.opround;
				let parse = args[1] || false;

                                console.log(`DEBUG: checking claim articles (by bots) for opround ${opround} ...`);
				
				let p = [opt.getOproundInfo(opround), opt.getOproundLottery(opround)];
                        	return Promise.all(p).then((rc)=>{
                                	let startBlk = rc[0][2];  // init block no.
                                	let endBlk   = rc[1][1];  // lottery block no.
                                	let lotteryWinNumber = rc[1][2];	

					return __range_winner_queries(startBlk, endBlk, lotteryWinNumber, parse) 
					            .catch((err) => { console.trace(err); return {} })
				})
				.catch((err) => { console.trace(err); return {} })
			})

			r.register('getClaimTickets', (args) => 
			{
				if (!opt.dbsync()) return {};

				let addr = args[0];
				let opround = args[1] || opt.game.opround;

				const __get_histxs = (resolve, reject) => 
				{
					opt.db.get(['histxs'], (err, rc) => {
						if (err || (rc.constructor === Object && Object.keys(rc).length === 0)) return resolve({});
						let out = Object.values(rc).reduce((o,i) => {
							if (typeof(o[i.v1blk]) === 'undefined') o[i.v1blk] = [];
							o[i.v1blk] = [ ...o[i.v1blk], i.v1leaf ];
							return o;
						}, {});
					
						resolve(out);
					})
				}

				let p = [
					opt.listAccLotteryWins(opround, addr),
					new Promise(__get_histxs)
				];

				return Promise.all(p).then((rc) => 
				{ 
					let all = rc[0].voted;
					let did = rc[1];
					let out = {};

					Object.keys(all).map((bn) => {
						if (typeof(did[bn]) === 'undefined') {
							out[bn] = all[bn];
							return; 
						}
						out[bn] = keeping(all[bn], did[bn]);
					})

					return out;
				})
				.catch((err) => { console.trace(err); return {} })
			})

			const __OpFinalList = (op) => 
			{
				return opt.getOproundResults(op).then((rc) =>
                                {
					if (!opt.dbsync() || op >= opt.game.opround || op <= 1) return {};
					if (rc[5] === '0x0000000000000000000000000000000000000000000000000000000000000000') return {}
                                        let ipfsFL = opt.Bytes32toIPFSstring(rc[5]); console.log(`ipfs for final list ${op}: ${ipfsFL}`);
					if (!opt.validIPFSHash(ipfsFL)) return {};
					return opt.get(ipfsFL).then((fl) => { return {[op]: JSON.parse(fl.toString())} })
                                })
			}

			const __OpFinalListPage = (op) => 
			{
				return opt.getOproundResults(op).then((rc) =>
                                {
					if (!opt.dbsync() || op >= opt.game.opround || op <= 1) return {};
					if (rc[5] === '0x0000000000000000000000000000000000000000000000000000000000000000') return {}
                                        let ipfsFL = opt.Bytes32toIPFSstring(rc[5]); console.log(`ipfs for final list ${op}: ${ipfsFL}`);
					if (!opt.validIPFSHash(ipfsFL)) return {};
					return opt.get(ipfsFL).then((fl) => { return JSON.parse(fl.toString()); })
						   .then((opFL) => {
							   let p = opFL.map((url) => {
								   return mr.parse(url).then((page) => { return {[url]: page} })
							   })

							   return Promise.all(p).then((pl) => {
								   let c = pl.reduce((o,i) => { return {...o, ...i}});
								   return {[op]: c}
							   })

						   })
                                })
			}

			r.register('getOpRangeFinalList', (args) => 
			{
				let startOp = args[0];
				let endOp   = args[1];
				let parse   = args[2] || false;

				//TODO: sanity checks

				let queue = [];
				for (let i = startOp; i <= endOp; i++) {
					if (parse) {
						queue.push(__OpFinalListPage(i).catch((err) => { return {[i]: {}}; }))
					} else {
						queue.push(__OpFinalList(i).catch((err) => { return {[i]: {}}; }))
					}
				}

				return Promise.all(queue)
					      .then((rc) => { return rc.reduce((o,i) => { return {...o, ...i} }) })
				              .catch((err) => { console.trace(err); return {} })
				
			})

			r.register('getMyVault', (args) =>
			{
				let account = args[0];
				const __get_vt = (account) => (resolve, reject) =>
				{
					opt.db.get(['vault', account], (e,r) => {
						if (e) resolve({});
						resolve(r);
					})
				}

				return new Promise(__get_vt(account))
				              .catch((err) => { console.trace(err); return {} })
			})

			// event registration
			r.event('blockData'); opt.on('blockData', (bd) => { r.emit('blockData', bd) });
			r.event('opStats');   opt.on('opStats', (opObj) => { r.emit('opStats', opObj) });
		    })

		    process.on('SIGINT', () => {
		        console.log("\n\t" + 'Stopping WSRPC...');
			opt.leave('Optract');
			opt.swarm.close();
			r.close();
		    })
	     }
	 })
	 .catch((err) => { console.trace(err); })
}
