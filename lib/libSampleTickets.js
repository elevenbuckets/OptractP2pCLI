#!/usr/bin/env node
'use strict';
/*
The purpose here is to sample some tickets from a given array `tickets` base on the `lotteryWinNumber`.
Both `lotteryWinNumber` and `tickets` are hex string of length 64 (or 66 if include prefix '0x').

The rule to choose a ticket is: the `refDigit` digit of the ticket must be `winChar`.
`refDigit` and `winChar` are determined by the `lotteryWinNumber`
1. `refDigit`:
    - an integer between -1 and -4.
    - It is determined by 1st digit of `lotteryWinNumber` (mod by 4 then convert to the range of -1 and -4)
2. `winChar` is the last digit of `lotteryWinNumber`

combine 1 and 2 and apply the rule to 'ticketHex':

    a ticket is selected if the 'refDigit' of the ticket is 'winChar' (only 1/16 of chance to be selected)

To select more tickets (25% of tickets is selectd):

    a ticket is selected if the 'refDigit' of the ticket is in ['winChar', 'winChar+1', 'winChar+2', 'winChar+3']

To be precise, to generate the above winChar-array, the procedures are: 
    - convert 'winChar' to int; plus a value from 0 to 3; mod by 16, convert back to hex, or in js:
      Array.from({length:4}, (_, k)=>{return ((parseInt(winChar, 16)+k)%16).toString(16)});

*/

class RandomSampleTicket {
    constructor() {

        this._getHexNthDigit = (value, n) => {
            if (n < -64 || n >= 64) throw("Wrong digit for a length 64 hex string, got:" + n);
            if (this._isHex(value)) {
                if (value.length != 64) throw("wrong hex value: " + value);
            } else if (this._isHex(value.substring(2, 64)) && value.substring(0,2) === '0x') {
                if (value.length != 66) throw("wrong hex value: " + value);
                value = value.slice(2);
            } else {
                throw("wrong hex value: " + value);
            }

            if (n === -1) {
                return value.slice(n);
            } else {
                return value.slice(n, n+1);
            }

        }

        this._isHex = (value) =>  {
                let hexRegex = /^[0-9A-Fa-f]{2,}$/;
                return hexRegex.test(value);
        };

        this._sampleByCompareNthDigit= (_tickets, winChar, n, winHexWidth=0) => {
            // assume '_tickets' is uint array, 'winChar' is a hex (one digit)
            let tickets = _tickets.map((t)=>{return this._getHexNthDigit(t, n)});
            let res = [];
            if (winHexWidth === 0) {
                tickets.map((a, k) => {if ( a === winChar ) res.push(_tickets[k])});
            } else if (winHexWidth > 0 && winHexWidth <= 16) {
                let winChars = Array.from({length:winHexWidth}, (v, k)=>{return ((parseInt(winChar, 16)+k)%16).toString(16)});
                tickets.map((v, k) => {if ( winChars.includes(v) ) res.push(_tickets[k])});
            } else {
                throw('Error: winHexWidth must >=1 and <=16, here receive: ' + winHexWidth);
            }
            return res;
        }

        this.sample = (tickets, lotteryWinNumber, winHexWidth=4, verbose=false) => {
            // 'tickets' is an array of bytes32 hex string; 'lotteryWinNumber' is a bytes32 hex string
            // both with or without the prefix '0x' are acceptable here
            // return an array of hex string
            // Note: In order to consistent with smart contract: 'winHexWidge' should fix at 4
            if (winHexWidth < 1 || winHexWidth > 16) throw('Error: winHexWidth must bewteen 1 and 16');

            // make refDigit in the range of [-1, -2, -3, -4], i.e., could be 1st, 2nd, 3rd, or 4th digit count from behind
            let refDigit = parseInt(this._getHexNthDigit(lotteryWinNumber, 0), 16) % 4 * (-1) - 1;
            // let refDigit = 63 - parseInt(this._getHexNthDigit(winningTicket, 0), 16) % digitRange;  // only for 32 bytes
            let winChar = this._getHexNthDigit(lotteryWinNumber, -1);
            return this._sampleByCompareNthDigit(tickets, winChar, refDigit, winHexWidth);
        }

        // this.intToBytes32Hex = (v) => {
        //     return '0x'+v.toString(16).padStart(64, '0');
        // }
    }
}


module.exports = RandomSampleTicket;
