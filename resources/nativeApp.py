#!/usr/bin/python -u

# Note that running python with the `-u` flag is required on Windows,
# in order to ensure that stdin and stdout are opened in binary, rather
# than text, mode.
import time
import json
import sys
import struct
import subprocess
import os
import signal
import logging
import shutil
import tarfile
import OptractDaemon

# On Windows, the default I/O mode is O_TEXT. Set this to O_BINARY
# to avoid unwanted modifications of the input/output streams.
if sys.platform == "win32":
    import winreg
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# global variables
# 'cwd' is for installtion
cwd = os.path.dirname(os.path.realpath(sys.argv[0]))  # os.getcwd() may not correct if click it from File manager
cwd = os.path.dirname(cwd)  # after pack by pyarmor, it's one folder deeper, and here we need the parent one

# determine path of basedir
if sys.platform.startswith('linux'):
    basedir = os.path.expanduser("~/.config/Optract")
elif sys.platform.startswith('darwin'):
    basedir = os.path.expanduser("~/.config/Optract")
elif sys.platform.startswith('win32'):
    basedir = os.path.expanduser("~\AppData\Local\Optract")
if not os.path.isdir(basedir):
    os.mkdir(basedir)

lockFile = os.path.join(basedir, "dist", "Optract.LOCK")
myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
ipfs_path = os.path.join(basedir, 'ipfs_repo')
myenv['IPFS_PATH'] = ipfs_path

FNULL = open(os.devnull, 'w')
ipfsP = None
nodeP = None

# logging
log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
log_datefmt = '%Y-%m-%d %H:%M:%S'
logfile = os.path.join(basedir, 'optract.log')
# replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                    datefmt=log_datefmt)


# Read a message from stdin and decode it.
def get_message():
    raw_length = sys.stdin.read(4)
    if not raw_length:
        sys.exit(0)
    message_length = struct.unpack('=I', raw_length)[0]  # python2
    # message_length = struct.unpack('=I', bytes(raw_length, encoding="utf-8"))[0]  # python3
    message = sys.stdin.read(message_length)
    return json.loads(message)


# Encode a message for transmission, given its content.
def encode_message(message_content):
    encoded_content = json.dumps(message_content)
    encoded_length = struct.pack('=I', len(encoded_content))  # python2
    # encoded_length = struct.pack('=I', len(encoded_content)).decode()  # python3
    return {'length': encoded_length, 'content': encoded_content}


# Send an encoded message to stdout.
def send_message(encoded_message):
    sys.stdout.write(encoded_message['length'])
    sys.stdout.write(encoded_message['content'])
    sys.stdout.flush()


def startServer():
    send_message(encode_message('in starting server'))
    if os.path.exists(lockFile):
        loggins.warning('Do nothing: lockFile exists in: '.format(lockFile))
        return

    ipfsConfigPath = os.path.join(basedir, "ipfs_repo", "config")
    ipfsBinPath = os.path.join(basedir, "dist", "bin", "ipfs")
    ipfsRepoPath = ipfs_path
    if not os.path.exists(ipfsConfigPath):
        send_message(encode_message('before init ipfs'))
        subprocess.check_call([ipfsBinPath, "init"], env=myenv, stdout=FNULL, stderr=subprocess.STDOUT)
        return startServer()
    else:
        send_message(encode_message('before starting ipfs'))
        ipfsP = subprocess.Popen([ipfsBinPath, "daemon", "--routing=dhtclient"], env=myenv, stdout=FNULL, stderr=subprocess.STDOUT)
        send_message(encode_message('after starting ipfs'))
    send_message(encode_message(' finish ipfs processing'))
    logging.info(' finish ipfs processing')
    ipfsAPI = os.path.join(ipfsRepoPath, "api")
    ipfsLock = os.path.join(ipfsRepoPath, "repo.lock")
    while (not os.path.exists(ipfsAPI) or not os.path.exists(ipfsLock)):
        time.sleep(.01)

    send_message(encode_message(' starting node processing'))
    os.chdir(os.path.join(basedir, "dist", "lib"))
    nodeP = OptractDaemon.OptractDaemon()
    os.chdir(basedir)
    send_message(encode_message('finish starting server'))
    send_message(encode_message(str(nodeP)))
    logging.info(' finish starting server')
    return ipfsP, nodeP


