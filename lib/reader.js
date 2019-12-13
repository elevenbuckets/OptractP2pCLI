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
var srv = process.argv[2]; 
var opt;
var r;
var title = 'Optract: Ops Console';

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

return connectRPC(srv)
 .then((rc) => 
 {
	if (!rc) throw("failed connection");

	title = 'Optract: WS Console';
	let p = [ ASCII_Art(title) ];
	return Promise.all(p).then((rc) => {
		let art = rc[1];
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
