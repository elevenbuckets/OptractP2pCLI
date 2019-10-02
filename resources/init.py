#!/usr/bin/python -u
import os
import sys
import json
import subprocess
import shutil
import logging
import tarfile

# global variable
# basedir = os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))  # os.getcwd() is not enough


def get_basedir():
    return os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))


def createConfig(optract_install, dest_file):
    config = {
        "datadir": os.path.join(optract_install, "dist", "dapps"),
        "rpcAddr": "https://rinkeby.infura.io/v3/f50fa6bf08fb4918acea4aadabb6f537",
        "defaultGasPrice": "20000000000",
        "gasOracleAPI": "https://ethgasstation.info/json/ethgasAPI.json",
        "condition": "sanity",
        "networkID": 4,
        "passVault": os.path.join(optract_install, "myArchive.bcup"),
        "node": {
            "dappdir": os.path.join(optract_install, "dist", "dapps"),
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
                "artifactDir": os.path.join(optract_install, "dist", "dapps", "OptractMedia", "ABI"),
                "conditionDir": os.path.join(optract_install, "dist", "dapps", "OptractMedia", "Conditions"),
                "contracts": [
                    { "ctrName": "BlockRegistry", "conditions": ["Sanity"] },
                    { "ctrName": "MemberShip", "conditions": ["Sanity"] }
                ],
                "account": "0x",
                "database": os.path.join(optract_install, "dist", "dapps", "OptractMedia", "DB"),
                "version": "1.0",
                "streamr": "false"
            }
        }
    }

    # if previous setting exists, migrate a few settings and make a backup
    if os.path.isfile(dest_file):
        # load previous config
        with open(dest_file, 'r') as f:
            orig = json.load(f)
        try:
            config['dapps']['OptractMedia']['account'] = orig['dapps']['OptractMedia']['account']
        except KeyError:
            logging.warning('Cannot load "account" from previous config file. Use default: "0x".')
        try:
            config['dapps']['OptractMedia']['streamr'] = orig['dapps']['OptractMedia']['streamr']
        except KeyError:
            logging.warning('Cannot load "streamr" from previous config file. Use default: "false".')

        # logging.warning('{0} already exists, will overwrite it'.format(dest_file))
        logging.warning('{0} already exists, will move it to {0}'.format(dest_file + '.orig'))
        shutil.move(dest_file, dest_file+'.orig')

    # write
    with open(dest_file, 'w') as f:
        json.dump(config, f, indent=4)
        logging.info('config write to file {0}'.format(dest_file))
    return


def extract_node_modules():
    # asarBinPath = os.path.join('bin', 'asar')
    # subprocess.check_call([asarBinPath, "extract", "node_modules.asar", "node_modules"], stdout=None, stderr=subprocess.STDOUT)
    basedir = get_basedir()
    shutil.rmtree(os.path.join(basedir, 'dist', 'node_modules'), ignore_errors=True)
    with tarfile.open(os.path.join(basedir, 'dist', 'node_modules.tar'), 'r') as tar:
        tar.extractall(os.path.join(basedir, 'dist'))
    logging.info('extracting latest version of node_modules...')
    # os.remove(os.path.join(basedir, 'dist', 'node_modules.tar')
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
    basedir = get_basedir()
    ipfs_repo_default = os.path.join(basedir, 'ipfs_repo')
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
    process = subprocess.Popen([ipfs_bin, "init"], env=myenv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output, error = process.communicate()
    logging.info('ipfs results: \n' + output)
    if len(error) > 0:
        logging.critical('ipfs error message: \n' + error)

    return


def compatibility_symlinks():
    basedir = get_basedir()
    dapps = os.path.join(basedir, 'dist', 'dapps')

    src_to_names = {  # create a symlink pointing to `source` with link names
        os.path.join(basedir, 'ipfs_repo'): os.path.join(basedir, 'dist', 'ipfs_repo'),
        os.path.join(basedir, 'config.json'): os.path.join(dapps, 'config.json'),
        os.path.join(basedir, 'keystore'): os.path.join(dapps, 'keystore'),
        os.path.join(basedir, 'myArchive.bcup'): os.path.join(dapps, 'myArchive.bcup')
    }

    for src in src_to_names:
        name = src_to_names[src]
        if os.path.exists(name):
            if os.path.islink(name) or 'config.json' in name:  # safe to remove
                os.remove(name)
        try:
            os.symlink(src, name)
        except:
            logging.warning("Failed to symlink to {0}. Please check manually.".format(src))
    return


def init():
    # In this script, `basedir` is the `optract_install_path`
    # Default `basedir` for supporting OS:
    #   * linux: /home/<userName>/.config/optract
    #   * Mac: /Users/<userName>/.config/optract
    #   * Windows 10: C:\Users\<userName>\AppData\Local\Optract
    # In `basedir`, there are 'dist/', `ipfs_repo/`, buttercup, eth private key directory, and config.
    # Most others are in the directory `dist`, such as node_modules, nativeApp.py, and dapps.

    # logging
    log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
    log_datefmt = '%Y-%m-%d %H:%M:%S'
    basedir = get_basedir()
    logfile = os.path.join(basedir, 'install.log')
    # replace the `filename='install.log'` to `stream=sys.stdout` to direct log to stdout
    logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                        datefmt=log_datefmt)

    # print('Installing...')
    logging.info('Initializing Optract...')

    dest_file = os.path.join(basedir, 'config.json')
    createConfig(basedir, dest_file)

    extract_node_modules()
    init_ipfs()
    logging.info('Done')

    # still need to manually copy 'myArchive.bcup' and directory 'keystore' into 'dapps' folder
    # print('Done. Please see the log in {0}'.format(logfile))
    return


if __name__ == '__main__':
    # operation_system = getOS();  # probably no need this
    init()
    compatibility_symlinks()  # cannot work on windows; remove this after daemon.js update the paths
