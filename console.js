#!/usr/bin/env node
'use strict';

const url = require('url');
const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSubNode = require('./pubsubNode.js');
const OptractMedia = require('./dapps/OptractMedia/OptractMedia.js');

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
        {name: 'nonce', length: 32, allowLess: true, default: new Buffer([]) },
        {name: 'account', length: 20, allowZero: true, default: new Buffer([]) },
        {name: 'content', length: 32, allowLess: true, default: new Buffer([]) }, // ipfs hash
        {name: 'since', length: 32, allowLess: true, default: new Buffer([]) },
        {name: 'comment', length: 32, allowLess: true, default: new Buffer([]) }, // ipfs hash, premium member only
        {name: 'v', allowZero: true, default: new Buffer([0x1c]) },
        {name: 'r', allowZero: true, length: 32, default: new Buffer([]) },
        {name: 's', allowZero: true, length: 32, default: new Buffer([]) }
];

const pfields =
[
        {name: 'nonce', length: 32, allowLess: true, default: new Buffer([]) },
        {name: 'pending', length: 32, allowLess: true, default: new Buffer([]) },
        {name: 'validator', length: 20, allowZero: true, default: new Buffer([]) },
        {name: 'cache', length: 32, allowLess: true, default: new Buffer([]) }, // ipfs hash, containing JSON with IPFS hash that points to previous cache
        {name: 'since', length: 32, allowLess: true, default: new Buffer([]) },
        {name: 'v', allowZero: true, default: new Buffer([0x1c]) },
        {name: 'r', allowZero: true, length: 32, default: new Buffer([]) },
        {name: 's', allowZero: true, length: 32, default: new Buffer([]) }
];

//Main
class OptractNode extends PubSubNode {
	constructor(cfgObj) {
		super(cfgObj);

		this.appCfgs = require(path.join(cfgObj.dappdir, 'config.json')); // can become part of cfgObj
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
		   'makeMerkleTreeAndUploadRoot',
                   'configured'
		];		

		mixins.map((f) => { if (typeof(this[f]) === 'undefined' && typeof(Ethereum[f]) === 'function') this[f] = Ethereum[f] })
		
		this.currentTick = 0; //Just an epoch.
		this.pending = {}; // format ??????

		const observer = (sec = 3001) =>
		{
        		return setInterval(() => { 
				this.currentTick = Math.floor(Date.now() / 1000);
				this.emit('epoch', { epoch: this.currentTick }) 
			}, sec);
		}

		// pubsub handler
		this.connectP2P();
		this.join('Optract');

		this.setIncommingHandler((msg) => 
		{
			// check membership status
			// check ap balance (or nonce) ??????? 

			// check signature <--- time consuming !!!
			let packed = this.abi.encodeParameters( // mfield
			  [ 'uint', 'address', 'bytes32', 'uint', 'bytes32'],
			  []
			)
			// store under this.pending[this.currentBlock]
		})

		this.setOnpendingHandler((msg) => 
		{
			// merge with own pending pool
		})
	
		observer(30000 + Math.floor(Math.random() * 10));

		this.on('epoch', (currentTick) => {
			 // update this.pending.past and create new this.pending.currnetTick 
			 // AND: broadcast pending 
			 // OR: trigger create merkle root
			 //  when committing new block, additional logic to perform last sync or fallback to another witness also be executed here.
		});
	}
}

const app = new OptractNode(
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
});

var r;

let stage = new Promise(askMasterPass)
         .catch((err) => { process.exit(1); })
         .then((answer) => { return app.password(answer) })
	 .then(app.validPass)
         .then((rc) => { 
		if (rc && typeof(app.appCfgs.dapps[app.appName].account) !== 'undefined') {
			return app.linkAccount(app.appName)(app.appCfgs.dapps[app.appName].account).then(console.log);
		}
	 })
	 .catch((err) => { console.trace(err); });

stage = stage.then(() => {
	return ASCII_Art('Optract: Ops Console').then((art) => {
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
