#!/usr/bin/env python
from __future__ import print_function
import os
import sys
import shutil
import tarfile
import json
import subprocess
import hashlib
import logging
log = logging.getLogger(__name__)

# global variables
# 'cwd' is for installtion, it may look like ~/Downloads/optract_release
cwd = os.path.dirname(os.path.realpath(sys.argv[0]))  # os.getcwd() may not correct if click it from File manager(?)
cwd = os.path.dirname(cwd)  # after pack by pyarmor/pyinstaller, it's one folder deeper, and here we need the parent one


def mkdir(dirname):  # if parent dir exists and dirname does not exist
    if os.path.isdir(os.path.dirname(dirname)) and not os.path.isdir(dirname):
        os.mkdir(dirname)
    return


class OptractInstall():
    def __init__(self, basedir):
        self.basedir = basedir
        return

    def add_registry_chrome(self):
        # TODO: add remove_registry()
        if sys.platform == 'win32':
            keyVal = r'Software\Google\Chrome\NativeMessagingHosts\optract'
            try:
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, keyVal, 0, winreg.KEY_ALL_ACCESS)
            except:
                key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, keyVal)
            nativeMessagingMainfest = os.path.join(self.basedir, 'dist', 'optract-win-chrome.json')
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, nativeMessagingMainfest)
            winreg.CloseKey(key)

            # create optract-win-chrome.json
            with open(nativeMessagingMainfest, 'w') as f:
                manifest_content = self.create_manifest_chrome('nativeApp\\nativeApp.exe')
                json.dump(manifest_content, f, indent=4)
        return

    def add_registry_firefox(self):
        # TODO: add remove_registry()
        if sys.platform == 'win32':
            keyVal = r'SOFTWARE\Mozilla\NativeMessagingHosts\optract'
            try:
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, keyVal, 0, winreg.KEY_ALL_ACCESS)
            except:
                key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, keyVal)
            nativeMessagingMainfest = os.path.join(self.basedir, 'dist', 'optract-win-firefox.json')
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, nativeMessagingMainfest)
            winreg.CloseKey(key)

            # create optract-win-firefox.json
            with open(nativeMessagingMainfest, 'w') as f:
                manifest_content = self.create_manifest_firefox('nativeApp\\nativeApp.exe')
                json.dump(manifest_content, f, indent=4)
        return

    def init_ipfs(self):
        ipfs_path = os.path.join(self.basedir, 'ipfs_repo')
        ipfs_config = os.path.join(ipfs_path, 'config')

        if os.path.exists(ipfs_config):
            logging.warning("ipfs repo exists, will use existing one in " + ipfs_path)
            return

        # create ipfs_repo
        myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
        myenv['IPFS_PATH'] = ipfs_path
        ipfs_bin = os.path.join(self.basedir, "dist", "bin", "ipfs")

        logging.info("initilalizing ipfs in " + ipfs_path)
        process = subprocess.Popen([ipfs_bin, "init"], env=myenv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, error = process.communicate()
        logging.info('ipfs results: \n' + str(output))
        if len(error) > 0:
            logging.critical('ipfs error message: \n' + str(error))
        return

    def create_manifest_chrome(self, nativeAppPath, extension_id):
        # extension_id = "jlanclpnebjipbolljoenepmcofibpmk"
        manifest_json = {
          "name": "optract",
          "description": "optract server",
          "path": nativeAppPath,
          "type": "stdio",
          "allowed_origins": [ "chrome-extension://{0}/".format(extension_id) ]
        }
        return manifest_json

    def create_manifest_firefox(self, nativeAppPath, extension_id):
        # extension_id = "{5b2b58c5-1a22-4893-ac58-9ca33f27cdd4}"
        manifest_json= {
          "name": "optract",
          "description": "optract server",
          "path": nativeAppPath,
          "type": "stdio",
          "allowed_extensions": [ extension_id ]
        }
        return manifest_json

    def create_and_write_manifest(self, browser):
        if browser not in ['firefox', 'chrome']:
            raise BaseException('Unsupported browser {0}'.format(browser))

        # create manifest file and write to native message folder
        if sys.platform.startswith('win32'):
            if browser == 'chrome':
                self.add_registry_chrome(self.basedir)
            elif browser == 'firefox':
                self.add_registry_firefox(self.basedir)
        else:  # unix-like
            # determine native message directory for different OS and browsers
            # TODO: make sure user already has at least one browser installed
            if sys.platform.startswith('linux') and browser == 'chrome':
                nativeMsgDir = os.path.expanduser('~/.config/google-chrome/NativeMessagingHosts')
            elif sys.platform.startswith('linux') and browser == 'firefox':
                nativeMsgDir = os.path.expanduser('~/.mozilla/native-messaging-hosts')
            elif sys.platform.startswith('darwin') and browser == 'chrome':
                nativeMsgDir = os.path.expanduser('~/Library/Application Support/Google/Chrome/NativeMessagingHosts')
            elif sys.platform.startswith('darwin') and browser == 'firefox':
                nativeMsgDir = os.path.expanduser('~/Library/Application Support/Mozilla/NativeMessagingHosts')
            else:
                logging.warning('you should not reach here...')
                raise BaseException('Unsupported platform')
            mkdir(nativeMsgDir)
            nativeAppPath = os.path.join(self.basedir, 'dist', 'nativeApp', 'nativeApp')

            # create content for manifest file of native messaging
            extid_file = os.path.join(cwd, 'extension_id.json')  # or write fix values here?
            with open(extid_file, 'r') as f:
                extid = json.load(f)
            if browser == 'chrome':
                manifest_content = self.create_manifest_chrome(nativeAppPath, extid['chrome'])
            elif browser == 'firefox':
                manifest_content = self.create_manifest_firefox(nativeAppPath, extid['firefox'])

            # write manifest file
            manifest_path = os.path.join(nativeMsgDir, 'optract.json')
            with open(manifest_path, 'w') as f:
                json.dump(manifest_content, f, indent=4)
        return

    def _compare_md5(self, filename, md5_expected):
        md5_seen = hashlib.md5(open(filename, 'rb').read()).hexdigest()
        if md5_seen != md5_expected:
            raise BaseException('The md5sum of file {0} is inconsistent with expected hash.'.format(filename))

    def check_md5(self):
        if sys.platform.startswith('win32'):
            node_md5_expected = 'f293ba8c28494ecd38416aa37443aa0d'
            ipfs_md5_expected = 'bbed13baf0da782311a97077d8990f27'
            node_modules_tar_md5_expected = 'f177837cd1f3b419279b52a07ead78ce'
        elif sys.platform.startswith('linux'):
            node_md5_expected = '8a9aa6414470a6c9586689a196ff21e3'
            ipfs_md5_expected = 'ee571b0fcad98688ecdbf8bdf8d353a5'
            node_modules_tar_md5_expected = '745372d74f1be243764268ac84b4ab8d'
        elif sys.platform.startswith('darwin'):
            node_md5_expected = 'b4ba1b40b227378a159212911fc16024'
            ipfs_md5_expected = '5e8321327691d6db14f97392e749223c'
            node_modules_tar_md5_expected = '6f997ad2bac5f0fa3db05937554c9223'

        nodeCMD = os.path.join(cwd, 'bin', 'node')
        ipfsCMD = os.path.join(cwd, 'bin', 'ipfs')
        node_modules_tar = os.path.join(cwd, 'node_modules.tar')
        self._compare_md5(nodeCMD, node_md5_expected)
        self._compare_md5(ipfsCMD, ipfs_md5_expected)
        self._compare_md5(node_modules_tar, node_modules_tar_md5_expected)
        return

    def prepare_basedir(self):
        logging.info('Preparing folder for optract in: ' + self.basedir)

        # generate new empty "dist" directory in basedir
        release_dir = os.path.join(self.basedir, 'dist')
        release_backup = os.path.join(self.basedir, 'dist_orig')
        if os.path.isdir(release_dir):
            # keep a backup of previous release
            if os.path.isdir(release_backup):
                shutil.rmtree(release_backup)
            shutil.move(release_dir, release_backup)
        os.mkdir(release_dir)

        # check md5sum
        self.check_md5()

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
        if sys.platform.startswith('darwin'):
            systray = 'systray.app'
        else:
            systray = 'systray'
        logging.info('copy {0} to {1}'.format(systray, release_dir))
        shutil.copytree(os.path.join(cwd, systray), os.path.join(release_dir, systray))
        logging.info('copy {0} to {1}'.format('icon.png', release_dir))
        shutil.copy2(os.path.join(cwd, 'icon.png'), release_dir)
        logging.info('copy {0} to {1}'.format('nativeApp', release_dir))
        shutil.copytree(os.path.join(cwd, 'nativeApp'), os.path.join(release_dir, 'nativeApp'))
        self.extract_node_modules(os.path.join(cwd, 'node_modules.tar'), release_dir)

        logging.info('creating keystore folder if necessary')
        key_folder = os.path.join(self.basedir, 'keystore')
        mkdir(key_folder)
        return

    def create_config(self):
        config = {
            "datadir": self.basedir,  # while update, replace the "dist/" folder under basedir
            "rpcAddr": "https://rinkeby.infura.io/v3/f50fa6bf08fb4918acea4aadabb6f537",
            "defaultGasPrice": "20000000000",
            "gasOracleAPI": "https://ethgasstation.info/json/ethgasAPI.json",
            "condition": "sanity",
            "networkID": 4,
            "passVault": os.path.join(self.basedir, "myArchive.bcup"),
            "node": {
                "dappdir": os.path.join(self.basedir, "dist", "dapps"),
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
                    "artifactDir": os.path.join(self.basedir, "dist", "dapps", "OptractMedia", "ABI"),
                    "conditionDir": os.path.join(self.basedir, "dist", "dapps", "OptractMedia", "Conditions"),
                    "contracts": [
                        { "ctrName": "BlockRegistry", "conditions": ["Sanity"] },
                        { "ctrName": "MemberShip", "conditions": ["Sanity"] }
                    ],
                    "database": os.path.join(self.basedir, "dist", "dapps", "OptractMedia", "DB"),
                    "version": "1.0",
                    "streamr": "false"
                }
            }
        }

        # if previous setting exists, migrate a few settings and make a backup
        config_file = os.path.join(self.basedir, 'config.json')
        if os.path.isfile(config_file):
            # load previous config
            with open(config_file, 'r') as f:
                orig = json.load(f)

            try:
                config['dapps']['OptractMedia']['streamr'] = orig['dapps']['OptractMedia']['streamr']
            except KeyError:
                logging.warning('Cannot load "streamr" from previous config file. Use default: "false".')

            logging.warning('{0} already exists, will move it to {1}'.format(config_file, config_file + '.orig'))
            shutil.move(config_file, config_file+'.orig')

        # write
        with open(config_file, 'w') as f:
            json.dump(config, f, indent=4)
            logging.info('config write to file {0}'.format(config_file))
        return

    def extract_node_modules(self, src, dest):
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


def main(basedir):
    logging.info('Initializing Optract...')
    if not (sys.platform.startswith('linux') or sys.platform.startswith('darwin') or sys.platform.startswith('win32')):
        raise BaseException('Unsupported platform')
    if cwd == basedir:
        raise BaseException('Please do not extract file in the destination directory')

    install = OptractInstall(basedir)
    install.prepare_basedir()  # copy files to basedir
    install.create_config()
    install.init_ipfs()
    # install for all supporting browsers (for now assume firefox is must)
    install.create_and_write_manifest("firefox")
    try:
        install.create_and_write_manifest("chrome")
    except:
        pass

    # done
    logging.info('Done! Optract is ready to use.')

    # add a ".installed" to indicate a succesful installation (not used)
    installed = os.path.join(basedir, 'dist', '.installed')
    open(installed, 'a').close()

    return


if __name__ == '__main__':
    print("please do not run this script directly")
