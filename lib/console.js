'use strict';

const fs = require('fs');
const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
// const AsciiTable = require('ascii-table');
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
        {name: 'opround', length: 32, allowLess: true, default: Buffer.from([]) },  // opround integer
        {name: 'account', length: 20, allowZero: true, default: Buffer.from([]) },  // user (autherized) address
        {name: 'content', length: 32, allowLess: true, default: Buffer.from([]) },  // ipfs hash (content or comment)
        {name: 'oid', length: 32, allowLess: true, default: Buffer.from([]) },      // participating game round ID, bytes32
        {name: 'v1block', length: 32, allowLess: true, default: Buffer.from([]) },  // 1st vote block
        {name: 'v1leaf', length: 32, allowLess: true, default: Buffer.from([]) },   // 1st vote txhash
        {name: 'v2block', length: 32, allowLess: true, default: Buffer.from([]) },  // 2nd vote (claim) block
        {name: 'v2leaf', length: 32, allowLess: true, default: Buffer.from([]) },   // 2nd vote (claim) txhash
        {name: 'since', length: 32, allowLess: true, default: Buffer.from([]) },    // timestamp, uint
        {name: 'v1proof', length: 512, allowZero: true, allowLess:true, default: Buffer.from([]) }, // 1st vote merkle proof
        {name: 'v1side', length: 16, allowZero: true, allowLess:true, default: Buffer.from([]) },    // 1st vote merkle proof (side)
        {name: 'v2proof', length: 512, allowZero: true, allowLess:true, default: Buffer.from([]) }, // 2nd vote merkle proof
        {name: 'v2side', length: 16, allowZero: true, allowLess:true, default: Buffer.from([]) },    // 2nd vote merkle proof (side)
        {name: 'v', allowZero: true, default: Buffer.from([0x1c]) },
        {name: 'r', allowZero: true, length: 32, default: Buffer.from([]) },
        {name: 's', allowZero: true, length: 32, default: Buffer.from([]) }
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
		   'unlockAndSign',
		   'verifySignature',
		   'queueReceipts',
		   'validateMerkleProof',
		   'getBlockNo',
		   'getBlockInfo',
		   'getOpround',
		   'getOproundId',
		   'getOproundInfo'
		];		

		mixins.map((f) => { if (typeof(this[f]) === 'undefined' && typeof(Ethereum[f]) === 'function') this[f] = Ethereum[f] });

		this.networkID = Ethereum.networkID;
		this.abi = Ethereum.abi;
		this.userWallet = Ethereum.userWallet;

		// IPFS related
		this.ipfs = new ipfsClient('127.0.0.1', '5001', {protocol: 'http'})

		this.get = (ipfsPath) => { return this.ipfs.cat(ipfsPath) }; // returns promise that resolves into Buffer
		this.put = (buffer)   => { return this.ipfs.add(buffer) }; // returns promise that resolves into JSON
		
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

		this.game = {drawed: false, opround: 1 }; // mocking.. the actual data should be read from smart contract.

		this.ipfsSwarms = [
			"/ipfs/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM",
			"/ipfs/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
			"/ipfs/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu",
			"/ipfs/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd",
			"/ipfs/QmTKBfNygNbmH4iGL8z5CbKUpxR7j4fDtTgbKCDsRZguZ7",
			"/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
			"/ipfs/QmanMqJfywyBDAFej6GKyb967jBy7drBkeFDT66t3mKhgD",
			"/ipfs/QmXUZGsV4jPUNqTQPZpV6fg8z3ivPgoi6FVBWF3wP6Boyj"
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
				this.getBlockNo().then((newEpoch) => {
					if (this.myEpoch < newEpoch) {
						this.myEpoch = newEpoch; 
						this.emit('block', { tick: this.myStamp, epoch: this.myTick, block: this.myEpoch })
					} else {
						// TODO: update here so that epoch only happen right before committing new block.
						//       otherwise we simply update myTick by adding 1.
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

		//const compare = (a,b) => { if (a.nonce > b.nonce) { return 1 } else { return -1 }; return 0 };

		this.setIncommingHandler((msg) => 
		{
			//TODO: filter duplication post by same sender.
			let data = msg.data;
			let account = ethUtils.bufferToHex(data.account);

			this.memberStatus(account).then((rc) => { return rc[0] === 'active'; }).then((rc) => {
				if (!rc) return; // check is member or not ... not yet checking different tiers of memberships.
				try {
					if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
					        return;
					} else if ( typeof(this.pending['txhash'][account]) === 'undefined' 
					         || typeof(this.pending['nonces'][account]) === 'undefined') 
					{
					        this.pending['txhash'][account] = [];
					        this.pending['nonces'][account] = 0;
					} else if (this.pending.nonces[account] >= 120) {
					        return; // FIXME: still need to implement nonce records properly in committed blocks.
					}
				} catch(err) {
					console.trace(err);
					return;
				}

				this.getOproundInfo().then((rc) => {	
					let oid = ethUtils.bufferToHex(data.oid);
					let since = ethUtils.bufferToInt(data.since);
					let content = ethUtils.bufferToHex(data.content);
					let opround = ethUtils.bufferToInt(data.opround); 
					let v1block = ethUtils.bufferToInt(data.v1block); 
					let v1leaf = ethUtils.bufferToHex(data.v1leaf); 
					let v2block = ethUtils.bufferToInt(data.v2block); 
					let v2leaf = ethUtils.bufferToHex(data.v2leaf); 

					//payload arrays
					let labels = ['uint', 'address', 'bytes32', 'bytes32', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'];
					let values = [opround,  account,  content, oid, v1block, v1leaf, v2block, v2leaf,  since];

					console.dir(rc);
	
					if (rc[0] === 0 && rc[1] === '0x0000000000000000000000000000000000000000000000000000000000000000' && opround === rc[0]) {
						console.log(`DEBUG: Genesis`);
						oid = rc[1]; values[3] = rc[1];
					} else if (oid !== rc[1] || opround !== rc[0]) { 
						return 
					}
	
					if (content === '0x') {
						content = '0x0000000000000000000000000000000000000000000000000000000000000000';
						values[2] = content;
						if (v1leaf === '0x' || v1block === 0) return;
						if (v2leaf !== '0x' && v2block === 0) return;
					}

					if (v1leaf === '0x') { // curate
						v1block = 0;
						v1leaf = '0x0000000000000000000000000000000000000000000000000000000000000000';
						values[4] = v1block;
						values[5] = v1leaf;

						v2block = 0;
						v2leaf = '0x0000000000000000000000000000000000000000000000000000000000000000';
						values[6] = v2block;
						values[7] = v2leaf;

						return __abi_sign(labels, values);
					}

					const __handle_vote = (type) => (data) =>
					{
						let proof;
						let proves;
						let side;
						let sides;
						if (type === 'v1') {
	                                        	proof = ethUtils.bufferToHex(data.v1proof);  // assume v1proof is 0x + (32bytes)*16
                                                	proves = proof.slice(2).match(/.{1,32}/g).map((i)=>{return '0x'+i});
	                                        	side = ethUtils.bufferToHex(data.v1side);
                                                	sides = side.slice(2).match(/.{1,2}/g).map((i)=>{return i === '00' ? false : true});
						} else if (type === 'v2') {
	                                        	proof = ethUtils.bufferToHex(data.v2proof);  // assume v1proof is 0x + (32bytes)*16
                                                	proves = proof.slice(2).match(/.{1,32}/g).map((i)=>{return '0x'+i});
	                                        	side = ethUtils.bufferToHex(data.v2side);
                                                	sides = side.slice(2).match(/.{1,2}/g).map((i)=>{return i === '00' ? false : true});
						}

						return {proof, proves, side, sides};
					}

					const __add_abi = (type) => (labels, values, proves, sides, leaf, block) =>
					{
						let n1 = type === 'v1' ? 9 : 11 ;
						let n2 = n1 + 1;

						return this.call(this.appName)('BlockRegistry')('txExist')(proves, sides, leaf, block).then((rc) => {
							if (!rc) return;
                                        		labels.splice(n1, 0, 'bytes32[]'); 
                                        		labels.splice(n2, 0, 'bool[]');  
                                        		values.splice(n1, 0, proves);
                                        		values.splice(n2, 0, sides);

							return {labels, values};
						})
					}

					const __abi_sign = (labels, values) => {
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
							let pack = msg.data.serialize();
							let txhash = ethUtils.bufferToHex(ethUtils.sha256(pack));
					                this.pending['txhash'][account].push(txhash);
							this.pending['txhash'][account] = Array.from(new Set(this.pending['txhash'][account])).sort();
							this.pending['nonces'][account] = this.pending['txhash'][account].length;
		                	       		this.pending['txdata'][txhash]  = pack;
				                        this.pending['payload'][txhash] = payload;
	
							console.log(`INFO: Got ${txhash} from ${account}`); 
							// silenced. just to cache content on local ipfs.
							if (content !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
								let ipfshash = this.Bytes32toIPFSstring(content);
								this.ipfs.pin.add(ipfshash);
							}
		                	       	}
					}
	
					if (v1leaf !== '0x') {
						let v1 = __handle_vote('v1')(data);
						
						if (v2leaf === '0x') { // v1 vote
							return __add_abi('v1')(labels, values, v1.proves, v1.sides, v1.leaf, v1.block).then((abiObj) => 
							{
								let values = abiObj.values;
								let labels = abiObj.labels;

								v2block = 0;
								v2leaf = '0x0000000000000000000000000000000000000000000000000000000000000000';
								values[6] = v2block;
								values[7] = v2leaf;

								__abi_sign(labels, values);
							})
				    		} else if (v2leaf !== '0x') {
							return this.call(this.appName)('BlockRegistry')('lotterySblockNo')(opround).then((rc) => {
								if(Number(rc) === 0) return;
								let lotteryBlockNo = rc;

								return __add_abi('v1')(labels, values, v1.proves, v1.sides, v1.leaf, v1.block).then((abiObj) => {
									let v2 = __handle_vote('v2')(data);
									let labels = abiObj.labels;
									let values = abiObj.values;

									return __add_abi('v2')(labels, values, v2.proves, v2.sides, v2.leaf, v2.block).then((abiObj) => 
									{
										let labels = abiObj.labels;
										let values = abiObj.values;

										let p = [
	                                                                          this.call(this.appName)('BlockRegistry')('isWinningTicket')(lotteryBlockNo, v1.leaf), 
	                                                                          this.call(this.appName)('BlockRegistry')('isWinningTicket')(lotteryBlockNo, v2.leaf) 
										];

	                                                                        return Promise.all(p).then((rc) => 
										{
	                                                                                if (!rc[0] || !rc[1]) return;

	                                                                                //TODO: verify success rate

											__abi_sign(labels, values);
										})
									}) 
								}) 
							})
						}
					}
			       })
			})
		})

		const __inner_msgTx = (content, txData) =>
		{
			let opround = txData.opround;
			let account = txData.account;
			let v1block = txData.v1block;
			let v1leaf  = txData.v1leaf;
			let v2block = txData.v2block;
			let v2leaf  = txData.v2leaf;
			let oid = txData.oid;
			let since = Math.floor(Date.now() / 1000);
			let v1proof;
			let v2proof;
			let v1side;
			let v2side;

			let labels = ['uint', 'address', 'bytes32', 'bytes32', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'];
			let values = [opround, account, content, oid, v1block, v1leaf, v2block, v2leaf, since];

			if (typeof(txData.v1proof) !== 'undefined' && typeof(txData.v1side) !== 'undefined') {
				v1side  = txData.v1side;
				labels.splice(9, 0, 'bytes32[]');  // v1proof
                                labels.splice(10, 0, 'bool[]');  // v1side
                                values.splice(9, 0, txData.v1proof);
                                values.splice(10, 0, v1side);
                                v1proof = Buffer.concat(txData.v1proof.map((v)=>{return Buffer.from(v.slice(2))}));
			}

			if (typeof(txData.v2proof) !== 'undefined' && typeof(txData.v2side) !== 'undefined') {
				v2side  = txData.v2side;
				labels.splice(11, 0, 'bytes32[]');  // v2proof
                                labels.splice(12, 0, 'bool[]');  // v2side
                                values.splice(11, 0, txData.v2proof);
                                values.splice(12, 0, v2side);
                                v2proof = Buffer.concat(txData.v2proof.map((v)=>{return Buffer.from(v.slice(2))}));
			}

			let payload = this.abi.encodeParameters(labels, values);

			return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
				let params = {
					opround, account, content, oid,
					v1block, v1leaf, v2block, v2leaf,
					since, v: sig.v, r: sig.r, s: sig.s
				};

				if (typeof(v1proof) !== 'undefined' && typeof(v1side) !== 'undefined') params = { ...params, v1proof, v1side}
				if (typeof(v2proof) !== 'undefined' && typeof(v2side) !== 'undefined') params = { ...params, v2proof, v2side}

                            // TODO: make sure `bytes32[]` size is 32*16=512 bytes
                            // Note: got error in handleRLPx while: opt.newVote(6, '0xfa698a00dc37cd75762b2c685d45c3f9446b69574dd175f876a681d178478c65')
				let rlp = this.handleRLPx(mfields)(params);
				this.publish('Optract', rlp.serialize());

				return rlp;
			}).catch((err) => { console.trace(err); })
		}

		const __msgTx = (result, txData) =>
		{
			return this.put(Buffer.from(JSON.stringify(result))).then((out) => {
				let content = this.IPFSstringtoBytes32(out[0].hash);
				return __inner_msgTx(content, txData);
			})
		}

		this.newArticle = (url, tags = []) => 
		{
			let account = this.userWallet[this.appName];
			let v1leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v2leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v1block = 0;
			let v2block = 0;

			return this.getOproundInfo().then((rc) => {
				let opround = rc[0];
                        	let oid = rc[1];
				return mr.parse(url).then((result) => {
					result['tags'] = tags;
					result.content = ethUtils.bufferToHex(ethUtils.sha256(Buffer.from(result.content)));
					return __msgTx(result, {oid, opround, v1leaf, v1block, v2leaf, v2block, account});
				}).catch((err) => { console.trace(err); })
			})
		}

		this.newVote = (v1block, v1leaf, comments = '') =>
		{
			let account = this.userWallet[this.appName];
			let v2leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v2block = 0;

			let p = [ this.getProofSet(v1block, v1leaf), this.getOproundInfo() ];

                        return Promise.all(p).then((rc) => { // this will fail if v1leaf not in v1block
                                let v1proof = rc[0][0]
				let v1side  = rc[0][1];
				let opround = rc[1][0];
                        	let oid     = rc[1][1];

				if (typeof(v1proof) === 'undefined' || typeof(v1side) === 'undefined' || opround === 0 || oid === '0x') return {call: 'newVote', rc};

                                // convert v1side from boolean array to integer (0-65535, or 2 bytes)
                                // for example: [true, false, true] = 1*(2^2) + 0*(2^1) + 1*(2^0) = 5
                                if (v1side.length > 16) throw ('block contain more than 65535 txHash')
                                // v1side = v1side.map((v, k)=>{return v===true ? 2**(v1side.length-1-k) : 0}).reduce((_a, _b)=> _a+_b);

				if (comments.length > 0) {
					let result = { comments, from: account };
					return __msgTx(result, {oid, opround, v1leaf, v1block, v1proof, v1side, v2leaf, v2block, account});
				} else {
					let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
					return __inner_msgTx(content, {oid, opround, v1leaf, v1block, v1proof, v1side, v2leaf, v2block, account});
				}
                        })
		} 

		this.newClaim = (v1block, v1leaf, v2block, v2leaf, comments = '') =>
		{
			let account = this.userWallet[this.appName];
			let p = [ this.getProofSet(v1block, v1leaf), this.getProofSet(v2block, v2leaf), this.getOproundInfo() ];

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

                                // convert bool array to integer (max length of array is 16 to make a uint of 2 bytes)
                                if (v1side.length > 16 || v2side.length > 16) throw ('block contain more than 65535 txHash')
                                v1side = v1side.map((v, k)=>{return v===true ? 2**(v1side.length-1-k) : 0}).reduce((_a, _b)=> _a+_b);
                                v2side = v2side.map((v, k)=>{return v===true ? 2**(v2side.length-1-k) : 0}).reduce((_a, _b)=> _a+_b);

				if (comments.length > 0) {
					let result = { comments, from: account };
					return __msgTx(result, {oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side});
				} else {
					let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
					return __inner_msgTx(content, {oid, opround, v1leaf, v1block, v2leaf, v2block, account, v1proof, v1side, v2proof, v2side});
				}
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
				let ipfsHash = this.Bytes32toIPFSstring(data.cache); console.log(`Snapshot IPFS: ${ipfsHash}`);
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
		}

		this.setOnpendingHandler(__gen_pending); 

		this.parseMsgRLPx = (mRLPx) => { return this.handleRLPx(mfields)(mRLPx); }

/*
		this.showTxContent = (txhash) => 
		{
			let ipfshash = this.Bytes32toIPFSstring(this.parseMsgRLPx(this.pending.txdata[txhash]).content);
			return this.get(ipfshash).then((c) => { return JSON.parse(c.toString()) })
				   .catch((err) => { console.log(`DEBUG: error in showTxContent (${ipfshash} from ${txhash})`); });
		}
*/

		this.mergeSnapShot = (remote, dhashs) =>
		{
			// TODO: update v1 and v2 counts from pending
			console.log('Merging snapshot');
			dhashs.map((thash) => {
				return setTimeout((hash) => {
					let idx = remote[0].indexOf(hash);
					let data = this.handleRLPx(mfields)(Buffer.from(remote[2][idx]));
					let account = ethUtils.bufferToHex(data.account);
					let sigout = {
						originAddress: account,
						payload: Buffer.from(remote[1][idx]),
						v: ethUtils.bufferToInt(data.v),
						r: data.r, s: data.s,
						netID: this.networkID // FIXME: we need to include networkID in snapshot
					}
	
					if (this.verifySignature(sigout)){
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
                                                if (data.content.length != 0) {  // vote have no content
                                                        let ipfshash = this.Bytes32toIPFSstring(data.content);
                                                        this.ipfs.pin.add(ipfshash);
                                                }
					}
				}, 0, thash);
			})

			// generate & commit merkle root here when the time is up.
			// when new block is committed, need to "diff" new block with local pending. 
			// but this time we will keep tx that did not go into block.
		}
	
		this.makeMerkleTreeAndUploadRoot = () =>
                {
                        // Currently, we will group all block data into single JSON and publish it on IPFS
                        let blkObj =  {myEpoch: this.myEpoch, data: {} };
                        let leaves = [];

                        // is this block data structure good enough?
			let snapshot = this.packSnap();
		        if (snapshot[0].length === 0) return;
		        leaves = [...snapshot[0]];
		        blkObj.data = snapshot;

                        console.log(`DEBUG: Final Leaves for myEpoch = ${blkObj.myEpoch}:`); console.dir(leaves);

                        let merkleTree = this.makeMerkleTree(leaves);
                        let merkleRoot = ethUtils.bufferToHex(merkleTree.getMerkleRoot());
                        console.log(`Block Merkle Root: ${merkleRoot}`);

                        let stage = this.generateBlock(blkObj);
                        stage = stage.then((rc) => {
                                console.log('IPFS Put Results'); console.dir(rc);
                                let ipfscid = this.IPFSstringtoBytes32(rc[1][0].hash);
                                console.log('IPFS CID: ' + ipfscid);
                                // TODO: fill in following variables
                                let v1count = 0;
                                let v2count = 0;
                                let lotteryIPFS = '0x0';
                                let minSuccessRate = 0;
                                let successRateDB = '0x0';
                                let finalistIPFS = '0x0';
                                return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(
                                    merkleRoot, ipfscid, snapshot[0].length, v1count, v2count, lotteryIPFS, minSuccessRate, successRateDB, finalistIPFS)();
                        })
                        .catch((err) => { console.log(`ERROR in makeMerkleTreeAndUploadRoot`); console.trace(err); });

                        return stage;
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
					[tikObj.epoch, tikObj.block, account, cache, tikObj.tick] //PoC code fixing pending block No to "1"
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
							this.lostChunk = [ ...new Set(this.lostChunk) ];
							[...this.lostChunk].map((h) => { 
								this.ipfs.pin.add(h).then(() => { 
									this.lostChunk.splice(this.lostChunk.indexOf(h), 1) 
								}) 
							})
						}, 0);
					}
				}).catch((err) => { console.trace(err); })
			})
		}

		this.pinBlockDelta = (remote, dhashs) =>
		{
			console.log('pinning block delta');
                        dhashs.map((thash) => {
                                return setTimeout((hash) => {
					console.log(`DEBUG: checking and pin ${hash} if applicable ...`);
					let idx = remote[0].indexOf(hash);
                                        let data = this.handleRLPx(mfields)(Buffer.from(remote[2][idx]));
					if (data.content.length != 0) {
						let ipfshash = this.Bytes32toIPFSstring(data.content);
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
			//TODO: pin -> in -> data
			let newBlockNo = tikObj.block;
			this.getBlockData(newBlockNo - 1).then((blkdat) => { 
				console.log(`DEBUG: parsing block data ${newBlockNo - 1}`);
				let ipfsHash = Object.values(blkdat.blockData)[0];
				return Promise.all([this.ipfs.pin.add(ipfsHash), this.get(ipfsHash), this.packSnap()])
			}).then((rc) => {
				let bksnap = JSON.parse(rc[1].toString()).data;
				let mysnap = rc[2];

				let tokeep = keeping([...mysnap[0]], [...bksnap[0]]); // pass in duplicates
				let todrop = keeping([...mysnap[0]], tokeep);
				let tosync = missing([...mysnap[0]], [...bksnap[0]]); // pass in duplicates

                                this.clearSnapShot(todrop);
                                if (tosync.length === 0 ) return this.emit('epoch', tikObj);
				this.pinBlockDelta(bksnap, tosync);
			})
                        .catch((err) => { console.log(`parseBlock: `); console.trace(err); })
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
	let stage = new Promise(askMasterPass)
         .catch((err) => { process.exit(1); })
         .then((answer) => { opt = new OptractNode(appCfg); opt.password(answer); return opt.validPass() })
         .then((rc) => {
		if (rc && typeof(opt.appCfgs.dapps[opt.appName].account) !== 'undefined') {
			return opt.linkAccount(opt.appName)(opt.appCfgs.dapps[opt.appName].account).then(console.log);
		} else {
			//console.log(`WARNING: Read-Only Mode as Master Password is NOT unlocked!!!`);
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
				func: ['newArticle', 'getBlockData', 'password']
			}

			expose.vars.map((i) => { r.register(i, () => { return opt[i]; }); })
			expose.stat.map((s) => { r.register(s, () => { return opt[s](); }); })
			expose.func.map((f) => { r.register(f, (args) => { let input = args[0]; return opt[f](input); }); })
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
