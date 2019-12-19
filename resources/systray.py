#!/usr/bin/env pythonw
# -*- coding:utf-8 -*-
import wx.adv
import wx
import sys
import os
import time
import psutil
import logging
import threading
import wx.lib.newevent as NE
import webbrowser
from nativeApp import NativeApp
# TODO: help user to move $basedir to another place, or detect and show warnings. Such as
#       browser nativeMsgHost missing warning (done); and paths in config.json (not done)

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

# more global variables
TRAY_TOOLTIP = 'Optract'

icons = {
    'inactive': os.path.join(nativeApp.distdir, 'assets', 'icon.xpm'),
    'active': os.path.join(nativeApp.distdir, 'assets', 'icon-active.xpm')
}

TRAY_ICON = icons['inactive']

# logging
log = logging.getLogger(__name__)
log_format = '[%(asctime)s] %(levelname)-7s : %(message)s'
log_datefmt = '%Y-%m-%d %H:%M:%S'
logfile = os.path.join(nativeApp.basedir, 'optract.log')
# replace the `filename=logfile` to `stream=sys.stdout` to direct log to stdout
# TODO: add logrotate or similar mechanism to remote old log for optract.log
# TODO: let log level=logging.WARNING for released version? or make a toggle for the level
logging.basicConfig(filename=logfile, level=logging.INFO, format=log_format,
                    datefmt=log_datefmt)


def create_menu_item(menu, label, func, enable=True, parent_menu=None):
    item = wx.MenuItem(menu, -1, label)
    # in windows, need to bind with "parent_menu", while for ubuntu 18.04 and mac
    # need to bind with "menu" (wxpython 4.0.7.post2)
    if parent_menu is not None and sys.platform.startswith('win32'):
        parent_menu.Bind(wx.EVT_MENU, func, id=item.GetId())
    else:
        menu.Bind(wx.EVT_MENU, func, id=item.GetId())
    menu.Append(item)
    if not enable:
        item.Enable(False)
    return item


class TaskBarIcon(wx.adv.TaskBarIcon):
    def __init__(self, frame):
        self.frame = frame
        super(TaskBarIcon, self).__init__()

        # init value
        self.time_ipfs_boot = time.time()
        self.ipfs_boot_required_time = 40
        self.ipfs_restart_max_retry = 10
        self.ipfs_restart_tried = 0

        self.set_icon(TRAY_ICON)
        self.Bind(wx.adv.EVT_TASKBAR_LEFT_DOWN, self.on_left_down)

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
        create_menu_item(menu, 'Start', self.frame.on_start_server)
        create_menu_item(menu, 'Stop', self.frame.on_stop_server)
        menu.AppendSeparator()

        config_menu = wx.Menu()
        # should detect the existence of 'optract.json' (and check if they point to the running instance of optract)
        create_menu_item(config_menu, 'config firefox', self.frame.on_config_firefox, parent_menu=menu)
        create_menu_item(config_menu, 'config chrome', self.frame.on_config_chrome, parent_menu=menu)
        create_menu_item(config_menu, 'reset config file', self.on_create_config, parent_menu=menu)
        # create_menu_item(config_menu, 'reset ipfs', self.on_null)
        # create_menu_item(config_menu, 'reset', self.on_null)  # remove existing and re-install
        menu.AppendSubMenu(config_menu, 'config browsers')

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
                    msg = 'Error: Try to restart ipfs for {0} times.\nPlease try again later or check the logfile in {1}.\nReport this issue if still wrong.'.format(self.ipfs_restart_max_retry, logfile)
                    log.error(msg)
                    wx.MessageBox(msg)
                    sys.exit(1)
                if time.time() - self.time_ipfs_boot > self.ipfs_boot_required_time:  # prevent (re)start ipfs too soon
                    self.time_ipfs_boot = time.time()
                    self.ipfs_restart_tried += 1
                    log.info("Restarting ipfs")
                    nativeApp.start_ipfs()
                # else:
                #     log.info("Waiting for another try of restarting ipfs")

    def on_restart_ipfs(self, event):
        nativeApp.start_ipfs()

    def on_create_config(self, event):
        msg = "Are you sure to reset the config?\nIf yes, will take some time to restart server."
        dlg = wx.MessageDialog(None, msg, "Optract config",
                               wx.YES_NO | wx.YES_DEFAULT | wx.ICON_EXCLAMATION)
        ret = dlg.ShowModal()
        if ret == wx.ID_YES:
            log.info('regenerate config.json')
            nativeApp.installer.create_config()
            config_file = os.path.join(nativeApp.datadir, 'config.json')
            nativeApp.stopServer()
            time.sleep(0.5)  # note: already wait inside stopServer
            nativeApp.startServer()
            wx.MessageBox('Server restarted!.\nConfig file in: \n{0}'.format(config_file))
        else:
            wx.MessageBox('do nothing')

    def on_exit(self, event):
        # TODO/BUG: on mac, sometimes segmentfault or buserror, especially while (1)window is shown; (2)exit shortly after open
        nativeApp.stopServer()
        log.info('[taskbar] call frame.DestroyLater()')
        self.frame.DestroyLater()
        log.info('[taskbar] call Destroy()')
        self.Destroy()


