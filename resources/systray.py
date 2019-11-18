#!/usr/bin/env pythonw
# encoding: utf-8
from __future__ import print_function
import wx.adv
import wx
# import sys
import os
import time
import psutil
import logging
from nativeApp import NativeApp


nativeApp = NativeApp()

TRAY_TOOLTIP = 'Optract'

icons = {
    'inactive': os.path.join(nativeApp.basedir, 'dist', 'assets', 'icon.xpm'),
    'active': os.path.join(nativeApp.basedir, 'dist', 'assets', 'icon-active.xpm')
}

TRAY_ICON = icons['inactive']

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
        # self.nativeApp = nativeApp
        super(TaskBarIcon, self).__init__()
        self.set_icon(TRAY_ICON)
        self.Bind(wx.adv.EVT_TASKBAR_LEFT_DOWN, self.on_left_down)
        # if len(sys.argv) > 1:
        #     ppid = sys.argv[1]  # the browser pid which call nativeApp which Popen systray
        # else:
        #     ppid = 1
        # wx.CallAfter(simple_daemon)
        # time event
        self.timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, self.on_timer)
        self.timer.Start(6000)  # every 6 seconds

    def CreatePopupMenu(self):
        menu = wx.Menu()
        create_menu_item(menu, 'show window', self.on_show_frame)
        (is_running, node_symbol, nodeP_report, ipfs_symbol, ipfsP_report) = self.get_status()
        create_menu_item(menu, 'Status: {0}'.format('✔️' if is_running else '---'), self.on_null, enable=False)
        create_menu_item(menu, ' node: pid {0} {1}'.format(nodeP_report, node_symbol), self.on_null, enable=False)  # TODO: hide these details
        create_menu_item(menu, ' ipfs: pid {0} {1}'.format(ipfsP_report, ipfs_symbol), self.on_null, enable=False)
        menu.AppendSeparator()
        create_menu_item(menu, 'Start', self.on_start_server)
        create_menu_item(menu, 'Stop', self.on_stop_server)
        menu.AppendSeparator()
        if not self.ipfsP_is_running and self.nodeP_is_running:
            create_menu_item(menu, 'restart ipfs (experimental)', self.on_restart_ipfs)
            menu.AppendSeparator()
        create_menu_item(menu, 'Exit', self.on_exit)
        return menu

    def set_icon(self, path):
        icon = wx.Icon(wx.Bitmap(path))
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
        self.nodeP_is_running = False
        if hasattr(nativeApp.nodeP, 'pid'):
            nodeP_is_running, nodeP_status, nodeP_status_report = self._get_pid_status(nativeApp.nodeP.pid)
            if nodeP_is_running and node_locked:
                nodeP_symbol = '✔️'
                self.nodeP_is_running = True

        ipfsP_symbol = '❌'
        ipfsP_status_report = '-'
        self.ipfsP_is_running = False  # for menu item "restart ipfs"
        if hasattr(nativeApp.ipfsP, 'pid'):
            ipfsP_is_running, ipfsP_status, ipfsP_status_report = self._get_pid_status(nativeApp.ipfsP.pid)
            if ipfsP_is_running and ipfs_locked:
                ipfsP_symbol = '✔️'
                self.ipfsP_is_running = True

        if (hasattr(nativeApp.nodeP, 'pid') and hasattr(nativeApp.ipfsP, 'pid') and
                node_locked and nodeP_is_running and
                ipfs_locked and ipfsP_is_running):
            is_running = True

        return (is_running, nodeP_symbol, nodeP_status_report, ipfsP_symbol, ipfsP_status_report)

    def on_show_frame(self, event):
        self.frame.Show()

    def on_left_down(self, event):
        self.PopupMenu(self.CreatePopupMenu())

    def on_null(self, event):
        pass

    def on_hello(self, event):
        if nativeApp.nodeP is not None:
            print(nativeApp.nodeP.pid)
        if nativeApp.ipfsP is not None:
            print(nativeApp.ipfsP.pid)

    def on_timer(self, event):
        is_running, _, _, _, _ = self.get_status()
        if is_running:
            self.set_icon(icons['active'])
            self.timer.Stop()
            self.timer.Start(15000)  # use lower frequency
        else:
            self.set_icon(icons['inactive'])
            # if ipfs is down and node is still active --> call "self.on_restart_ipfs()"

    def on_start_server(self, event):
        nativeApp.startServer()  # can_exit=False

    def on_stop_server(self, event):
        nativeApp.stopServer()

    def on_restart_ipfs(self, event):
        nativeApp.start_ipfs()

    def on_exit(self, event):
        nativeApp.stopServer()
        time.sleep(1)  # is it necessary to wait a bit for ipfs?
        self.frame.Destroy()
        self.Destroy()


