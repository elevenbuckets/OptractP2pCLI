#!/usr/bin/env node
'use strict';

const ethUtils = require('ethereumjs-utils');
const BigNumber = require('bignumber.js');
const RandomSample = require('./libSampleTickets.js');

// choose a number and a set of numbers (between 0 and 2**256)
// let winTicketHash = '0xe1002222215d9c0aad446b4016fdedfc2b5463af50d23de3e6a7e0985d75970d';
let winTicketHash = ethUtils.bufferToHex(ethUtils.keccak256(Math.random().toString()));
let winTicket = new BigNumber(winTicketHash);

// var myDict = Array.from({length:20}, (v, k)=>(k+1.1).toString())  // a fixed set
var myDict = Array.from({length:1000}, ()=>{return Math.random().toString()});
let ticketHash = myDict.map((v)=>{
    return ethUtils.bufferToHex(ethUtils.keccak256(v));
});
let ticketInt = ticketHash.map((v)=>{return new BigNumber(v)});
// console.log('winTicket (hex):' + winTicketHash);
// console.log('winTicket (int):' + Number(winTicket));

// start from here
const randomSample = new RandomSample();
// let sample = randomSample.sampleN(ticketInt, winTicket, 10, 16, 4, true);
let sample = randomSample.sampleN([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,30], 14, 10, 3, 1, true);
console.log('sample');
console.log(sample.map(randomSample.intToBytes32Hex));
// console.log(sample.map((v)=>Number(v)));
