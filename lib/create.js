const fs = require('fs');
const keth = require('keythereum');
const path = require('path');

let password = process.env.password;
delete process.env.password;
let datadir = process.env.datadir;

keth.create(keth.constants, (k) => { 
        let dk = k;
        let keyObj = keth.dump(password, dk.privateKey, dk.salt, dk.iv, {kdf: 'scrypt'});

        if (keyObj.error) {
                process.send({});
                process.exit(0);
        }

        let p = keth.exportToFile(keyObj, path.join(datadir, 'keystore'));

        if (!fs.existsSync(p)) {
                process.send({});
                process.exit(0);
        }

        fs.chmodSync(p, '600');
        process.send({address: keyObj.address});
        process.exit(0);
});
