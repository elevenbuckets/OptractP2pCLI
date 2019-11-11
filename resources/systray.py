#!/usr/bin/env pythonw
from __future__ import print_function
import wx.adv
import wx
import sys
import os
import time
import psutil
import logging
from nativeApp import NativeApp


nativeApp = NativeApp()

TRAY_TOOLTIP = 'Optract'
TRAY_ICON = os.path.join(nativeApp.basedir, 'dist', 'icon.xpm')

# logging
# even though logging is not used in systray, nativeApp still use logging and have to be defined here
log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
log_datefmt = '%Y-%m-%d %H:%M:%S'
logfile = os.path.join(nativeApp.basedir, 'optract.log')
# replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                    datefmt=log_datefmt)


# def simple_daemon(self):
#     while True:
#         time.sleep(3)
#         # pl = subprocess.Popen(['pgrep', '-lf', 'firefox'], stdout=subprocess.PIPE).communicate()[0]
#         # pl = pl.split("\n")[0:-1]
#         # if (len(pl) == 0):
#         firefox_pids = [p.info for p in psutil.process_iter(attrs=['pid', 'name']) if 'firefox' == p.info['name']]
#         if len(firefox_pids) == 0:
#             nativeApp.stopServer()
#             sys.exit(0)


def create_menu_item(menu, label, func, enable=True):
    item = wx.MenuItem(menu, -1, label)
    menu.Bind(wx.EVT_MENU, func, id=item.GetId())
    menu.Append(item)
    if not enable:
        item.Enable(False)
    return item


class TaskBarIcon(wx.adv.TaskBarIcon):
    def __init__(self, frame):
        self.frame = frame
        self.nativeApp = nativeApp
        super(TaskBarIcon, self).__init__()
        self.set_icon(TRAY_ICON)
        self.Bind(wx.adv.EVT_TASKBAR_LEFT_DOWN, self.on_left_down)
        # if len(sys.argv) > 1:
        #     ppid = sys.argv[1]  # the browser pid which call nativeApp which Popen systray
        # else:
        #     ppid = 1
        # wx.CallAfter(simple_daemon)

    def CreatePopupMenu(self):
        menu = wx.Menu()
        (is_running, node_symbol, nodeP_report, ipfs_symbol, ipfsP_report) = self.get_status()
        create_menu_item(menu, 'Status: {0}'.format('✔️'  if is_running else '---'), self.on_null, enable=False)
        create_menu_item(menu, ' node: pid {0} {1}'.format(nodeP_report, node_symbol), self.on_null, enable=False)  # TODO: hide these details
        create_menu_item(menu, ' ipfs: pid {0} {1}'.format(ipfsP_report, ipfs_symbol), self.on_null, enable=False)
        menu.AppendSeparator()
        create_menu_item(menu, 'Start', self.on_start_server)
        create_menu_item(menu, 'Stop', self.on_stop_server)
        menu.AppendSeparator()
        if not self.ipfsP_is_running:
            create_menu_item(menu, 'restart ipfs (experimental)', self.on_restart_ipfs)

        menu.AppendSeparator()
        create_menu_item(menu, 'Exit', self.on_exit)
        return menu

    def set_icon(self, path):
        icon = wx.Icon(wx.Bitmap(path))
        # TODO: call set_icon while hover on icon or periodically
        if os.path.exists(nativeApp.lockFile):
            TRAY_TOOLTIP = 'Optract is running'
        else:
            TRAY_TOOLTIP = 'Optract'
        self.SetIcon(icon, TRAY_TOOLTIP)

    def _get_pid_status(self, pid):
        if psutil.pid_exists(pid):
            is_running = psutil.Process(pid).is_running()
            status = psutil.Process(pid).status()
            if status == psutil.STATUS_ZOMBIE:
                is_running = False
            status_report = '{0} ({1})'.format(pid, status)
        else:
            is_running = False
            status = None
            status_report = '-'  # no such process (could be pending or already dead)
        return is_running, status, status_report

    def get_status(self):
        is_running = False

        node_locked = ipfs_locked = False
        if os.path.exists(nativeApp.lockFile):
            node_locked = True
        if os.path.exists(nativeApp.ipfs_lockFile):
            ipfs_locked = True

        nodeP_symbol = '❌'
        nodeP_status_report = '-'
        if hasattr(self.nativeApp.nodeP, 'pid'):
            nodeP_is_running, nodeP_status, nodeP_status_report = self._get_pid_status(self.nativeApp.nodeP.pid)
            if nodeP_is_running and node_locked:
                nodeP_symbol = '✔️'

        ipfsP_symbol = '❌'
        ipfsP_status_report = '-'
        self.ipfsP_is_running = False  # for menu item "restart ipfs"
        if hasattr(self.nativeApp.ipfsP, 'pid'):
            ipfsP_is_running, ipfsP_status, ipfsP_status_report = self._get_pid_status(self.nativeApp.ipfsP.pid)
            if ipfsP_is_running and ipfs_locked:
                ipfsP_symbol = '✔️'
                self.ipfsP_is_running = True

        if (hasattr(self.nativeApp.nodeP, 'pid') and hasattr(self.nativeApp.ipfsP, 'pid') and
                node_locked and nodeP_is_running and
                ipfs_locked and ipfsP_is_running):
            is_running = True

        return (is_running, nodeP_symbol, nodeP_status_report, ipfsP_symbol, ipfsP_status_report)

    def on_left_down(self, event):
        self.PopupMenu(self.CreatePopupMenu())

    def on_null(self, event):
        pass

    def on_hello(self, event):
        if self.nativeApp.nodeP is not None:
            print(self.nativeApp.nodeP.pid)
        if self.nativeApp.ipfsP is not None:
            print(self.nativeApp.ipfsP.pid)

    def on_start_server(self, event):
        self.nativeApp.startServer()  # can_exit=False
        pass

    def on_stop_server(self, event):
        self.nativeApp.stopServer()
        pass

    def on_restart_ipfs(self, event):
        self.nativeApp.start_ipfs()

    def on_exit(self, event):
        self.nativeApp.stopServer()
        time.sleep(3)
        wx.CallAfter(self.Destroy)
        self.frame.Close()

class App(wx.App):
    def OnInit(self):
        frame=wx.Frame(None)
        self.SetTopWindow(frame)
        # icon = wx.Icon(wx.Bitmap(TRAY_ICON))
        # frame.SetIcon(icon)
        TaskBarIcon(frame)
        return True

def main():
    app = App(False)
    nativeApp.startServer(can_exit=True)  # to prevent multiple instances
    app.MainLoop()


if __name__ == '__main__':
    main()  # assume first argument is pid of nativeApp
