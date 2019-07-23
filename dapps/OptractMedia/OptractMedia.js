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
		this.getOpround = () => { return this.call(this.appName)('BlockRegistry')('queryOpRound')().then((op)=>{return op.toNumber()}) }
		this.getOproundId = (op) => { return this.call(this.appName)('BlockRegistry')('queryOpRoundId')(op) }
		this.getMaxVoteTime = () => {return this.call(this.appName)('BlockRegistry')('maxVoteTime')().then((vtime)=>{return vtime.toNumber()})}
		this.isValidator = (addr) => { return this.call(this.appName)('BlockRegistry')('isValidator')(addr) }

		// op=0 (default) is for current opround
		// This call only returns common opround info regardless finalized or not.
		this.getOproundInfo = (op=0) => 
		{
			return this.call(this.appName)('BlockRegistry')('queryOpRoundInfo')(op)
				   .then((rc) => { return [ rc[0].toNumber(), rc[1], rc[2].toNumber() ] });
		}

		// This is for finalized opround. It returns everything.
		this.getOproundResults = (op) => 
		{
			return this.call(this.appName)('BlockRegistry')('queryOpRoundResult')(op)
				   .then((rc) => { return [ rc[0].toNumber(), rc[1], rc[2].toNumber(), rc[3].toNumber(), rc[4], rc[5], rc[6].toNumber(), rc[7], rc[8].toNumber() ] });
		}

		this.getOproundProgress = () => 
		{
			return this.call(this.appName)('BlockRegistry')('queryOpRoundProgress')()
				   .then((rc) => { return [ rc[0].toNumber(), rc[1], rc[2].toNumber(), rc[3].toNumber(), rc[4].toNumber(), rc[5].toNumber()] });
                                    // return(articleCount, atV1, v1EndTime, v2EndTime, roundVote1Count, roundVote2Count);
		}

		this.getMinSuccessRate = (op) =>
		{
			return this.call(this.appName)('BlockRegistry')('queryOpRoundResult')(op)
				   .then((rc) => { return rc[3].toNumber() });
		}

                this.memberStatus = (address) => {  // "status", "token (hex)", "since", "penalty"
                        return this.call(this.appName)('MemberShip')('getMemberInfo')(address).then( (res) => {
                                let statusDict = ["failed connection", "active", "expired", "not member"];
                                let status = res[0];
                                let id = res[1];
                                let since = res[2].toNumber();
                                let penalty = res[3].toNumber();
                                let kycid = res[4];
                                let tier = res[5].toNumber();
                                let expireTime = res[6].toNumber();
                                return [statusDict[status], id, since, penalty, kycid, tier, expireTime];
                        })
                }

		this.buyMembership = () => {
			const _renew = () => {
				return this.call(this.appName)('MemberShip')('fee')().then((rc)=>{
					let fee = rc.toNumber();
					return this.sendTk(this.appName)('MemberShip')('renewMembership')()(fee)
				})
			};
			const _new = () => {
				return this.call(this.appName)('MemberShip')('fee')().then((rc)=>{
					let fee = rc.toNumber();
					return this.sendTk(this.appName)('MemberShip')('buyMembership')()(fee)
				})
			}

			let account = this.userWallet[this.appName];
			return this.memberStatus(account).then((rc)=>{
				if (rc[0] === "active") {
					let expireTime = rc[5];
					let now = (new Date()).getTime()/1000;  // convert from ms to seconds
					if (now > expireTime - 86400*7) {  // 7 days is hard coded in smart contract
						return _renew();
					} else {
						console.log("Already a active member");
						return;
					}
				} else if (rc[0] === "expired") {
					return _renew();
				} else if (rc[0] === "not member") {
					return _new();
				} else {
					console.dir(rc);
					throw "unknown member status"
				}
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
