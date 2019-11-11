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

TRAY_TOOLTIP = 'Optract...'
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
        (node_lock, nodeP_pid, ipfs_lock, ipfsP_pid) = self.get_status()
        create_menu_item(menu, 'Status:', self.on_null, enable=False)
        create_menu_item(menu, ' node: pid {0} {1}'.format(nodeP_pid, node_lock), self.on_null, enable=False)  # TODO: hide these details
        create_menu_item(menu, ' ipfs: pid {0} {1}'.format(ipfsP_pid, ipfs_lock), self.on_null, enable=False)
        menu.AppendSeparator()
        create_menu_item(menu, 'Start', self.on_start_server)
        create_menu_item(menu, 'Stop', self.on_stop_server)
        menu.AppendSeparator()
        create_menu_item(menu, 'Exit', self.on_exit)
        return menu

    def set_icon(self, path):
        icon = wx.Icon(wx.Bitmap(path))
        # TODO: call set_icon while hover on icon
        if os.path.exists(nativeApp.lockFile):
            TRAY_TOOLTIP = 'Optract is running'
        else:
            TRAY_TOOLTIP = 'Optract'
        self.SetIcon(icon, TRAY_TOOLTIP)

    def get_status(self):
        node_lock = ipfs_lock = '-'
        if os.path.exists(nativeApp.lockFile):
            node_lock = '🔒'
        if os.path.exists(nativeApp.ipfs_lockFile):
            ipfs_lock = '🔒'

        nodeP_pid = ipfsP_pid = None

        if self.nativeApp.nodeP.pid is not None:
            if psutil.pid_exists(self.nativeApp.nodeP.pid):
                nodeP_pid = '{0} ({1})'.format(self.nativeApp.nodeP.pid, psutil.Process(nodeP_pid).status())

        if self.nativeApp.ipfsP.pid is not None:
            if psutil.pid_exists(self.nativeApp.ipfsP.pid):
                ipfsP_pid = '{0} ({1})'.format(self.nativeApp.ipfsP.pid, psutil.Process(ipfsP_pid).status())

        return (node_lock, nodeP_pid, ipfs_lock, ipfsP_pid)

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
