#!/bin/bash

OD=`pwd`;

if [ $1 == "console" ]; then
   exec $OD/node $OD/console.js;
fi

(
  export IPFS_PATH="${OD}/ipfs_repo";
  [ -e ${OD}/ipfs_repo/config ] && echo "ipfs repo ready" || ${OD}/ipfs init && \
  ${OD}/ipfs daemon --routing=dhtclient &
)

sed "s|__OPTRACT_INSTALL__|${OD}|g" ./dapps/config.json.dist > ./dapps/config.json && \
 rm -fr ${OD}/node_modules && ${OD}/asar extract ${OD}/node_modules.asar ${OD}/node_modules && \
 ${OD}/node ${OD}/daemon.js && pkill -15 ipfs;
