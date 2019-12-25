#!/usr/bin/python -u
# -*- coding:utf-8 -*-

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
import threading
import hashlib
import psutil
# from checksumdir import dirhash
import OptractInstall
import OptractDaemon

# On Windows, the default I/O mode is O_TEXT. Set this to O_BINARY
# to avoid unwanted modifications of the input/output streams.
if sys.platform == "win32":
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# global variables
log = logging.getLogger(__name__)
# FNULL = open(os.devnull, 'w')  # python2
FNULL = subprocess.DEVNULL  # python3

# basedir: root directory of Optract, for example: ~/Downloads/Optract
# distdir: release directory, contain binaries and modules; replace this one while update, for example: ~/Downloads/Optract/dist
# datadir: ipfs, config, and keys are here (for now same as `basedir`) (change it to `~/.config/Optract`?)
distdir = os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))
if sys.platform.startswith('linux'):
    systray = os.path.join(distdir, 'systray', 'systray')
elif sys.platform.startswith('darwin'):
    systray = os.path.join(distdir, 'systray.app', 'Contents', 'MacOS', 'systray')
elif sys.platform.startswith('win32'):
    # systray = os.path.join(distdir, 'systray', 'systray.exe')  # if pyarmor pack without "-F"
    systray = os.path.join(distdir, 'systray.exe')
else:
    raise BaseException('Unsupported platform')


