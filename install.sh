#!/bin/bash
set -euxo pipefail

mkdir -p local

npm install --loglevel=verbose
npm run build

sudo apt install -y wireguard
sudo apt install -y podman socat

# Download Extra Tools

mkdir -p bin

cd bin
wget https://github.com/go-gost/gost/releases/download/v3.2.6/gost_3.2.6_linux_amd64.tar.gz
tar -xzvf gost_3.2.6_linux_amd64.tar.gz gost
rm gost_3.2.6_linux_amd64.tar.gz
chmod a+x gost

wget https://github.com/fatedier/frp/releases/download/v0.54.0/frp_0.54.0_linux_amd64.tar.gz
tar -xzvf frp_0.54.0_linux_amd64.tar.gz --strip-component=1 frp_0.54.0_linux_amd64/frpc frp_0.54.0_linux_amd64/frps
chmod a+x frpc
chmod a+x frps
rm frp_0.54.0_linux_amd64.tar.gz
cd ..

# Build Container Image

sudo podman build . -t bird-router

sed s#__INSTALL_DIR__#$PWD#g network-tools@.service.template > /tmp/network-tools@.service
sudo mv /tmp/network-tools@.service /etc/systemd/system/network-tools@.service
sudo systemctl daemon-reload
