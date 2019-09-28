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
logging.basicConfig(filename='install.log', level=logging.INFO, format=log_format,
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


def os_specific():
    is_64bits = sys.maxsize > 2**32
    msg_info = 'Preparing binaries for {0}'
    msg_instruction = 'Need to manual install Optract node for your operation system {0}. Please follow http://optract.com/... for instructions'
    msg_unsupported = 'Sorry, your operation system {0} is not supported'
    if sys.platform.startswith('freebsd'):
        logging.error(msg_instruction.format('freebsd'))
    elif sys.platform.startswith('linux'):
        if os.uname()[4].startswith('arm'):  # such as raspberry pi
            logging.error(msg_instruction.format('arm'))
        else:
            if is_64bits:
                logging.info(msg_info.format('linux (64-bit)'))
                # os.rename('bin/node.linux64', 'bin/node')
                # os.rename('bin/asar.linux64', 'bin/asar')
                # os.rename('bin/ipfs.linux64', 'bin/ipfs')
            else:
                logging.error(msg_instruction.format('linux (32-bit)'))
    elif sys.platform.startswith('win32'):  # not necessary 32-bit
        if is_64bits:
            logging.error(msg_instruction.format('windows (64-bit)'))
            # logging.info(msg_info.format('windows (64-bit)'))
            # os.rename('bin/node.win', 'bin/node')
            # os.rename('bin/asar.win', 'bin/asar')
            # os.rename('bin/ipfs.win', 'bin/ipfs')
        else:
            logging.error(msg_instruction.format('windows (32-bit)'))
    elif sys.platform.startswith('cygwin'):  # is it same as windows?
        logging.error(msg_unsupported.format('cygwin'))
    elif sys.platform.startswith('darwin'):
        os.rename('bin/node.macos.mojave', 'bin/node')
        os.rename('bin/asar.macos.mojave', 'bin/asar')
        os.rename('bin/ipfs.macos.mojave', 'bin/ipfs')
    else:
        logging.error(msg_unsupported.format(sys.platform))
    return


def init_ipfs(ipfs_repo):
    # there should have no ipfs_repo folder at this point
    ipfs_repo_default = os.path.join(os.getcwd(), 'ipfs_repo')
    if os.path.exists(ipfs_repo_default):
        # logging.warning("ipfs repo exists, will use existing one in " + ipfs_repo_default + " and ignore the input value)
        # return
        errmsg_ipfs_exist = 'Error: ipfs_repo already exist in {0}'.format(ipfs_repo_default)
        logging.error(errmsg_ipfs_exist)
        raise SystemExit(errmsg_ipfs_exist)

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
    if len(sys.argv) != 2:
        raise SystemExit('Error! Please give a ipfs_repo (if the ipfs_repo exist will symlink to it; ' +
                         'if not exist, will create one then symlink to it if necessary)')
    print('Installing, please see the log in "install.log"')
    ipfs_repo = sys.argv[1]
    logging.info('Initializing Optract...')

    os_specific()  # mainly get the correct binary for node/ipfs/asar; should call it first

    dest_file = 'dapps/config.json'
    createConfig(os.getcwd(), dest_file)

    extract_node_modules()
    init_ipfs(ipfs_repo)
    # still need to manually copy 'myArchive.bcup' and directory 'keystore' into 'dapps' folder
