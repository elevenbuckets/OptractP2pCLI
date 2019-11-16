# OptractP2pCLI 
#### Note: Requires NodeJS 10.5.* or newer, recommended: 10.15.3
#### Note: Developers needs to npm install asar as global package.

### Quick howto:
- `git clone ...`
- `npm install `
- `npm run release `
- Install tarball release (assuming to /tmp/Optract)
- `tar xf OptractClient.tar.gz -C /tmp/Optract `
- (Temoprary DEV BUILD setup): Copy keystore and bcup archive into dist/dapps under install root dir.

### Start Service:
- `./optRun `

### Start Console (After service is up)
- `./optRun console` 

### Or ... launch all-in-one dev console without WSRPC:
- First update config in config.json.dist and set node.wsrpc = false.
- `./optRun devConsole`


----

**for init_setup branch**

Above instruction still valid for validator's node.

The `OptractClient` will install in the following folders (call it `$basedir` below):

- mac and linux: `~/.config/Optract`
- windows: `~/AppData/Local/Optract`

Under `$basedir` there contain files and directories after installation:
- `dist/`: the main code, include executables, contract related, node_modules, nativeApp, systray
  and gui
- `config.json`, `ipfs_repo/`, `myArchive.bcup`, and `keystore/`: should keep these file while
  update the main code
    - note that cache files also in `$basedir` and may need to remove them in some cases
- `optract.log`: contain installation log, and a couple lines while `nativeApp` start to work

## To build
- requirements: python2.7
    - `pip` and `virtualenv`: it is probably better to use virtualenv of python and install python
      modules in user space.  There's no `pip` in mac (at least not in MacOS 10.13) and no python
      in windows 10. One way is to download and install python from python.org, install `virtualenv`
      using `pip`, and create virtualenv (using python 2.7) as a non-root user. In mac, use
      anaconda/miniconda (my choice) or homebrew or get-pip.py or macports are alternative choices.
    - install python modules:
        - `pip install pyinstaller pyarmor wxPython psutil`
    - register pyarmor (assume the register file is in `~/Downloads`)
        - `pyarmor register ~/Downloads/pyarmor-regfile-1.zip`
        - then, run `pyarmor register` should see something like `This code is authorized to ...`
    - note: should migrate to python3 in near future. In case that happens, at lease need to
      update following places:
        - encode/decode `bytes` in `struct.pack()` and `struct.unpack()`
        - `raw_input()` -> `input()`
        - remove `from __future__ import print_function`
- if not yet:
    - `git clone git@github.com:elevenbuckets/OptractP2pCLI.git` 
    - `git checkout init_setup`
    - `npm install`
- Build release for different platforms:
    - linux: `npm run release`
    - mac: `npm run releaseMac64`
    - win: `npm run releaseWin64`
- Now there's a `dist` folder and the corresponding archive `Optract*.tar.gz` or zip file (for
  windows release). 

To build without pyarmor (for debug purpose):
- In `package.json`, rename the npm script `buildNativeAppNoArmor` to `buildNativeApp`, and the
  original `buildNativeApp` or `buildNativeAppMac` to anything unused. Then run
  `npm run release` or `npm run releaseMac64`.

## To install
- **close browsers which has optract installed and make sure all processes are stop**
- (optional) copy or move `keystore/`, `myArchive.bcup`, and `ipfs_repo` to `$basedir`.
- In terminal, cd into the `dist` folder (extract the `Optract*.tar.gz` if necessary), run the 
  following script to install:
    - `./install.sh` for linux and mac
    - `install.bat` for windows
    - The script copies necessary files into `$basedir`, untar `node_modules.tar`, add registry
      or copy the mainfest of extension to proper places depend on OS

## developing
**the following tips may be outdated**
* to see the console:
    - in OptractP2PCli folder: `cd lib; cp pubsubNode.js libSampleTickets.js console.js ~/.config/Optract/dist`
        - TODO: add npm script for the line above
        - TODO: update the path of config file in `console.js` to `../../` instead of `/../dapps`
    - then open browser and run optract, or:
        - `cd ~/.config/Optract/dist; ./nativeApp/nativeApp test`
        - then wait ~10 seconds, should see a `enter anything to stop...`, wait a few more 
          seconds to make sure nodes and ipfs are running
    - open another terminal
        - `cd ~/.config/Optract/dist; ./bin/node ./lib/console.js`
    - to stop, go back to first terminal (if use this method) and press `enter` to stop
* if update `daemon.js`, `pubSubNode.js`, or `libSampleTickets.js`, need to manually edit the `OptractDaemon.py`
    - should find simple ways to update `OptractDaemon.py`
* to develop nativeApp, there are two ways:
    1. update `package.json`, and replace `buildNativeApp` by `buildNativeAppNoArmor` and build again
        - the pyarmor-ed code are difficult to debug
    2. simply replace the `~/.config/Optract/dist/nativeApp/nativeApp` by `nativeApp.py` and
       also update the manifest file of browser extension
* note: for wxPython, need to use `pythonw` instead of `python`
