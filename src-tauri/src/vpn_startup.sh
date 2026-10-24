#!/bin/bash
# Startup script for a Gus VPN exit server (Debian 12 on GCE). The WireGuard
# keys come from instance metadata, so every server in every region answers
# with the same identity and the Mac's one tunnel works with any of them.
set -euo pipefail
md() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }

if ! command -v wg >/dev/null || ! command -v iptables >/dev/null; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wireguard-tools iptables
fi

IF=$(ip route show default | awk '{print $5; exit}')
umask 077
# The VPC's MTU is 1460, so the tunnel (80 bytes of overhead) gets 1380.
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.66.0.1/24
ListenPort = 51820
MTU = 1380
PrivateKey = $(md wg-server-key)
PostUp = sysctl -w net.ipv4.ip_forward=1
PostUp = iptables -t nat -A POSTROUTING -o $IF -j MASQUERADE
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT
PostUp = iptables -A FORWARD -o wg0 -j ACCEPT
PostUp = iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu

[Peer]
PublicKey = $(md wg-client-pub)
AllowedIPs = 10.66.0.2/32
EOF

systemctl enable wg-quick@wg0
systemctl restart wg-quick@wg0
echo "GUSVPN READY"
