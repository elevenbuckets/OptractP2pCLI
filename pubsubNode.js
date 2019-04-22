'use strict';

const swarm = require('discovery-swarm');
const gossip = require('secure-gossip');
const EventEmitter = require('events');
const ethUtils = require('ethereumjs-utils');

// console-only packages, not for browsers
const fs = require('fs');
const os = require('os');
const path = require('path');

// Common Bucket Tx
const fields = 
[
	{name: 'nonce', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'originAddress', length: 20, allowZero: true, default: new Buffer([]) },
	{name: 'ipfsHash', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'since', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'reply', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'comment', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'score', length: 32, allowZero: true, default: new Buffer([]) }, // review only
	{name: 'category', length: 32, allowLess: true, default: new Buffer([]) }, // new fields to be handled by ??? 
   	{name: 'v', allowZero: true, default: new Buffer([0x1c]) },
   	{name: 'r', allowZero: true, length: 32, default: new Buffer([]) },
   	{name: 's', allowZero: true, length: 32, default: new Buffer([]) }
];

// Validator Only
const active =
[
	{name: 'validator', length: 20, allowZero: true, default: new Buffer([]) },
	{name: 'originAddress', length: 20, allowZero: true, default: new Buffer([]) },
	{name: 'ipfsHash', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'since', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'agree', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'disagree', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'score', length: 32, allowZero: true, default: new Buffer([]) }, // review only
	{name: 'category', length: 32, allowLess: true, default: new Buffer([]) }, // new fields to be handled by ??? 
   	{name: 'v', allowZero: true, default: new Buffer([0x1c]) },
   	{name: 'r', allowZero: true, length: 32, default: new Buffer([]) },
   	{name: 's', allowZero: true, length: 32, default: new Buffer([]) }
];

const summary = 
[
	{name: 'validator', length: 20, allowZero: true, default: new Buffer([]) },
	{name: 'originAddress', length: 20, allowZero: true, default: new Buffer([]) },
	{name: 'start', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'end', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'spend', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'gain', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'accuRewards', length: 32, allowLess: true, default: new Buffer([]) },
   	{name: 'v', allowZero: true, default: new Buffer([0x1c]) },
   	{name: 'r', allowZero: true, length: 32, default: new Buffer([]) },
   	{name: 's', allowZero: true, length: 32, default: new Buffer([]) }
];

class PubSub extends EventEmitter 
{
	constructor(options) {
		super();

		let opts = options || { gossip: {} };
		this.gossip = gossip(opts.gossip);
  		this.id = this.gossip.keys.public; // should eventually use ETH address
  		this.swarm = swarm();
		this.port  = opts.port || 0;

		this.join = (topic) =>
		{
  			if (!topic || typeof topic !== 'string') { throw new Error('topic must be set as a string') }
			if (typeof this.topic !== 'undefined') this.leave();
			this.topic = topic;
			this.seen  = { init: Math.floor(Date.now()/1000), logs: {}, seen: {} };
  			return this.swarm.join(this.topic);
		}

		this.leave = () =>
		{
			if (typeof this.topic === 'undefined') return true;
			return this.swarm.leave(this.topic);
		}

		this.stats = () =>
		{
			return {
				connecting: this.swarm.connecting,
				upcomming: this.swarm.queued,
				connected: this.swarm.connected
			};
		}

		this.connectP2P = () =>
		{
			if (fs.existsSync(path.join(os.homedir(), '.optract_keys'))) {
				opts.gossip.keys = require(path.join(os.homedir(), '.optract_keys'));
				this.gossip = gossip(opts.gossip);
			} else {
				this.gossip = gossip(opts.gossip);
				fs.writeFileSync(path.join(os.homedir(), '.optract_keys'), JSON.stringify(this.gossip.keys))
			}

  			this.id = this.gossip.keys.public; // should eventually use ETH address

		  	this.gossip.on('message', (msg, info) => {
				if (this.filterSeen(msg) && this.throttlePeer(info) && this.validateMsg(msg)) this.emit('message', msg);
  			})

			this.firstConn = false;
  			this.swarm.on('connection', (connection) => 
			{
    				console.log('found + connected to peer');
    				let g = this.gossip.createPeerStream();
    				connection.pipe(g).pipe(connection);

    				if (!this.firstConn && this.swarm.connected === 1) {
      					this.firstConn = true;
      					this.emit('connected');
    				}
  			});
		}

		// encode if packet is object, decode if it is RLPx
                this.handleRLPx = (fields) => (packet) =>
                {
                        let m = {};
                        try {
                                ethUtils.defineProperties(m, fields, packet);
                                return m;
                        } catch(err) {
                                console.trace(err);
                                return {};
                        }
                }

		this.filterSeen = (msg) =>
		{
			let timeNow = Math.floor(Date.now()/1000);
			let hashID = ethUtils.bufferToHex(ethUtils.sha256(Buffer.from(msg)));
			if (typeof(this.seen.logs[hashID]) !== 'undefined' && timeNow - this.seen.logs[hashID] < 10000 ) {
				this.seen.logs[hashID] = timeNow;
				return false;
			} else {
				Object.keys(this.seen.logs).map((h) => { if (timeNow - this.seen.logs[h] > 25000) delete this.seen.logs[h]; });
				this.seen.logs[hashID] = timeNow;
				return true;
			}
		}

		this.throttlePeer = (info) =>
		{
			let timeNow = Math.floor(Date.now()/1000);
			if (typeof(this.seen.seen[info.public]) !== 'undefined' && timeNow - this.seen.seen[info.public] < 3) {
				this.seen.seen[info.public] = timeNow;
				return false;
			} else {
				Object.keys(this.seen.seen).map((h) => { if (timeNow - this.seen.seen[h] > 25000) delete this.seen.seen[h]; });
				this.seen.seen[info.public] = timeNow;
				return true;
			}
		}

		this.validateMsg = (msg) =>
		{
			// for now, only validate RLPx format, will also validate RLPx payload signature and confirm active membership via smart contract.
			try {
				this.handleRLPx(fields)(msg);
				return true;
			} catch (err) {
				return false;
			}
		}

		this.publish = (msg) =>
		{
    			return this.gossip.publish(msg)
		}

  		this.swarm.listen(this.port);

	}
}

module.exports = PubSub;
