# OptractP2pCLI 
#### Note: Requires NodeJS 10.5.* or newer, recommended: 10.15.3
#### Note: Developers needs to npm install asar as global package.

### Quick howto:
- ``` git clone ...```
- ``` npm install ```
- ``` npm run release ```
- Install tarball release (assuming to /tmp/Optract)
- ``` tar xf OptractClient.tar.gz -C /tmp/Optract ```
- (Temoprary DEV BUILD setup): Copy keystore and bcup archive into dist/dapps under install root dir.

### Start Service:
- ``` ./optRun ```

### Start Console (After service is up)
- ``` ./optRun console ```

### Or ... launch all-in-one dev console without WSRPC:
- ``` ./optRun devConsole ```