def stopServer(ipfsP, nodeP):
    send_message(encode_message('in stoping server'))
    if os.path.exists(lockFile):
       os.remove(lockFile)
       send_message(encode_message('LockFile removed'))
    nodeP.terminate()
    send_message(encode_message('nodeP killed'))
    # This will not kill the ipfs by itself, but this is needed for the sys.exit() to kill it 
    ipfsP.terminate()
    # os.kill(ipfsP.pid, signal.SIGINT)
    send_message(encode_message('ipfsP killed signal sent'))


# functions related to installation
def add_registry(basedir):
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


def createConfig(basedir, dest_file):
    config = {
        "datadir": basedir,  # while update, replace the "dist/" folder under basedir
        "rpcAddr": "https://rinkeby.infura.io/v3/f50fa6bf08fb4918acea4aadabb6f537",
        "defaultGasPrice": "20000000000",
        "gasOracleAPI": "https://ethgasstation.info/json/ethgasAPI.json",
        "condition": "sanity",
        "networkID": 4,
        "passVault": os.path.join(basedir, "myArchive.bcup"),  # for now, copy into dist/dapps
        "node": {
            "dappdir": os.path.join(basedir, "dist", "dapps"),
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
                "artifactDir": os.path.join(basedir, "dist", "dapps", "OptractMedia", "ABI"),
                "conditionDir": os.path.join(basedir, "dist", "dapps", "OptractMedia", "Conditions"),
                "contracts": [
                    { "ctrName": "BlockRegistry", "conditions": ["Sanity"] },
                    { "ctrName": "MemberShip", "conditions": ["Sanity"] }
                ],
                "database": os.path.join(basedir, "dist", "dapps", "OptractMedia", "DB"),
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
            config['dapps']['OptractMedia']['streamr'] = orig['dapps']['OptractMedia']['streamr']
        except KeyError:
            logging.warning('Cannot load "streamr" from previous config file. Use default: "false".')

        logging.warning('{0} already exists, will move it to {1}'.format(dest_file, dest_file + '.orig'))
        shutil.move(dest_file, dest_file+'.orig')

    # write
    with open(dest_file, 'w') as f:
        json.dump(config, f, indent=4)
        logging.info('config write to file {0}'.format(dest_file))
    return


def extract_node_modules(src, dest):
    # asarBinPath = os.path.join('bin', 'asar')
    # subprocess.check_call([asarBinPath, "extract", "node_modules.asar", "node_modules"], stdout=None, stderr=subprocess.STDOUT)
    dest_node_modules = os.path.join(dest, 'node_modules')
    if os.path.isdir(dest_node_modules):
        shutil.rmtree(dest_node_modules)
    logging.info('extracting latest version of node_modules to ' + dest_node_modules)
    with tarfile.open(src) as tar:
        tar.extractall(dest)
    logging.info('Done extracting latest version of node_modules.')
    return


def prepare_basedir():
    logging.info('Preparing folder for optract in: ' + basedir)

    # generate new empty "dist" directory in basedir
    release_dir = os.path.join(basedir, 'dist')
    release_backup = os.path.join(basedir, 'dist_orig')
    if os.path.isdir(release_dir):
        # keep a backup of previous release
        if os.path.isdir(release_backup):
            shutil.rmtree(release_backup)
        shutil.move(release_dir, release_backup)
    os.mkdir(release_dir)

    # copy files to basedir
    # if sys.platform == 'win32':
    #     nativeApp = os.path.join('nativeApp.exe')
    # else:
    #     nativeApp = os.path.join('nativeApp')
    logging.info('copy {0} to {1}'.format(os.path.join(cwd, 'bin'), os.path.join(release_dir, 'bin')))
    shutil.copytree(os.path.join(cwd, 'bin'), os.path.join(release_dir, 'bin'))
    logging.info('copy {0} to {1}'.format(os.path.join(cwd, 'dapps'), os.path.join(release_dir, 'dapps')))
    shutil.copytree(os.path.join(cwd, 'dapps'), os.path.join(release_dir, 'dapps'))
    logging.info('copy {0} to {1}'.format(os.path.join(cwd, 'lib'), os.path.join(release_dir, 'lib')))
    shutil.copytree(os.path.join(cwd, 'lib'), os.path.join(release_dir, 'lib'))
    logging.info('copy {0} to {1}'.format('nativeApp', release_dir))
    shutil.copytree(os.path.join(cwd, 'nativeApp'), os.path.join(release_dir, 'nativeApp'))
    extract_node_modules(os.path.join(cwd, 'node_modules.tar'), release_dir)

    return


def init_ipfs(ipfs_repo):
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


def check_mainfest(manifest_file):
    with open(manifest_file, 'r') as f:
        manifest_data = f.readlines()
    manifest = ''.join(manifest_data)
    if '{username}' in manifest or '{extension-id}' in manifest:
        raise BaseException('Please fill in username and extension-id in {0} (or update ./resources/optract.json and run install again).'.format(manifest_file))
    return


# major functions
def install():
    logging.info('Initializing Optract...')
    if not (sys.platform.startswith('linux') or sys.platform.startswith('darwin') or sys.platform.startswith('win32')):
        raise BaseException('Unsupported platform')
    if cwd == basedir:
        raise BaseException('Please do not extract file in the destination directory')
    prepare_basedir()  # copy files to there

    config_file = os.path.join(basedir, 'config.json')
    createConfig(basedir, config_file)

    init_ipfs(ipfs_path)

    # add to native message
    if sys.platform.startswith('win32'):
        add_registry(basedir)
        nativeMsgDir = os.path.join(basedir, "dist")
        shutil.copy2(os.path.join(cwd, 'optract-win.json'), nativeMsgDir)
    elif sys.platform.startswith('linux'):
        nativeMsgDir = os.path.expanduser('~/.config/google-chrome/NativeMessagingHosts')
        manifest_file = os.path.join(cwd, 'optract.json')
        check_mainfest(manifest_file)  # only need it while developing
        shutil.copy2(manifest_file, nativeMsgDir)
    elif sys.platform.startswith('darwin'):
        nativeMsgDir = os.path.expanduser('~/Library/Application Support/Google/Chrome/NativeMessagingHosts')
        manifest_file = os.path.join(cwd, 'optract.json')
        check_mainfest(manifest_file)  # only need it while developing
        shutil.copy2(os.path.join(cwd, 'optract.json'), nativeMsgDir)
    else:
        logging.warning('you should not reach here...')

    # done
    logging.info('Done! Optract is ready to use.')

    # add a ".installed" to indicate a succesful installation (not used)
    installed = os.path.join(basedir, 'dist', '.installed')
    open(installed, 'a').close()

    return


def main():
    started = False

    logging.info('Start to listen to native message...')
    while True:
        message = get_message()
        if "ping" in message.values() and started == False:
            started = True
            send_message(encode_message('ping->pong'))
            ipfsP, nodeP = startServer()
            logging.info('server started')
            send_message(encode_message('ping->pong more'))
        #if message:
        #    send_message(encode_message("pong")) 
        if "pong" in message.values() and started == True:
            started = False
            logging.info('closing native app...')
            send_message(encode_message('pong->ping'))
            stopServer(ipfsP, nodeP)
            send_message(encode_message('pong->ping more'))
            send_message(encode_message('close native app which will also shutdown the ipfs'))
            logging.info('native app closed')
            sys.exit(0)
    return


if __name__ == '__main__':
    # startServer()
    if len(sys.argv) > 1:
        if sys.argv[1] == 'install':
            print 'Installing... please see the progress in logfile: ' + logfile
            print 'Please also download Optract browser extension from optract.com or browser extension store or addon page'
            install()
        elif sys.argv[1] == 'test':
            ipfsP, nodeP = startServer()
            print('sleep 20 seconds then stopServer')
            time.sleep(20)
            stopServer(ipfsP, nodeP)
        else:
            main()
    else:
        main()
