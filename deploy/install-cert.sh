#!/usr/bin/env bash
# 备案通过后，一条命令签发正式证书并装到 nginx 使用的位置。
# 用法：ssh root@cerr.cc 'bash /opt/touchtag/deploy/install-cert.sh'
set -euo pipefail

DOMAIN="${1:-cerr.cc}"
EMAIL="${2:-admin@${DOMAIN}}"
WEBROOT=/var/www/certbot
TARGET=/etc/ssl/touchtag

echo "==> 1/4 确认 HTTP 是否已经不再被备案拦截"
if ! curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: ${DOMAIN}" http://127.0.0.1/.well-known/acme-challenge/ | grep -qE '^(200|403|404)$'; then
  echo "    本机 nginx 未响应，先检查服务状态。"
  exit 1
fi
echo "    本机 OK。注意：证书签发需要 Let's Encrypt 从公网访问 ${DOMAIN}:80，"
echo "    如果域名仍被运营商阻断，certbot 一定会失败——这一步先失败反而是好事。"

echo "==> 2/4 申请证书（HTTP-01）"
mkdir -p "$WEBROOT"
certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
  --agree-tos -m "$EMAIL" --non-interactive --keep-until-expiring

echo "==> 3/4 安装到 nginx 使用的位置 ${TARGET}"
mkdir -p "$TARGET"
cp -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "${TARGET}/fullchain.pem"
cp -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "${TARGET}/privkey.pem"
chmod 644 "${TARGET}/fullchain.pem"
chmod 600 "${TARGET}/privkey.pem"
nginx -t && systemctl reload nginx

echo "==> 4/4 挂上自动续期钩子"
cat > /etc/letsencrypt/renewal-hooks/deploy/touchtag.sh <<'HOOK'
#!/bin/sh
set -e
cp -f /etc/letsencrypt/live/cerr.cc/fullchain.pem /etc/ssl/touchtag/fullchain.pem
cp -f /etc/letsencrypt/live/cerr.cc/privkey.pem   /etc/ssl/touchtag/privkey.pem
chmod 644 /etc/ssl/touchtag/fullchain.pem
chmod 600 /etc/ssl/touchtag/privkey.pem
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/touchtag.sh
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

echo
echo "完成。用 HTTPS 打开： https://${DOMAIN}/"
echo "然后把 /etc/touchtag.env 里的 TOUCHTAG_BASE_URL 改成 https://${DOMAIN} 并重启服务，"
echo "NFC 打印出来的短链就会统一成正式域名。"
