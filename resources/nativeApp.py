#!/usr/bin/python -u

# Note that running python with the `-u` flag is required on Windows,
# in order to ensure that stdin and stdout are opened in binary, rather
# than text, mode.
from __future__ import print_function
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
FNULL = open(os.devnull, 'w')  # python2
# FNULL = subprocess.DEVNULL  # python3
if sys.platform.startswith('linux'):
    systray = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0]))), 'systray', 'systray')
elif sys.platform.startswith('darwin'):
    systray = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0]))), 'systray.app', 'Contents', 'MacOS', 'systray')
elif sys.platform.startswith('win32'):
    systray = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0]))), 'systray', 'systray.exe')
else:
    raise BaseException('Unsupported platform')


class NativeApp():
    def __init__(self):
        self.platform = self.get_platform()
        if not (self.platform == 'linux' or self.platform == 'darwin' or self.platform == 'win32'):
            logging.error('Unsupported platform')
            raise BaseException('Unsupported platform')
        # TODO: use the input argument to control basedir
        self.set_basedir()
        self.lockFile = os.path.join(self.basedir, "dist", "Optract.LOCK")
        self.nodeP = None
        self.ipfsP = None

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

    def set_basedir(self):
        # determine path of basedir
        if self.platform.startswith('linux'):
            self.basedir = os.path.expanduser("~/.config/Optract")
        elif self.platform.startswith('darwin'):
            self.basedir = os.path.expanduser("~/.config/Optract")
        elif self.platform.startswith('win32'):
            self.basedir = os.path.expanduser("~\\AppData\\Local\\Optract")
        if not os.path.isdir(self.basedir):
            os.mkdir(self.basedir)
        return

    # Read a message from stdin and decode it.
    def get_message(self):
        raw_length = sys.stdin.read(4)
        if not raw_length:
            sys.exit(0)
        message_length = struct.unpack('=I', raw_length)[0]  # python2
        # message_length = struct.unpack('=I', bytes(raw_length, encoding="utf-8"))[0]  # python3
        message = sys.stdin.read(message_length)
        return json.loads(message)

    # Encode a message for transmission, given its content.
    # note: encode_message() and send_message() are not used now, but keep them just in case
    def encode_message(self, message_content):
        encoded_content = json.dumps(message_content)
        encoded_length = struct.pack('=I', len(encoded_content))  # python2
        # encoded_length = struct.pack('=I', len(encoded_content)).decode()  # python3
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
            logging.error('The target {0} is neither file nor directory.'.format(target))
            raise BaseException('The target {0} is neither file nor directory.'.format(target))
        if md5_seen != md5_expected:
            logging.error('The md5sum of file or directory {0} is inconsistent with expected hash.'.format(target))
            raise BaseException('The md5sum of file or directory {0} is inconsistent with expected hash.'.format(target))

    def check_md5(self):
        # TODO: prepare function to generate these checksum for developer
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
            nodeCMD = os.path.join(self.basedir, 'dist', 'bin', 'node.exe')
            ipfsCMD = os.path.join(self.basedir, 'dist', 'bin', 'ipfs.exe')
        else:
            nodeCMD = os.path.join(self.basedir, 'dist', 'bin', 'node')
            ipfsCMD = os.path.join(self.basedir, 'dist', 'bin', 'ipfs')
        self._compare_md5(nodeCMD, node_md5_expected)
        self._compare_md5(ipfsCMD, ipfs_md5_expected)

        # note: problem in pyinstaller while use the 'checksumdir' module. Comment here, _compare_md5 before figure it out
        # node_modules_dir = os.path.join(self.basedir, 'dist', 'node_modules')
        # self._compare_md5(node_modules_dir, node_modules_md5_expected)

    def startServer(self, can_exit=False):
        if not self.platform == 'win32':  # in windows, nativeApp cannot close properly so lockFile is always there
            if os.path.exists(self.lockFile):
                if can_exit:
                    logging.error('Do nothing: lockFile exists in: {0}'.format(self.lockFile))
                    sys.exit(0)
                else:
                    logging.warning('Do nothing: lockFile exists in: {0}'.format(self.lockFile))
                    return

        self.check_md5()

        ipfs_path = {
            'repo': os.path.join(self.basedir, 'ipfs_repo'),
            'config': os.path.join(self.basedir, 'ipfs_repo', 'config'),
            'api': os.path.join(self.basedir, 'ipfs_repo', 'api'),
            'lock': os.path.join(self.basedir, 'ipfs_repo', 'repo.lock'),
            'bin': os.path.join(self.basedir, 'dist', 'bin', 'ipfs')
        }
        # logging.info('debug: basedir={0}'.format(self.basedir))
        myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
        myenv['IPFS_PATH'] = ipfs_path['repo']
        if not os.path.exists(ipfs_path['config']):
            subprocess.check_call([ipfs_path['bin'], "init"], env=myenv, stdout=FNULL, stderr=subprocess.STDOUT)
            return self.startServer()
        else:
            if os.path.exists(ipfs_path['api']):
                os.remove(ipfs_path['api'])
            if os.path.exists(ipfs_path['lock']):
                os.remove(ipfs_path['lock'])
            self.ipfsP = subprocess.Popen([ipfs_path['bin'], "daemon", "--routing=dhtclient"], env=myenv, stdin=FNULL,
                                          stdout=FNULL, stderr=subprocess.STDOUT)

        while (not os.path.exists(ipfs_path['api']) or not os.path.exists(ipfs_path['lock'])):
            time.sleep(.01)

        nodeCMD = os.path.join(self.basedir, 'dist', 'bin', 'node')
        os.chdir(os.path.join(self.basedir, "dist", "lib"))  # there are relative path in js stdin
        # f = open(os.path.join(basedir, 'nodep.log'), 'w')  # for debug, uncomment this 2 lines and comment the second nodeP
        # nodeP = subprocess.Popen([nodeCMD], stdin=subprocess.PIPE, stdout=f, stderr=f)  # leave log to "f"
        self.nodeP = subprocess.Popen([nodeCMD], stdin=subprocess.PIPE, stdout=FNULL, stderr=subprocess.STDOUT)
        op_daemon = threading.Thread(target=OptractDaemon.OptractDaemon, args=(self.nodeP, self.basedir))
        op_daemon.daemon = True
        op_daemon.start()
        os.chdir(self.basedir)
        logging.info(' daemon started')
        logging.info('  pid of node: {0}'.format(self.nodeP.pid))
        logging.info('  pid of ipfs: {0}'.format(self.ipfsP.pid))
        return

    def stopServer(self):
        if os.path.exists(self.lockFile):
           os.remove(self.lockFile)
        # nodeP.terminate()
        if self.nodeP is not None:
            logging.info('kill process {0}'.format(self.nodeP.pid))
            try:
                os.kill(self.nodeP.pid, signal.SIGTERM)
            except Exception as err:
                logging.error("Can't stop pid {0}: {1}: {2}".format(
                               self.nodeP.pid, err.__class__.__name__, err))
                pass
        # This will not kill the ipfs by itself, but this is needed for the sys.exit() to kill it 
        if self.ipfsP is not None:
            logging.info('kill process {0}'.format(self.ipfsP.pid))
            try:
                os.kill(self.ipfsP.pid, signal.SIGINT)
            except Exception as err:
                logging.error("Can't stop pid {0}: {1}: {2}".format(
                               self.ipfsP.pid, err.__class__.__name__, err))
                pass
            # send one more SIGINT to make sure (redundant?)
            time.sleep(0.5)
            try:
                os.kill(self.ipfsP.pid, signal.SIGINT)
            except:
                pass
        return


