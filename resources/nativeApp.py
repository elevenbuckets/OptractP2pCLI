#!/usr/bin/python -u

# Note that running python with the `-u` flag is required on Windows,
# in order to ensure that stdin and stdout are opened in binary, rather
# than text, mode.

import time
import json
import sys
import struct
import subprocess
import os.path as path
import os
import signal
import logging
import init

# On Windows, the default I/O mode is O_TEXT. Set this to O_BINARY
# to avoid unwanted modifications of the input/output streams.
if sys.platform == "win32":
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# global variables
# if sys.platform == 'win32':
#     # after packing by pynsist, the executable file is in the parent dir of the dir contain this script (nativeApp.py)
#     basedir = os.path.dirname(os.path.realpath(sys.argv[0]))
# else:
#     basedir = os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))
basedir = os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))

lockFile = os.path.join(basedir, "dist", "Optract.LOCK")
myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
myenv['IPFS_PATH'] = os.path.join(basedir, 'ipfs_repo')

FNULL = open(os.devnull, 'w')
ipfsP = None
nodeP = None

# logging
log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
log_datefmt = '%Y-%m-%d %H:%M:%S'
logfile = os.path.join(basedir, 'install.log')
# replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                    datefmt=log_datefmt)


# Read a message from stdin and decode it.
def get_message():
    raw_length = sys.stdin.read(4)
    if not raw_length:
        sys.exit(0)
    # message_length = struct.unpack('=I', raw_length)[0]  # python2
    message_length = struct.unpack('=I', bytes(raw_length, encoding="utf-8"))[0]  # python3
    message = sys.stdin.read(message_length)
    return json.loads(message)


# Encode a message for transmission, given its content.
def encode_message(message_content):
    encoded_content = json.dumps(message_content)
    # encoded_length = struct.pack('=I', len(encoded_content))  # python2
    encoded_length = struct.pack('=I', len(encoded_content)).decode()  # python3
    return {'length': encoded_length, 'content': encoded_content}


# Send an encoded message to stdout.
def send_message(encoded_message):
    sys.stdout.write(encoded_message['length'])
    sys.stdout.write(encoded_message['content'])
    sys.stdout.flush()


def startServer():  
    send_message(encode_message('in starting server')) 
    if os.path.exists(lockFile):
        return

    ipfsConfigPath = path.join(basedir, "ipfs_repo", "config")
    ipfsBinPath = path.join(basedir, "dist", "bin", "ipfs")
    ipfsRepoPath = path.join(basedir, 'ipfs_repo')
    if not os.path.exists(ipfsConfigPath):
        send_message(encode_message('before init ipfs')) 
        subprocess.check_call([ipfsBinPath, "init"], env=myenv, stdout=FNULL, stderr=subprocess.STDOUT)
        return startServer()
    else:
        send_message(encode_message('before starting ipfs')) 
        ipfsP = subprocess.Popen([ipfsBinPath, "daemon", "--routing=dhtclient"], env=myenv, stdout=FNULL, stderr=subprocess.STDOUT)
        send_message(encode_message('after starting ipfs')) 
    send_message(encode_message(' finish ipfs processing')) 
    ipfsAPI  = path.join(ipfsRepoPath, "api")
    ipfsLock = path.join(ipfsRepoPath, "repo.lock")
    while (not os.path.exists(ipfsAPI) or not os.path.exists(ipfsLock)):
        time.sleep(.01) 

    nodeCMD = path.join(basedir, "dist", "bin", "node")
    daemonCMD =  path.join(basedir, "dist", "lib", "daemon.js")
    send_message(encode_message(' starting node processing')) 
    nodeP = subprocess.Popen([nodeCMD, daemonCMD], stdout=FNULL, stderr=subprocess.STDOUT)
    send_message(encode_message('finish starting server')) 
    send_message(encode_message(str(nodeP)))
    return ipfsP, nodeP

def stopServer(ipfsP, nodeP):
    send_message(encode_message('in stoping server')) 
    if os.path.exists(lockFile):
       os.remove(lockFile) 
       send_message(encode_message('LockFile removed')) 
    nodeP.kill()
    send_message(encode_message('nodeP killed')) 
    # This will not kill the ipfs by itself, but this is needed for the sys.exit() to kill it 
    ipfsP.terminate()
    # os.kill(ipfsP.pid, signal.SIGINT)
    send_message(encode_message('ipfsP killed signal sent')) 
    
# startServer()
started = False

# while True:
#     if started == False:
#         started = True
#         send_message(encode_message('ping->pong')) 
#         ipfsP, nodeP = startServer()
#         send_message(encode_message('ping->pong more'))

ipfsConfigPath = path.join(basedir, "ipfs_repo", "config")
installed = os.path.join(basedir, 'dist', '.installed')
if (not os.path.isfile(ipfsConfigPath) or not os.path.isfile(installed)):  # i.e., rm or mv the logfile to init again
    init.init()
    init.sym_or_copy_data()

logging.info('Start messaging channel')
while True:
    message = get_message()
    if "ping" in message.values() and started == False:
        started = True
        send_message(encode_message('ping->pong')) 
        ipfsP, nodeP = startServer()
        send_message(encode_message('ping->pong more'))
    #if message:
    #    send_message(encode_message("pong")) 
    if "pong" in message.values() and started == True:
        started = False
        send_message(encode_message('pong->ping')) 
        stopServer(ipfsP, nodeP)
        send_message(encode_message('pong->ping more'))
        send_message(encode_message('close native app which will also shutdown the ipfs'))
        sys.exit(0)
