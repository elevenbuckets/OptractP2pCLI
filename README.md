# OptractP2pCLI

### Quick howto:
- ``` git clone ...```
- ``` npm install ```
- In package root, run ``` node console.js ```
- In console, assuming PubSub topic is "Optract" :

  - Setup channel connection:
  
    ``` app.connectP2P() ```
    
    ``` app.join('Optract') ```

  After channel is set, one can now perform the following:

  - To listen to message:
    
    ``` app.setIncommingHandler((msg) => {console.dir(msg);} ) ```
    
  - To send message:
 
    ``` app.publish('Optract', 'My message or RLPx') ```
