#!/usr/bin/env bash
# 本地一条命令把 app/ 推到远端并重启服务。
# 用法：bash app/deploy/deploy.sh
set -euo pipefail

HOST="${TOUCHTAG_HOST:-root@cerr.cc}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE=/opt/touchtag

echo "==> 打包并上传（不含 data/，数据在服务器 /var/lib/touchtag）"
cd "$APP_DIR"
tar czf - --exclude=data --exclude='*.log' --exclude='._*' \
  server.js lib public deploy | ssh "$HOST" "rm -rf ${REMOTE}/lib ${REMOTE}/public ${REMOTE}/deploy ${REMOTE}/server.js && mkdir -p ${REMOTE} && tar xzf - -C ${REMOTE}"

echo "==> 同步 systemd 单元与 nginx 站点配置"
ssh "$HOST" "set -e
find ${REMOTE} -name '._*' -delete
chown -R root:root ${REMOTE}
cp -f ${REMOTE}/deploy/touchtag.service /etc/systemd/system/touchtag.service
cp -f ${REMOTE}/deploy/nginx-touchtag.conf /etc/nginx/sites-available/touchtag
systemctl daemon-reload
nginx -t
systemctl restart touchtag
systemctl reload nginx
sleep 2
systemctl is-active touchtag
curl -s -o /dev/null -w '应用健康检查: %{http_code}\n' http://127.0.0.1:3000/api/health
curl -s -o /dev/null -w 'nginx 80 健康检查: %{http_code}\n' -H 'Host: 127.0.0.1' http://127.0.0.1/api/health"

echo "==> 完成"
