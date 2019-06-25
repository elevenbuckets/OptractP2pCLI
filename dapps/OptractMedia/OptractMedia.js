'use strict';

const ethUtils = require('ethereumjs-utils');
const KnifeIron = require('../../lib/KnifeIron.js');

// Common actions
// - connect to Ethereum, Optract Pubsub, and IPFS
// * Get latest Optract block and IPFS location from smart contract
// - loading the block and active records from IPFS.
// Validator extra:
// - at the same time, send pending pool ID with last block info. <----- Only allow validators to actively query pending pool 
// - getting newer snapshot IPFS location and start merging with real-time new tx received
// - determine effective merged pending state and send out pending pool ID of it again. This message frequency is critical, can't be too often, can't be too long.
// - repeat previous two steps in loops (until all master nodes agree?)
// - Once reaching new block snapshot time, determine and send out effective merged pending pool ID
// - Once reaching new block commit time, sync last round of pending pool ID before commiting new block merkle root on IPFS hashes to smart contract.
// Client extra:
// - getting newer snapshot IPFS location. <---- Only allow clients to passively receiving snapshots
// - whenever receiving valid new snapshot, rerender UI. <---- or only rerender if tx count has increased by certain amounts...
// - caching the last valid snopshot RLPx and response to requests. <---- ... but allow clients to resend last known snapshot RLPx (cached)
// - indevidual pending tx can also be rendered, if desired. 
// - if previously sent tx by client not found in latest snapshot, resend.
// * Once detect new block commited, loop back to the begining star (*) 

class OptractMedia extends KnifeIron {
	constructor(cfgObj)
        {
                super(cfgObj);

		this.appName = 'OptractMedia';

		this.getBlockNo = () => { return this.call(this.appName)('BlockRegistry')('getBlockNo')().then((bn) => { return bn.toNumber() }) }
		this.getBlockInfo = (blkNo) => { return this.call(this.appName)('BlockRegistry')('getBlockInfo')(blkNo) }
		this.getBlockInfo = (blkNo) => { return this.call(this.appName)('BlockRegistry')('getBlockInfo')(blkNo) }
		this.getOpround = () => { return this.call(this.appName)('BlockRegistry')('queryOpRound')() }
		this.getOproundId = (op) => { return this.call(this.appName)('BlockRegistry')('queryOpRoundId')(op) }
		this.getOproundInfo = (op=0) => 
		{
			let p = [ this.getOpround(), this.getOproundId(op) ];
			return Promise.all(p);
		}

                this.memberStatus = (address) => {  // "status", "token (hex)", "since", "penalty"
                        return this.call(this.appName)('MemberShip')('getMemberInfo')(address).then( (res) => {
                                let status = res[0];
                                let statusDict = ["failed connection", "active", "expired", "not member"];
                                return [statusDict[status], res[1], res[2], res[3], res[4]]  // "status", "id", "since", "penalty", "kycid"
                        })
                }

		this.validateMerkleProof = (targetLeaf) => (merkleRoot, proof, isLeft) => 
		{
			return this.call(this.appName)('BlockRegistry')('merkleTreeValidator')(proof, isLeft, targetLeaf, merkleRoot) 
				.catch((err) => { console.log(`ERROR in validateMerkleProof`); console.trace(err); return false; });
		}

		this.configs.dapps[this.appName].contracts.map((cobj) => 
		{
			console.dir(this.init(this.appName)(cobj.ctrName)());
		});
	}
}

module.exports = OptractMedia;
