'use strict';

const Web3   = require('web3');
const abi  = require('web3-eth-abi');
const keth = require('keythereum');
const net    = require('net');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const uuid  = require('uuid/v4');
const BigNumber = require('bignumber.js');
const fetch     = require('node-fetch');
const ethUtils = require('ethereumjs-utils');
const EthTx = require('ethereumjs-tx');
const { promisify } = require('util');

// account manager
const bcup  = require('buttercup');
const { createCredentials, FileDatasource } = bcup;
const masterpw = new WeakMap();

// condition checks
const web3EthFulfill = require( __dirname + '/rpcserv/conditions/Web3/Fulfill.js' );
const web3EthSanity  = require( __dirname + '/rpcserv/conditions/Web3/Sanity.js' );
const TokenSanity    = require( __dirname + '/rpcserv/conditions/Token/Sanity.js' ); // auto mapping from contract ABI
const allConditions  = { ...web3EthSanity, ...web3EthFulfill, ...TokenSanity };

// EIP20 standard ABI
const EIP20ABI = require( __dirname + '/rpcserv/ABI/StandardToken.json' );

// token list (taken from https://balanceof.me)
const Tokens = require( __dirname + '/rpcserv/configs/Tokens.json' );

// Internal functions
const recover = (address, password, datadir) =>
{
        let keyObj;

        try {
                keyObj = keth.importFromFile(address, datadir);
        } catch (err) {
                console.dir(err);
                return Promise.resolve({rc: false, pkey: {}});
        }

        const __recovers = (resolve, reject) =>
        {
                console.log("Processing " + address);
                keth.recover(password, keyObj, function(pkey) {
                        if (pkey.toString() === 'Error: message authentication code mismatch') {
                                resolve({rc: false, pkey: {}})
                        } else {
                                resolve({rc: true, pkey});
                        }
                });
        }

        return new Promise(__recovers);
}

