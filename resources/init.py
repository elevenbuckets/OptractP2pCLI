#!/usr/bin/python -u
import os
import sys
import json
import subprocess
import shutil
import logging
from pathlib import Path  # this is python 3 only

# logging
log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
log_datefmt = '%Y-%m-%d %H:%M:%S'
basedir = os.path.dirname(os.path.realpath(sys.argv[0]));  # os.getcwd() is not enough
logfile = os.path.join(basedir, 'install.log')
# replace the `filename='install.log'` to `stream=sys.stdout` to direct log to stdout
logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                    datefmt=log_datefmt)


def createConfig(optract_install, dest_file, account='0x'):
    optract_install = Path(optract_install)
    config = {
        "datadir": str(optract_install / "dapps"),
        "rpcAddr": "https://rinkeby.infura.io/metamask",
        "defaultGasPrice": "20000000000",
        "gasOracleAPI": "https://ethgasstation.info/json/ethgasAPI.json",
        "condition": "sanity",
        "networkID": 4,
        "passVault": str(optract_install / "dapps" / "myArchive.bcup"),
        "node": {
            "dappdir": str(optract_install / "dapps"),
            "dns": {
                "server": [
                    "discovery1.datprotocol.com",
                    "discovery2.datprotocol.com"
                ]
            },
            "dht": {
                "bootstrap": [
                    "bootstrap1.datprotocol.com:6881",
                    "bootstrap2.datprotocol.com:6881",
                    "bootstrap3.datprotocol.com:6881",
                    "bootstrap4.datprotocol.com:6881"
                ]
            }
        },
        "dapps": {
            "OptractMedia": {
                "appName": "OptractMedia",
                "artifactDir": str(optract_install / "dapps" / "OptractMedia" / "ABI"),
                "conditionDir": str(optract_install / "dapps" / "OptractMedia" / "Conditions"),
                "contracts": [
                    { "ctrName": "BlockRegistry", "conditions": ["Sanity"] },
                    { "ctrName": "MemberShip", "conditions": ["Sanity"] }
                ],
                "account": account,
                "database": str(optract_install / "dapps" / "OptractMedia" / "DB"),
                "version": "1.0",
                "streamr": False
            }
        }
    }
    if os.path.isfile(dest_file):
        logging.warning('{0} already exists, will overwrite it'.format(dest_file))
    with open(dest_file, 'w') as f:
        json.dump(config, f, indent=4)
        logging.info('config write to file {0}'.format(dest_file))
    return config


def extract_node_modules():
    shutil.rmtree('node_modules', ignore_errors=True)
    asarBinPath = os.path.join('bin', 'asar')
    subprocess.check_call([asarBinPath, "extract", "node_modules.asar", "node_modules"], stdout=None, stderr=subprocess.STDOUT)
    return


def getOS():
    is_64bits = sys.maxsize > 2**32
    if sys.platform.startswith('freebsd'):
        operation_system = 'freebsd'
    elif sys.platform.startswith('linux'):
        if os.uname()[4].startswith('arm'):  # such as raspberry pi
            operation_system = 'arm'
        else:
            operation_system = 'linux'
    elif sys.platform.startswith('win32'):  # not necessary 32-bit
        operation_system = 'win32'
    elif sys.platform.startswith('cygwin'):  # is it same as windows?
        operation_system = 'cygwin'
    elif sys.platform.startswith('darwin'):
        operation_system = 'darwin'
    return operation_system, is_64bits


def init_ipfs(ipfs_repo=None):
    # note: assume the default ipfs_repo locate in ``../ipfs_repo` of optract_install
    ipfs_repo_default = os.path.join(os.path.dirname(basedir), 'ipfs_repo')
    if ipfs_repo is None:
        ipfs_repo = ipfs_repo_default

    ipfs_config = os.path.join(ipfs_repo, 'config')

    if os.path.exists(ipfs_config):
        logging.warning("ipfs repo exists, will use existing one in " + ipfs_repo)
        return

    # create ipfs_repo
    myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
    myenv['IPFS_PATH'] = ipfs_repo
    ipfs_bin = os.path.join("bin", "ipfs")

    logging.info("initilalizing ipfs in " + ipfs_repo)
    subprocess.check_call([ipfs_bin, "init"], env=myenv, stdout=None, stderr=subprocess.STDOUT)

    return


if __name__ == '__main__':
    # (default) basedir for supporting OS:
    # linux: /home/<userName>/.config/optract
    # Mac: /Users/<userName>/.config/optract
    # Windows 10: C:\Users\<userName>\AppData\Local\Optract
    # "ipfs" should be `../ipfs_repo` relative to basedir
    print('Installing...')
    logging.info('Initializing Optract...')

    # operation_system = getOS();  # will need it in createConfig?

    dest_file = 'dapps/config.json'
    createConfig(basedir, dest_file)

    # extract_node_modules()
    init_ipfs()
    # still need to manually copy 'myArchive.bcup' and directory 'keystore' into 'dapps' folder
    print('Done. Please see the log in {0}.'.format(logfile))