class NativeApp():
    def __init__(self, distdir):
        self.platform = self.get_platform()
        if not (self.platform == 'linux' or self.platform == 'darwin' or self.platform == 'win32'):
            log.error('Unsupported platform')
            raise BaseException('Unsupported platform')

        # if extract file in ~/Downloads, then basedir and datadir are both: ~/Downloads/Optract,
        # and distdir is: ~/Downloads/Optract/dist
        # and nativeApp (this one) in: ~/Downloads/Optract/dist/nativeApp/nativeApp
        self.distdir = distdir
        self.basedir = os.path.dirname(distdir)
        self.datadir = os.path.dirname(distdir)  # for now, put data in basedir
        self.lockFile = os.path.join(self.distdir, 'Optract.LOCK')
        self.ipfs_lockFile = os.path.join(self.datadir, 'ipfs_repo', 'repo.lock')
        self.install_lockFile = os.path.join(self.distdir, '.installed')
        self.nodeP = None
        self.ipfsP = None
        self.installer = OptractInstall.OptractInstall(self.basedir, self.distdir, self.datadir)

        self.message = '[na]Welcome to Optract!'
        log.info('nativeApp path: {0}'.format(distdir))

        self.check_md5 = True

    def no_check_md5(self):
        self.check_md5 = False

    def get_platform(self):
        if sys.platform.startswith('linux'):
            platform = 'linux'
        elif sys.platform.startswith('darwin'):
            platform = 'darwin'
        elif sys.platform.startswith('win32'):
            platform = 'win32'
        else:
            return sys.platform
        return platform

    def install(self, forced=False):
        self.message = '[na]Installing'
        if forced:
            self.installer.install(check_md5=self.check_md5)
        else:
            if not os.path.exists(self.install_lockFile):
                self.installer.install(check_md5=self.check_md5)
            else:
                self.message = '[na]Lockfile exists ({0})'.format(self.install_lockFile)

    # Read a message from stdin and decode it.
    def get_message(self):
        raw_length = sys.stdin.read(4)
        if not raw_length:
            sys.exit(0)
        # message_length = struct.unpack('=I', raw_length)[0]  # python2
        message_length = struct.unpack('=I', bytes(raw_length, encoding="utf-8"))[0]  # python3
        message = sys.stdin.read(message_length)
        return json.loads(message)

    # Encode a message for transmission, given its content.
    # note: encode_message() and send_message() are not used now, but keep them just in case
    def encode_message(self, message_content):
        encoded_content = json.dumps(message_content)
        # encoded_length = struct.pack('=I', len(encoded_content))  # python2
        encoded_length = struct.pack('=I', len(encoded_content)).decode()  # python3
        return {'length': encoded_length, 'content': encoded_content}

    def send_message(self, encode_message):
        # ex: send_message(encode_message('ping->pong'))
        sys.stdout.write(self.encode_message('length'))
        sys.stdout.write(self.encode_message('content'))
        sys.stdout.flush()
        return

    def _compare_md5(self, target, md5_expected):
        if os.path.isfile(target):
            md5_seen = hashlib.md5(open(target, 'rb').read()).hexdigest()
        # elif os.path.isdir(target):
        #     md5_seen = dirhash(target, 'md5')
        else:
            log.error('The target {0} is neither file nor directory.'.format(target))
            raise BaseException('The target {0} is neither file nor directory.'.format(target))
        if md5_seen != md5_expected:
            log.error('The md5sum of file or directory {0} is inconsistent with expected hash.'.format(target))
            raise BaseException('The md5sum of file or directory {0} is inconsistent with expected hash.'.format(target))

    def run_check_md5(self):
        # TODO: prepare function to generate these checksum for developer
        # note: there's another run_check_md5() in OptractInstall
        if sys.platform.startswith('win32'):
            node_md5_expected = 'f293ba8c28494ecd38416aa37443aa0d'
            ipfs_md5_expected = 'bbed13baf0da782311a97077d8990f27'
            node_modules_dir_md5_expected = '11f0140775c0939218afa7790a39cbb5'
        elif sys.platform.startswith('linux'):
            node_md5_expected = '8a9aa6414470a6c9586689a196ff21e3'
            ipfs_md5_expected = 'ee571b0fcad98688ecdbf8bdf8d353a5'
            node_modules_dir_md5_expected = '11f0140775c0939218afa7790a39cbb5'
        elif sys.platform.startswith('darwin'):
            node_md5_expected = 'b4ba1b40b227378a159212911fc16024'
            ipfs_md5_expected = '5e8321327691d6db14f97392e749223c'
            node_modules_dir_md5_expected = '8a2aae4ca15614c9eef5949bdf78b495'

        if sys.platform.startswith('win32'):
            nodeCMD = os.path.join(self.distdir, 'bin', 'node.exe')
            ipfsCMD = os.path.join(self.distdir, 'bin', 'ipfs.exe')
        else:
            nodeCMD = os.path.join(self.distdir, 'bin', 'node')
            ipfsCMD = os.path.join(self.distdir, 'bin', 'ipfs')
        self._compare_md5(nodeCMD, node_md5_expected)
        self._compare_md5(ipfsCMD, ipfs_md5_expected)

        # note: problem in pyinstaller while use the 'checksumdir' module. Comment here, _compare_md5 before figure it out
        # node_modules_dir = os.path.join(self.basedir, 'dist', 'node_modules')
        # self._compare_md5(node_modules_dir, node_modules_md5_expected)

    def start_ipfs(self):
        ipfs_path = {
            'repo': os.path.join(self.datadir, 'ipfs_repo'),
            'config': os.path.join(self.datadir, 'ipfs_repo', 'config'),
            'api': os.path.join(self.datadir, 'ipfs_repo', 'api'),
            'lock': os.path.join(self.datadir, 'ipfs_repo', 'repo.lock'),
            'bin': os.path.join(self.distdir, 'bin', 'ipfs')
        }
        # log.info('debug: basedir={0}'.format(self.basedir))
        myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
        myenv['IPFS_PATH'] = ipfs_path['repo']
        if not os.path.exists(ipfs_path['config']):
            self.message = '[na] creating a new ipfs repo in {0}'.format(ipfs_path['repo'])
            subprocess.check_call([ipfs_path['bin'], "init"], env=myenv, stdout=FNULL, stderr=subprocess.STDOUT)
            return self.startServer(no_check_md5=True)  # is it safe to check_md5=False? if true then need to check frequently while starting
        else:
            try:
                status = psutil.Process(self.ipfsP.pid).status()
                is_running = psutil.Process(self.ipfsP.pid).is_running()  # careful: return true if status == "zombie"
            except (AttributeError, psutil.NoSuchProcess):  # "self.ipfsP" does not have "pid"
                status = None
                is_running = None
            if status is None or is_running is None or status == psutil.STATUS_ZOMBIE:  # prevent kill a ipfs daemon which is still running
                if os.path.exists(ipfs_path['api']):
                    os.remove(ipfs_path['api'])
                if os.path.exists(ipfs_path['lock']):
                    os.remove(ipfs_path['lock'])
                # self.ipfsP_old = self.ipfsP
                self.ipfsP = subprocess.Popen([ipfs_path['bin'], "daemon", "--routing=dhtclient"], env=myenv, stdout=FNULL,
                                              stderr=subprocess.STDOUT)
        return ipfs_path

    def start_node(self):
        nodeCMD = os.path.join(self.distdir, 'bin', 'node')
        os.chdir(os.path.join(self.distdir, 'lib'))  # there are relative path in js stdin
        # f = open(os.path.join(basedir, 'nodep.log'), 'w')  # for debug, uncomment this 2 lines and comment the second nodeP
        # nodeP = subprocess.Popen([nodeCMD], stdin=subprocess.PIPE, stdout=f, stderr=f)  # leave log to "f"
        self.nodeP = subprocess.Popen([nodeCMD], stdin=subprocess.PIPE, stdout=FNULL, stderr=subprocess.STDOUT)
        op_daemon = threading.Thread(target=OptractDaemon.OptractDaemon, args=(self.nodeP, self.basedir))
        op_daemon.daemon = True
        op_daemon.start()
        os.chdir(self.basedir)

    def pgrep_services(self):
        ''' return dictionary {'ipfs':pid, 'node': pid} where pip is None or int '''
        result = {'ipfs': None, 'node': None}  # or make it an attribute of this class?
        for p in psutil.process_iter(attrs=['pid', 'name', 'cmdline']):
            if p.info['name'] == 'ipfs':
                if result['ipfs'] is not None:
                    log.warning('There are multiple instances of ipfs running')  # or error?
                if p.info['cmdline'] is not None:
                    if len(p.info['cmdline']) >= 2:
                        if p.info['cmdline'][0] == os.path.join(self.distdir, 'bin', 'ipfs') and p.info['cmdline'][1] == 'daemon':
                            result['ipfs'] = p.info
            elif p.info['name'] == 'node':
                if result['node'] is not None:
                    log.warning('There are multiple instances of Optract running')  # or error?
                if p.info['cmdline'] is not None:
                    if p.info['cmdline'][0] == os.path.join(self.distdir, 'bin', 'node'):
                    # full path to node here; while debugging usually use relative path like ./bin/node so should be safe
                        result['node'] = p.info
            # TODO: deal with existing multiple instances of ipfs and node
            if result['ipfs'] is not None and result['node'] is not None:
                break
        return result

    def pgrep_services_msg(self):
        msg = ''
        processes = self.pgrep_services()
        if processes['ipfs'] is not None:
            msg += 'Another instance of ipfs is running with pid {0}:\n\n{1}\n'.format(
                processes['ipfs']['pid'], ' '.join(processes['ipfs']['cmdline']))
        if processes['node'] is not None:
            msg += '\nAnother instance of Optract is running with pid {0}:\n{1}\n'.format(
                processes['node']['pid'], ' '.join(processes['node']['cmdline']))
        if msg != '':
            msg += '\nTo run Optract-gui, please kill/stop existing process(es) and close browser.\n'
        return msg.lstrip()

    def startServer(self, can_exit=True, no_check_md5=False, check_existing_process=True):
        ''' note: in GUI, use pgrep_services_msg() to check existing services and exit if necessary
        note: set 'no_check_md5' to True to ignore the value of self.check_md5
        '''
        if check_existing_process:
            msg = self.pgrep_services_msg()
            if msg != '' and can_exit:
                log.warning(msg)
                sys.exit(0)
        if not self.platform == 'win32':  # in windows, nativeApp cannot close properly so lockFile is always there
            if os.path.exists(self.lockFile):
                if can_exit:
                    log.warning('Do nothing: lockFile exists in: {0}'.format(self.lockFile))
                    sys.exit(0)
                else:
                    log.warning('Do nothing: lockFile exists in: {0}'.format(self.lockFile))
                    return

        if no_check_md5:
            pass
        else:
            if self.check_md5:  # in start_ipfs(), chach_md5 should be False to prevent un-necessary(?) checks
                self.run_check_md5()

        ipfs_path = self.start_ipfs()
        while (not os.path.exists(ipfs_path['api']) or not os.path.exists(ipfs_path['lock'])):
            time.sleep(.2)

        self.start_node()
        log.info(' daemon started')
        log.info('  pid of node: {0}'.format(self.nodeP.pid))
        log.info('  pid of ipfs: {0}'.format(self.ipfsP.pid))

    def stopServer(self):
        if os.path.exists(self.lockFile):
            os.remove(self.lockFile)
        # nodeP.terminate()
        if self.nodeP is not None:
            log.info('kill process {0}'.format(self.nodeP.pid))
            try:
                os.kill(self.nodeP.pid, signal.SIGTERM)
            except OSError as err:
                log.error("Error while stop pid {0}: {1}: {2}".format(
                               self.nodeP.pid, err.__class__.__name__, err))

        if self.ipfsP is not None:
            log.info('kill process {0}'.format(self.ipfsP.pid))
            try:
                os.kill(self.ipfsP.pid, signal.SIGINT)
            except OSError as err:
                log.error("Can't stop pid {0}: {1}: {2}".format(
                               self.ipfsP.pid, err.__class__.__name__, err))

            # send one more signal (redundant?)
            time.sleep(0.8)
            try:
                os.kill(self.ipfsP.pid, signal.SIGINT)
            except Exception:
                pass


