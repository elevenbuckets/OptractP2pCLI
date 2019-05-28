'use strict';

const { parentPort, workerData } = require('worker_threads');

const keth = require('keythereum');
const ethUtils = require('ethereumjs-utils');

let addr = workerData.addr;
let passes = workerData.passes;
let datadir = workerData.datadir;
let data = workerData.data;
let netID = workerData.networkID;

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

const sign = (data) => (p) =>
{
	if (!p.rc) throw "key not unlocked.";

	let chkhash = ethUtils.hashPersonalMessage(Buffer.from(data));
        let signature = ethUtils.ecsign(chkhash, p.pkey, netID);
        return signature;
}

//Worker Main
console.log(`Worker launched`);
recover(addr, passes, datadir)
  .then(sign(data))
  .then((sig) => { parentPort.postMessage(sig); })
  .catch((error) => console.trace);
