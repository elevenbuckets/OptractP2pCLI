'use strict';

const fs = require('fs');
const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSubNode = require('./pubsubNode.js');
const OptractMedia = require('../dapps/OptractMedia/OptractMedia.js');
const ipfsClient = require('ipfs-http-client');
const mr = require('@postlight/mercury-parser');
const bs58 = require('bs58');
const diff = require('json-diff').diff;
const ethUtils = require('ethereumjs-utils');
const MerkleTree = require('merkle_tree');
const WSServer = require('rpc-websockets').Server;

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

// Common Tx
const mfields =
[
        {name: 'nonce', length: 32, allowLess: true, default: Buffer.from([]) },
        {name: 'account', length: 20, allowZero: true, default: Buffer.from([]) },
        {name: 'content', length: 32, allowLess: true, default: Buffer.from([]) },   // ipfs hash (content or comment)
        {name: 'opround', length: 32, allowLess: true, default: Buffer.from([]) },    // game round participating. should be sha3(side block hash + eth block hash)
        {name: 'v1block', length: 32, allowLess: true, default: Buffer.from([]) },  // 1st vote block
        {name: 'v1leaf', length: 32, allowLess: true, default: Buffer.from([]) },   // 1st vote txhash
        {name: 'v2block', length: 32, allowLess: true, default: Buffer.from([]) },  // 2nd vote (claim) block
        {name: 'v2leaf', length: 32, allowLess: true, default: Buffer.from([]) },   // 2nd vote (claim) txhash
        {name: 'since', length: 32, allowLess: true, default: Buffer.from([]) },
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
		   'validateMerkleProof'
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

                this.Bytes32toIPFSstring = (hash) =>  // hash is a bytes32 Buffer
                {
                        return bs58.encode(Buffer.concat([Buffer.from([0x12, 0x20]), hash]))
                }

		// Event related		
		this.currentTick = 0; //Just an epoch.
		this.pending = { txdata: {}, payload: {}, txhash: {} }; // format ??????
		this.newblock = {};
		this.myNonce = 0;
		this.myEpoch = 0; // Optract block No.
		this.game = {drawed: false, opround: 1 }; // mocking.. the actual data should be read from smart contract.

		this.ipfsSwarms = [
			"/ipfs/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM",
			"/ipfs/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64",
			"/ipfs/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu",
			"/ipfs/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd",
			"/ipfs/Qmd5QhvVUdYa7LPnyKsWvVTi2iz2sa7XeGLdGc2eC9Fecm",
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
				this.currentTick = Math.floor(Date.now() / 1000);
				this.myEpoch = (this.currentTick - (this.currentTick % 300)) / 300;
				this.emit('epoch', { tick: this.currentTick, epoch: this.myEpoch }) 
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

			this.memberStatus(account).then((rc) => { return rc[0] === 'active'; })
			    .then((rc) => {
				if (!rc) return; // check is member or not ... not yet checking different tiers of memberships.
				try {
					if ( !('v' in data) || !('r' in data) || !('s' in data) ) {
					        return;
					} else if ( typeof(this.pending['txhash'][account]) === 'undefined' ) {
					        this.pending['txhash'][account] = [];
					} else if (this.pending['txhash'][account].length >= 120) {
					        return;
					}
				} catch(err) {
					console.trace(err);
					return;
				}
	
				let nonce = ethUtils.bufferToInt(data.nonce);
				let since = ethUtils.bufferToInt(data.since);
				let content = ethUtils.bufferToHex(data.content);
				let opround = ethUtils.bufferToInt(data.opround); 
				let v1block = ethUtils.bufferToInt(data.v1block); 
				let v1leaf = ethUtils.bufferToHex(data.v1leaf); 

				if (opround === '0' || opround !== this.game.opround) return;

				if (content === '0x') {
					content = '0x0000000000000000000000000000000000000000000000000000000000000000';
					if (v1leaf === '0x' || v1block === 0) return;
					if (v2leaf !== '0x' && v2block === 0) return;
				}

				if (v1leaf !== '0x') {
					//TODO: verify v1leaf in v1block

					if (v2leaf !== '0x') {
						// TODO: verify opround lottery has announced
						//     & verify v2leaf in v2block
						//     & verify v1block[v1leaf] won opround "user" lottery
						//     & verify account success rate
						//     & verify v2block[v2leaf] won opround "article" lottery
					}
				}

				if (v1leaf === '0x') {
					v1block = 0;
					v1leaf = '0x0000000000000000000000000000000000000000000000000000000000000000';
				}

				if (v2leaf === '0x') {
					v2block = 0;
					v2leaf = '0x0000000000000000000000000000000000000000000000000000000000000000';
				}

				let _payload = this.abi.encodeParameters(
					['uint', 'address', 'bytes32', 'uint', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'],
					[nonce,  account,  content, opround, v1block, v1leaf, v2block, v2leaf,  since]
				);

				let payload = ethUtils.hashPersonalMessage(Buffer.from(_payload));
	                        let sigout = {
					originAddress: account,
	                                v: ethUtils.bufferToInt(data.v),
	                                r: data.r, s: data.s,
					payload,
	                                netID: this.networkID
	                        };
				//console.dir(sigout);

			        if (this.verifySignature(sigout)){
					let pack = msg.data.serialize();
					let txhash = ethUtils.bufferToHex(ethUtils.sha256(pack));
	                                this.pending['txhash'][account].push(txhash);
					this.pending['txhash'][account] = Array.from(new Set(this.pending['txhash'][account])).sort();
	                                this.pending['txdata'][txhash]  = pack;
	                                this.pending['payload'][txhash] = payload;

					console.log(`INFO: Got ${txhash} from ${account}`); 
	                        }
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

			let since = Math.floor(Date.now() / 1000);
			let payload = this.abi.encodeParameters(
				['uint', 'address', 'bytes32', 'uint', 'uint', 'bytes32', 'uint', 'bytes32', 'uint'],
				[this.myNonce + 1, account, content, opround, v1block, v1leaf, v2block, v2leaf, since]
			);

			return this.unlockAndSign(account)(Buffer.from(payload)).then((sig) => {
				let params = {
					nonce: this.myNonce + 1,
					account, content, opround, 
					v1block, v1leaf, v2block, v2leaf,
					since, v: sig.v, r: sig.r, s: sig.s
				}; 
				let rlp = this.handleRLPx(mfields)(params);
				this.publish('Optract', rlp.serialize());
				this.myNonce = this.myNonce + 1;
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
			let opround = this.game.opround;

			return mr.parse(url).then((result) => {
				result['tags'] = tags;
				result.content = ethUtils.bufferToHex(ethUtils.sha256(Buffer.from(result.content)));
				return __msgTx(result, {opround, v1leaf, v1block, v2leaf, v2block, account});
			}).catch((err) => { console.trace(err); })
		}

		this.newVote = (v1block, v1leaf, comments = '') =>
		{
			// TODO: verify v1block and v1leaf before sending
			let account = this.userWallet[this.appName];
			let v2leaf  = '0x0000000000000000000000000000000000000000000000000000000000000000';
			let v2block = 0;
			let opround = this.game.opround;

			if (comments.length > 0) {
				let result = { comments, from: account };
				return __msgTx(result, {opround, v1leaf, v1block, v2leaf, v2block, account});
			} else {
				let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
				return __inner_msgTx(content, {opround, v1leaf, v1block, v2leaf, v2block, account});
			}
		} 

		this.newClaim = (v1block, v1leaf, v2block, v2leaf, comments = '') =>
		{
			// TODO: verify v1leaf and v2leaf in their respective blocks before sending
			//     & verify account did send v1leaf.
			let account = this.userWallet[this.appName];

			if (comments.length > 0) {
				let result = { comments, from: account };
				return __msgTx(result, {opround, v1leaf, v1block, v2leaf, v2block, account});
			} else {
				let content = '0x0000000000000000000000000000000000000000000000000000000000000000';
				return __inner_msgTx(content, {opround, v1leaf, v1block, v2leaf, v2block, account});
			}
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
		})

		this.parseMsgRLPx = (mRLPx) => { return this.handleRLPx(mfields)(mRLPx); }

		this.showTxContent = (txhash) => 
		{
			let ipfshash = this.Bytes32toIPFSstring(this.parseMsgRLPx(this.pending.txdata[txhash]).content);
			return this.get(ipfshash).then((c) => { return JSON.parse(c.toString()) })
		}

		this.mergeSnapShot = (remote, dhashs) =>
		{
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
						if (typeof(this.pending['txhash'][account]) === 'undefined') {
							this.pending['txhash'][account] = [];
						}

						let pack = Buffer.from(remote[2][idx]); let payload = Buffer.from(remote[1][idx]);
		                                this.pending['txhash'][account].push(hash);
						this.pending['txhash'][account] = Array.from(new Set(this.pending['txhash'][account])).sort();
		                                this.pending['txdata'][hash]  = pack;
		                                this.pending['payload'][hash] = payload;
	
						console.log(`INFO: Got ${hash} by ${account} from snapshot`); 
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
                        // Object.keys(this.pending[blkObj.myEpoch]).map((addr) => {
                        //         if (this.pending[blkObj.myEpoch][addr].length === 0) return;

                        //         let out = this.uniqRLP(addr);
                        //         blkObj.data[addr] = out.data;
                        //         leaves = [ ...leaves, ...out.leaves ];
                        // });

                        console.log(`DEBUG: Final Leaves for myEpoch = ${blkObj.myEpoch}:`); console.dir(leaves);

                        let merkleTree = this.makeMerkleTree(leaves);
                        let merkleRoot = ethUtils.bufferToHex(merkleTree.getMerkleRoot());
                        console.log(`Block Merkle Root: ${merkleRoot}`);

                        let stage = this.generateBlock(blkObj);
                        stage = stage.then((rc) => {
                                console.log('IPFS Put Results'); console.dir(rc);
                                let ipfscid = this.IPFSstringtoBytes32(rc[0].hash);
                                console.log('IPFS CID: ' + ipfscid);
                                return this.sendTk(this.appName)('BlockRegistry')('submitMerkleRoot')(blkObj.myEpoch, merkleRoot, ipfscid)();
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
                                return false;
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
                        const __genBlockBlob = (blkObj) => (resolve, reject) =>
                        {
                                // fs.writeFile(path.join(database, String(blkObj.myEpoch), 'blockBlob'), JSON.stringify(blkObj), (err) => {
                                //         if (err) return reject(err);
                                //         resolve(path.join(database, String(blkObj.myEpoch), 'blockBlob'));
                                // })
                                // manually mkdir `${database}` for now
                                fs.writeFile(path.join(database, 'blockBlob'), JSON.stringify(blkObj), (err) => {
                                        if (err) return reject(err);
                                        resolve(path.join(database, 'blockBlob'));
                                })
                        }

                        let stage = new Promise(__genBlockBlob(blkObj));
                        stage = stage.then((blockBlobPath) =>
                        {
                                console.log(`Local block data cache: ${blockBlobPath}`);
                                return this.put(fs.readFileSync(blockBlobPath));
                        })
                        .catch((err) => { console.log(`ERROR in generateBlock`); console.trace(err); });

                        return stage;
                }

                this.getBlockData = (sblockNo) => {
                        return this.call(this.appName)('BlockRegistry')('getBlockInfo')(sblockNo).then( (rc) => {
				/*
                                 console.log('- sblock no: ' + sblockNo);
                                 console.log('- eth block height:' + rc[0]);
                                 console.log('- merkle root: ' + rc[1]);
                                 console.log('- IPFS CID: ' + rc[2]);
                                 console.log('- IPFS CID: ' + this.Bytes32toIPFSstring(Buffer.from(rc[2].slice(2), 'hex')))
				*/
				
				return { blockNo: sblockNo, ethBlockNo: rc[0], merkleRoot: rc[1], blockData: { [rc[2]]: this.Bytes32toIPFSstring(Buffer.from(rc[2].slice(2), 'hex')) } }
                        })
                }

                this.getPrevBlockData = () => {
                        return this.call(this.appName)('BlockRegistry')('getBlockNo')().then( (sblockNo) =>{
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

		this.on('epoch', (tikObj) => {
			let account  = this.userWallet[this.appName];
			let snapshot = this.packSnap(); 
			if (snapshot[0].length === 0) return;

			this.put(Buffer.from(JSON.stringify(snapshot))).then((out) => {
				let cache  = this.IPFSstringtoBytes32(out[0].hash);
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
						v: sig.v, r: sig.r, s: sig.s
					};
					let rlp = this.handleRLPx(pfields)(params);
					this.publish('Optract', rlp.serialize());
					console.log(`Local snapshot ${out[0].hash} sent`);
				}).catch((err) => { console.trace(err); })
			})
		});
	}
}

const appCfg = { ...config.node, port: 45054, daemon: true, wsrpc: true };

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
				func: ['newArticle', 'getBlockData', 'showTxContent', 'password']
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
