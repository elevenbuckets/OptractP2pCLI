#!/usr/bin/env python
# encoding: utf-8
''' unix-only, for validator '''
from __future__ import print_function
import os
import sys
import psutil
import subprocess
import time
import signal

cwd = os.path.dirname(os.path.realpath(sys.argv[0]))


def run_ipfs():
    myenv = os.environ.copy()  # "DLL initialize error..." in Windows while set the env inside subprocess calls
    myenv['IPFS_PATH'] = os.path.join(cwd, 'ipfs_repo')
    ipfsCMD = os.path.join(cwd, 'bin', 'ipfs')
    return subprocess.Popen([ipfsCMD, "daemon", "--routing=dhtclient"], env=myenv), time.time()


def get_pid_status(pid):
    if psutil.pid_exists(pid):
        is_running = psutil.Process(pid).is_running()
        status = psutil.Process(pid).status()
        if status == psutil.STATUS_ZOMBIE:
            is_running = False
    else:
        is_running = False
        status = None
    return is_running, status


def get_daemon_pids():
    daemon_pid = None
    ipfsP_pid = None
    for p in psutil.process_iter(attrs=['pid', 'name', 'cmdline']):
        if p.info['name'].startswith('python') and len(p.info['cmdline']) == 3:
            if p.info['cmdline'][1] == './run_ipfs.py' and p.info['cmdline'][2] == 'daemon':
                daemon_pid = p.info['pid']
        elif p.info['name'] == 'ipfs':
            ipfsP_pid = p.info['pid']
    return daemon_pid, ipfsP_pid


if __name__ == '__main__':
    ipfs_start_require_time = 24  # seconds
    check_frequency = 6  # seconds

    if sys.argv[1] == 'daemon':
        ipfsP, time_ipfs_start = run_ipfs()
        while True:
            is_running, status = get_pid_status(ipfsP.pid)
            if not is_running and time.time() - time_ipfs_start > ipfs_start_require_time:
                print('ipfs (pid: {0}) is not running, status: {1}. Restart ipfs.'.format(ipfsP.pid, status))
                ipfsP, time_ipfs_start = run_ipfs()
                print('ipfs (pid: {0}) is starting.'.format(ipfsP.pid))
            time.sleep(check_frequency)
    elif sys.argv[1] == 'kill':
        daemon_pid, ipfsP_pid = get_daemon_pids()
        if daemon_pid is not None:
            print("kill ipfs daemon spawner with pid {0}".format(daemon_pid))
            os.kill(daemon_pid, signal.SIGTERM)
        if ipfsP_pid is not None:
            print("kill ipfs daemon with pid {0}".format(ipfsP_pid))
            os.kill(ipfsP_pid, signal.SIGINT)