# major functions
def main(nativeApp):
    started = False
    logging.info('Start to listen to native message...')
    while True:
        message = nativeApp.get_message()
        if "ping" in message.values() and started == False:
            started = True
            # the "Popen" below will fail if there's a systray running due to the lock file of daemon.js
            # TODO: (bug) can generate two systray if the first systray call "stop" and then start or restart browser
            # add a lockfile for systray?
            systrayP = subprocess.Popen([systray, ppid], shell=True, stdin=FNULL, stdout=FNULL, stderr=FNULL)  # the "shell=True" is essential for windows
            logging.info('sysatry (pid:{0}) and server starting...'.format(systrayP.pid))
    return


# def mainwin():
#     nativeApp = NativeApp()
#     started = False
#     logging.info('Start to listen to native message...')
#     while True:
#         message = nativeApp.get_message()
#         if "ping" in message.values() and started == False:
#             started = True
#             nativeApp.startServer()
#             logging.info('server started')
#         if "pong" in message.values() and started == True:
#             started = False
#             logging.info('closing native app...')
#             nativeApp.stopServer()
#             logging.info('native app closed')
#             sys.exit(0)
#     return


# def launcher():
#     nativeApp = NativeApp()
#     logging.info('in launcher...')
#     started = False
#     while True:
#         if started == False:
#             started = True
#             nativeApp.startServer()
#             logging.info('in launcher...starting server')
#         time.sleep(3)
#         pl = subprocess.Popen(['pgrep', '-lf', 'firefox'], stdout=subprocess.PIPE).communicate()[0]
#         pl = pl.split("\n")[0:-1]
#         if (len(pl) == 0):
#             nativeApp.stopServer()
#             sys.exit(0)
#     return


# def starter():
#     nativeApp = NativeApp()
#     logging.info('in starter...')
#     started = False
#     while True:
#         message = nativeApp.get_message()
#         if "ping" in message.values() and started == False:
#             logging.info('[starter]got ping signal')
#             started = True
#             time.sleep(1)
#             nativeApp = os.path.realpath(sys.argv[0])
#             logging.info('[starter]calling: {0} launch'.format(nativeApp))
#             subprocess.Popen([nativeApp, "launch"])

#             sys.exit(0)
#     return


if __name__ == '__main__':
    nativeApp = NativeApp()  # borrow a couple attributes 
    basedir = nativeApp.basedir

    # logging
    log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
    log_datefmt = '%Y-%m-%d %H:%M:%S'
    logfile = os.path.join(basedir, 'optract.log')
    # replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
    logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                        datefmt=log_datefmt)

    logging.info('nativeApp path = {0}'.format(os.path.realpath(sys.argv[0])))
    print('nativeApp path = {0}'.format(os.path.realpath(sys.argv[0])))

    try:
        ppid = '{0}'.format(os.getppid())  # pid of browser; getppid() only work on unix
    except:
        ppid = '-'
    if len(sys.argv) > 1:
        if sys.argv[1] == 'install':
            print('Installing... please see the progress in logfile: ' + logfile)
            print('Please also download Optract browser extension.')
            OptractInstall.main(basedir)
        elif sys.argv[1] == 'test':
            nativeApp.startServer()
            raw_input("press <enter> to stop...")
            nativeApp.stopServer()
        elif sys.argv[1] == 'testtray':
            systrapP = subprocess.Popen([systray, ppid])
        else:
            main(nativeApp)
    else:
        main(nativeApp)

        # elif sys.argv[1] == 'launch':
        #     if platform == 'win32':
        #         raise BaseException("windows version does not support 'launch' argument")
        #     launcher()
        # else:
        #     if platform == 'win32':
        #         mainwin()
        #     else:
        #         logging.info('calling starter() 1')
        #         starter()
    # else:
        # if platform == 'win32':
        #     mainwin()
        # else:
        #     logging.info('calling starter() 2')
        #     starter()
