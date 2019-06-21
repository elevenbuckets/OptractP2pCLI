#!/usr/bin/env node
'use strict';
/* The main purpose of this class is to:
 * give an array of uint256 (correspond to bytes32) and a `winningTicket`
 * base on the `winningTicket`, choose a sample from the array
 * sample criteria (see example below)

Example usage:

```javascript
const RandomSample = require('./libSampleTickets.js');
const randomSample = new RandomSample();
let sample = randomSample.sampleN([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,32], 14);
console.log('sample');
console.log(sample.map(randomSample.intToBytes32Hex));
```

Here is an integer array of tickets, winningTicket=14 , numSample=10, winHexWidth=4 (default), digitRange=4 (default)
 * first digit of winningTicket is '0' (treat it as byets32, padding 0 to the left),
   so the `refDigit is `first_digit%digitRange*(-1)-1 = 0%4*(-1)-1 = -1`
 * after convert to hex, the hex in refDigit (the last digit in this case) of `winningTicket` is `e`, call it `winHex`
    - since `winHexWidth`=4, so create an array `winHexs = [winHex, winHex+1, winHex+2, winHex+3] = ['e', 'f', '0', '1']`
        - note: convert winHex to int, add, then mod all elements of the array by 16, then convert back to hex
 * sampled ticket: after convert to hex, the `refDigit` of the ticket must be in `winHexs`
    - in this case their `-1` digit must be in `['e', 'f', '0' ,'1']`, so the return values are (trim the 0 in higher bytes):
    - 0x01, 0x0e, 0x0f, 0x10, 0x20
*/

class RandomSampleTicket {
    constructor() {

        this._getHexNthDigit = (i, d) => {
            // assume 'i' is Number, and 0 <= i < 2**256 (i.e., correspond to a byets32)
            if (d > 32){
                throw("digit is outside length of number " + i);
            } else if (d === -1){
                return i.toString(16).slice(d);
            } else {
                return i.toString(16).padStart(64, '0').slice(d, d+1);
            }
        }

        this._sampleByCompareNthDigit= (_tickets, winHex, n, winHexWidth=0) => {
            // assume '_tickets' is uint array, 'winHex' is a hex (one digit)
            let tickets = _tickets.map((t)=>{return this._getHexNthDigit(t, n)});
            let res = [];
            if (winHexWidth === 0) {
                tickets.map((a, k) => {if ( a === winHex ) res.push(_tickets[k])});
            } else if (winHexWidth > 0 && winHexWidth <= 16) {
                let winHexs = Array.from({length:winHexWidth}, (v, k)=>{return ((parseInt(winHex, 16)+k)%16).toString(16)});
                // console.log('winHexs:'+winHexs);
                tickets.map((v, k) => {if ( winHexs.includes(v) ) res.push(_tickets[k])});
            } else {
                throw('Error: winHexWidth must >=1 and <=16, here receive: ' + winHexWidth);
            }
            return res;
        }

        this.sampleN = (_tickets, winningTicket, winHexWidth=4, digitRange=4, verbose=false) => {
            // 'tickets' and 'winningTicket' are both uint array;
            // In order to consistent with smart contract: 'winHexWidge' should fix at 4 and 'digitRange' should fix at 4
            // return a uint array
            if (16 % digitRange != 0 || digitRange > 16) throw('Error:digitRange should be 1,2,4,8,16'); 
            if (winHexWidth < 1 || winHexWidth > 16) throw('Error: winHexWidth must bewteen 1 and 16');

            let refDigit = parseInt(this._getHexNthDigit(winningTicket, 0), 16) % digitRange * (-1) - 1;
            // let refDigit = 63 - parseInt(this._getHexNthDigit(winningTicket, 0), 16) % digitRange;  // only for 32 bytes
            let winHex = this._getHexNthDigit(winningTicket, -1);
            return this._sampleByCompareNthDigit(_tickets, winHex, refDigit, winHexWidth);
        }

        this.intToBytes32Hex = (v) => {
            return '0x'+v.toString(16).padStart(64, '0');
        }
    }
}


module.exports = RandomSampleTicket;
