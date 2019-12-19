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

The `OptractClient` will install in where user extract the file (the `$basedir`).

After install, `$basedir` contain files and directories:
- `dist/`: the main code, include executables, contract related, node_modules, nativeApp,
  systray and gui
- `config.json`, `ipfs_repo/`, `myArchive.bcup`, and `keystore/`: should keep these file
  while update the main code
    - note that cache files also in `$basedir`
- `optract.log`: contain installation log, and a couple lines while `nativeApp` start to
  work

## To build
- requirements: python3 and modules
    - create virtualenv: assume there are python3 installed (through python.org or
      anaconda/minoconda or homebrew on mac or linux package managers). For example:
        - unix, python3, bash or zsh
            - `python3 -m venv ~/py37`
            - `~/py37/bin/activate`
        - unix, anaconda/miniconda, bash or zsh
            - `conda create --name py37 python=3.7`
            - `conda activate py37`
        - to leave virtualenv, use `source deactivate` or `conda deactivate`
    - install python modules:
        - `pip install pyinstaller pyarmor wxPython psutil`
    - register pyarmor (assume the register file is in `~/Downloads/pyarmor-regfile-1.zip`)
        - `pyarmor register ~/Downloads/pyarmor-regfile-1.zip`
        - then, after run `pyarmor register` should show something like
          `This code is authorized to ...`
- if not yet:
    - `git clone git@github.com:elevenbuckets/OptractP2pCLI.git` 
    - `git checkout init_setup`
    - `npm install`
- Build release for different platforms:
    - linux: `npm run release`
    - mac: `npm run releaseMac64`
    - win: `npm run releaseWin64`
- Now there's a `Optract_release` folder and the corresponding archive `Optract*.tar.gz` or
  `.zip` file (for windows release). 


## To install
**close browsers which has optract installed and make sure all processes are stop**

- (optional) copy or move `keystore/`, `myArchive.bcup`, and `ipfs_repo` to `$basedir`.
- open folder `$basedir/dist` (after extract the `Optract*.tar.gz`), install by:
    - mac: `./systray.app/Contents/MacOS/systray` from terminal or double click `systray.app`
    - linux: `./systray/systray` from terminal
    - windows: double click `systray.exe`
- Note that `systray` will install if `$basedir/.installed` does not exist
- Note that the `install` here mainly prepare folders, untar `node_modules.tar` and tell
  browsers the location of `$basedir/dist/nativeApp` (by creating or updating the 
  corresponding `nativeMessagingHost` folders or registry).

## about debug
- Even build with pyarmor, if execute systray from command line, one can still see the error
  line number and error message (if the problem is in systray or nativeApp)
- check the log file in `$basedir/optract.log`
- access console
    - in OptractP2PCli folder, `cd lib; cp pubsubNode.js libSampleTickets.js console.js $basedir/dist/lib`
    - `cd $basedir/dist`
    - `vi lib/console.js`
    - change this line (around line 23):
      - from: `const config = JSON.parse(fs.readFileSync(path.join(__dirname, '/../dapps', 'config.json')).toString()); // can become part of cfgObj`
      - to: `const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../', 'config.json')).toString()); // can become part of cfgObj`
    - `./bin/node ./lib/console.js` 
- test server and GUI (to see `stdout` and `stderr`), `cd $basedir/dist`, then:
    - start server: `./nativeApp/nativeApp test`
    - systray: `./nativeApp/nativeApp testtray`
        - note that wxpython's `TaskBarIcon` is not compatible with ubuntu, so pop up a window
          instead