# major functions
def main(nativeApp):
    started = False
    log.info('Start to listen to native message...')
    while True:
        message = nativeApp.get_message()
        if message['text'] == 'ping' and started is False:
            started = True
            processes = nativeApp.pgrep_services()
            log.info('got "ping"')
            if processes['node'] is None and processes['ipfs'] is None:
                if nativeApp.check_md5:
                    cmdline = [systray,]
                else:
                    cmdline = [systray, 'nochecksum']
                systrayP = subprocess.Popen(cmdline, shell=True, stdin=FNULL, stdout=FNULL, stderr=FNULL)  # the "shell=True" is essential for windows
                log.info('systray (pid:{0}) and server starting...'.format(systrayP.pid))
            elif processes['node'] is not None and processes['ipfs'] is not None:
                log.info('Servers are running. Do nothing.')
            else:  # one pid exists and the other does not
                # TODO: popup a warning?
                if processes['node'] is None:
                    log.warning('ipfs is running but node is not running')
                elif processes['ipfs'] is None:
                    log.warning('node is running but ipfs is not running')
    return


if __name__ == '__main__':
    # Note: if distdir in "~/Downloads/Optract/dist" then nativeApp (this one) in:
    #       "~/Downloads/Optract/dist/nativeApp/nativeApp" (same for mac,linux,win)
    distdir = os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))
    nativeApp = NativeApp(distdir)
    basedir = nativeApp.basedir

    # log
    log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
    log_datefmt = '%Y-%m-%d %H:%M:%S'
    logfile = os.path.join(basedir, 'optract.log')
    # replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
    logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                        datefmt=log_datefmt)

    log.info('nativeApp path = {0}'.format(os.path.realpath(sys.argv[0])))
    log.info('basedir path = {0}'.format(basedir))

    # if call nativeApp from browser (chrome and firefox), they add extension id as argument
    # TODO: use argparse
    if len(sys.argv) > 1:
        check_md5 = True
        if len(sys.argv) > 2:
            if sys.argv[2] == 'False' or sys.argv[2] == 'false':
                check_md5 = False
                nativeApp.no_check_md5()
        print('DEBUG: check_md5 = {0}'.format(check_md5))
        if sys.argv[1] == 'install':
            nativeApp.install()
        elif sys.argv[1] == 'test':
            nativeApp.startServer()
            input("press <enter> to stop...")  # python3: input(); python2: raw_input()
            nativeApp.stopServer()
        elif sys.argv[1] == 'testtray':
            if check_md5:
                systrapP = subprocess.Popen([systray,])
            else:
                systrapP = subprocess.Popen([systray, 'nochecksum'])
        else:
            main(nativeApp)
    else:
        main(nativeApp)
