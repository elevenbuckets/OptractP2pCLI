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
# import shutil
import threading
# import ctypes
import OptractInstall
import OptractDaemon

# On Windows, the default I/O mode is O_TEXT. Set this to O_BINARY
# to avoid unwanted modifications of the input/output streams.
if sys.platform == "win32":
    import winreg
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# global variables
# 'cwd' is for installtion, it may look like ~/Downloads/optract_release
# cwd = os.path.dirname(os.path.realpath(sys.argv[0]))  # os.getcwd() may not correct if click it from File manager(?)
# cwd = os.path.dirname(cwd)  # after pack by pyarmor, it's one folder deeper, and here we need the parent one

FNULL = open(os.devnull, 'w')


class NativeApp():
    def __init__(self):
        self.platform = self.get_platform()
        if not (self.platform == 'linux' or self.platform == 'darwin' or self.platform == 'win32'):
            raise BaseException('Unsupported platform')
        self.set_basedir()
        self.lockFile = os.path.join(self.basedir, "dist", "Optract.LOCK")
        return

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
        sys.stdout.write(self.encode_message['length'])
        sys.stdout.write(self.encode_message['content'])
        sys.stdout.flush()
        return

    def startServer(self):
        if not self.platform == 'win32':  # in windows, nativeApp cannot close properly so lockFile is always there
            if os.path.exists(self.lockFile):
                logging.error('Do nothing: lockFile exists in: {0}'.format(self.lockFile))
                sys.exit(0)
                return

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
            self.ipfsP = subprocess.Popen([ipfs_path['bin'], "daemon", "--routing=dhtclient"], env=myenv, stdout=FNULL,
                                         stderr=subprocess.STDOUT)

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
            os.kill(self.nodeP.pid, signal.SIGTERM)
        # This will not kill the ipfs by itself, but this is needed for the sys.exit() to kill it 
        if self.ipfsP is not None:
            logging.info('kill process {0}'.format(self.ipfsP.pid))
            os.kill(self.ipfsP.pid, signal.SIGINT)
        return


# major functions
def mainwin():
    nativeApp = NativeApp()
    started = False
    logging.info('Start to listen to native message...')
    while True:
        message = nativeApp.get_message()
        if "ping" in message.values() and started == False:
            started = True
            nativeApp.startServer()
            logging.info('server started')
        if "pong" in message.values() and started == True:
            started = False
            logging.info('closing native app...')
            nativeApp.stopServer()
            logging.info('native app closed')
            sys.exit(0)
    return


def launcher():
    nativeApp = NativeApp()
    logging.info('in launcher...')
    started = False
    while True:
        if started == False:
            started = True
            nativeApp.startServer()
            logging.info('in launcher...starting server')
        time.sleep(3)
        pl = subprocess.Popen(['pgrep', '-lf', 'firefox'], stdout=subprocess.PIPE).communicate()[0]
        pl = pl.split("\n")[0:-1]
        if (len(pl) == 0):
            nativeApp.stopServer()
            sys.exit(0)
    return


def starter():
    nativeApp = NativeApp()
    logging.info('in starter...')
    started = False
    while True:
        message = nativeApp.get_message()
        if "ping" in message.values() and started == False:
            logging.info('[starter]got ping signal')
            started = True
            time.sleep(1)
            nativeApp = os.path.realpath(sys.argv[0])
            logging.info('[starter]calling: {0} launch'.format(nativeApp))
            subprocess.Popen([nativeApp, "launch"])
            sys.exit(0)
    return


if __name__ == '__main__':
    _ = NativeApp()  # borrow a couple attributes 
    basedir = _.basedir
    platform = _.platform

    # logging
    log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
    log_datefmt = '%Y-%m-%d %H:%M:%S'
    logfile = os.path.join(basedir, 'optract.log')
    # replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
    logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                        datefmt=log_datefmt)

    logging.info('nativeApp path = {0}'.format(os.path.realpath(sys.argv[0])))
    print('nativeApp path = {0}'.format(os.path.realpath(sys.argv[0])))

    if len(sys.argv) > 1:
        if sys.argv[1] == 'install':
            print('Installing... please see the progress in logfile: ' + logfile)
            print('Please also download Optract browser extension.')
            OptractInstall.main(basedir)
        elif sys.argv[1] == 'test':
            nativeApp = NativeApp()
            nativeApp.startServer()
            raw_input("enter anything to stop...")
            nativeApp.stopServer()
        elif sys.argv[1] == 'launch':
            if platform == 'win32':
                raise BaseException("windows version does not support 'launch' argument")
            launcher()
        else:
            if platform == 'win32':
                mainwin()
            else:
                logging.info('calling starter() 1')
                starter()
    else:
        if platform == 'win32':
            mainwin()
        else:
            logging.info('calling starter() 2')
            starter()