class KnifeIron {
	constructor(cfgObj) 
	{
		masterpw.set(this, {passwd: null});

		this.web3 = new Web3();
		this.web3.toAddress = address => {
			if (this.web3.isAddress(address)) return address.toLowerCase();

                        let addr = String(this.web3.toHex(this.web3.toBigNumber(address)));

                        if (addr.length === 42) {
                                return addr
                        } else if (addr.length > 42) {
                                throw "Not valid address";
                        }

                        let pz = 42 - addr.length;
                        addr = addr.replace('0x', '0x' + '0'.repeat(pz));

                        return addr;
                };

		this.abi  = abi;
		this.toHex = (input) => { return this.web3.toHex(input) };

		this.CUE = { 'Web3': { 'ETH': {'sendTransaction': this.web3.eth.sendTransaction } }, 'Token': {} };
                Object.keys(allConditions).map( (f) => { if(typeof(this[f]) === 'undefined') this[f] = allConditions[f] } );
		this.groupCons = new Set([]);

		this.setup = (cfgobj) => {
			this.AToken = {};
			this.allocated = {};
			this.configs = cfgobj;
	                this.rpcAddr = this.configs.rpcAddr || null;
			this.networkID = this.configs.networkID || 'NO_CONFIG';
	                this.condition = this.configs.condition || null; // 'sanity' or 'fulfill'
	                this.archfile  = this.configs.passVault || null;

			if (this.archfile !== null) {
	                        this.ds = new FileDatasource(this.archfile);
        	        } else {
                	        this.ds = {};
                	}

			this.GasOracle = this.configs.gasOracleAPI || undefined;
                	this.TokenList = Tokens[this.networkID]; //FIXME!!!
			this.userWallet = {};
                	this.gasPrice = this.configs.defaultGasPrice || 50000000000;
			this.qTimeout  = this.configs.queueInterval || 5000;
		}

		this.password = (value) => { masterpw.get(this).passwd = value };

		this.validPass = () =>
	        {
	               let pw = masterpw.get(this).passwd;
	               return this.ds.load(createCredentials.fromPassword(pw)).then( (myArchive) =>
	                      {
	                         return true;
	                      })
	                      .catch( (err) =>
	                      {
				 //console.log(err);
	                         return false;
	                      });
	        }

		this.managedAddress = (address) =>
	        {
	               let pw = masterpw.get(this).passwd;
	               return this.ds.load(createCredentials.fromPassword(pw)).then( (myArchive) =>
	                      {
	                        let vaults = myArchive.findGroupsByTitle("ElevenBuckets")[0];
	                        let passes = undefined;
	
	                        try {
	                                passes = vaults.findEntriesByProperty('username', address)[0].getProperty('password');
	                        } catch(err) {
	                                console.trace(err);
	                                passes = undefined;
	                        }
	
	                        return typeof(passes) === 'undefined' ? {[address]: false} : {[address]: true};
	                      })
	        }

		this.connectRPC = () => 
		{
	                const __connectRPC = (resolve, reject) => {
	                        try {
	                                if (
	                                    this.web3 instanceof Web3
	                                 && this.web3.net._requestManager.provider instanceof Web3.providers.HttpProvider
					 && this.web3.net.listening
	                                ) {
	
	                                        if (this.networkID === 'NO_CONNECTION') this.networkID = this.configs.networkID; // reconnected
	                                        if (this.web3.version.network != this.networkID) {
	                                                throw(`Connected to network with wrong ID: wants: ${this.networkID}; geth: ${this.web3.net.version}`);
	                                        }
	
	                                        resolve(true);
	                                } else if (this.web3 instanceof Web3) {
	                                        this.web3.setProvider(new Web3.providers.HttpProvider(this.rpcAddr));
	
	                                        if (this.networkID === 'NO_CONNECTION') this.networkID = this.configs.networkID; // reconnected
	                                        if (this.web3.version.network != this.networkID) {
	                                                throw(`Connected to network with wrong ID: wants: ${this.networkID}; geth: ${this.web3.net.version}`);
	                                        }
	
	                                        resolve(true);
	                                } else {
	                                        reject(false);
	                                }
	                        } catch (err) {
	                                //console.log(err);
	                                reject(false);
	                        }
	                }
	
	                return new Promise(__connectRPC);
	        }

		this.connect = () => {
	                let stage = Promise.resolve();
	
	                stage = stage.then(() => {
	                        return this.connectRPC();
	                })
	                .then((rc) => {
	                        if (rc) {
					this.TokenABI  = this.web3.eth.contract(EIP20ABI);
					return rc;
	                        } else {
	                                throw("no connection");
	                        }
	                })
	                .catch((err) => {
	                        this.networkID = 'NO_CONNECTION';
	                        return Promise.resolve(false);
	                });
	
	                return stage;
	        }
	
		//this.allAccounts = () => { return this.web3.eth.accounts; } // should parse local keystore files and collect addresses instead
		this.allAccounts = () =>
		{
			const readdir = promisify(fs.readdir);
			const readfile = promisify(fs.readFile);
			let keydir = path.join(this.configs.datadir, 'keystore');
			return readdir(keydir).then((list) => 
			{
				let p = list.map((f) => { return readfile(path.join(keydir,f)).then((b) => { 
					return '0x' + JSON.parse(b.toString()).address }).catch((e) => { return null });  
				});

				return Promise.all(p).then((results) => { let r = results.filter((i) => { return i !== null }); return Array.from(new Set(r)) });
			})
		}

		this.ethNetStatus = () =>
	        {
	                if (this.web3.net.peerCount === 0 && this.web3.eth.mining === false) {
	                        return {blockHeight: 0, blockTime: 0, highestBlock: 0};
	                }
	
	                let sync = this.web3.eth.syncing;
	
	                if (sync === false) {
	                        let blockHeight = this.web3.eth.blockNumber;
	                        let blockTime;
	
	                        try {
	                                blockTime = this.web3.eth.getBlock(blockHeight).timestamp;
	                        } catch(err) {
	                                blockTime = 0;
	                                blockHeight = 0;
	                        }
	
	                        return {blockHeight, blockTime, highestBlock: blockHeight};
	                } else {
	                        let blockHeight = sync.currentBlock;
	                        let highestBlock = sync.highestBlock;
	                        let blockTime;
	                        try {
	                                blockTime = this.web3.eth.getBlock(blockHeight).timestamp;
	                        } catch(err) {
	                                blockTime = 0;
	                                blockHeight = 0;
	                                highestBlock = 0;
	                        }
	
	                        return {blockHeight, blockTime, highestBlock};
	                }
	        }

		this.unlockAndSign = addr => (msgSHA256Buffer) =>
		{
			let pw = masterpw.get(this).passwd;
			
			return this.ds.load(createCredentials.fromPassword(pw)).then( (myArchive) => {
				let vaults = myArchive.findGroupsByTitle("ElevenBuckets")[0];
				let passes;
	
				try {
					passes = vaults.findEntriesByProperty('username', addr)[0].getProperty('password');
				} catch(err) {
					passes = undefined;
				}
		
		               	if (typeof(passes) === 'undefined' || passes.length == 0) {
					console.warn("no password provided for address " + addr + ", skipped ...");
	
	                        	return {v: null, r: null, s: null, };
	                	} else {
					return recover(addr, passes, this.configs.datadir).then((p) => {
						if(!p.rc) throw "failed to unlock account";

                				let chkhash = ethUtils.hashPersonalMessage(msgSHA256Buffer);
                				let signature = ethUtils.ecsign(chkhash, p.pkey, this.networkID);
						return signature;
					})
				}
			})
		}

		this.verifySignedMsg = (msgSHA256Buffer) => (v, r, s, signer) =>
		{
                	let chkhash = ethUtils.hashPersonalMessage(msgSHA256Buffer);
			let originAddress = '0x' +
		              ethUtils.bufferToHex(
                		ethUtils.sha3(
                  			ethUtils.bufferToHex(
                        			ethUtils.ecrecover(chkhash, v, r, s, this.networkID)
                  			)
                		)
              		).slice(26);

        		//console.log(`signer address: ${signer}`);
        		return signer === originAddress;
		}

                this.verifySignature = (sigObj) => //sigObj = {payload, v,r,s, networkID}
                {
                        let signer = '0x' +
                              ethUtils.bufferToHex(
                                ethUtils.sha3(
                                  ethUtils.bufferToHex(
                                        ethUtils.ecrecover(sigObj.payload, sigObj.v, sigObj.r, sigObj.s, sigObj.netID)
                                  )
                                )
                              ).slice(26);

                        console.log(`signer address: ${signer}`);

                        return signer === ethUtils.bufferToHex(sigObj.originAddress);
                }

		this.addrEtherBalance = addr => { return this.web3.eth.getBalance(addr); }
		this.byte32ToAddress = (b) => { return this.web3.toAddress(this.web3.toHex(this.web3.toBigNumber(String(b)))); };
	        this.byte32ToDecimal = (b) => { return this.web3.toDecimal(this.web3.toBigNumber(String(b))); };
        	this.byte32ToBigNumber = (b) => { return this.web3.toBigNumber(String(b)); };

		// These three actually need to be at the client side as well...
		this.toEth = (wei, decimals) => new BigNumber(String(wei)).div(new BigNumber(10 ** decimals));
	        this.toWei = (eth, decimals) => new BigNumber(String(eth)).times(new BigNumber(10 ** decimals)).floor();
        	this.hex2num = (hex) => new BigNumber(String(hex)).toString();

		this.configured = () => 
		{
                	if (this.networkID === 'NO_CONFIG') {
                        	return false;
                	} else {
                        	return true;
                	}
        	}

		this.connected = () => 
		{
	                if (!this.configured()) return false;
	
	                let live;
	                try {
	                        live = this.web3 instanceof Web3 && this.web3.net._requestManager.provider instanceof Web3.providers.HttpProvider && this.web3.net.listening;
	                } catch(err) {
	                        live = false;
	                }
	
	                return live;
	        }

		this.getReceipt = (txHash, interval = 500) =>
	        {
	                if (txHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
	                        return Promise.resolve({status: '0x0', transactionHash: txHash});
	                }
	
	                const transactionReceiptAsync = (resolve, reject) => {
	                        this.web3.eth.getTransactionReceipt(txHash, (error, receipt) => {
	                                if (error) {
	                                        reject(error);
	                                } else if (receipt == null) {
	                                        setTimeout( () => transactionReceiptAsync(resolve, reject), interval);
	                                } else {
	                                        resolve(receipt);
	                                }
	                        });
	                };
	
	                if (Array.isArray(txHash)) {
	                        return Promise.all( txHash.map(oneTxHash => this.getReceipt(oneTxHash, interval)) );
	                } else if (typeof txHash === "string") {
	                        return new Promise(transactionReceiptAsync);
	                } else {
	                        throw new Error("Invalid Type: " + txHash);
	                }
	        }

		this.gasCostEst = (addr, txObj) =>
	        {
	                if (
	                        txObj.hasOwnProperty('gasLimit') == false
	                     || txObj.hasOwnProperty('gasPrice') == false
	                ) { throw new Error("txObj does not contain gas-related information"); }
	
	                let gasBN = this.web3.toBigNumber(txObj.gasLimit);
	                let gasPriceBN = this.web3.toBigNumber(txObj.gasPrice);
	                let gasCost = gasBN.mul(gasPriceBN);
	
	                return gasCost;
	        }

		this.version = '1.0'; // API version
                this.jobQ = {}; // Should use setter / getter
                this.rcdQ = {}; // Should use setter / getter
		
	  	this.enqueue = jobObj => addr => 
		{
	                let {Q, ...job} = jobObj;
	
	                if (Q == undefined || typeof(this.jobQ[Q]) === 'undefined' || this.condition === null) {
	                        throw new Error("Queue error (enqueue)");
	                } else if (typeof(this.jobQ[Q][addr]) === 'undefined') {
	                        this.jobQ[Q][addr] = [];
	                }
	
	                if (typeof(this.CUE[jobObj.type]) === 'undefined' || typeof(this.CUE[jobObj.type][jobObj.contract]) === 'undefined') {
	                        throw new Error(`Invalid or unknown contract ABI: ${JSON.stringify(jobObj, 0, 2)}`);
	                }
 
	                //conditional function call
	                let cfname; let cfclass = String(`${jobObj.type}_${jobObj.contract}`).split('_').slice(0,2).join('_');
			if (jobObj.type === 'Token' || jobObj.type === 'Web3' || this.groupCons.has(cfclass)) {
			// internal type were designed with reusable group condition in mind, 
			// at the moment apps initialized by newApps would have to have specific 
			// condition per contract, even if they can be under same group due to 
			// similarity. This should be fixed by introducing "group conditions" options
			// when creating conditions for apps.
			//
			// e.g.: if the app condition module has attribute group = true, when the app is set
			// to use the condition, assume all contracts in the app to follow same single 
			// condition set identified by the "three-level" condition names.
			// 
			// -- Jason Lin, 2019/02/14
	                	cfname = `${jobObj.type}_${jobObj.call}_${this.condition}`; // "three-level" condition name, group conditions
			} else if ( jobObj.contract in this.CUE[jobObj.type] 
			         && typeof(this[`${jobObj.type}_${jobObj.contract}_${jobObj.call}_${this.condition}`]) !== 'undefined'
			) {
				cfname = `${jobObj.type}_${jobObj.contract}_${jobObj.call}_${this.condition}`; // "four-level" condition name
			}

			if (typeof(this[cfname]) === 'undefined') {
				if (!this.groupCons.has(cfclass)) {
	                       		throw `Invalid condition of jobObj: ${JSON.stringify(jobObj, 0, 2)}, Missing condition: ${jobObj.contract}_${jobObj.call}_${this.condition}`;
				} else {
	                       		throw `Invalid condition of jobObj: ${JSON.stringify(jobObj, 0, 2)}, Missing (group) condition: ${jobObj.type}_${jobObj.call}_${this.condition}`;
				}
			}

	                let args = job.args.map((e) =>
	                {
	                        if (typeof(job[e]) === 'undefined') {
	                                throw new Error(`jobObj missing element ${e} for ${cfname} action`);
	                        }

                                return job[e];
                        });
	
	                if (this[cfname](addr, jobObj) == true) {
	                        this.jobQ[Q][addr].push({...job, args}); // replace 
	                        return true;
	                } else {
	                        this.jobQ[Q][addr].push({...job, args, cfc: cfname}); // replace 
	                        return false;
	                }
	        }

		this.prepareQ = timeout =>
	        {
	                const __initQueue = (resolve, reject) => {
	                        if (Object.keys(this.jobQ).length !== 0) {
	                                setTimeout(() => __initQueue(resolve, reject), timeout);
	                        } else {
	                                let myid = uuid();
	                                this.jobQ[myid] = {};
	                                this.rcdQ[myid] = [];
	
	                                resolve(myid);
	                        }
	                };
	
	                return new Promise(__initQueue);
	        }

		this.processQ = Q => 
		{
			let pw = masterpw.get(this).passwd;
	
			if (Q == undefined) {
				console.log("processQ: Invalid QID!!!");
				return Promise.reject(false);
			} else if (typeof(this.jobQ[Q]) === 'undefined' || this.jobQ[Q].length === 0|| pw === null) {
				delete this.jobQ[Q];
				console.log("Queue error (processQ), skipping...");
				return Promise.reject(false);
			}
	
			return this.ds.load(createCredentials.fromPassword(pw)).then( (myArchive) => {
				let vaults = myArchive.findGroupsByTitle("ElevenBuckets")[0];
			        let results = Promise.resolve(); 
	
		        	Object.keys(this.jobQ[Q]).map((addr) => {
					let passes;
	
					try {
						passes = vaults.findEntriesByProperty('username', addr)[0].getProperty('password');
					} catch(err) {
						passes = undefined;
					}
		
		                	if (typeof(passes) === 'undefined' || passes.length == 0) {
						delete this.jobQ[Q][addr];
						console.warn("no password provided for address " + addr + ", skipped ...");
		
		                        	return Promise.reject(false);
		                	}
		
			                results = results.then( () => {
		        	                return recover(addr, passes, this.configs.datadir).then((p) => {
                                                if(!p.rc) throw "failed to unlock account";

							let fatal = false;
		                	                this.jobQ[Q][addr].map((o, id) => 
							{
								try {
									if (fatal) throw "previous job in queue failed, Abort!";
									if (typeof(o.cfc) !== 'undefined') throw `job failed to pass condition ${o.cfc}`;
								
			                        	        	//let tx = this.CUE[o.type][o.contract][o.call](...o.args, o.txObj);

			                        	        	let data;
			                        	        	let tx;
									let nonce = this.web3.eth.getTransactionCount(addr);
									nonce = nonce + id;
		                       	        			if (o.type !== 'Web3') {
		                       	        				data = this.CUE[o.type][o.contract][o.call].getData(...o.args);
										tx = new EthTx({ ...o.txObj, nonce, data, chainID: this.networkID});
									} else {
										tx = new EthTx({ ...o.txObj, nonce, chainID: this.networkID});
									}
									tx.sign(p.pkey);
									let txHash = this.web3.eth.sendRawTransaction(ethUtils.bufferToHex(tx.serialize()));

								  	if (typeof(o['amount']) !== 'undefined') {
								    		this.rcdQ[Q].push({id, addr, 
											'tx': txHash, 
											'type': o.type, 
											'contract': o.contract, 
											'call': o.call, ...o.txObj, 
											'amount': o.amount
										});
								  	} else {
								    		this.rcdQ[Q].push({id, addr, 
											'tx': txHash, 
											'type': o.type, 
											'contract': o.contract, 
											'call': o.call, ...o.txObj,
									        	'amount': null
										});
								  	}
								} catch(error) {
									console.trace(error);
									this.rcdQ[Q].push({id, addr, 
										'error': error.toString(),
										'tx': '0x0000000000000000000000000000000000000000000000000000000000000000',
									        'type': o.type, 
									        'contract': o.contract, 
									        'call': o.call, ...o.txObj, 
									        'amount': typeof(o['amount']) !== 'undefined' ? o.amount : null
									});
									fatal = true;
								}
		                                	})
			                        }).then( () => { delete this.jobQ[Q][addr]; })
		                	}).catch( (error) => { console.trace(error); delete this.jobQ[Q][addr]; return Promise.resolve(); } );
		        	}); 
			
				results = results.then(() => { return this.closeQ(Q) });
	
				return results;
	
			}).catch( (error) => { console.log(error); delete this.jobQ[Q]; return this.closeQ(Q); });
		}

		this.closeQ = Q => 
		{
			if (Q == undefined || typeof(this.jobQ[Q]) === 'undefined') {
				console.log("Queue error (closeQ)");
				return Promise.reject(false);
			}
	
			const __closeQ = (resolve, reject) => {
				if (Object.keys(this.jobQ[Q]).length == 0) {
					delete this.jobQ[Q]; console.log(`DEBUG: Resolving ${Q}`)
					resolve(Q);
				} else if (Object.keys(this.jobQ[Q]).length > 0 && this.connected()) {
					setTimeout( () => __closeQ(resolve, reject), 500 );
				} else {
					console.error("Uh Oh...... (closeQ)");
					reject(false);
				}
			};
	
			return new Promise(__closeQ);
		}

		this.gasPriceEst = () =>
	        {
	                let results = Promise.resolve();
	
	                results = results.then(() =>
	                {
	                        return fetch(this.GasOracle)
	                                .then( (r) => { return r.json(); })
	                                .then( (json) => {
	                                                   return {   // ethGasStation returns unit is 10GWei, hence 10 ** 8
	                                                                low: String(Number(json.safeLow)*(10 ** 8)),
	                                                                mid: String(Number(json.average)*(10 ** 8)),
	                                                               high: String(Number(json.fast)*(10 ** 8)),
	                                                               fast: String(Number(json.fastest)*(10 ** 8)),
	                                                            onblock: json.blockNum
	                                                          };
	                                                 })
	                                .catch( (e) => { throw(e); })
	                })
	
	                return results;
	        }

		this.hotGroups = tokenList =>
	        {
	                if (this.connected()) {
	                        this.TokenABI  = this.web3.eth.contract(EIP20ABI);
	                }
	
	                let rc = tokenList.map( (token) =>
	                {
	                        if (typeof(this.TokenList[token]) === 'undefined') return false;
	
	                        let record = this.TokenList[token];
	
	                        this.CUE.Token[token] = this.TokenABI.at(record.addr);
	                        this.AToken[token] = this.web3.toBigNumber(10).pow(record.decimals);
	
	                        return true;
	                });
	
	                return rc.reduce((result, stat) => { return result && (stat === true) });
	        }

		this.setAccount = appName => addr =>
	        {
	                this.userWallet[appName] = addr;
	                if (typeof(this.allocated[addr]) === 'undefined') this.allocated[addr] = new BigNumber(0);
	
	                return true;
	        }

		this.processJobs = jobObjList => 
		{
			let tokenList = jobObjList
				.map( (job) => { return job.contract; } )
				.filter( (value, index, self) => 
				{ 
					return self.indexOf(value) === index; 
				});
	
			let txOnly = this.hotGroups(tokenList);
			
			return this.prepareQ(this.qTimeout)
				.then( (Q) => 
				{
					console.debug(`Queue ID: ${Q}, Enqueuing ...`);

					try {
						let _count = 0;	
						jobObjList.map( (job) => 
						{
							this.setAccount(job.type)(job.txObj.from);
							let jobWallet = this.userWallet[job.type];
							let userBalance = this.web3.eth.getBalance(jobWallet);
		
                                                    console.debug(` - Account: ${jobWallet}; Balance: ${userBalance/1e18} ETH`);
		
							let gasCost = new BigNumber(job.txObj.gasLimit).times(this.gasPrice); 
		
							if (
							        typeof(this.TokenList[job.contract]) === 'undefined'
							     && typeof(job.type) !== 'undefined' 
							     && job.type === 'Token'
							     && userBalance.sub(this.allocated[jobWallet]).gte(gasCost)
							) {
								console.debug(`WARN: Unknown token ${job.contract}, skipping job ...`);
								return;
							} else if (
						     	        typeof(this.CUE[job.type]) === 'undefined'
						     	     || typeof(this.CUE[job.type][job.contract]) === 'undefined'
							) {
								console.warn(`WARN: Invalid call ${job.type}.${job.contract}.${job.call}, skipping job ...`);
								return;
							} else if (
								job.type !== 'Web3' 
							     && userBalance.sub(this.allocated[jobWallet]).gte(gasCost) 
							) {
								console.debug(`INFO: calling ${job.type}.${job.contract}.${job.call}, allocating gas fee from wallet: ${gasCost}`);
								this.allocated[jobWallet] = this.allocated[jobWallet].add(gasCost);
							} else if (
								job.type === 'Web3' 
							     && userBalance.sub(this.allocated[jobWallet]).sub(job.txObj.value).gte(gasCost) 
							) {
								console.debug(`INFO: sending Ether, allocating gas fee ${gasCost} and ether ${job.txObj.value} from wallet`);
								this.allocated[jobWallet] = this.allocated[jobWallet].add(gasCost).add(job.txObj.value);
							} else {
								console.warn(`WARN: Insufficient fund in wallet, skipping job ...`);
								return;
							}
		
							this.enqueue({...job, Q})(jobWallet);
							_count++;
						})

						if (_count === 0) { delete this.jobQ[Q]; delete this.rcdQ[Q]; }
					} catch(err) {
						console.log(`In BIAPI ProcessJobs:`); console.trace(err);
						delete this.jobQ[Q]; delete this.rcdQ[Q];
						return;
					}

					this.allocated = {};	
					return Q;
				})
				.then( (Q) => { return this.processQ(Q); })
				.catch( (err) => { console.log("ProcessJob failed, skipping QID..."); return; } );
		}

		this.enqueueTx = tokenSymbol => (fromWallet, toAddress, amount, gasAmount) => 
		{
			// txObj field checks.
			// While CastIron has conditions to perform final checks before send, basic checks here will allow 
			// caller to drop invalid txObj even before entering promise chain.

			// Sanitize
			fromWallet = this.web3.toAddress(fromWallet);
			toAddress  = this.web3.toAddress(toAddress);

			if (
			     ( tokenSymbol !== 'ETH' && Number(amount) <= 0 )
			     || ( tokenSymbol === 'ETH' && Number(amount) < 0 ) // allow 0 amount for nonpayable contract fallback
			     || isNaN(Number(amount))
			     || Number(gasAmount) <= 0
			     || isNaN(Number(gasAmount))
			){
				throw "enqueueTx: Invalid element in txObj";
			};
	
			if (tokenSymbol === 'ETH') {
				return {
					Q: undefined,
					type: 'Web3',
					contract: 'ETH',
					call: 'sendTransaction',
					args: [],
					txObj: { from: fromWallet, to: toAddress, value: this.toHex(amount), gasLimit: this.toHex(gasAmount), gasPrice: this.toHex(this.gasPrice) } 
				}
			} else {
				let tokenAddr = this.CUE['Token'][tokenSymbol].address;
				return {
					Q: undefined,
					type: 'Token',
					contract: tokenSymbol,
					call: 'transfer',	
					args: ['toAddress', 'amount'],
					toAddress,
					amount,
					txObj: { from: fromWallet, to: tokenAddr, gasLimit: this.toHex(gasAmount), gasPrice: this.toHex(this.gasPrice) }
				}
			}
		}

		this.addrTokenBalance = tokenSymbol => walletAddr =>
	        {
	                if (typeof(this.CUE.Token[tokenSymbol]) === 'undefined') throw new Error(`Token ${tokenSymbol} is not part of current hot group`);
	                return this.CUE.Token[tokenSymbol].balanceOf(walletAddr);
	        }

		this.enqueueTk = (type, contract, call, args) => (fromWallet, amount, gasAmount, tkObj) =>
	        {
	                let txObj = {};
	
	                // txObj field checks.
	                // While CastIron has conditions to perform final checks before send, basic checks here will allow 
	                // caller to drop invalid txObj even before entering promise chain.
	                //
	                // Note: for enqueueTk, it is the caller's duty to verify elements in tkObj.

			// Sanitize
	                fromWallet = this.web3.toAddress(fromWallet);

	                if (
	                     Number(gasAmount) <= 0
	                     || isNaN(Number(gasAmount))
	                ){
	                        throw "enqueueTk: Invalid element in txObj";
	                };

			let toAddress = this.CUE[type][contract].address;
	
	                if (amount === null) {
	                        txObj = { from: fromWallet, to: toAddress, gasLimit: this.toHex(gasAmount), gasPrice: this.toHex(this.gasPrice) }
	                } else if (amount > 0) {
	                        txObj = { from: fromWallet, to: toAddress, value: this.toHex(amount), gasLimit: this.toHex(gasAmount), gasPrice: this.toHex(this.gasPrice) }
	                }
	
	                return { Q: undefined, type, contract, call, args, ...tkObj, txObj };
	        }

		this.verifyApp = appSymbol => (version, contract, abiPath, conditions) =>
	        {
	                if (appSymbol === 'Web3' || appSymbol === 'Token') return false; // preserved words
	
	                // placeholder to call on-chain package meta for verification
	                // This should generate all checksums and verify against the records on pkg manager smart contract
	                // Smart contract ABI binding to pkg manager should happen during constructor call!
	                return true;
	        }

		this.newApp = appSymbol => (version, contract, abiPath, conditions, address = null) =>
	        {
	                if (this.verifyApp(appSymbol)(version, contract, abiPath, conditions) === false) throw 'Invalid dApp info';
	
	                let buffer = fs.readFileSync(abiPath);
	                let artifact = JSON.parse(buffer.toString());
	                artifact.contract_name = contract;
	
	                if (typeof(this.CUE[appSymbol]) === 'undefined') this.CUE[appSymbol] = { ABI: {} };
	
	                if (address === '0x') {
	                        this.CUE[appSymbol][contract] = undefined;
	                        return { [appSymbol]: version, 'Ready': false };
	                }
	
	                // appSymbol contains the string which becomes the 'type' keywords of the app
	                // contract is the name of the contract
	                let abi  = this.web3.eth.contract(artifact.abi);
	                let addr;
	
	                if (address !== null) {
	                        console.debug(`custom address for contract ${contract} found...`);
	                        addr = address;
	                } else {
	                        console.debug(`contract address fixed ...`);
	                        addr = artifact.networks[this.networkID].address;
	                }
	
	                this.CUE[appSymbol][contract] = abi.at(addr);
			this.CUE[appSymbol].ABI[contract] = artifact.abi;

			// console.log(this.CUE[appSymbol].ABI[contract]); console.log('---'); console.log(conditions);	// DEBUG
	                // conditions is objects of {'condition_name1': condPath1, 'condition_name2': condPath2 ...}
	                let allConditions = {};
	
			console.log(`DEBUG: Condition parsing for ${appSymbol}: ${contract}...`);
	                Object.keys(conditions).map((cond) =>
	                {
				console.log(` - ${conditions[cond]}`);
	                        let thiscond = require(conditions[cond]);
	                        allConditions = { ...allConditions, ...thiscond };
	                });

			if (Object.keys(allConditions).length === 0) throw `WARNING: NO condition defined for ${appSymbol}: ${contract}!!!`;
			console.log(allConditions); 
	                // loading conditions. there names needs to follow CastIron conventions to be recognized by queue, otherwise job will fail.
			if (typeof(allConditions.GROUP_CONDITION) !== 'undefined') { // group condition (PoC)
				console.log(`DEBUG: Group Condition found: ${appSymbol}_${allConditions.GROUP_CONDITION}`);
				this.groupCons = new Set([ ...this.groupCons, `${appSymbol}_${allConditions.GROUP_CONDITION}` ]);
				delete allConditions.GROUP_CONDITION;
	                	Object.keys(allConditions).map((f) => { if(typeof(this[f]) === 'undefined') this[f] = allConditions[f] });
			} else {
	                	Object.keys(allConditions).map((f) => { if(typeof(this[`${appSymbol}_${f}`]) === 'undefined') this[`${appSymbol}_${f}`] = allConditions[f] });
			}

			return { [appSymbol]: version, 'Ready': true };
	        }

		this.init = (appName) => (ctrName) => (condType = "Sanity") =>
		{
			let appConfigs = this.configs.dapps[appName]; 

                        const __getABI = (ctrName) =>
                        {
                                return [appConfigs.version, ctrName, path.join(appConfigs.artifactDir, ctrName + '.json')]
                        }

                        const __newAppHelper = (ctrName) => (condType) =>
                        {
                                let output = __getABI(ctrName); let condition = {};
                                let _c = appConfigs.contracts.filter( (c) => { return (c.ctrName === ctrName && c.conditions.indexOf(condType) !== -1) });
                                if (_c.length === 1) {
                                        condition = { [condType]: path.join(appConfigs.conditionDir, appName, ctrName, condType + '.js') };
                                }

                                return [...output, condition];
                        }

			return this.newApp(appName)(...__newAppHelper(ctrName)(condType));

		}

		this.call = (appName) => (ctrName) => (callName) => (...args) =>
		{
			let abiObj = null;
			let fromWallet = this.userWallet[appName]; 
			try {
				if (!fromWallet) throw `${appName} has no default wallet set`;
                		abiObj = this.CUE[appName].ABI[ctrName].filter((i) => { return (i.name === callName && i.constant === true) } );

                		if (abiObj.length === 1 && abiObj[0].inputs.length === args.length) {
                        		//console.log("Calling " + callName)
                        		let __call = (resolve, reject) => {
                                		this.CUE[appName][ctrName][callName](...args, {from: fromWallet}, (err, result) => {
                                        		if (err) return reject(err);
                                        		//console.log("HERE!")
                                        		resolve(result);
                                		})
                        		}

                        		return new Promise(__call);
                		} else {
                        		throw "Wrong function or function arguments";
                		}
        		} catch(err) {
                		console.trace(err);
                		return Promise.reject('unsupported constant call');
        		}	
		}

		this.sendTk = (appName) => (ctrName) => (callName) => (...__args) => (amount = null) =>
                {
                        let tkObj = {};
                        __args.map((i,j) => { tkObj = { ...tkObj, ['arg'+j]: i } });
                        let appArgs = Object.keys(tkObj).sort();
			let gasAmount = (typeof(this.gasAmount) !== 'undefined') ? this.gasAmount : undefined;
			let fromWallet = this.userWallet[appName]; 

			try {
                		if (typeof(gasAmount) === 'undefined') {
					if (amount === null) {
                        			gasAmount = this.CUE[appName][ctrName][callName].estimateGas(...__args, {from: fromWallet, gasPrice: this.gasPrice})
                			} else {
                        			gasAmount = this.CUE[appName][ctrName][callName].estimateGas(...__args, {from: fromWallet, value: amount, gasPrice: this.gasPrice})
					}
				}
        		} catch(err) {
                		console.trace(err);
                        	return Promise.reject(`failed to determine gas amount, please specify it in this.gasAmount`);
        		}

        		console.log(`DEBUG: calling ${callName} using gasAmount = ${gasAmount}`)

        		try {
                		return Promise.resolve(this.enqueueTk(appName, ctrName, callName, appArgs)(fromWallet, amount, gasAmount, tkObj))
					      .then((jobObj) => { return this.processJobs([jobObj]).then(console.log) })
        				      .catch((err) => { console.trace(err); return Promise.reject(err); });
        		} catch (err) {
                		console.trace(err);
                		return Promise.reject(err);
        		}
		}

		this.queueReceipts = (Q) => 
		{
        		let errRcds = {};
        		let txhashes = this.rcdQ[Q].map((r) => {
                		if (r.tx === '0x0000000000000000000000000000000000000000000000000000000000000000') {
                        		errRcds[r.id] = r;
                		}
                		return r.tx;
        		});

        		return this.getReceipt(txhashes).then((rc) => {
                		return rc.map((t,i) => {
                        		if (i in errRcds) {
                                		return { ... errRcds[i], ...t };
                        		} else {
                                		return t;
                        		}
                		})
        		})
        		.catch((err) => { console.trace(err); return Promise.reject(err); })
		}

		this.linkAccount = (appName) => (address) =>
		{
			return this.managedAddress(address)
				   .then((rc) => {
					if (rc[address]) this.userWallet[appName] = address;
					return rc;
				   })
		} 

		// init
		this.setup(cfgObj);
		this.connect();
	}
}

module.exports = KnifeIron;
