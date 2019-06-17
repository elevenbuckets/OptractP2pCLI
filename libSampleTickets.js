#!/usr/bin/env node
'use strict';
/* The main purpose of this class is to:
 * give an array of uint256 (correspond to bytes32) and a `winningTicket`
 * base on the `winningTicket`, choose a sample from the array
 * there are two criterias so far:
    1. as integers, their distance to the `winningTicket`
    2. base on the hex of `winningTicket`, find a rule to determine at which tickets
       are selected. More detail (use hex):
       - the last digit of `winningTicket` is `w`
       - use first hex of `winningTicket` to determine another digit `n`
       - for tickets, the hex in digit `n` must be equal to `w`
         - varient : the hex in digit `n` must be in the array [`w`, `w+1`, ..., '`w+(r-1)`],
           here `w` is treat as integer, then elements of the array are mod by 16 and convert back to hex.

Example usage:

```javascript
const randomSample = new RandomSample();
let sample = randomSample.sampleN([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 14, 10, 3, 1, true);
console.log('sample');
console.log(sample.map(randomSample.intToBytes32Hex));
```

Here tickets range from 1 to 16, winningTicket=14 , numSample=10, winHexWidth=3, digitRange=1, verbose=true
* after convert to hex, the last digit of `winningTicket` is `3`, call it `winHex`
    - since `winHexWidth`=3, so create an array `winHexs = [winHex, winHex+1, winHex+2] = ['e', 'f', '0']`
        - note: convert winHex to int, then mod all elements of the array by 16, then convert back to hex
* first digit of winningTicket is '0', so the `refDigit is `first_digit%digitRange*(-1)-1 = 0%1*(-1)-1 = -1`
* sampled ticket: after convert to hex, the `refDgit` of the ticket must be in `winHexs`
    - in this case their `-1` digit must be in `['e', 'f', '0']`
*/

class RandomSampleTicket {
    constructor() {
        this.sampleByDistance = (_tickets, winningTicket, numSample=3, upperBoundary=2**256) => {
            // '_tickets' and 'winningTicket' are both uint
            // This function returns a sample from uint array `_tickets`.
            // The values in `_tickets` are in the range of [0, upperBoundary).
            // This function returns first `numSample` values which is closer to the `winningTicket`
            // Note that wrapping is considered, i.e., the distance between `upperBoundary-1`
            // and 0 is only 1.
            // note: consider to change the "_tickets" from uint array to hex array
            let distance = _tickets.map(
                (v) => (Math.abs(v-winningTicket) > upperBoundary/2) ?
                       Math.abs(upperBoundary - Math.abs(v - winningTicket)) :
                       Math.abs(v-winningTicket)
            );
            var sorted = distance.slice().sort((a,b)=>{return b-a});
            var ranks = distance.slice().map((v)=>{return sorted.indexOf(v)+1});  // rank 1 is the farthest
            let res = [];
            ranks.map((v,k)=>{ if (v>(_tickets.length-numSample)) res.push(_tickets[k])});
            return res;
        }

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

        this.sampleN = (_tickets, winningTicket, numSample, winHexWidth=8, digitRange=8, verbose=false) => {
            // 'tickets' and 'winningTicket' are both uint array, 'numSample' is int
            // return a uint array
            if (16 % digitRange != 0 || digitRange > 16) throw('Error:digitRange should be 1,2,4,8,16'); 
            if (winHexWidth < 1 || winHexWidth > 16) throw('Error: winHexWidth must bewteen 1 and 16');

            let refDigit = parseInt(this._getHexNthDigit(winningTicket, 0), 16) % digitRange * (-1) - 1;
            let winHex = this._getHexNthDigit(winningTicket, -1);
            if (verbose) {
                console.log('For tickets, the digit "refDigit" must be the "winHex" or in "winHexs"');
                console.log('* winHex or winHexs:');
                console.log('  - If winHexWidth=1, then "winHex" is the last digit of winningTicket');
                console.log('  - If winHexWidth>1, and the last digit of winningTicket is "n",');
                console.log('    where "n" is converted from hex to integer,');
                console.log('    then "winHexs" is [n, n+1, ..., n+winHexWidth-1] (mod by 16 and convert to hex)');
                console.log(`* refDigit = int(first_digit_of_winningTicket)%${digitRange}*(-1)-1 = ${refDigit}`);
                console.log(`* Here, a ticket is selected while:`);
                if (winHexWidth === 1) {
                    console.log(`   - the '${refDigit}' digit is '${winHex}'`);
                } else {
                    let winHexs = Array.from({length:winHexWidth}, (v, k)=>{
                        return ((parseInt(winHex, 16)+k)%16).toString(16)});
                    console.log(`   - the '${refDigit}' digit is in '${winHexs}'`);
                }

                console.log('* these selected tickets are then sorted by their distance to "winningTicket", and choose the first "numSample". ');
            }
            if (winHexWidth === 16) {
                return this.sampleByDistance(_tickets, winningTicket, numSample);
            } else {
                return this.sampleByDistance(
                    // this._sampleByCompareNthDigit(_tickets, winHex, -1-refDigit, winHexWidth),
                    this._sampleByCompareNthDigit(_tickets, winHex, refDigit, winHexWidth),
                    winningTicket,
                    numSample);
            }
        }

        this.intToBytes32Hex = (v) => {
            return '0x'+v.toString(16).padStart(64, '0');
        }
    }
}


module.exports = RandomSampleTicket;
