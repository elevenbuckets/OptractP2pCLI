#!/usr/bin/env node
'use strict';

const url = require('url');
//const cluster = require('cluster');
const repl = require('repl');
const figlet = require('figlet');
const readline = require('readline');
const AsciiTable = require('ascii-table');
const PubSub = require('./pubsubNode.js');

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

/*
const initBIServer = (options) => {
	cluster.setupMaster({exec: './pubsubNode.js'}); //BladeIron RPCServ
        return cluster.fork(options);
}
*/

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

/*
if (cluster.isMaster) {
}
*/

let app = new PubSub();
let slogan = 'Optract';
let r;

ASCII_Art('Optract: Ops Console').then((art) => {
        console.log(art);
	r = repl.start({ prompt: `[-= ${slogan} =-]$ `, eval: replEvalPromise });
        r.context = {app};
        r.on('exit', () => {
                console.log("\n\t" + 'Stopping CLI...');
		app.leave();
		process.exit(0);
        });
});
