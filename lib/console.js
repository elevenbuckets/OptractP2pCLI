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
		   'call', 
                   'sendTk',
		   'ethNetStatus',
		   'linkAccount',
		   'password',
                   'validPass',
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
		
		// IPFS string need to convert to bytes32 in order to put in smart contract
                this.IPFSstringtoBytes32 = (ipfsHash) =>
                {
                        // return '0x'+bs58.decode(ipfsHash).toString('hex').slice(4);  // return string
                        return ethUtils.bufferToHex(bs58.decode(ipfsHash).slice(2));  // slice 2 bytes = 4 hex  (the 'Qm' in front of hash)
                }

                this.Bytes32toIPFSstring = (hash) =>  // hash is a bytes32 Buffer or hex string (w/wo '0x' prefix)
                {
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

		this.game = { drawed: false, opround: -1, 
			      aid2vc: {}, aid2cc: {}, aidUrl: {}, 
			      curated: {}, voted: {}, votWatch: {},
			      clmWatch: {}
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
			"/ipfs/QmPKSjMv3Zp9tdAGFEPMjUtmQjdyHC6HKbEyCgfPNEFDAh"
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
        		return setInterval(() => {
				__ipfsConnect();
				this.myStamp = Math.floor(Date.now() / 1000);
				this.myTick  = ( this.myStamp - (this.myStamp % 300) ) / 300;

				let p = [
					this.getBlockNo(),
					this.getOproundInfo(),
				];

				Promise.all(p).then((rc) => {
					let newEpoch = rc[0];
					let newOpRnd = rc[1][0];
					let opStart  = rc[1][2];

					if (this.myEpoch < newEpoch) {
						if (newOpRnd > this.game.opround && newOpRnd >= 1) {
							// reset this.game
							this.game = { 
							      drawed: false, opround: newOpRnd,
							      aid2vc: {}, aid2cc: {}, aidUrl: {},
							      curated: {}, voted: {}, votWatch: {},
							      clmWatch: {}, opStart, 
							};

							//pull sDB and fIPFS
							this.renewOproundDB(newOpRnd);
						}

						this.saveDB();
						this.myEpoch = newEpoch; 
						this.emit('block', { tick: this.myStamp, epoch: this.myTick, block: this.myEpoch })
					} else {
						this.emit('epoch', { tick: this.myStamp, epoch: this.myTick, block: this.myEpoch }) 
					}
				})


			}, sec);
		}

		this.reports = () =>
                {
                        return {
				pubsub:	this.stats(),
				ipfs: this.ipfsStats,
				ethereum: this.ethNetStatus(),
				throttle: this.seen.seen
			};
                }

		// pubsub handler
		this.connectP2P();
		this.join('Optract');
		__ipfsConnect();

		// JSON for now, leveldb soon
		const Pathwise = require('level-pathwise');
		const level = require('level');
		this.db;
		this.lastblk = 0;

		this.initDB = () =>
		{
			let dbpath = path.join(this.appCfgs.datadir, 'opdb');
			if (fs.existsSync(dbpath)) {
				// TODO: check db integrity?
				try {
					this.db = new Pathwise(level(dbpath));
					this.db.get(['lost'], (err, rc) => { 
						if (err) this.lostChunk = []; 
						this.lostChunk = rc;
					});
					this.db.get(['lastblk'], (err, rc) => { 
						if (err) this.lastblk = 0;
						this.lastblk = rc; 
						this.genOpRoundDB();
						this.genBlockDB(this.lastblk);
					});
				} catch(err) {
					if (err) { console.trace(err); throw 'leveldb initialization failed'; }
				}
			} else {
				//this.db = { block: {}, acc2vc: {}, lost: [], lastblk: 0 };
				this.db = new Pathwise(level(dbpath));
				this.db.put([], {
					lastblk: 0, lost: [], block: {}, acc2vc: {}
				}, (err, rc) => {
					if (err) { console.trace(err); throw 'leveldb initialization failed'; }
					this.genOpRoundDB();
					this.genBlockDB(0);
				})
			}
		}

		this.saveDB = () =>
		{
			if (this.lostChunk.length > 0) this.db.put(['lost'], this.lostChunk, (e,r) => {
				console.log(`Please do not turn off node before done ...`);
			});
		}

		// db update for curated, voted, and claimed will not be abstracted for now
		this.setIncommingHandler((msg) => 
		{
			let data = msg.data;
			let account = ethUtils.bufferToHex(data.account);

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
					} else if (this.pending.nonces[account] >= 120) {
					        return; // FIXME: still need to implement nonce records properly in committed blocks. ?????????????????????
					}
				} catch(err) {
					console.trace(err);
					return;
				}

				this.getOproundInfo().then((rc) => {	
					let oid = ethUtils.bufferToHex(data.oid);
					let aid = ethUtils.bufferToHex(data.aid);
					let since = ethUtils.bufferToInt(data.since);
					let comment = ethUtils.bufferToHex(data.comment);
					let opround = ethUtils.bufferToInt(data.opround); 
					let v1block = ethUtils.bufferToInt(data.v1block); 
					let v1leaf = ethUtils.bufferToHex(data.v1leaf); 
					let v2block = ethUtils.bufferToInt(data.v2block); 
					let v2leaf = ethUtils.bufferToHex(data.v2leaf); 

					//payload arrays
					let labels = ['uint', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'];
					let values = [opround,  account,  comment,        aid,       oid, v1block,   v1leaf, v2block,   v2leaf,  since];

					// console.dir(rc);
	
					if (rc[0] === 0 && rc[1] === '0x0000000000000000000000000000000000000000000000000000000000000000' && opround === rc[0]) {
						console.log(`DEBUG: Genesis`);
						oid = rc[1]; values[4] = rc[1];
					} else if (oid !== rc[1] || opround !== rc[0]) { 
						return 
					}
	
					if (comment === '0x') {
						comment = '0x0000000000000000000000000000000000000000000000000000000000000000';
						values[2] = comment;
						if (v1leaf === '0x' || v1block === 0) return;
						if (v2leaf !== '0x' && v2block === 0) return;
					}

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

					const __abi_sign = (txtype, aid) => (labels, values) => {
						let _payload = this.abi.encodeParameters(labels, values);
						let payload = ethUtils.hashPersonalMessage(Buffer.from(_payload));
		                	       	let sigout = {
							originAddress: account,
				                      	v: ethUtils.bufferToInt(data.v),
		                		        r: data.r, s: data.s,
							payload,
				                       	netID: this.networkID
		                		};
						console.dir(sigout);
		
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

							let pack = msg.data.serialize();
							let txhash = ethUtils.bufferToHex(ethUtils.sha256(pack));
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
								this.ipfs.pin.add(ipfshash);
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

						return __abi_sign('curate', aid)(labels, values);
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

                                                                if (typeof(abiObj) === 'undefined' || aid === null) return;
								let values = abiObj.values;
								let labels = abiObj.labels;

								values[7] = 0;									  //v2block
								values[8] = '0x0000000000000000000000000000000000000000000000000000000000000000'; //v2leaf

								__abi_sign('vote', aid)(labels, values);
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
                                                                                if (!rc[0][0] || !rc[1][0] || rc[2] !== account || rc[3] === null) return;

										if (this.game.opround > 1) {
											if (this.game.lastMsr > 0 && typeof(this.game.lastSrates[account]) !== 'undefined') {
												let srate = (this.game.lastSrates[account][0] / this.game.lastSrates[account][1]) * 100;
										          	if (srate >= this.game.lastMsr) {
													let aid = rc[3];
                                                                                			__abi_sign('claim', aid)(labels, values);
												} else {
													return;
												}
											} else {
												console.log(`DEBUG: No lastMsr or lastSrates on this node... skip claim tx process`);
												return;
											}
										} else {
											let aid = rc[3];
                                                                                	__abi_sign('claim', aid)(labels, values);
										}
                                                                        })
                                                                }) 
                                                        }) 
						}
					}
			       })
			})
		})

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

				console.dir(params);

				let rlp = this.handleRLPx(mfields)(params);
				this.publish('Optract', rlp.serialize());

				return rlp;
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

				if (comments.length > 0) {
					let result = { comments, from: account };
					return __msgTx(result, {aid, oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side});
				} else {
					let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
					return __inner_msgTx(content, {aid, oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side});
				}
			})
		}

		this.rssParser = new Parser();
		this.parseFeed = (feedObj) => {
			let fields = feedObj.fields;
			return rssParser.parseURL(feedObj.url).then((feed)=>{
				return feed.items.map((rc)=>{
					return { title:rc[fields.title], link:rc[fields.link], contentSnippet:rc[fields.contentSnippet] };
				})
			})
		}
		this.allFeeds = [  // manually manage this for now
			{url: 'http://hackernoon.com/feed', fields: {title: 'title', link:'link', contentSnippet:'content:encoded'}},
			{url: 'https://medium.com/feed/one-zero', fields: {title: 'title', link:'link', contentSnippet:'contentSnippet'}}

		]

		this.newBotArticles = (_comment = "send by 11be bot") =>
		{
			let allFeedInfo = []
			allFeeds.map((feed)=>{
				this.parseFeed(feed).then((rc)=>{
					allFeedInfo.push(...rc);
				}).then(()=>{
					allFeeds.map((feedInfo)=>{
						let tags = '';  // TODO: determine tags from contentSnippet or mercury parser
						let url = feedInfo.url;
						// TODO: don't newArticle() if the url exists in recent opround(s)
						this.newArticle = (url, tags, _comment="send by 11BE rss bot");
					})
				})
			})
		}

		this.listV1LotteryWins = (op, acc) =>  // return winning votes
		{
			// Too much query if ask root-chain: First generate an array of txHashes, then query txHash one by one by:
			//     this.call(this.appName)('BlockRegistry')('isWinningTicket')(opround, txHash);
			let lottery = new Lottery();
			return this.getOproundInfo().then((rc)=>{
				let blk1 = rc[0];
				return this.getOproundLottery(op).then((rc)=>{
					// get a list of tx of type v1
					let blk2 = rc[1];
					let lotteryWinNumber = rc[2];
					let blk = Array.from({length: blk2-blk1+1}, (v, k)=>k+blk1);
					let articles = [];
					//let _blkdata = this.db.block[_blk];
					return new Promise((resolve, reject) => {
						this.db.get(['block', _blk], (err, _blkdata) => {
							if (err) return reject(err);
							Object.keys(_blkdata.tx2acc).map((_tx) => {
								if (_blkdata.tx2acc[_tx] === acc) {
									if (_blkdata.tx2aid[_tx] === '0x11be010000000000000000000000000000000000000000000000000000000000') articles.push(k);
								}
							})
						})

					        // from the list of txhash of type v1, select the lottery winner
						resolve(lottery.sample(articles, lotteryWinNumber));
					})
				})
			})
		}

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
					let ipfsHash = this.Bytes32toIPFSstring(data.cache); console.log(`Snapshot IPFS: ${ipfsHash} for block ${pending}`);
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

		this.setOnpendingHandler(__gen_pending); 

		this.parseMsgRLPx = (mRLPx) => { return this.handleRLPx(mfields)(mRLPx); }

		this.showTxContent = (txhash) => 
		{
			return this.parseMsgRLPx(this.pending.txdata[txhash]);
		}

		this.mergeSnapShot = (remote, dhashs) =>
		{
			console.log('Merging snapshot');
			dhashs.map((thash) => {
				return setTimeout((hash) => {
					let idx = remote[0].indexOf(hash);
					let data = this.handleRLPx(mfields)(Buffer.from(remote[2][idx]));
					let account = ethUtils.bufferToHex(data.account);
					let aid = ethUtils.bufferToHex(data.aid);
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
                                                        let ipfshash = this.Bytes32toIPFSstring(data.comment);
                                                        this.ipfs.pin.add(ipfshash);
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
			if (this.lastBlk !== this.myEpoch - 1) return; // node not yet fully synced, cannot calculate data for block production

		        leaves = [...snapshot[0]];
		        blkObj.data = snapshot;

                        console.log(`DEBUG: Final Leaves for myEpoch = ${blkObj.myEpoch}:`); console.dir(leaves);

                        let merkleTree = this.makeMerkleTree(leaves);
                        let merkleRoot = ethUtils.bufferToHex(merkleTree.getMerkleRoot());
                        console.log(`Block Merkle Root: ${merkleRoot}`);

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
                                        		this.game.lastSrates[acc][0] += this.game.voted[acc].reduce((c,aid) => {return this.game.aidwon[aid] ? c+1 : c }, 0);
						})
					})

					return this.put(Buffer.from(JSON.stringify(this.game.lastSrates)));
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
					return __genblk().then((ipfscid)=>{
						let baseline = 0;
						let finalistIPFS = '0x0';
						let successRateDB = '0x0';
						let minSuccessRate = 0;
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, snapshot[0].length, v1count, v2count, minSuccessRate, baseline, successRateDB, finalistIPFS)();
					})
                                } else if (rc === 1) {  // NDR
					let baseline = 0;
					let p = [__genblk()];

					//if (v1count > 0 || Object.values(this.game.acc2vc).reduce((c, i) => { c = c + i; return c }, 0) > 0) p.push(__genSdb());
					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let finalistIPFS = '0x0';
						let successRateDB = this.game.lastSDB;
						let minSuccessRate = Number(this.game.lastMsr);
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, snapshot[0].length, v1count, v2count, minSuccessRate, baseline, successRateDB, finalistIPFS)();
						})
				} else if (rc === 2) { // v1pass, trigger draw
					let baseline = 0;
					let p = [__genblk()];

					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let finalistIPFS = '0x0';
						let successRateDB = '0x0';
						let minSuccessRate = 0;
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, snapshot[0].length, v1count, v2count, minSuccessRate, baseline, successRateDB, finalistIPFS)();
						})
				} else if (rc === 3) {
					let _aid2cc = {};
					Object.keys(this.aidWatch).map((_aid) => { _aid2cc[_aid] = this.aidWatch[_aid].claimed.length });
					Object.keys(this.game.aid2cc).map((_aid) => { 
						if (typeof(_aid2cc[_aid]) === 'undefined') _aid2cc[_aid] = 0;
						_aid2cc[_aid] = _aid2cc[_aid] + this.game.aid2cc[_aid];
					});
					let baseline = Math.max(...Object.values(_aid2cc));
					let p = [__genblk(), __genFinalistIPFS(baseline), __genSdb()];
					return Promise.all(p).then((rc)=>{
						let ipfscid = rc[0];
						let finalistIPFS = rc[1];
						let successRateDB = rc[2][0];
						let minSuccessRate = rc[2][1];
                                            console.log(merkleRoot, ipfscid, snapshot[0].length);
                                            console.log(v1count, v2count, minSuccessRate, baseline);
                                            console.log(successRateDB, finalistIPFS);
						return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
						    merkleRoot, ipfscid, snapshot[0].length, v1count, v2count, minSuccessRate, baseline, successRateDB, finalistIPFS)();
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
				return { blockNo: sblockNo, ethBlockNo: rc[0], merkleRoot: rc[1], blockData: { [rc[2]]: this.Bytes32toIPFSstring(Buffer.from(rc[2].slice(2), 'hex')) } }
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
			return this.getBlockData(sblockNo).then( (b) => {
				let ipfsHash = Object.values(b.blockData)[0];
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

		const __send_pending = (tikObj) => 
		{
			let account  = this.userWallet[this.appName];
			let snapshot = this.packSnap(); 
			if (snapshot[0].length === 0) return;

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
								this.ipfs.pin.add(h).then(() => { 
									this.lostChunk.splice(this.lostChunk.indexOf(h), 1) 
								}) 
							})
						}, 0);
					}
				}).catch((err) => { console.trace(err); })
			})
		}

		this.genBlockCache = (blockNo) => (ipfsHash, blocksnap) =>
		{
			let txhs = blocksnap[0];
			let txdt = blocksnap[2];

			// initalize
			let opblock = { ipfsHash, tx2aid: {}, tx2acc: {} };

			txhs.map((t,i) => {
				let data = this.parseMsgRLPx(Buffer.from(txdt[i]));
				let aid  = ethUtils.bufferToHex(data.aid); 
				let acc  = ethUtils.bufferToHex(data.account); 
				opblock['tx2aid'][t] = aid;
				opblock['tx2acc'][t] = acc;

				if (aid === '0x11be010000000000000000000000000000000000000000000000000000000000') {
					this.db.get(['acc2vc', acc], (err, rc) => {
						let acc2vc;

						if (err || typeof(rc) === 'undefined') {
							console.trace(err);
							acc2vc = 0;
						} else {
							acc2vc = rc;
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

				if (blockNo > this.lastblk) {
					this.lastblk = blockNo;
					this.db.put(['lastblk'], blockNo);
				}
			});
		}

		this.locateTx = (blockNo) => (txhash, field='txdata') =>
		{
			const __locate = (resolve, reject) => {
				this.db.get(['block', blockNo], (err, opblock) => {
					if (field === 'aid' && typeof(opblock[blockNo]) !== 'undefined' && this.lastblk >= blockNo) {
						resolve(opblock[blockNo].tx2aid[txhash] || null);
					} else if (field === 'account' && typeof(opblock[blockNo]) !== 'undefined' && this.lastblk >= blockNo) {
						resolve(opblock[blockNo].tx2acc[txhash] || null);
					} else {
						this.getBlockData(blockNo).then((blkdat) => {
	        	                        	let ipfsHash = Object.values(blkdat.blockData)[0];
        	        	                        this.get(ipfsHash).then((bd) => {
                	        	                        let bksnap = JSON.parse(bd.toString()).data;
	
        	                        	                // sync comments
                	                        	        this.pinBlockDelta(bksnap, bksnap[0]);

	                        	                        // gen block cache
        	                        	                this.genBlockCache(blockNo)(ipfsHash, bksnap);

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

			txhs.map((t,i) => {
				let data = this.parseMsgRLPx(Buffer.from(txdt[i]));
				let aid  = ethUtils.bufferToHex(data.aid); 
				let acc  = ethUtils.bufferToHex(data.account);

				if (aid === '0x11be010000000000000000000000000000000000000000000000000000000000') {
					let v1blk = ethUtils.bufferToInt(data.v1block);
					let v1tx  = ethUtils.bufferToHex(data.v1leaf);
				
					if (typeof(this.game.voted[acc]) === 'undefined') this.game.voted[acc] = [];
					this.game.voted[acc].push(t);

					if (typeof(this.game.votWatch[acc]) === 'undefined') this.game.votWatch[acc] = [];
					this.game.votWatch[acc].push(v1tx);

					return this.locateTx(v1blk)(v1tx).then((v1txd) => {
						let v1aid = ethUtils.bufferToHex(v1txd.aid);
						let url   = v1txd.url.toString();
						if (typeof(this.game.aid2vc[v1aid]) === 'undefined') this.game.aid2vc[v1aid] = 0;
						this.game.aid2vc[v1aid] = this.game.aid2vc[v1aid] + 1;
						this.game.aidUrl[v1aid] = url; 
					})
				} else if (aid === '0x11be020000000000000000000000000000000000000000000000000000000000') {
					let v2blk = ethUtils.bufferToInt(data.v2block);
					let v2tx  = ethUtils.bufferToHex(data.v2leaf);
					let v1tx  = ethUtils.bufferToHex(data.v1leaf);

					if (typeof(this.game.clmWatch[acc]) === 'undefined') this.game.clmWatch[acc] = [];
					this.game.clmWatch[acc].push(v1tx)

					return this.locateTx(v2blk)(v2tx, 'aid').then((v2aid) => {
						if (typeof(this.game.aid2cc[v2aid]) === 'undefined') this.game.aid2cc[v2aid] = 0;
						this.game.aid2cc[v2aid] = this.game.aid2vc[v2aid] + 1;
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

				if (this.lastblk < sblockNo - 1) {
					console.log(`WARNING: block sync not yet finished ... skipped`);
					return setTimeout(this.genOpRoundDB, 60000);
				}

				this.renewOproundDB(this.game.opround);

				if (sblockNo > this.game.opStart) {
					__range(this.game.opStart, sblockNo - 1).map((b) => {
						return this.getBlockData(b).then((blkdat) => { 
							let ipfsHash = Object.values(blkdat.blockData)[0];
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
					if ( this.game.lastSDB === '0x0000000000000000000000000000000000000000000000000000000000000000' 
					  || this.game.lastFL  === '0x0000000000000000000000000000000000000000000000000000000000000000')
					{
						this.game.lastMsr = 0;
						this.game.lastSDB = '0x0';
						this.game.lastFL = '0x0';
						this.game.lastSrates = {};
						this.game.lastFinalist = [];

						return;
					}

					this.game.lastSDB = this.Bytes32toIPFSstring(this.game.lastSDB);
					this.game.lastFL  = this.Bytes32toIPFSstring(this.game.lastFL);

					let p = [ 
						this.get(this.game.lastSDB), 
						this.get(this.game.lastFL),
						this.ipfs.pin.add(this.game.lastSDB),
						this.ipfs.pin.add(this.game.lastFL)
					];

					return Promise.all(p).then((rc)=>{
                                                // lastSrates is the accumulated srate until previous opround
						this.game.lastSrates = JSON.parse(rc[0].toString());
						this.game.lastFinalist = JSON.parse(rc[1].toString());
					})
				})
			} else if (newOpRndNo === 1) {
				// may cause error in next opround if these values are 'underfined'
				this.game.lastMsr = 0;
				this.game.lastSDB = '0x0';
				this.game.lastFL = '0x0';
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
						let ipfshash = this.Bytes32toIPFSstring(data.comment);
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
				let ipfsHash = Object.values(blkdat.blockData)[0];
				return Promise.all([this.ipfs.pin.add(ipfsHash), this.get(ipfsHash), this.packSnap(), Promise.resolve(ipfsHash)])
			}).then((rc) => {
				let bksnap = JSON.parse(rc[1].toString()).data;
				let mysnap = rc[2];

				let tokeep = keeping([...mysnap[0]], [...bksnap[0]]); // pass in duplicates
				let todrop = keeping([...mysnap[0]], tokeep);
				let tosync = missing([...mysnap[0]], [...bksnap[0]]); // pass in duplicates

				this.aidWatch = {};
				this.clmWatch = {};
                                this.clearSnapShot(todrop);
                                if (tosync.length > 0) this.pinBlockDelta(bksnap, tosync);
				this.emit('epoch', tikObj); // do this only *after* clearSnapShot

				this.getOpRoundCache(newBlockNo - 1)(rc[3], bksnap);
				this.genBlockCache(newBlockNo - 1)(rc[3], bksnap);
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
						let ipfsHash = Object.values(blkdat.blockData)[0];

						let p = [
							this.get(ipfsHash),
							this.ipfs.pin.add(ipfsHash)
						];

						return Promise.all(p).then((rc) => {
							let bd = rc[0];
							let bksnap = JSON.parse(bd.toString()).data;

							// sync comments
							this.pinBlockDelta(bksnap, bksnap[0]);

							// gen block cache
							this.genBlockCache(b)(ipfsHash, bksnap);
						})
					})
                        		.catch((err) => { console.log(`genBlockDB: `); console.trace(err); process.exit(1);})
				})

				this.saveDB();
			})
                        .catch((err) => { console.log(`genBlockDB: `); console.trace(err); process.exit(1);})
		}

		this.on('epoch', __send_pending);
		this.on('block', this.parseBlock);
	}
}

const appCfg = { daemon: false, wsrpc: true, ...config.node, port: 45054 };

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
	 .then(() => { return new Promise(askMasterPass) })
         .then((answer) => { opt.password(answer); return opt.validPass() })
         .then((rc) => {
		if (rc && typeof(opt.appCfgs.dapps[opt.appName].account) !== 'undefined') {
			return opt.linkAccount(opt.appName)(opt.appCfgs.dapps[opt.appName].account)
			          .then((rc) => {console.log(rc); return opt.initDB() });
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
				opt.leave();
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
				vars: ['networkID', 'userWallet', 'pending'],
				stat: ['reports', 'getPrevBlockData', 'validPass'],
				func: ['getBlockData', 'password'],
				main: ['newArticle', 'newVote', 'newClaim']
			}

			expose.vars.map((i) => { r.register(i, () => { return opt[i]; }); })
			expose.stat.map((s) => { r.register(s, () => { return opt[s](); }); })
			expose.func.map((f) => { r.register(f, (args) => { let input = args[0]; return opt[f](input); }); })
			expose.main.map((f) => { r.register(f, (obj) => { let inputs = obj.args; return opt[f](...inputs); }); })
		    })

		    process.on('SIGINT', () => {
		        console.log("\n\t" + 'Stopping WSRPC...');
			opt.leave();
			opt.swarm.close();
			r.close();
		    })
	     }
	 })
	 .catch((err) => { console.trace(err); })
}
