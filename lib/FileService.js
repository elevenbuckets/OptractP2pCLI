'use strict';

const IPFS = require('ipfs');  // js-ipfs

class FileService {
        constructor(cfgObj) {  // js-ipfs
                // Create the IPFS node instance
                this.ipfs = new IPFS(cfgObj);
                this.ipfs.on('ready', () => {
                        console.log('IPFS node is ready');
                })
        }
}

module.exports = FileService;
