#!/usr/bin/env pythonw
# -*- coding:utf-8 -*- 
from __future__ import print_function
import wx.adv
import wx
import sys
import os
import time
import psutil
import logging
import threading
import wx.lib.newevent as NE
from nativeApp import NativeApp

InstallEvent, EVT_INSTALL = NE.NewEvent()
StartserverEvent, EVT_STARTSERVER = NE.NewEvent()

# path
systray_dir = os.path.dirname(os.path.realpath(sys.argv[0]))  # os.getcwd() may not correct
if sys.platform.startswith('darwin'):
    # in mac: systray = os.path.join(distdir, 'systray.app', 'Contents', 'MacOS', 'systray')
    distdir = os.path.dirname(os.path.dirname(os.path.dirname(systray_dir)))
elif sys.platform.startswith('linux'):
    # in linux: systray = os.path.join(distdir, 'systray', 'systray')
    distdir = os.path.dirname(systray_dir)
elif sys.platform.startswith('win32'):
    # in win: systray = os.path.join(distdir, 'systray.exe')
    distdir = systray_dir
nativeApp = NativeApp(distdir)

TRAY_TOOLTIP = 'Optract'

icons = {
    'inactive': os.path.join(nativeApp.distdir, 'assets', 'icon.xpm'),
    'active': os.path.join(nativeApp.distdir, 'assets', 'icon-active.xpm')
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

        # init value
        self.time_ipfs_boot = time.time()
        self.ipfs_boot_required_time = 40
        self.ipfs_restart_max_retry = 10
        self.ipfs_restart_tried = 0

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
        self.timer.Start(5000)  # every 5 seconds

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

        config_menu = wx.Menu()
        # should detect the existence of 'optract.json' (and check if they point to the running instance of optract)
        create_menu_item(config_menu, 'connect to firefox', self.on_config_firefox)
        create_menu_item(config_menu, 'connect to chrome', self.on_config_chrome)
        create_menu_item(config_menu, 'reset config file', self.on_create_config)
        # create_menu_item(config_menu, 'reset ipfs', self.on_null)
        # create_menu_item(config_menu, 'reset', self.on_null)  # remove existing and re-install
        menu.Append(wx.ID_ANY, '&config browsers', config_menu)

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

        if hasattr(nativeApp.nodeP, 'pid') and hasattr(nativeApp.ipfsP, 'pid') and \
                node_locked and nodeP_is_running and \
                ipfs_locked and ipfsP_is_running:
            is_running = True

        return (is_running, nodeP_symbol, nodeP_status_report, ipfsP_symbol, ipfsP_status_report)

    def on_show_frame(self, event):
        self.frame.Show()
        self.frame.Raise()

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
            self.timer.Start(9000)  # use lower frequency
            self.ipfs_restart_tried = 0
        else:
            self.set_icon(icons['inactive'])
            if not self.ipfsP_is_running and self.nodeP_is_running:
                if self.ipfs_restart_tried > 10:
                    logging.error('Already retry restarting ipfs for {0} times. Bye!'.format(self.ipfs_restart_max_retry))
                    sys.exit(1)
                if time.time() - self.time_ipfs_boot > self.ipfs_boot_required_time:  # prevent (re)start ipfs too soon
                    self.time_ipfs_boot = time.time()
                    self.ipfs_restart_tried += 1
                    logging.info("Restarting ipfs")
                    nativeApp.start_ipfs()
                # else:
                #     logging.info("Waiting for another try of restarting ipfs")

    def on_start_server(self, event):
        nativeApp.startServer()  # can_exit=False

    def on_stop_server(self, event):
        # TODO?: kill the process "nativeApp" if exists
        nativeApp.stopServer()

    def on_restart_ipfs(self, event):
        nativeApp.start_ipfs()

    def on_config_firefox(self, event):
        logging.info('createing manifest for firefox')
        nativeApp.installer.create_and_write_manifest('firefox')
        wx.MessageBox('create nativeApp for firefox. Please install browser extension from https://11be.org/browser_extensions')

    def on_config_chrome(self, event):
        nativeApp.installer.create_and_write_manifest('chrome')
        wx.MessageBox('create nativeApp for chrome. Please install browser extension from https://11be.org/browser_extensions')

    def on_create_config(self, event):
        # TODO: popup a confirm window
        # TODO: it only create a config and does not migrate
        nativeApp.installer.create_config()
        config_file = os.path.join(nativeApp.datadir, 'config.json')
        wx.MessageBox('regenerate config file in: {0}'.format(config_file))

    def on_exit(self, event):
        # TODO/BUG: sometimes segmentfault or buserror, especially while (1)window is shown; (2)exit shortly after open
        nativeApp.stopServer()
        time.sleep(1.2)  # is it necessary to wait a bit for ipfs?
        logging.info('[taskbar] call frame.DestroyLater()')
        self.frame.DestroyLater()
        logging.info('[taskbar] call Destroy()')
        self.Destroy()


class MainFrame(wx.Frame):
    def __init__(self, *args, **kw):
        # ensure the parent's __init__ is called
        super(MainFrame, self).__init__(*args, **kw)
        self.tbIcon = TaskBarIcon(self)

        # create a panel in the frame
        self.panel = wx.Panel(self)

        # create a self.sizer to manage the layout of child widgets
        self.sizer = wx.GridBagSizer()

        # make buttons
        row = 0
        self.button_start_server = wx.Button(self.panel, label="start server")
        self.button_start_server.Bind(wx.EVT_BUTTON, self.on_button_start_server)
        self.sizer.Add(self.button_start_server, pos=(row, 0), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
        self.button_start_server.Disable()

        self.button_stop_server = wx.Button(self.panel, label="stop server")
        self.button_stop_server.Bind(wx.EVT_BUTTON, self.on_button_stop_server)
        self.sizer.Add(self.button_stop_server, pos=(row, 1), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
        self.button_stop_server.Disable()

        self.button_ipfs_restart= wx.Button(self.panel, label="restart ipfs")
        self.button_ipfs_restart.Bind(wx.EVT_BUTTON, self.on_button_ipfs_restart)
        self.button_ipfs_restart.Disable()
        self.sizer.Add(self.button_ipfs_restart, pos=(row, 2), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        row = 1
        _ = 0
        if self.tbIcon.IsAvailable():
            self.button_minimize = wx.Button(self.panel, label="Minimize")
            self.button_minimize.Bind(wx.EVT_BUTTON, self.on_iconize)
            self.sizer.Add(self.button_minimize, pos=(row, 0), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
            _ += 1
        self.button_exit = wx.Button(self.panel, label="Exit")
        self.button_exit.Bind(wx.EVT_BUTTON, self.on_exit)
        self.sizer.Add(self.button_exit, pos=(row, _), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        # put some text with a larger bold font on it
        row = 2
        self.st = wx.StaticText(self.panel, label=self.get_status_text())
        font = self.st.GetFont()
        font.PointSize += 3
        # font = font.Bold()
        self.st.SetFont(font)
        self.sizer.Add(self.st, pos=(row, 0), span=(1, 2), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        # install if necessary
        row = 3
        self.Bind(EVT_INSTALL, self.on_evt_install)
        self.Bind(EVT_STARTSERVER, self.on_evt_startserver)
        try:
            self.install_called  # check existence of this variable
        except AttributeError:
            self.install_called = True
            if os.path.exists(nativeApp.install_lockFile):
                # TODO: also check browser manifest are properly configured
                # TODO: deal with Optract.LOCK (rm it in some cases)
                self.st_status = wx.StaticText(self.panel, label='Welcome to Optract!')
                wx.PostEvent(self, StartserverEvent())
            else:
                self.st_status = wx.StaticText(self.panel, label='Installing Optract...')
                wx.PostEvent(self, InstallEvent())

        self.st_status.SetFont(font)  # use wx.LogWindow instead?
        self.sizer.Add(self.st_status, pos=(row, 0), span=(1, 2), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        # setSizer to panel
        self.panel.SetSizer(self.sizer)

        # create a menu bar
        self.makeMenuBar()

        # and a status bar
        self.CreateStatusBar()
        self.SetStatusText("Welcome to Optract!")

        # events
        self.Bind(wx.EVT_CLOSE, self.on_iconize)  # iconize instead of close
        # self.Bind(wx.EVT_ICONIZE, self.on_iconize)

        self.timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, self.on_timer)
        self.timer.Start(2000)  # every 2 seconds

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

        # enable/disable buttons
        if os.path.exists(nativeApp.install_lockFile) and \
                (not self.tbIcon.ipfsP_is_running) and (not self.tbIcon.nodeP_is_running):
            self.button_start_server.Enable()
        else:
            self.button_start_server.Disable()

        if self.tbIcon.ipfsP_is_running and self.tbIcon.nodeP_is_running:
            self.button_stop_server.Enable()
        else:
            self.button_stop_server.Disable()

        if (not self.tbIcon.ipfsP_is_running) and self.tbIcon.nodeP_is_running and \
                (time.time() - self.tbIcon.time_ipfs_boot > self.tbIcon.ipfs_boot_required_time):
            self.button_ipfs_restart.Enable()
        else:
            self.button_ipfs_restart.Disable()

        # update information text (or use wx.LogWindow instead?)
        if os.path.exists(nativeApp.install_lockFile) \
                and self.tbIcon.ipfsP_is_running and self.tbIcon.nodeP_is_running:
            # TODO: also check whether browser manifest are properly configured
            self.st_status.SetLabel('Optract is running')

    def on_button_ipfs_restart(self, event):
        nativeApp.start_ipfs()
        # self.sizer.Layout()  # or panel.layout()

    def on_button_start_server(self, event):
        nativeApp.startServer()  # can_exit=False
        self.button_start_server.Disable()

    def on_button_stop_server(self, event):
        nativeApp.stopServer()  # can_exit=False
        self.button_stop_server.Disable()

    def on_exit(self, event):
        """Close the frame, terminating the application."""
        # TODO/BUG: sometimes segmentfault
        # TODO: if TaskBarIcon is available, add an event handler which close window and keep servers running
        nativeApp.stopServer()
        time.sleep(1.2)
        # logging.info('call RemoveIcon()')
        # self.tbIcon.RemoveIcon()
        logging.info('[frame] call tbIcon.Destroy()')
        self.tbIcon.Destroy()
        logging.info('[frame] call DestroyLater()')
        self.DestroyLater()

    def on_iconize(self, event):
        self.Iconize(True)
        # if self.IsIconized():
        #     self.Hide()

    def on_evt_install(self, event):
        def _evt_install(win):
            nativeApp.install()
            wx.CallAfter(self.st_status.SetLabel, 'Starting server....')
            # self.st_status.SetLabel("Starting server...")  # this line cause core dumped in Ubuntu (due to calling gui from other thread?), use wx.callAfter instead
            nativeApp.startServer(can_exit=True)  # to prevent multiple instances
        t = threading.Thread(target=_evt_install, args=(self, ))
        t.setDaemon(True)
        t.start()

    def on_evt_startserver(self, event):
        def _evt_startserver(win):
            wx.CallAfter(self.st_status.SetLabel, 'Starting server....')
            nativeApp.startServer(can_exit=True)  # to prevent multiple instances
        t = threading.Thread(target=_evt_startserver, args=(self, ))
        t.setDaemon(True)
        t.start()

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
        frame = MainFrame(None, title='Optract GUI', size=(300, 260))
        self.SetTopWindow(frame)

        # install if necessary; show gui only when systray is not available or during install
        if not os.path.exists(nativeApp.install_lockFile):
            logging.info('Installing Optract')
            frame.Show()
            # nativeApp.install()  # put this line in MainFrame()
        if not frame.tbIcon.IsAvailable():
            logging.warning("TaskBarIcon not available")  # such as Ubuntu 18.04 (Gnome3 + unity DE)
            frame.Show()
        if not frame.tbIcon.IsOk():
            logging.error("Failed to init TaskBarIcon")
            sys.exit(1)

        icon = wx.Icon(wx.Bitmap(TRAY_ICON))
        frame.SetIcon(icon)
        return True


def main():
    app = App(False)
    # frame = MainFrame(None, title='Optract GUI')
    # frame.Show()
    app.MainLoop()


if __name__ == '__main__':
    main()  # assume first argument is pid of nativeApp
