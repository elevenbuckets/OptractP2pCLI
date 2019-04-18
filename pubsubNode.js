'use strict';

const swarm = require('discovery-swarm');
const gossip = require('secure-gossip');
const EventEmitter = require('events');
const ethUtils = require('ethereumjs-utils');

const fields = 
[
	{name: 'nonce', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'originAddress', length: 20, allowZero: true, default: new Buffer([]) },
	{name: 'ipfsHash', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'since', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'agree', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'disagree', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'reply', length: 32, allowLess: true, default: new Buffer([]) },
	{name: 'comment', length: 32, allowLess: true, default: new Buffer([]) },
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
	constructor(opts) {
		this.gossip = gossip(opts.gossip);
  		this.id = this.gossip.keys.public; // should eventually use ETH address
  		this.swarm = swarm();
		this.port  = opts.port || 0;

		this.join = (topic) =>
		{
  			if (!topic || typeof topic !== 'string') { throw new Error('topic must be set as a string') }
			if (typeof this.topic !== 'undefined') this.leave();
			this.topic = topic;
			this.seen  = { init: Math.floor(Date.now()/1000), logs: {} };
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

		this.filterSeen = (msg) =>
		{
			
		}

		this.publish = (msg) =>
		{
    			return this.gossip.publish(msg)
		}

  		this.swarm.listen(this.port);

	  	this.gossip.on('message', (msg) => {
    			this.emit('message', msg);
  		})
	}
}

module.exports = PubSub;