class MainFrame(wx.Frame):
    def __init__(self, *args, **kw):
        # ensure the parent's __init__ is called
        super(MainFrame, self).__init__(*args, **kw)
        self.tbIcon = TaskBarIcon(self)

        # create a panel in the frame
        self.panel = wx.Panel(self)

        # create a self.sizer to manage the layout of child widgets
        self.sizer = wx.BoxSizer(wx.VERTICAL)

        # make buttons
        self.button_status = wx.Button(self.panel, label="update status")
        self.button_status.Bind(wx.EVT_BUTTON, self.on_button_status)
        self.sizer.Add(self.button_status, wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, 5)

        self.button_start_server = wx.Button(self.panel, label="start server")
        self.button_start_server.Bind(wx.EVT_BUTTON, self.on_button_start_server)
        self.sizer.Add(self.button_start_server, wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, 5)

        self.button_stop_server = wx.Button(self.panel, label="stop server")
        self.button_stop_server.Bind(wx.EVT_BUTTON, self.on_button_stop_server)
        self.sizer.Add(self.button_stop_server, wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, 5)

        self.button_exit = wx.Button(self.panel, label="Exit")
        self.button_exit.Bind(wx.EVT_BUTTON, self.on_exit)
        self.sizer.Add(self.button_exit, wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, 5)

        # put some text with a larger bold font on it
        self.st = wx.StaticText(self.panel, label=self.get_status_text())
        font = self.st.GetFont()
        font.PointSize += 3
        # font = font.Bold()
        self.st.SetFont(font)
        self.sizer.Add(self.st, wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, 5)
        # self.sizer.Add(self.st, wx.SizerFlags().Border(wx.TOP | wx.LEFT, 25))

        # setSizer to panel
        self.panel.SetSizer(self.sizer)

        # create a menu bar
        self.makeMenuBar()

        # and a status bar
        self.CreateStatusBar()
        self.SetStatusText("Welcome to Optract!")

        # events
        self.Bind(wx.EVT_CLOSE, self.on_iconize)  # minimize to tray instead of close
        self.Bind(wx.EVT_ICONIZE, self.on_iconize)

        self.timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, self.on_timer)
        self.timer.Start(4000)  # every 4 seconds

    def makeMenuBar(self):
        # Make a file menu with Hello and Exit items
        fileMenu = wx.Menu()
        # The "\t..." syntax defines an accelerator key that also triggers
        # the same event
        helloItem = fileMenu.Append(
            -1, "&Hello...\tCtrl-H",
            "Help string shown in status bar for this menu item")
        fileMenu.AppendSeparator()
        # When using a stock ID we don't need to specify the menu item's
        # label
        exitItem = fileMenu.Append(wx.ID_EXIT)

        # Now a help menu for the about item
        helpMenu = wx.Menu()
        aboutItem = helpMenu.Append(wx.ID_ABOUT)

        # Make the menu bar and add the two menus to it. The '&' defines
        # that the next letter is the "mnemonic" for the menu item. On the
        # platforms that support it those letters are underlined and can be
        # triggered from the keyboard.
        menuBar = wx.MenuBar()
        menuBar.Append(fileMenu, "&File")
        menuBar.Append(helpMenu, "&Help")

        # Give the menu bar to the frame
        self.SetMenuBar(menuBar)

        # Finally, associate a handler function with the EVT_MENU event for
        # each of the menu items. That means that when that menu item is
        # activated then the associated handler function will be called.
        self.Bind(wx.EVT_MENU, self.on_hello, helloItem)
        self.Bind(wx.EVT_MENU, self.on_exit, exitItem)
        self.Bind(wx.EVT_MENU, self.on_about, aboutItem)

    def update_status_text(self):
        self.st.SetLabel(self.get_status_text())

    def get_status_text(self):
        (is_running, node_symbol, nodeP_report, ipfs_symbol, ipfsP_report) = self.tbIcon.get_status()
        is_running_symbol = '✔️' if is_running else '---'
        status_text = '''Optract status: {0}
  node status: {1}
  ipfs status: {2}'''.format(is_running_symbol, node_symbol, ipfs_symbol)
        return status_text

    def on_timer(self, event):
        self.update_status_text()

    def on_button_status(self, event):
        self.st.SetLabel(self.get_status_text())
        self.sizer.Layout()  # or panel.layout()

    def on_button_start_server(self, event):
        nativeApp.startServer()  # can_exit=False

    def on_button_stop_server(self, event):
        nativeApp.stopServer()  # can_exit=False

    def on_exit(self, event):
        """Close the frame, terminating the application."""
        nativeApp.stopServer()
        # self.tbIcon.RemoveIcon()
        time.sleep(1)
        self.tbIcon.Destroy()
        self.Destroy()

    def on_iconize(self, event):
        pass
        # if self.IsIconized():
        #     self.Hide()

    def on_hello(self, event):
        """Say hello to the user."""
        wx.MessageBox("Hello again from wxPython")

    def on_about(self, event):
        """Display an About Dialog"""
        wx.MessageBox("This is a wxPython Hello World sample",
                      "About Hello World 2",
                      wx.OK | wx.ICON_INFORMATION)


class App(wx.App):
    def OnInit(self):
        frame = MainFrame(None, title='Optract GUI', size=(220, 300))
        self.SetTopWindow(frame)

        if not frame.tbIcon.IsAvailable():
            logging.warning("TaskBarIcon not available")  # such as Ubuntu (Gnome3 + unity DE)
            frame.Show()
        if not frame.tbIcon.IsOk():
            logging.error("Failed to init TaskBarIcon")
            sys.exit(1)

        icon = wx.Icon(wx.Bitmap(TRAY_ICON))
        frame.SetIcon(icon)
        return True


def main():
    app = App(False)
    nativeApp.startServer(can_exit=True)  # to prevent multiple instances
    # frame = MainFrame(None, title='Optract GUI')
    # frame.Show()
    app.MainLoop()


if __name__ == '__main__':
    main()  # assume first argument is pid of nativeApp
