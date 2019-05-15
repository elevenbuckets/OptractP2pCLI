'use strict';

const IPFS = require('ipfs');  // js-ipfs
// const ipfsctl = require('ipfsd-ctl');  // go-ipfs
const ipfsAPI = require('ipfs-http-client');


class FileService {
        constructor() {  // js-ipfs
                // Create the IPFS node instance
                this.ipfs = new IPFS({ repo: String(Math.random() + Date.now()) });
                this.ipfsAPI = new ipfsAPI('ipfs.infura.io', '5001', {protocol: 'https'})
                console.log("new ipfs");
                this.ipfs.once('ready', () => {
                        console.log('IPFS node is ready');
                })
        }
}

const fileService = new FileService();
module.exports = fileService;
