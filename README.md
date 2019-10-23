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

**update**

Above instruction still valid for validator's node.

After merge the `init_setup` branch back to master, the `OptractClient` should be installed in
the following folders (will call it `$basedir` below):

- mac and linux: `~/.config/Optract`
- windows: `~/AppData/Local/Optract`

Under `$basedir` there (will) contain files and directories:
- `dist/`: the main code
- `config.json`, `ipfs_repo/`, `myArchive.bcup`, and `keystore/`: should keep these file while
  update the main code
- `optract.log`: contain installation log, and a couple lines while `nativeApp` start to work

## To build
- requirements: python2 and pyinstaller installed
    - only need to change a few lines if migrate to python3 in future
- `git clone git@github.com:elevenbuckets/OptractP2pCLI.git` 
- `npm install`
- edit `resources/optract.json` (unix-like) or `resources/optrac-win.json` (windows), insert the `username` and `extension-id`
    - note that the `nativeApp` will be a executable binary (no need to append `.py`)
- Build release for different platform:
    - linux: `npm run release`
    - mac: `npm run releaseMac64`
    - win: `npm run releaseWin64`
- Now there's a `dist` folder and the corresponding archive `Optract*.tar.gz`.

## To install
- (optional) copy existing `keystore/` and `myArchive.bcup` to `$basedir`. The install script
  will symlink to those files.
- (optional) copy or move existing `ipfs_repo` to the `$basedir`.
- In terminal, cd into the `dist` folder (extract the `Optract*.tar.gz` if necessary), run the 
  following script to install:
    - `./install.sh` for linux and mac
    - `install.bat` for windows
    - The script copies necessary files into `$basedir`, untar `node_modules.tar`, add registry
      or copy the mainfest of extension to proper places depend on OS

- TODO:
    - (for windows) Although there are symlink for windows vista and above, but due to UAC,
      it seems that must run as administrator to symlink. Thus install script use `copy` instead
        of symlink in wonsows. This may cause problem while update to newer version of `dist`.
