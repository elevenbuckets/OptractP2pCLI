#!/usr/bin/python -u
# note: this script should able to execute on both python 2.7 and 3.x or above
import os
import sys
import json
import subprocess
import shutil
import logging

# logging
log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
log_datefmt = '%Y-%m-%d %H:%M:%S'
# replace the `filename='install.log'` to `stream=sys.stdout` to direct log to stdout
basedir = os.path.dirname(os.path.realpath(sys.argv[0]));  # os.getcwd() is not enough
logfile = os.path.join(basedir, 'install.log')
logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                    datefmt=log_datefmt)


def createConfig(optract_install, dest_file, account='0x', geth_rpc="http://localhost:8545", streamr=False):
    config = {
        "datadir": os.path.join(optract_install, "dapps"),
        "rpcAddr": geth_rpc,
        "defaultGasPrice": "20000000000",
        "gasOracleAPI": "https://ethgasstation.info/json/ethgasAPI.json",
        "condition": "sanity",
        "networkID": 4,
        "passVault": os.path.join(optract_install, "dapps/myArchive.bcup"),
        "node": {
            "dappdir": os.path.join(optract_install,  "dapps"),
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
                "artifactDir": os.path.join(optract_install, "dapps/OptractMedia/ABI"),
                "conditionDir": os.path.join(optract_install, "dapps/OptractMedia/Conditions"),
                "contracts": [
                    { "ctrName": "BlockRegistry", "conditions": ["Sanity"] },
                    { "ctrName": "MemberShip", "conditions": ["Sanity"] }
                ],
                "account": account,
                "database": os.path.join(optract_install, "dapps/OptractMedia/DB"),
                "version": "1.0",
                "streamr": streamr
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


def init_ipfs(ipfs_repo):
    # note: The real ipfs_repo should be outside the `basedir`, and symlink to that one inside `basedir`.
    basedir = os.path.dirname(os.path.realpath(sys.argv[0]));
    ipfs_repo_default = os.path.join(os.path.dirname(basedir), 'ipfs_repo')
    ipfs_config_default = os.path.join(ipfs_repo_default, 'config')
    if os.path.exists(ipfs_config_default):
        logging.warning("ipfs repo exists, will use existing one in " + ipfs_repo_default)
        return
        # msg_ipfs_exist = 'Error: ipfs_repo already exist in {0}'.format(ipfs_repo_default)
        # logging.error(msg_ipfs_exist)
        # raise SystemExit(msg_ipfs_exist)

    # create ipfs_repo
    ipfs_config = os.path.join(ipfs_repo, "config")
    ipfs_bin = os.path.join("bin", "ipfs")
    if not os.path.exists(ipfs_config):
        logging.info("initilalizing ipfs in " + ipfs_repo)
        subprocess.check_call([ipfsBinPath, "init"], env={'IPFS_PATH': ipfs_repo}, stdout=None, stderr=subprocess.STDOUT)
    else:
        logging.warning("ipfs repo exists, will use existing one in " + ipfs_repo)

    # symlink if necessary (it does not work for windows prior to vista)
    if (ipfs_repo != ipfs_repo_default):
        os.symlink(ipfs_repo, ipfs_repo_default)
    return


if __name__ == '__main__':
    # (default) base_directory for major OS:
    # linux: /home/<userName>/.config/optract
    # Mac: /Users/<userName>/.config/optract
    # Windows 10: C:\Users\<userName>\AppData\Local\Optract
    # "optract_install" should be `os.path.join(base_directory, 'dist')`
    # "ipfs" should be `os.path.join(base_directory, 'ipfs')`
    if len(sys.argv) != 2:
        raise SystemExit('Error! Please give a ipfs_repo (if the ipfs_repo exist will symlink to it; ' +
                         'if not exist, will create one then symlink to it if necessary)')
    print('Installing...')
    ipfs_repo = sys.argv[1]
    logging.info('Initializing Optract...')

    operation_system = getOS();  # will need it in createConfig

    dest_file = 'dapps/config.json'
    createConfig(os.getcwd(), dest_file)

    extract_node_modules()
    init_ipfs(ipfs_repo)
    # still need to manually copy 'myArchive.bcup' and directory 'keystore' into 'dapps' folder
    print('Done. Please see the log in {0}.'.format(logfile))
