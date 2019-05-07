#!/usr/bin/env node
'use strict';

const url = require('url');
const repl = require('repl');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSub = require('./pubsubNode.js');
const KnifeIron = require('./KnifeIron.js');

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
let app  = new PubSub(
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
	} 
});

app.eth = new KnifeIron(
{
	datadir:"/home/jasonlin/.ethereum",
	rpcAddr:"https://rinkeby.infura.io/v3/abf050ddd1334730b9e8071ab1a09090",
        defaultGasPrice:"20000000000",
        gasOracleAPI:"https://ethgasstation.info/json/ethgasAPI.json",
        condition:"sanity",
	networkID:4,
	passVault:"/home/jasonlin/.rinkeby/myArchive.bcup",
	dapps: {
		"OptractMedia": {
			appName: "OptractMedia",
   			artifactDir: "/home/jasonlin/Proj/Playground/OptractP2pCLI/dapps/OptractMedia/ABI",
   			conditionDir: "/home/jasonlin/Proj/Playground/OptractP2pCLI/dapps/OptractMedia/Conditions",
   			contracts: [{ ctrName: "BlockRegistry", conditions: ['Sanity'] }],
   			account: "0xb440ea2780614b3c6a00e512f432785e7dfafa3e",
   			database: "/home/jasonlin/Proj/ETH/11BE/Release/11BE/dapps/OptractMedia/DB",
   			version: "1.0"
		}
	}
});

let slogan = 'Optract';
let r;

let stage = new Promise(askMasterPass)
         .catch((err) => { process.exit(1); })
         .then((answer) => { return app.eth.password(answer) });

stage = stage.then(() => {
	return ASCII_Art('Optract: Ops Console').then((art) => {
	        console.log(art);
		r = repl.start({ prompt: `[-= ${slogan} =-]$ `, eval: replEvalPromise });
	        r.context = {app};
	        r.on('exit', () => {
	                console.log("\n\t" + 'Stopping CLI...');
			app.leave();
			app.swarm.close();
			process.exit(0);
	        });
	});
})