class MainFrame(wx.Frame):
    def __init__(self, *args, **kw):
        # ensure the parent's __init__ is called
        super(MainFrame, self).__init__(*args, **kw)
        self.tbIcon = TaskBarIcon(self)

        # quit if something's wrong
        if errormsg != '':
            wx.MessageBox('Exit due to following reason:\n\n{0}'.format(errormsg))
            log.error(errormsg)
            sys.exit(1)
        self.quit_if_duplicate()  # merge it to "errormsg"?

        # create a panel in the frame
        self.panel = wx.Panel(self)
        self.init_ui()  # buttons and text

        # create a menu bar
        self.makeMenuBar()

        # and a status bar
        self.CreateStatusBar()
        self.SetStatusText("Welcome to Optract!")
        # TODO: add more status text (for example, while mouse on buttons)

        # events
        self.Bind(wx.EVT_CLOSE, self.on_iconize)  # iconize instead of close
        # self.Bind(wx.EVT_ICONIZE, self.on_iconize)

        self.timer = wx.Timer(self)
        self.Bind(wx.EVT_TIMER, self.on_timer)
        self.timer.Start(1000)  # ms

    def init_ui(self):
        def _mouse_event(btn, help_string):
            btn.Bind(wx.EVT_ENTER_WINDOW, lambda event: self.on_mouse_enter(event, help_string))
            btn.Bind(wx.EVT_LEAVE_WINDOW, self.on_mouse_leave)

        # create a self.sizer to manage the layout of child widgets
        self.sizer = wx.GridBagSizer()

        # make buttons
        row = 0
        self.button_start_server = wx.Button(self.panel, label="start server")
        self.button_start_server.Bind(wx.EVT_BUTTON, self.on_start_server)
        _mouse_event(self.button_start_server, "start server")
        self.sizer.Add(self.button_start_server, pos=(row, 0), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
        self.button_start_server.Disable()

        self.button_stop_server = wx.Button(self.panel, label="stop server")
        self.button_stop_server.Bind(wx.EVT_BUTTON, self.on_stop_server)
        _mouse_event(self.button_stop_server, "stop server")
        self.sizer.Add(self.button_stop_server, pos=(row, 1), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
        self.button_stop_server.Disable()

        self.button_ipfs_restart = wx.Button(self.panel, label="restart ipfs")
        self.button_ipfs_restart.Bind(wx.EVT_BUTTON, self.on_restart_ipfs)
        _mouse_event(self.button_ipfs_restart, "restart ipfs")
        self.button_ipfs_restart.Disable()
        self.sizer.Add(self.button_ipfs_restart, pos=(row, 2), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        row = 1
        _ = 0
        if self.tbIcon.IsAvailable():
            self.button_minimize = wx.Button(self.panel, label="Minimize")
            self.button_minimize.Bind(wx.EVT_BUTTON, self.on_iconize)
            _mouse_event(self.button_minimize, "minimize to tray")
            self.sizer.Add(self.button_minimize, pos=(row, 0), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
            _ += 1
        self.button_exit = wx.Button(self.panel, label="Exit")
        self.button_exit.Bind(wx.EVT_BUTTON, self.on_exit)
        _mouse_event(self.button_exit, "Exit")
        self.sizer.Add(self.button_exit, pos=(row, _), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        # put some text with a larger bold font on it
        row = 2
        self.st = wx.StaticText(self.panel, label=self.get_status_text())
        font = self.st.GetFont()
        font.PointSize += 1
        # font = font.Bold()
        self.st.SetFont(font)
        self.sizer.Add(self.st, pos=(row, 0), span=(1, 3), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        # check browser status
        row = 3
        self.button_config_firefox = wx.Button(self.panel, label='config firefox')
        self.button_config_firefox.Bind(wx.EVT_BUTTON, self.on_config_firefox)
        _mouse_event(self.button_config_firefox, "tell firefox the location of Optract-gui")
        self.sizer.Add(self.button_config_firefox, pos=(row, 0), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
        self.button_config_firefox.Disable()

        self.button_config_chrome = wx.Button(self.panel, label='config chrome')
        self.button_config_chrome.Bind(wx.EVT_BUTTON, self.on_config_chrome)
        _mouse_event(self.button_config_chrome, "tell chrome the location of Optract-gui")
        self.sizer.Add(self.button_config_chrome, pos=(row, 1), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)
        self.button_config_chrome.Disable()

        # install if necessary
        row = 4
        self.Bind(EVT_INSTALL, self.on_evt_install)
        self.Bind(EVT_STARTSERVER, self.on_evt_startserver)
        try:
            self.check_install  # check existence of this variable
        except AttributeError:
            self.check_install = True
            if os.path.exists(nativeApp.install_lockFile):
                # TODO: deal with Optract.LOCK (rm it in some cases)
                self.st_nativeApp = wx.StaticText(self.panel, label='Welcome to Optract!')
                log.info('checking browser during render UI: firefox:{0}, chrome:{1}'.format(self.check_browser('firefox'), self.check_browser('chrome')))
                if not (self.check_browser('firefox') or self.check_browser('chrome')):
                    wx.MessageBox('Cannot find config for firefox and chrome. Please click the "config browser" buttons')
                wx.PostEvent(self, StartserverEvent())
            else:
                self.st_nativeApp = wx.StaticText(self.panel, label='Installing Optract...')
                wx.PostEvent(self, InstallEvent())

        self.st_nativeApp.SetFont(font)  # use wx.LogWindow instead?
        self.sizer.Add(self.st_nativeApp, pos=(row, 0), span=(1, 3), flag=wx.ALL | wx.EXPAND | wx.ALIGN_CENTER_HORIZONTAL, border=3)

        # TODO: add buttons to enter config menu (such as re-configure browser manifest)
        # setSizer to panel
        self.panel.SetSizer(self.sizer)

    def makeMenuBar(self):
        # Make a file menu with Hello and Exit items
        server_menu = wx.Menu()
        # The "\t..." syntax defines an accelerator key that also triggers
        # the same event
        start_item = server_menu.Append(-1, "&Start...\tCtrl-r", "Start server")
        stop_item = server_menu.Append(-1, "&Stop...\tCtrl-p", "Stop server")
        restart_ipfs_item = server_menu.Append(-1, "&Restart ipfs", "Restart ipfs")
        server_menu.AppendSeparator()
        config_firefox_item = server_menu.Append(-1, "create firefox config", "create firefox config")
        config_chrome_item = server_menu.Append(-1, "create chrome config", "create chrome config")
        # When using a stock ID we don't need to specify the menu item's label
        exit_item = server_menu.Append(wx.ID_EXIT)

        # Now a help menu for the about item
        helpMenu = wx.Menu()
        about_item = helpMenu.Append(wx.ID_ABOUT)
        visit_item = helpMenu.Append(-1, "&visit homepage", "visit 11be.org")

        # Make the menu bar and add the two menus to it. The '&' defines
        # that the next letter is the "mnemonic" for the menu item. On the
        # platforms that support it those letters are underlined and can be
        # triggered from the keyboard.
        menuBar = wx.MenuBar()
        menuBar.Append(server_menu, "&Server")
        menuBar.Append(helpMenu, "&Help")

        # Give the menu bar to the frame
        self.SetMenuBar(menuBar)

        # Finally, associate a handler function with the EVT_MENU event for
        # each of the menu items. That means that when that menu item is
        # activated then the associated handler function will be called.
        self.Bind(wx.EVT_MENU, self.on_start_server, start_item)
        self.Bind(wx.EVT_MENU, self.on_stop_server, stop_item)
        self.Bind(wx.EVT_MENU, self.on_restart_ipfs, restart_ipfs_item)
        self.Bind(wx.EVT_MENU, self.on_config_firefox, config_firefox_item)
        self.Bind(wx.EVT_MENU, self.on_config_chrome, config_chrome_item)
        self.Bind(wx.EVT_MENU, self.on_visit_homepage, visit_item)
        self.Bind(wx.EVT_MENU, self.on_exit, exit_item)
        self.Bind(wx.EVT_MENU, self.on_about, about_item)

    def quit_if_duplicate(self):
        if len(other_systray_proc) > 0:
            wx.MessageBox("Exit due to following reason:\n\nAnother Optract-GUI is running. Please use the Optract-GUI (and start server) or kill the processes using system task manager and start again.\n pid(s): {0}".format(other_systray_proc))
            # TODO: test the 'zombie' case
            if len([x['status'] for x in other_systray_proc if x['status'] != 'zombie']) > 0:
                sys.exit(0)
            else:
                log.warning('Detect zombie process(es)')

    def update_status_text(self):
        self.st.SetLabel(self.get_status_text())

    def get_status_text(self):
        (is_running, node_symbol, nodeP_report, ipfs_symbol, ipfsP_report) = self.tbIcon.get_status()
        is_running_symbol = '✔️' if is_running else '---'
        status_text = '''Optract status: {0}
  node status: {1}
  ipfs status: {2}'''.format(is_running_symbol, node_symbol, ipfs_symbol)
        return status_text

    def check_browser(self, browser):
        # check if browser nativeMsg are properly configured
        browser_nativeApp = nativeApp.installer.get_nativeApp_from_browser_manifest(browser)
        if sys.platform.startswith('win32'):
            current_nativeApp = os.path.join(nativeApp.distdir, 'nativeApp', 'nativeApp.exe')
        elif sys.platform.startswith('darwin'):
            current_nativeApp = os.path.join(nativeApp.distdir, 'nativeApp', 'nativeApp')
        elif sys.platform.startswith('linux'):
            current_nativeApp = os.path.join(nativeApp.distdir, 'nativeApp', 'nativeApp')
        if browser_nativeApp:  # note: browser_nativeApp can be False
            # return browser_nativeApp == unicode(current_nativeApp, encoding='utf-8')  # in python2 the latter is 'string'
            return browser_nativeApp == current_nativeApp
        else:
            return False

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
        # TODO: also check whether browser manifest are properly configured
        # TODO: also add nativeApp.message, and ignore nativeApp.installer.message except during installation
        if os.path.exists(nativeApp.install_lockFile) \
                and self.tbIcon.ipfsP_is_running and self.tbIcon.nodeP_is_running:
            self.timer.Stop()
            self.timer.Start(5000)  # use lower frequency
            self.st_nativeApp.SetLabel('Optract is running')
        else:
            self.st_nativeApp.SetLabel(nativeApp.installer.message)
            self.button_start_server.Disable()
            self.button_stop_server.Disable()
            self.button_ipfs_restart.Disable()

        # test: browser status
        if os.path.exists(nativeApp.install_lockFile):
            if not self.check_browser('firefox'):
                self.button_config_firefox.Enable()
            else:
                self.button_config_firefox.Disable()
            if not self.check_browser('chrome'):
                self.button_config_chrome.Enable()
            else:
                self.button_config_chrome.Disable()

    def on_mouse_enter(self, event, help_string):
        # self.StatusBar.SetStatusText("button: {0}".format(btn.GetLabel()))
        self.StatusBar.SetStatusText(help_string)
        event.Skip()

    def on_mouse_leave(self, event):
        self.StatusBar.SetStatusText("")
        event.Skip()

    def on_restart_ipfs(self, event):
        self.button_start_server.Disable()
        self.button_stop_server.Disable()
        nativeApp.start_ipfs()
        # self.sizer.Layout()  # or panel.layout()

    def on_start_server(self, event):
        self.button_start_server.Disable()
        self.start_server(False)

    def on_stop_server(self, event):
        self.button_stop_server.Disable()
        nativeApp.stopServer()  # can_exit=False

    def on_exit(self, event):
        """Close the frame, terminating the application."""
        # TODO/BUG: sometimes segmentfault on mac
        # TODO: if TaskBarIcon is available, add an event handler which close window and keep servers running
        log.info('Bye!')
        nativeApp.stopServer()
        time.sleep(0.8)
        # self.tbIcon.RemoveIcon()
        self.tbIcon.Destroy()
        self.DestroyLater()

    def on_iconize(self, event):
        self.Iconize(True)
        # if self.IsIconized():
        #     self.Hide()

    def dialog_finish_install(self):
        if sys.platform.startswith('win32'):  # already popup dialog in the beginning of installation for win32
            dlg = wx.MessageBox("Finish installation")
        else:
            # TODO: a bit confusing to use "cancel" button here, change to something else
            msg = "Press OK to visit https://11be.org to get the browser addon or CANCEL to continue."
            dlg = wx.MessageDialog(None, msg, "Finish installation",
                                   wx.OK | wx.CANCEL | wx.ICON_INFORMATION)
            ret = dlg.ShowModal()
            if ret == wx.ID_OK:
                webbrowser.open("https://11be.org")
        dlg.Destroy()

    def on_visit_homepage(self, event):
        webbrowser.open("https://11be.org")

    def on_evt_install(self, event):
        # TODO: provide information about the addon is installed locally and only create nativeMsg for
        #       chrome or firefox
        # TODO: detect existing installation from browser nativeMsg, and confirm to use the data there
        #       (by replacing the dist folder there)
        def _evt_install(win):
            nativeApp.install()
            wx.CallAfter(self.st_nativeApp.SetLabel, 'Starting server....')
            # note: use wx.CallAfter instead of calling gui from another thread (otherwise core dumped in Ubuntu)
            # TODO: run self.start_server() before click the button in dialog_finish_install()
            wx.CallAfter(self.dialog_finish_install)
            wx.CallAfter(self.start_server)
        t = threading.Thread(target=_evt_install, args=(self, ))
        t.setDaemon(True)
        t.start()

        if sys.platform.startswith('win32'):
            dlg = wx.MessageDialog(None, "Press OK to visit https://11be.org to get the browser addon", "Visit homepage",
                                   wx.OK | wx.CANCEL | wx.ICON_INFORMATION)
            ret = dlg.ShowModal()
            if ret == wx.ID_OK:
                webbrowser.open("https://11be.org")

    def on_config_firefox(self, event):
        log.info('createing or config manifest for firefox')
        nativeApp.installer.create_and_write_manifest('firefox')
        wx.MessageBox('create nativeApp for firefox. Please install browser extension from https://11be.org')

    def on_config_chrome(self, event):
        log.info('createing or config manifest for chrome')
        nativeApp.installer.create_and_write_manifest('chrome')
        wx.MessageBox('create nativeApp for chrome. Please install browser extension from https://11be.org')

    def start_server(self, can_exit=True):
        msg = nativeApp.pgrep_services_msg()
        if msg != '':
            wx.MessageBox(msg + '\nQuit now')
            sys.exit(0)
        else:
            nativeApp.startServer(can_exit=can_exit)

    def on_evt_startserver(self, event):
        def _evt_startserver(win):
            wx.CallAfter(self.st_nativeApp.SetLabel, 'Starting server....')
            wx.CallAfter(self.start_server)
        t = threading.Thread(target=_evt_startserver, args=(self, ))
        t.setDaemon(True)
        t.start()

    def on_about(self, event):
        """Display an About Dialog"""
        wx.MessageBox("Optract Optract is a consensus protocol representing collective intelligence\n" +
                      "for the process of assessing the value of any information stream.\n" +
                      "Please visit https://11be.org for more information",
                      "About",
                      wx.OK | wx.ICON_INFORMATION)


class App(wx.App):
    def OnInit(self):
        frame = MainFrame(None, title='Optract GUI', size=(300, 280))
        self.SetTopWindow(frame)

        # install if necessary; show gui only when systray is not available or during install
        if not os.path.exists(nativeApp.install_lockFile):
            log.info('Installing Optract')  # do it in MainFrame()
            frame.Show()
        if not frame.tbIcon.IsAvailable():
            log.warning("TaskBarIcon not available")  # such as Ubuntu 18.04 (Gnome3 + unity DE)
            frame.Show()
        if not frame.tbIcon.IsOk():
            log.error("Failed to init TaskBarIcon")
            sys.exit(1)

        icon = wx.Icon(wx.Bitmap(TRAY_ICON))
        frame.SetIcon(icon)
        return True


def pgrep_systray():
    proc = []
    for p in psutil.process_iter(attrs=['pid', 'name', 'cmdline', 'status']):
        # note: cmdline may not contain full path if execute manually
        if p.info['name'] == 'systray' and p.info['pid'] != psutil.Process().pid:
            log.error('[systray:pgrep_systray()] {0}'.format(p.info))
            proc.append({'pid': p.info['pid'], 'status': p.info['status']})
    return proc


def main():
    print('DEBUG: running sysatry in {0}'.format(distdir))
    print('DEBUG: sysatry logfile in {0}'.format(logfile))
    app = App(False)
    app.MainLoop()


if __name__ == '__main__':
    if len(sys.argv) > 1:
        errormsg = sys.argv[1]
    else:
        errormsg = ''
    other_systray_proc = pgrep_systray()
    main()
