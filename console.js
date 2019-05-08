#!/usr/bin/env node
'use strict';

const url = require('url');
const repl = require('repl');
const path = require('path');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSubNode = require('./pubsubNode.js');

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

//Main
const OptractMedia = require('./dapps/OptractMedia/OptractMedia.js');

class OptractNode extends PubSubNode {
	constructor(cfgObj) {
		super(cfgObj);

		this.appCfgs = require(path.join(cfgObj.dappdir, 'config.json')); // can become part of cfgObj
		this.eth = new OptractMedia(this.appCfgs);
		this.appName = this.eth.appName;

		const mixins = 
		[
		   'call', 
                   'sendTk',
		   'ethNetStatus',
		   'linkAccount',
		   'password',
                   'validPass',
		   'allAccounts'
		];		

		mixins.map((f) => { if (typeof(this[f]) === 'undefined' && typeof(this.eth[f]) === 'function') this[f] = this.eth[f] })
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
