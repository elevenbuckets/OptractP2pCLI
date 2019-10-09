#!/usr/bin/python -u
import os
import sys
import json
import subprocess
import shutil
import logging
import tarfile

if sys.platform == 'win32':
    import winreg
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
        "passVault": os.path.join(optract_install, "dist", "dapps", "myArchive.bcup"),  # this and 'keystore/' are hardcoded in daemon,js
        # "passVault": os.path.join(optract_install, "myArchive.bcup"),  # for now, copy into dist/dapps
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
        logging.warning('{0} already exists, will move it to {1}'.format(dest_file, dest_file + '.orig'))
        shutil.move(dest_file, dest_file+'.orig')

    # write
    with open(dest_file, 'w') as f:
        json.dump(config, f, indent=4)
        logging.info('config write to file {0}'.format(dest_file))
    return


def extract_node_modules(basedir=None):
    if basedir is None:
        basedir = get_basedir()
    # asarBinPath = os.path.join('bin', 'asar')
    # subprocess.check_call([asarBinPath, "extract", "node_modules.asar", "node_modules"], stdout=None, stderr=subprocess.STDOUT)
    basedir = get_basedir()
    shutil.rmtree(os.path.join(basedir, 'dist', 'node_modules'), ignore_errors=True)
    logging.info('extracting latest version of node_modules...')
    with tarfile.open(os.path.join(basedir, 'dist', 'node_modules.tar'), 'r') as tar:
        tar.extractall(os.path.join(basedir, 'dist'))
    logging.info('Done extracting latest version of node_modules.')
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
    ipfs_bin = os.path.join(basedir, "dist", "bin", "ipfs")

    logging.info("initilalizing ipfs in " + ipfs_repo)
    process = subprocess.Popen([ipfs_bin, "init"], env=myenv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output, error = process.communicate()
    logging.info('ipfs results: \n' + str(output))
    if len(error) > 0:
        logging.critical('ipfs error message: \n' + str(error))

    return


def symlink_data(target, name, force=False):
    if os.path.islink(name) and force==True:
        os.remove(name)
    try:
        os.symlink(target, name)
    except:
        logging.warning("Failed to symlink to {0}. Please check manually. Error message:\n{1}".format(target, sys.exc_info()[1]))
    return


def copy_data(src, dest, force=False):
    if os.path.exists(dest) and force==True:
        os.remove(dest)
    try:
        shutil.copyfile(src, dest)
    except:
        logging.warning("Failed to copy file from {0} to {1}. Please check manually. Error message:\n{2}".format(src, dest, sys.exc_info()[1]))
    return


def sym_or_copy_data(basedir=None):
    # This function is for developer only. Assume previous config or dir exists.
    # symlink or copy: "ipfs_repo/", "config.json", "keystore", "myArchive.bcup"
    # should deprecate this function after update daemon.js, make daemon.js read data files outside "dist"
    if basedir is None:
        basedir = get_basedir()
    logging.info('Now trying to copy or symlink existing files inside ' + basedir)
    dir_keystore = os.path.join(basedir, 'keystore')
    file_passvault = os.path.join(basedir, 'myArchive.bcup')
    if sys.platform == 'win32':  # In windows, need to run as administrator to symlink(?), so copy files instead of symlink
        symcopy = copy_data
    else:
        symcopy = symlink_data
    symcopy(os.path.join(basedir, 'ipfs_repo'), os.path.join(basedir, 'dist', 'ipfs_repo'))
    symcopy(os.path.join(basedir, 'config.json'), os.path.join(basedir, 'dist', 'dapps', 'config.json'), force=True)
    if os.path.isdir(dir_keystore) and os.path.isfile(file_passvault):
        symcopy(dir_keystore, os.path.join(basedir, 'dist', 'dapps', 'keystore'))
        symcopy(file_passvault, os.path.join(basedir, 'dist', 'dapps', 'myArchive.bcup'))
    else:
        os.mkdir(os.path.join(basedir, 'dist', 'dapps', 'keystore'))
    
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


def add_registry(basedir):
    if basedir is None:
        basedir = get_basedir()
    # TODO: add remove_registry()
    if sys.platform == 'win32':
        keyVal = r'Software\Google\Chrome\NativeMessagingHosts\optract'
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, keyVal, 0, winreg.KEY_ALL_ACCESS)
        except:
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, keyVal)
        nativeMessagingMainfest = os.path.join(basedir, 'dist', 'optract-win.json')
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, nativeMessagingMainfest)
        winreg.CloseKey(key)
    return


def init():
    # In this script, `basedir` is the `optract_install_path`
    # Default `basedir` for supporting OS:
    #   * linux: /home/<userName>/.config/optract
    #   * Mac: /Users/<userName>/.config/optract
    #   * Windows 10: C:\Users\<userName>\AppData\Local\Optract
    # In `basedir`, there are 'dist/', `ipfs_repo/`, buttercup, eth private key directory, and config.
    # Most others are in the directory `dist`, such as node_modules, nativeApp.py, and dapps.
    basedir = get_basedir()

    # logging
    log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
    log_datefmt = '%Y-%m-%d %H:%M:%S'
    basedir = get_basedir()
    logfile = os.path.join(basedir, 'dist', 'install.log')
    # replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
    logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                        datefmt=log_datefmt)

    # print('Installing...')
    logging.info('Initializing Optract...')
    add_registry(basedir)  # windows only: check os inside the function

    dest_file = os.path.join(basedir, 'config.json')
    createConfig(basedir, dest_file)

    extract_node_modules()
    init_ipfs()
    logging.info('Done! Optract is ready to use.')  # Not true: still need to sym_or_copy_data() before update daemon.js since daemon.js
                                                    # still looking for config, ipfs_repo, key and bcup files in the "dist" directory.
    # create a file to indicate the whole process has finished
    installed = os.path.join(basedir, 'dist', '.installed')
    open(installed, 'a').close()

    return


if __name__ == '__main__':
    init()
    # operation_system, _ = getOS();  # probably no need this
    # sym_or_copy_data()
