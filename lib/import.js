const fs = require('fs');
const keth = require('keythereum');

let password = process.env.password;
delete process.env.password;
let jsonpath = process.env.jsonpath;

let keybuf = fs.readFileSync(jsonpath);
let keyObj = JSON.parse(keybuf.toString());

keth.recover(password, keyObj, function(pkey) {
        if (pkey.toString() === 'Error: message authentication code mismatch') {
                process.send({});
        } else {
                process.send(keyObj);
        }

        process.exit(0);
});

